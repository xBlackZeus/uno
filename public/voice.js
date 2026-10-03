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
 */

(() => {
  'use strict';

  // Google's public STUN is enough for most home networks. It costs a few
  // hundred bytes once and tells WebRTC its public address; it carries no audio.
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Opus at 24 kbps mono: speech stays clear and this is among the cheapest
  // settings that still sounds like a person rather than a robot.
  const AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  class Voice {
    constructor({ send, onState }) {
      this.send = send; // (kind, toId, payload) => void
      this.onState = onState; // ({ enabled, muted, peers }) => void
      this.peers = new Map(); // playerId -> { pc, stream, audio }
      this.enabled = false;
      this.muted = false;
      this.localStream = null;
      this.me = null;
    }

    setMe(id) {
      this.me = id;
    }

    /** Peer ids that have also opted in. */
    setVoicePeers(ids) {
      if (!this.enabled) return;
      for (const id of ids) {
        if (id !== this.me && !this.peers.has(id)) this.connectTo(id, true);
      }
      // Drop peers who turned theirs off or left.
      for (const id of [...this.peers.keys()]) {
        if (!ids.includes(id)) this.closePeer(id);
      }
    }

    async enable() {
      if (this.enabled) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        this.onState?.({ error: 'This browser cannot do voice chat.' });
        return;
      }
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
          video: false,
        });
      } catch (err) {
        this.onState?.({
          error:
            err && err.name === 'NotAllowedError'
              ? 'Microphone blocked. Allow it in your browser to talk.'
              : 'No microphone available.',
        });
        return;
      }
      this.enabled = true;
      this.muted = false;
      this.onState?.({ enabled: true, muted: false, peers: this.peerList() });
    }

    disable() {
      if (!this.enabled) return;
      this.enabled = false;
      for (const id of [...this.peers.keys()]) {
        this.send('bye', id, null);
        this.closePeer(id);
      }
      for (const track of this.localStream?.getTracks() ?? []) track.stop();
      this.localStream = null;
      this.onState?.({ enabled: false, muted: false, peers: [] });
    }

    setMuted(muted) {
      this.muted = muted;
      for (const track of this.localStream?.getAudioTracks() ?? []) {
        track.enabled = !muted; // muting disconnects nothing
      }
      this.onState?.({ enabled: this.enabled, muted, peers: this.peerList() });
    }

    peerList() {
      return [...this.peers.keys()].map((id) => ({ id, connected: this.peers.get(id)?.pc.connectionState === 'connected' }));
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
        } else if (kind === 'answer') {
          await pc.setRemoteDescription(payload);
        } else if (kind === 'ice') {
          // Candidates can arrive before the description they belong to.
          if (payload?.candidate) await pc.addIceCandidate(payload).catch(() => {});
        }
      } catch (err) {
        this.onState?.({ error: 'Voice connection failed.' });
      }
    }

    connectTo(id, initiator) {
      const pc = new RTCPeerConnection({ iceServers: ICE });
      const entry = { pc, audio: null };
      this.peers.set(id, entry);

      if (this.localStream) {
        for (const track of this.localStream.getAudioTracks()) pc.addTrack(track, this.localStream);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) this.send('ice', id, e.candidate.toJSON());
      };
      pc.ontrack = (e) => {
        // One <audio> per peer, kept muted by autoplay rules and never attached
        // to the page twice.
        const audio = entry.audio ?? document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = e.streams[0];
        entry.audio = audio;
        document.body.append(audio);
        audio.play().catch(() => {
          this.onState?.({ error: 'Click anywhere to let the browser play voice.' });
        });
      };
      pc.onconnectionstatechange = () => {
        this.onState?.({ enabled: this.enabled, muted: this.muted, peers: this.peerList() });
      };

      if (initiator && this.localStream) {
        // Whoever turns the mic on first makes the offer, so nobody waits.
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => this.send('offer', id, { sdp: pc.localDescription.sdp, type: pc.localDescription.type }))
          .catch(() => this.onState?.({ error: 'Could not start voice.' }));
      }
      return entry;
    }

    closePeer(id) {
      const entry = this.peers.get(id);
      if (!entry) return;
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      try {
        entry.pc.close();
      } catch {
        /* already closed */
      }
      entry.audio?.remove();
      this.peers.delete(id);
      this.onState?.({ enabled: this.enabled, muted: this.muted, peers: this.peerList() });
    }
  }

  window.UNOVoice = { Voice };
})();