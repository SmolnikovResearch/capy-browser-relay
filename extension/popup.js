const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
const say = (t, ok) => { $('msg').textContent = t || ''; $('msg').className = 'msg' + (ok ? ' ok' : ''); };

const LABEL = {
  unpaired: 'Not paired', connecting: 'Connecting...', connected: 'Connected', offline: 'Offline, retrying',
  paused: 'Paused', revoked: 'Revoked by the relay, pair again', key_error: 'Device key problem, pair again',
};

async function refresh() {
  const s = await send({ type: 'status' });
  if (!s || !s.ok) return;
  $('status').textContent = LABEL[s.status] || s.status;
  $('dot').className = 'dot ' + s.status;
  $('detail').textContent = s.detail || '';
  const paired = s.cfg.paired;
  $('pairBox').hidden = paired;
  $('pairedBox').hidden = !paired;
  if (!paired) {
    if (!$('relay').value && s.cfg.relay) $('relay').value = s.cfg.relay;
    if (!$('devname').value) $('devname').value = s.cfg.name || '';
    return;
  }
  $('dname').textContent = s.cfg.name || '';
  $('drelay').textContent = s.cfg.relay || '';
  $('dexp').textContent = s.cfg.expires ? new Date(s.cfg.expires).toLocaleDateString() : '';
  $('pauseBtn').textContent = s.cfg.paused ? 'Resume' : 'Pause';
  if (document.activeElement !== $('localAllowed')) $('localAllowed').value = s.cfg.localAllowed.join('\n');
  if (document.activeElement !== $('localDenied')) $('localDenied').value = s.cfg.localDenied.join('\n');
  $('trustList').textContent = s.trust.length ? s.trust.map((g) => g.agent + ' on ' + g.host + ' until ' + new Date(g.until).toLocaleTimeString()).join('; ') : 'No active trust grants.';
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('siteAccess').textContent = has ? 'This extension can reach every site; your lists above decide which.' : 'Not granted yet: agents cannot read or act in pages until you allow it.';
  $('grantBtn').hidden = has;
  const act = await send({ type: 'activity' });
  const ul = $('activity');
  ul.textContent = '';
  for (const a of act.list.slice(0, 15)) {
    const li = document.createElement('li');
    li.textContent = new Date(a.t).toLocaleTimeString() + '  ' + a.agent + '  ' + a.cmd + (a.host ? ' ' + a.host : '') + '  ' + a.result;
    ul.appendChild(li);
  }
}

$('pairBtn').addEventListener('click', async () => {
  say('');
  let origin;
  try { origin = new URL($('relay').value.trim()).origin; } catch { say('The relay address is not a URL'); return; }
  // user gesture: ask for the relay origin first (needed to reach it from the extension)
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  if (!granted) { say('Access to the relay address was not granted'); return; }
  const r = await send({ type: 'pair', relay: $('relay').value, code: $('code').value, name: $('devname').value });
  if (!r.ok) { say(r.error); return; }
  say('Paired', true);
  refresh();
});
$('pauseBtn').addEventListener('click', async () => {
  const s = await send({ type: 'status' });
  await send({ type: s.cfg.paused ? 'resume' : 'pause' });
  refresh();
});
$('revokeBtn').addEventListener('click', async () => {
  await send({ type: 'unpair' });
  say('This browser was unpaired and the relay was told to revoke it', true);
  refresh();
});
$('grantBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  say(ok ? 'Site access granted' : 'Not granted', ok);
  refresh();
});
$('saveLocal').addEventListener('click', async () => {
  const lines = (id) => $(id).value.split('\n');
  await send({ type: 'set_local', allowed: lines('localAllowed'), denied: lines('localDenied') });
  say('Saved', true);
});
$('clearTrust').addEventListener('click', async () => { await send({ type: 'clear_trust' }); refresh(); });

refresh();
setInterval(refresh, 2000);
