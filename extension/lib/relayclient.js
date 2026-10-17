// Relay connection: pairing, authenticated WebSocket, reconnect with backoff,
// keepalive. Every browser-specific piece is injected so the same code runs
// in the service worker and in node tests.

export const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
const PING_MS = 20000;
const DEAD_AFTER_MS = 55000;
const HANDSHAKE_MS = 10000;

export function normalizeRelay(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('relay address is not a URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new Error('relay must be https (plain http only for localhost)');
  }
  const path = u.pathname.replace(/\/+$/, '');
  return u.origin + (path && path !== '/' ? path : '');
}

export function wsUrl(relay) {
  return relay.replace(/^http/, 'ws') + '/v1/device/ws';
}

export function createClient(d) {
  // d: store{get,patch,clear}, keys{get,create,remove,pub,sign,verify}, WS, fetchFn, handle,
  //    setTimer, clearTimer, setIntervalFn, clearIntervalFn, now, onStatus, defaultName
  let ws = null;
  let status = 'unpaired';
  let detail = '';
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let hsTimer = null;
  let lastRx = 0;
  let wantOpen = false;

  const setStatus = (s, why = '') => {
    status = s;
    detail = why;
    d.onStatus && d.onStatus(s, why);
  };

  function stopTimers() {
    if (retryTimer) { d.clearTimer(retryTimer); retryTimer = null; }
    if (pingTimer) { d.clearIntervalFn(pingTimer); pingTimer = null; }
    if (hsTimer) { d.clearTimer(hsTimer); hsTimer = null; }
  }

  function closeSocket() {
    const w = ws;
    ws = null;
    if (w) {
      w.onclose = w.onmessage = w.onerror = w.onopen = null;
      try { w.close(); } catch { /* already closed */ }
    }
  }

  function scheduleRetry() {
    if (!wantOpen || retryTimer) return;
    const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    attempt++;
    retryTimer = d.setTimer(() => { retryTimer = null; connect(); }, wait);
  }

  function lost(why) {
    stopTimers();
    closeSocket();
    if (!wantOpen) return;
    setStatus('offline', why);
    scheduleRetry();
  }

  async function connect() {
    const cfg = await d.store.get();
    if (!cfg.token) { setStatus('unpaired'); return; }
    if (cfg.paused) { wantOpen = false; setStatus('paused'); return; }
    if (ws) return; // already connecting or connected
    wantOpen = true;
    const chk = await d.keys.verify(cfg.pub);
    if (!chk.ok) {
      wantOpen = false;
      setStatus('key_error', chk.reason);
      return;
    }
    setStatus('connecting');
    let sock;
    try {
      sock = new d.WS(wsUrl(cfg.relay));
    } catch (e) {
      lost('cannot open socket');
      return;
    }
    ws = sock;
    let ready = false;
    hsTimer = d.setTimer(() => { if (!ready) lost('handshake timeout'); }, HANDSHAKE_MS);
    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token: cfg.token }));
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => { if (ws === sock) lost(ready ? 'connection closed' : 'relay unreachable or refused'); };
    sock.onmessage = async (ev) => {
      lastRx = d.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'challenge') {
        const kp = await d.keys.get();
        sock.send(JSON.stringify({ type: 'proof', sig: await d.keys.sign(kp, 'capy-auth|' + cfg.deviceId + '|' + m.nonce) }));
      } else if (m.type === 'ready') {
        ready = true;
        attempt = 0;
        if (hsTimer) { d.clearTimer(hsTimer); hsTimer = null; }
        setStatus('connected');
        lastRx = d.now();
        pingTimer = d.setIntervalFn(() => {
          if (d.now() - lastRx > DEAD_AFTER_MS) { lost('relay stopped answering'); return; }
          try { sock.send('{"type":"ping"}'); } catch { /* onclose handles it */ }
        }, PING_MS);
      } else if (m.type === 'error') {
        if (m.code === 'unauthorized') {
          wantOpen = false;
          stopTimers();
          closeSocket();
          await d.store.patch({ token: '' });
          setStatus('revoked', 'the relay no longer accepts this device');
        }
      } else if (m.id && m.cmd) {
        const reply = await d.handle(m);
        try { sock.send(JSON.stringify(reply)); } catch { /* socket gone, relay reports offline */ }
      }
    };
  }

  async function disconnect() {
    wantOpen = false;
    stopTimers();
    closeSocket();
  }

  // Called from alarms and SW start: bring the link up if it should be up.
  async function ensure() {
    const cfg = await d.store.get();
    if (!cfg.token || cfg.paused) return;
    if (!ws && !retryTimer) { attempt = Math.min(attempt, 2); await connect(); }
  }

  async function pair({ relay, code, name }) {
    const origin = normalizeRelay(relay);
    code = String(code || '').trim().toUpperCase();
    name = String(name || d.defaultName || 'Chrome').trim().slice(0, 64);
    if (!/^[A-Z0-9]{6,12}$/.test(code)) throw new Error('the pairing code looks wrong');
    if (!name) throw new Error('name the device');
    await disconnect();
    await d.keys.remove(); // a fresh key for every pairing
    const kp = await d.keys.create();
    const pub = await d.keys.pub(kp);
    let resp;
    try {
      resp = await d.fetchFn(origin + '/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, profile: 'Default', public_key: pub, signature: await d.keys.sign(kp, 'capy-pair|' + code + '|' + name) }),
      });
    } catch {
      throw new Error('cannot reach the relay');
    }
    const body = await resp.json().catch(() => ({}));
    if (resp.status !== 201) {
      throw new Error(resp.status === 403 ? 'the code is wrong or expired' : resp.status === 429 ? 'too many wrong codes, wait a few minutes' : (body.error || 'pairing failed: ' + resp.status));
    }
    await d.store.patch({ relay: origin, deviceId: body.device_id, token: body.device_token, expires: body.expires_at, name, pub, paused: false });
    attempt = 0;
    await connect();
    return { deviceId: body.device_id };
  }

  async function unpair() {
    const cfg = await d.store.get();
    await disconnect();
    if (cfg.token && cfg.relay) { // best effort: tell the relay to revoke
      try {
        await d.fetchFn(cfg.relay + '/v1/device/unpair', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token } });
      } catch { /* offline: the owner can revoke from the relay side */ }
    }
    await d.keys.remove();
    await d.store.patch({ token: '', deviceId: '', pub: '', expires: '' });
    setStatus('unpaired');
  }

  async function setPaused(p) {
    await d.store.patch({ paused: !!p });
    if (p) { await disconnect(); setStatus('paused'); } else { await connect(); }
  }

  return { connect, disconnect, ensure, pair, unpair, setPaused, state: () => ({ status, detail }) };
}
