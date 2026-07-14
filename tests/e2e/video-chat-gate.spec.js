const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Video chat is friends-only: the in-game button may only appear once AGS
// confirms mutual friendship with the current opponent, and the call entry
// point refuses strangers even when invoked directly. Offline spec — the
// friendship probe (window.agsIsFriendWith) is stubbed; the gating logic in
// app.js (updateVideoChatAvailability / startVideoChat) runs for real.

const btnDisplay = page =>
  page.evaluate(() => document.getElementById('btn-video-chat').style.display);

// Puts app.js into "online game vs <userId>" state without a live peer:
// showColorSelect('online') sets gameMode, setCurrentOpponent triggers the
// friendship re-check (both are top-level app.js functions, hence globals).
const simulateOnlineOpponent = (page, userId) =>
  page.evaluate(id => {
    window.showColorSelect('online');
    window.setCurrentOpponent(id ? 'Opponent' : '', id);
  }, userId);

async function installFakeMediaPeer(page) {
  await page.evaluate(async () => {
    class Emitter {
      constructor() { this.listeners = new Map(); }
      on(name, handler) {
        const handlers = this.listeners.get(name) || [];
        handlers.push(handler);
        this.listeners.set(name, handlers);
        return this;
      }
      emit(name, value) {
        for (const handler of this.listeners.get(name) || []) handler(value);
      }
    }

    class FakePeerConnection {
      constructor(stream = null) {
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        this.listeners = new Map();
        this.statsTick = 0;
        this.restartCount = 0;
        this.senders = [];
        if (stream) this.setStream(stream);
      }
      setStream(stream) {
        this.senders = stream.getTracks().map(track => ({
          track,
          parameters: { encodings: [{}] },
          getParameters() { return structuredClone(this.parameters); },
          async setParameters(parameters) { this.parameters = structuredClone(parameters); },
          async replaceTrack(replacement) { this.track = replacement; },
        }));
      }
      getSenders() { return this.senders; }
      addEventListener(name, handler) {
        const handlers = this.listeners.get(name) || [];
        handlers.push(handler);
        this.listeners.set(name, handlers);
      }
      setConnectionState(connectionState, iceConnectionState = connectionState) {
        this.connectionState = connectionState;
        this.iceConnectionState = iceConnectionState;
        for (const handler of this.listeners.get('connectionstatechange') || []) handler();
        for (const handler of this.listeners.get('iceconnectionstatechange') || []) handler();
      }
      restartIce() { this.restartCount += 1; }
      async getStats() {
        this.statsTick += 1;
        const timestamp = performance.now();
        const bytes = this.statsTick * 100_000;
        return new Map([
          ['codec-video', { id: 'codec-video', type: 'codec', mimeType: 'video/VP8' }],
          ['out-video', {
            id: 'out-video', type: 'outbound-rtp', kind: 'video', timestamp,
            bytesSent: bytes, frameWidth: 1280, frameHeight: 720,
            framesPerSecond: 30, codecId: 'codec-video', qualityLimitationReason: 'none',
          }],
          ['in-video', {
            id: 'in-video', type: 'inbound-rtp', kind: 'video', timestamp,
            bytesReceived: bytes, packetsReceived: this.statsTick * 100,
            packetsLost: 0, frameWidth: 1280, frameHeight: 720,
            framesPerSecond: 30, codecId: 'codec-video',
          }],
          ['pair', {
            id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true,
            localCandidateId: 'local', remoteCandidateId: 'remote',
            currentRoundTripTime: 0.04, availableOutgoingBitrate: 2_500_000,
          }],
          ['local', { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
          ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
        ]);
      }
    }

    class FakeMediaCall extends Emitter {
      constructor(remoteId, stream = null) {
        super();
        this.peer = remoteId;
        this.peerConnection = new FakePeerConnection(stream);
        this.open = true;
      }
      answer(stream) {
        this.answeredWith = stream;
        this.peerConnection.setStream(stream);
        setTimeout(() => this.emit('stream', stream), 0);
      }
      close() {
        if (!this.open) return;
        this.open = false;
        this.emit('close');
      }
    }

    class FakePeer extends Emitter {
      constructor() {
        super();
        this.id = 'local-peer';
      }
      call(remoteId, stream) {
        const call = new FakeMediaCall(remoteId, stream);
        window.__lastFakeMediaCall = call;
        window.__lastLocalCallStream = stream;
        setTimeout(() => call.emit('stream', stream), 0);
        return call;
      }
      destroy() {}
    }

    const fakePeer = new FakePeer();
    window.__fakeMediaPeer = fakePeer;
    window.__createIncomingMediaCall = () => new FakeMediaCall('remote-peer');
    window.chessVideoCall = {
      ...window.chessVideoCall,
      createPeer: async () => fakePeer,
    };
    await window.createOnlineRoom();
    window.setupPeerConnection({
      peer: 'remote-peer',
      open: true,
      on() {},
      send() {},
      close() {},
    }, 'joiner');
    window.showColorSelect('online');
    window.showScreen('game');
    window.setCurrentOpponent('Opponent', 'friend-1');
  });
  await expect.poll(() => btnDisplay(page)).toBe('');
}

test.describe('Video chat friends-only gate', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.agsIsFriendWith = async userId => userId === 'friend-1';
    });
  });

  test('shows the button only after friendship is confirmed', async ({ page }) => {
    await simulateOnlineOpponent(page, 'friend-1');
    await expect.poll(() => btnDisplay(page)).toBe('');
  });

  test('keeps the button hidden for a non-friend opponent', async ({ page }) => {
    await simulateOnlineOpponent(page, 'stranger-9');
    // The probe resolves asynchronously — give it a beat, then assert hidden.
    await page.waitForTimeout(250);
    expect(await btnDisplay(page)).toBe('none');
  });

  test('keeps the button hidden when the opponent is unknown or the probe is unavailable', async ({ page }) => {
    await simulateOnlineOpponent(page, '');
    await page.waitForTimeout(250);
    expect(await btnDisplay(page)).toBe('none');

    await page.evaluate(() => { delete window.agsIsFriendWith; });
    await simulateOnlineOpponent(page, 'friend-1');
    await page.waitForTimeout(250);
    expect(await btnDisplay(page)).toBe('none');
  });

  test('re-checks when the opponent changes mid-session', async ({ page }) => {
    await simulateOnlineOpponent(page, 'friend-1');
    await expect.poll(() => btnDisplay(page)).toBe('');

    // Rematch queue pairs us with a stranger → the button must retract.
    await page.evaluate(() => window.setCurrentOpponent('Rando', 'stranger-9'));
    await expect.poll(() => btnDisplay(page)).toBe('none');
  });

  test('startVideoChat refuses to dial a non-friend even when invoked directly', async ({ page }) => {
    await simulateOnlineOpponent(page, 'stranger-9');
    await page.waitForTimeout(250);

    const dialog = new Promise(resolve => {
      page.once('dialog', async d => {
        const message = d.message();
        await d.dismiss();
        resolve(message);
      });
    });
    await page.evaluate(() => window.startVideoChat());
    expect(await dialog).toContain('only available between friends');
  });
});

test.describe('Video chat media lifecycle', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium project provides deterministic fake media devices');

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.agsIsFriendWith = async userId => userId === 'friend-1';
      window.agsSendEvent = () => {};
    });
    await installFakeMediaPeer(page);
  });

  test('starts media, configures sender quality, exposes controls, and tears down tracks', async ({ page }) => {
    await page.evaluate(() => window.startVideoChat());
    const panel = page.locator('#video-chat-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-call-state', 'connected');
    await expect(page.locator('#remote-video')).toHaveJSProperty('paused', false);

    await expect.poll(() => page.evaluate(() => {
      const sender = window.__lastFakeMediaCall?.peerConnection?.getSenders()
        .find(candidate => candidate.track?.kind === 'video');
      return sender?.parameters?.encodings?.[0]?.maxBitrate || 0;
    })).toBe(1_600_000);

    await page.locator('#btn-toggle-audio').click();
    expect(await page.evaluate(() => window.__lastLocalCallStream.getAudioTracks()[0].enabled)).toBe(false);

    await page.locator('#btn-video-settings').click();
    await expect(page.locator('#video-device-settings')).toBeVisible();
    await expect(page.locator('#video-audio-input option')).not.toHaveCount(0);
    await expect(page.locator('#video-camera-input option')).not.toHaveCount(0);

    await page.locator('#btn-expand-video').click();
    await expect(panel).toHaveClass(/expanded/);

    await page.locator('#video-chat-panel .video-ctrl-btn.danger').click();
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() =>
      window.__lastLocalCallStream.getTracks().every(track => track.readyState === 'ended')
    )).toBe(true);
  });

  test('answers an incoming call and keeps the connecting state until remote media arrives', async ({ page }) => {
    await page.evaluate(() => {
      const incoming = window.__createIncomingMediaCall();
      window.__incomingMediaCall = incoming;
      window.__fakeMediaPeer.emit('call', incoming);
    });
    await expect(page.locator('#video-call-notification')).toBeVisible();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.locator('#video-chat-panel')).toHaveAttribute('data-call-state', 'connected');
    expect(await page.evaluate(() => !!window.__incomingMediaCall.answeredWith)).toBe(true);
    await page.evaluate(() => window.endVideoChat());
  });

  test('surfaces a failed transport, restarts ICE, and returns to connected', async ({ page }) => {
    await page.evaluate(() => window.startVideoChat());
    const panel = page.locator('#video-chat-panel');
    await expect(panel).toHaveAttribute('data-call-state', 'connected');

    await page.evaluate(() => {
      window.__lastFakeMediaCall.peerConnection.setConnectionState('failed');
    });
    await expect(panel).toHaveAttribute('data-call-state', 'reconnecting');
    await expect.poll(() => page.evaluate(() =>
      window.__lastFakeMediaCall.peerConnection.restartCount
    )).toBe(1);

    await page.evaluate(() => {
      window.__lastFakeMediaCall.peerConnection.setConnectionState('connected');
    });
    await expect(panel).toHaveAttribute('data-call-state', 'connected');
    await page.evaluate(() => window.endVideoChat());
  });
});
