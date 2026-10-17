if (location.search.includes('reload=1')) {
  try { chrome.runtime.reload(); } catch (e) {}
  setTimeout(() => window.close(), 200);
}
const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
const say = (t, ok) => { $('msg').textContent = t || ''; $('msg').className = 'msg' + (ok ? ' ok' : ''); };

const CMD = {
  tabs_open: 'открыл вкладку',
  tabs_list: 'посмотрел вкладки',
  navigate: 'перешёл',
  read_page: 'прочитал страницу',
  screenshot: 'сделал снимок',
  click: 'нажал',
  type: 'написал',
  form_input: 'заполнил поле',
};

const LABEL = {
  unpaired: 'Не подключен',
  connecting: 'Подключаюсь',
  connected: 'На связи',
  offline: 'Нет связи, пробую снова',
  paused: 'Пауза',
  revoked: 'Доступ закрыт',
  key_error: 'Ключ устройства не читается',
};

function show(view) {
  $('home').hidden = view !== 'home';
  $('settings').hidden = view !== 'settings';
  $('bar').hidden = view !== 'home';
}

function person(agent) {
  const who = String(agent || 'агент');
  return who.charAt(0).toUpperCase() + who.slice(1);
}

function renderActivity(list) {
  const ul = $('activity');
  ul.textContent = '';
  $('emptyAct').hidden = list.length > 0;
  for (const a of list) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(a.t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const act = document.createElement('span');
    act.className = 'act';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = person(a.agent) + ' ' + (CMD[a.cmd] || a.cmd);
    act.append(what);
    if (a.host) {
      const host = document.createElement('span');
      host.className = 'host';
      host.textContent = a.host;
      act.append(host);
    }
    li.append(when, act);
    ul.appendChild(li);
  }
}

async function refresh() {
  const s = await send({ type: 'status' });
  if (!s || !s.ok) return;
  $('status').textContent = LABEL[s.status] || s.status;
  $('dot').className = 'dot ' + s.status;
  $('detail').hidden = !s.detail;
  $('detail').textContent = s.detail || '';
  const paired = s.cfg.paired;
  $('pairedHome').hidden = !paired;
  $('unpairedHome').hidden = paired;
  $('pairBox').hidden = paired;
  $('pairedBox').hidden = !paired;
  if (!paired) {
    if (!$('relay').value && s.cfg.relay) $('relay').value = s.cfg.relay;
    if (!$('devname').value) $('devname').value = s.cfg.name || '';
    return;
  }
  $('dname').textContent = s.cfg.name || '';
  $('drelay').textContent = s.cfg.relay || '';
  $('pauseBtn').textContent = s.cfg.paused ? 'Снять паузу' : 'Пауза';
  if (document.activeElement !== $('localAllowed')) $('localAllowed').value = s.cfg.localAllowed.join('\n');
  if (document.activeElement !== $('localDenied')) $('localDenied').value = s.cfg.localDenied.join('\n');
  $('trustList').textContent = s.trust.length
    ? s.trust.map((g) => person(g.agent) + ' на ' + g.host + ' до ' + new Date(g.until).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })).join('. ')
    : 'Пока каждый раз спрашивает.';
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('siteAccess').textContent = has
    ? 'Агент может открывать сайты. Списки ниже сужают это.'
    : 'Страницы пока закрыты. Нажмите «Разрешить сайты».';
  $('grantBtn').hidden = has;
  const act = await send({ type: 'activity' });
  renderActivity((act.list || []).slice(0, 12));
}

$('settingsBtn').addEventListener('click', () => { say(''); show('settings'); });
$('backBtn').addEventListener('click', () => { say(''); show('home'); });
$('openConnect').addEventListener('click', () => { say(''); show('settings'); });

$('pairBtn').addEventListener('click', async () => {
  say('');
  let origin;
  try { origin = new URL($('relay').value.trim()).origin; } catch { say('Адрес не похож на ссылку'); return; }
  const pattern = origin + '/*';
  let granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) { say('Доступ к адресу не разрешён'); return; }
  const r = await send({ type: 'pair', relay: $('relay').value, code: $('code').value, name: $('devname').value });
  if (!r.ok) { say(r.error); return; }
  say('Подключено', true);
  show('home');
  refresh();
});
$('pauseBtn').addEventListener('click', async () => {
  const s = await send({ type: 'status' });
  await send({ type: s.cfg.paused ? 'resume' : 'pause' });
  refresh();
});
$('revokeBtn').addEventListener('click', async () => {
  await send({ type: 'unpair' });
  say('Браузер отключён', true);
  refresh();
});
$('grantBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  say(ok ? 'Сайты разрешены' : 'Не разрешено', ok);
  refresh();
});
$('saveLocal').addEventListener('click', async () => {
  const lines = (id) => $(id).value.split('\n');
  await send({ type: 'set_local', allowed: lines('localAllowed'), denied: lines('localDenied') });
  say('Списки сохранены', true);
});
$('clearTrust').addEventListener('click', async () => { await send({ type: 'clear_trust' }); refresh(); });

if (new URLSearchParams(location.search).get('reload') === '1') chrome.runtime.reload();
const preview = new URLSearchParams(location.search).get('preview');
if (preview) {
  $('status').textContent = 'На связи';
  $('dot').className = 'dot connected';
  $('dname').textContent = 'MacBook';
  $('pairedHome').hidden = false;
  $('unpairedHome').hidden = true;
  $('pairBox').hidden = true;
  $('pairedBox').hidden = false;
  $('drelay').textContent = 'http://127.0.0.1:18791';
  $('siteAccess').textContent = 'Агент может открывать сайты. Списки ниже сужают это.';
  $('grantBtn').hidden = true;
  $('trustList').textContent = 'Пока каждый раз спрашивает.';
  renderActivity([
    { t: Date.now() - 120000, agent: 'grok', cmd: 'tabs_open', host: 'example.com' },
    { t: Date.now() - 540000, agent: 'codex', cmd: 'read_page', host: 'yaxnet.ru' },
  ]);
  if (preview === 'settings') show('settings');
} else {
  refresh();
  setInterval(refresh, 2000);
}
