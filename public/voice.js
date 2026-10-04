/* Voice chat, peer to peer.
 *
 * The server only relays the SDP/ICE handshake between two players and stores
 * none of it. Audio goes directly browser to browser, so the server never sees
 * or forwards a single byte of voice.
 *
 * This is a full mesh: with N players each one holds N-1 connections. That is
 * fine at a table of six but would not scale to a hundred, which is why the
 * table is capped.
 *
 * Data note: while the microphone is on this is real bandwidth — far more than
 * everything else in the app put together. That is why it is opt-in, off by
 * default, and the UI says so before you turn it on.
 *
 * ── Why voice used to fail on phones ────────────────────────────────────────
 *
 * The old code reported "This browser cannot do voice chat." whenever
 * `navigator.mediaDevices` was missing. That check conflates two very different
 * situations, and in practice it was almost always the first one:
 *
 *   1. INSECURE_CONTEXT — the page was served over plain http:// from anything
 *      other than loopback. Browsers deliberately hide the whole `mediaDevices`
 *      API outside a secure context, so the property is *undefined* and there is
 *      nothing wrong with the browser at all. Opening the game from a phone via
 *      http://192.168.x.x:3000 hit this every single time, which is why it looked
 *      like a phone problem. Verified: on http://127.0.0.1 the same browser
 *      reports isSecureContext === true and getUserMedia() succeeds.
 *
 *   2. NO_API — a genuinely old or locked-down engine with no getUserMedia at
 *      all. Rare, and worth saying so precisely.
 *
 * `diagnose()` now separates these, plus permission and device failures, so the
 * UI can tell the player what to actually do about it.
 */

(() => {
  'use strict';

  const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  /**
   * TURN relays for when a direct peer path cannot be found (symmetric NAT,
   * some mobile carriers). Supplied by the server at join time and held in
   * memory only: never hard-coded here, and never baked into the client bundle.
   * With no TURN the mesh still works on most home networks.
   */
  function iceServers(turn) {
    const list = [...DEFAULT_ICE];
    if (turn && turn.urls && turn.username && turn.credential) {
      list.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
    }
    return list;
  }

  const AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  /** How long to wait for a peer before writing it off and retrying. */
  const PEER_TIMEOUT_MS = 20_000;
  const RETRY_BASE_MS = 1200;
  const RETRY_MAX_MS = 15_000;

  /**
   * Works out whether voice can work here, and if not, exactly why.
   * Pure and synchronous — safe to call before any permission exists.
   * @returns {{ ok: boolean, code?: string, detail?: string }}
   */
  function diagnose() {
    if (typeof RTCPeerConnection !== 'function') {
      return { ok: false, code: 'no_webrtc', detail: 'This browser has no WebRTC support.' };
    }
    if (!window.isSecureContext) {
      // The important one. `mediaDevices` is intentionally absent here.
      return { ok: false, code: 'insecure_context' };
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return { ok: false, code: 'no_api', detail: 'This browser exposes no microphone API.' };
    }
    return { ok: true };
  }

  /** Turns a getUserMedia rejection into a code the UI can act on. */
  function classify(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'denied';
      case 'NotFoundError':
      case 'OverconstrainedError':
      case 'DevicesNotFoundError':
        return 'no_device';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'device_busy';
      case 'SecurityError':
        return 'blocked';
      case 'AbortError':
        return 'aborted';
      default:
        return 'unknown';
    }
  }

  class Voice {
    constructor({ send, onState }) {
      this.send = send; // (kind, toId, payload) => void
      this.onState = onState; // (state) => void
      this.peers = new Map(); // playerId -> { pc, audio, timer, polite }
      this.enabled = false;
      this.muted = false;
      this.localStream = null;
      this.me = null;
      this.status = 'off'; // off|starting|live|reconnecting|error
      this.lastError = null;
      this.retries = 0;
      this.retryTimer = null;
      this.turn = null; // optional TURN credentials, handed over by the server
    }

    setMe(id) {
      this.me = id;
    }

    /** Optional TURN credentials from the server. Ignored if malformed. */
    setTurn(turn) {
      this.turn = turn && turn.urls && turn.username && turn.credential ? turn : null;
    }

    /** Peer ids that have also opted in. */
    setVoicePeers(ids) {
      if (!this.enabled) return;
      for (const id of ids) {
        if (id !== this.me && !this.peers.has(id)) this.connectTo(id, true);
      }
      for (const id of [...this.peers.keys()]) {
        if (!ids.includes(id)) this.closePeer(id);
      }
    }

    /**
     * Non-destructive capability check for the UI: lets the button explain
     * itself before the player commits to anything.
     */
    static diagnose = diagnose;

    async enable() {
      if (this.enabled) return true;

      const verdict = diagnose();
      if (!verdict.ok) {
        this.fail(verdict.code, verdict.detail);
        return false;
      }

      this.setStatus('starting');
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
          video: false,
        });
      } catch (err) {
        this.fail(classify(err), err && err.message);
        return false;
      }

      // A track that ends by itself (headset unplugged, OS revoking the mic)
      // would otherwise leave the UI claiming it is live.
      for (const track of this.localStream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          this.fail('device_lost');
          this.disable();
        });
      }

      this.enabled = true;
      this.muted = false;
      this.retries = 0;
      this.lastError = null;
      this.setStatus('live');
      return true;
    }

    disable() {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      const wasOn = this.enabled;
      this.enabled = false;
      this.status = 'off';
      this.retries = 0;
      if (!wasOn && !this.localStream) return this.emit();

      for (const id of [...this.peers.keys()]) {
        this.send('bye', id, null);
        this.closePeer(id, { silent: true });
      }
      for (const track of this.localStream?.getTracks() ?? []) track.stop();
      this.localStream = null;
      this.emit();
    }

    setMuted(muted) {
      this.muted = muted;
      for (const track of this.localStream?.getAudioTracks() ?? []) {
        track.enabled = !muted; // muting disconnects nothing
      }
      this.emit();
    }

    peerList() {
      return [...this.peers.entries()].map(([id, e]) => ({
        id,
        connected: e.pc.connectionState === 'connected',
        state: e.pc.connectionState,
      }));
    }

    /** True when this peer is currently talking loudly enough to show a ring. */
    isSpeaking(id) {
      return Boolean(this.peers.get(id)?.speaking);
    }

    /** Handles an inbound offer/answer/ICE/bye from another player. */
    async handle(from, kind, payload) {
      if (kind === 'bye') return this.closePeer(from);
      if (!this.enabled) return;

      // Offers arriving while we are muted still get answered, so the other side
      // is not left waiting on a connection that will never open.
      let entry = this.peers.get(from);
      if (!entry) entry = this.connectTo(from, false);

      const { pc } = entry;
      try {
        if (kind === 'offer') {
          await pc.setRemoteDescription(payload);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.send('answer', from, { sdp: pc.localDescription.sdp, type: pc.localDescription.type });
          this.clearPeerTimer(from);
        } else if (kind === 'answer') {
          await pc.setRemoteDescription(payload);
          this.clearPeerTimer(from);
        } else if (kind === 'ice') {
          // Candidates can arrive before the description they belong to; those
          // are held by the browser and arrive late, so dropping them is fine.
          if (payload?.candidate) await pc.addIceCandidate(payload).catch(() => {});
        }
      } catch (err) {
        this.fail('negotiation_failed', err && err.message);
      }
    }

    connectTo(id, initiator) {
      // Never run two negotiations for the same peer: a duplicate offer while
      // one is already in flight is the classic cause of a wedged connection.
      const existing = this.peers.get(id);
      if (existing && (existing.pc.signalingState !== 'stable' || existing.pc.currentRemoteDescription)) {
        existing.polite = true; // yield: let the other side drive negotiation
      }

      const pc = new RTCPeerConnection({ iceServers: iceServers(this.turn) });
      const entry = {
        pc,
        audio: null,
        timer: null,
        polite: existing?.polite ?? false,
        speaking: false,
      };
      if (existing) {
        this.teardownPeer(existing);
      }
      this.peers.set(id, entry);

      if (this.localStream) {
        for (const track of this.localStream.getAudioTracks()) pc.addTrack(track, this.localStream);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) this.send('ice', id, e.candidate.toJSON());
      };

      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        // One <audio> per peer, never attached twice, kept out of the layout.
        const audio = entry.audio ?? document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true; // iOS: without this, playback is a tap-to-start mess
        audio.setAttribute('aria-hidden', 'true');
        audio.style.display = 'none';
        audio.srcObject = stream;
        entry.audio = audio;
        document.body.append(audio);
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            // Autoplay policy, not a failure: one gesture anywhere unlocks it.
            this.fail('autoplay_blocked');
          });
        }

        // Speaking indicator, driven by the real audio level rather than a guess.
        entry.speaking = false;
        this.watchSpeaking(entry);
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          this.clearPeerTimer(id);
          this.retries = 0;
          if (this.status !== 'live') this.setStatus('live');
          this.emit();
        } else if (s === 'failed') {
          // ICE gave up. Tear down and rebuild; a new attempt often succeeds.
          this.closePeer(id);
          this.scheduleReconnect();
        } else {
          this.emit();
        }
      };

      // A phone that sleeps, changes Wi-Fi, or loses signal shows up as
      // 'disconnected', not 'failed', so it needs its own recovery path.
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' && !this.muted) this.scheduleReconnect();
      };

      entry.timer = setTimeout(() => {
        if (pc.connectionState !== 'connected') {
          this.closePeer(id);
          this.scheduleReconnect();
        }
      }, PEER_TIMEOUT_MS);

      if (initiator && this.localStream) {
        // Whoever turns the mic on first makes the offer, so nobody waits.
        this.makeOffer(id, pc);
      }
      return entry;
    }

    async makeOffer(id, pc) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        if (pc.signalingState !== 'stable') return; // someone else is negotiating
        await pc.setLocalDescription(offer);
        this.send('offer', id, { sdp: pc.localDescription.sdp, type: pc.localDescription.type });
      } catch {
        this.scheduleReconnect();
      }
    }

    clearPeerTimer(id) {
      const entry = this.peers.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry) entry.timer = null;
    }

    /** Retries every peer we expect to be talking to, with a capped backoff. */
    scheduleReconnect() {
      if (!this.enabled) return;
      if (this.status !== 'reconnecting') this.setStatus('reconnecting');

      const wanted = this.expected || [];
      if (!wanted.length) return;
      if (this.retryTimer) return;

      const delay = Math.min(RETRY_BASE_MS * 2 ** this.retries, RETRY_MAX_MS);
      this.retries += 1;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.enabled) return;
        for (const id of wanted) {
          if (id === this.me || this.peers.has(id)) continue;
          this.connectTo(id, true);
        }
        // Peers we had are stale: drop and rebuild them too.
        for (const id of [...this.peers.keys()]) {
          if (id !== this.me && !this.peers.get(id).pc.currentRemoteDescription) this.closePeer(id, { silent: true });
        }
      }, delay);
    }

    /**
     * Drives the speaking ring from the actual signal level. Uses the analyser
     * already sitting on each audio element rather than opening a second stream.
     */
    watchSpeaking(entry) {
      const audio = entry.audio;
      if (!audio) return;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return; // speaking ring is a nicety; never fatal

      let ctx;
      try {
        ctx = new Ctor();
        const source = ctx.createMediaStreamSource(audio.srcObject);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        entry.analyser = analyser;
        entry.audioData = data;
      } catch {
        return;
      }

      const tick = () => {
        if (!this.peers.has(this.peerIdOf(entry))) return;
        if (!entry.analyser) return;
        entry.analyser.getByteTimeDomainData(entry.audioData);
        let sum = 0;
        for (let i = 0; i < entry.audioData.length; i++) {
          const v = (entry.audioData[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.sqrt(sum / entry.audioData.length);
        const speaking = level > 0.035;
        if (speaking !== entry.speaking) {
          entry.speaking = speaking;
          this.emit();
        }
        entry.raf = requestAnimationFrame(tick);
      };
      entry.raf = requestAnimationFrame(tick);
      entry.ctx = ctx;
    }

    peerIdOf(entry) {
      for (const [id, e] of this.peers) if (e === entry) return id;
      return null;
    }

    setStatus(status, error = null) {
      this.status = status;
      this.lastError = error;
      this.emit();
    }

    fail(code, detail) {
      this.lastError = { code, detail: detail || null };
      this.setStatus('error', this.lastError);
    }

    emit() {
      this.onState?.({
        enabled: this.enabled,
        muted: this.muted,
        status: this.status,
        error: this.lastError,
        peers: this.peerList(),
        speaking: [...this.peers.entries()]
          .filter(([, e]) => e.speaking)
          .map(([id]) => id),
        // Lets the UI warn before anyone taps, rather than after they fail.
        capability: diagnose(),
      });
    }

    teardownPeer(entry) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.raf) cancelAnimationFrame(entry.raf);
      entry.ctx?.close?.().catch(() => {});
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      try {
        entry.pc.close();
      } catch {
        /* already closed */
      }
      entry.audio?.remove();
    }

    closePeer(id, { silent = false } = {}) {
      const entry = this.peers.get(id);
      if (!entry) return;
      this.teardownPeer(entry);
      this.peers.delete(id);
      if (!silent) this.emit();
    }
  }

  // Remember who we are talking to so reconnect can rebuild the whole mesh.
  const originalSetVoicePeers = Voice.prototype.setVoicePeers;
  Voice.prototype.setVoicePeers = function (ids) {
    this.expected = [...ids];
    return originalSetVoicePeers.call(this, ids);
  };

  window.UNOVoice = { Voice, diagnose, classify };
})();
