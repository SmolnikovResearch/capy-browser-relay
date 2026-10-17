const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);

const COPY = {
  ru: {
    lang: 'EN',
    status: { unpaired: 'Не подключен', connecting: 'Подключаюсь', connected: 'На связи', offline: 'Нет связи', paused: 'Пауза', revoked: 'Доступ закрыт', key_error: 'Ключ не читается' },
    empty: 'Напиши, что сделать на этой вкладке. Агенты работают каждый в своей и чужие не трогают.',
    ask: 'Что сделать на этой вкладке',
    fine: 'Эта строка остаётся здесь. Агент её из окна не читает.',
    settings: 'Настройки',
    back: 'Назад',
    pair: 'Подключение',
    relay: 'Адрес',
    code: 'Одноразовый код',
    name: 'Имя браузера',
    connect: 'Подключить',
    pairHint: 'Код даёт тот, кто держит релей. Он сгорает через пять минут.',
    pause: 'Пауза',
    resume: 'Снять паузу',
    revoke: 'Отключить',
    sites: 'Сайты',
    sitesOn: 'Агент может открывать сайты. Списки ниже сужают это.',
    sitesOff: 'Страницы пока закрыты.',
    grant: 'Разрешить сайты',
    allow: 'Только эти',
    deny: 'Никогда',
    save: 'Сохранить списки',
    siteHint: 'Банки, почта, вход и магазин Chrome закрыты всегда.',
    trust: 'Без вопроса',
    trustEmpty: 'Пока каждый раз спрашивает.',
    clear: 'Спрашивать снова',
    saved: 'Списки сохранены',
    paired: 'Подключено',
    unpairedMsg: 'Браузер отключён',
    badUrl: 'Адрес не похож на ссылку',
    noPerm: 'Доступ к адресу не разрешён',
    granted: 'Сайты разрешены',
    denied: 'Не разрешено',
    cmd: { tabs_open: 'открыл вкладку', tabs_list: 'посмотрел вкладки', navigate: 'перешёл', read_page: 'прочитал страницу', screenshot: 'сделал снимок', click: 'нажал', type: 'написал', form_input: 'заполнил поле' },
  },
  en: {
    lang: 'RU',
    status: { unpaired: 'Not connected', connecting: 'Connecting', connected: 'Connected', offline: 'No link', paused: 'Paused', revoked: 'Access closed', key_error: 'Key unreadable' },
    empty: 'Say what to do on this tab. Each agent works in its own tabs and leaves the others alone.',
    ask: 'What should be done on this tab',
    fine: 'This line stays here. An agent does not read it from this window.',
    settings: 'Settings',
    back: 'Back',
    pair: 'Connection',
    relay: 'Address',
    code: 'One-time code',
    name: 'Browser name',
    connect: 'Connect',
    pairHint: 'The code comes from whoever runs the relay. It dies after five minutes.',
    pause: 'Pause',
    resume: 'Resume',
    revoke: 'Disconnect',
    sites: 'Sites',
    sitesOn: 'The agent can open sites. The lists below only narrow that.',
    sitesOff: 'Pages are closed for now.',
    grant: 'Allow sites',
    allow: 'Only these',
    deny: 'Never these',
    save: 'Save lists',
    siteHint: 'Banks, mail, sign-in and the Chrome store stay closed.',
    trust: 'Without asking',
    trustEmpty: 'It still asks every time.',
    clear: 'Ask again',
    saved: 'Lists saved',
    paired: 'Connected',
    unpairedMsg: 'Browser disconnected',
    badUrl: 'That address is not a link',
    noPerm: 'Access to that address was not allowed',
    granted: 'Sites allowed',
    denied: 'Not allowed',
    cmd: { tabs_open: 'opened a tab', tabs_list: 'looked at tabs', navigate: 'navigated', read_page: 'read the page', screenshot: 'took a screenshot', click: 'clicked', type: 'typed', form_input: 'filled a field' },
  },
};

let lang = (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
const t = () => COPY[lang];
const say = (text, ok) => { $('msg').textContent = text || ''; $('msg').className = 'msg' + (ok ? ' ok' : ''); };

function applyCopy() {
  document.documentElement.lang = lang;
  const c = t();
  $('langBtn').textContent = c.lang;
  $('ask').placeholder = c.ask;
  $('fine').textContent = c.fine;
  $('empty').textContent = c.empty;
  $('setTitle').textContent = c.settings;
  $('backBtn').setAttribute('aria-label', c.back);
  $('settingsBtn').setAttribute('aria-label', c.settings);
  $('pairTitle').textContent = c.pair;
  label($('labRelay'), c.relay);
  label($('labCode'), c.code);
  label($('labName'), c.name);
  $('pairBtn').textContent = c.connect;
  $('pairHint').textContent = c.pairHint;
  $('connTitle').textContent = c.pair;
  $('revokeBtn').textContent = c.revoke;
  $('sitesTitle').textContent = c.sites;
  $('grantBtn').textContent = c.grant;
  label($('labAllow'), c.allow);
  label($('labDeny'), c.deny);
  $('saveLocal').textContent = c.save;
  $('siteHint').textContent = c.siteHint;
  $('trustTitle').textContent = c.trust;
  $('clearTrust').textContent = c.clear;
}

function label(el, text) {
  el.querySelector('span').textContent = text;
}

function show(view) {
  $('home').hidden = view !== 'home';
  $('settings').hidden = view !== 'settings';
}

function person(agent) {
  const who = String(agent || (lang === 'ru' ? 'агент' : 'agent'));
  return who.charAt(0).toUpperCase() + who.slice(1);
}

function render(notes, acts) {
  const items = [
    ...notes.map((n) => ({ t: n.t, kind: 'me', text: n.text })),
    ...acts.map((a) => ({
      t: a.t,
      kind: 'agent',
      who: person(a.agent),
      text: t().cmd[a.cmd] || a.cmd,
      host: a.host || '',
    })),
  ].sort((a, b) => a.t - b.t).slice(-40);
  const box = $('thread');
  box.textContent = '';
  $('empty').hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row ' + item.kind;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (item.kind === 'agent') {
      const who = document.createElement('span');
      who.className = 'who';
      const when = new Date(item.t).toLocaleTimeString(lang === 'ru' ? 'ru' : 'en', { hour: '2-digit', minute: '2-digit' });
      who.textContent = item.who + '  ' + when;
      const what = document.createElement('span');
      what.textContent = item.text;
      bubble.append(who, what);
      if (item.host) {
        const host = document.createElement('span');
        host.className = 'host';
        host.textContent = item.host;
        bubble.append(host);
      }
    } else {
      bubble.textContent = item.text;
    }
    row.append(bubble);
    box.append(row);
  }
  box.scrollTop = box.scrollHeight;
}

async function notes() {
  const r = await chrome.storage.local.get('panelNotes');
  return r.panelNotes || [];
}

async function refresh() {
  const s = await send({ type: 'status' });
  if (!s || !s.ok) return;
  $('status').textContent = t().status[s.status] || s.status;
  $('dot').className = 'dot ' + s.status;
  $('detail').hidden = !s.detail;
  $('detail').textContent = s.detail || '';
  const paired = s.cfg.paired;
  $('pairBox').hidden = paired;
  $('pairedBox').hidden = !paired;
  if (!paired) {
    if (!$('relay').value && s.cfg.relay) $('relay').value = s.cfg.relay;
    if (!$('devname').value) $('devname').value = s.cfg.name || '';
  } else {
    $('drelay').textContent = s.cfg.relay || '';
    $('pauseBtn').textContent = s.cfg.paused ? t().resume : t().pause;
    if (document.activeElement !== $('localAllowed')) $('localAllowed').value = (s.cfg.localAllowed || []).join('\n');
    if (document.activeElement !== $('localDenied')) $('localDenied').value = (s.cfg.localDenied || []).join('\n');
    $('trustList').textContent = s.trust.length
      ? s.trust.map((g) => person(g.agent) + ' · ' + g.host).join('. ')
      : t().trustEmpty;
    const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    $('siteAccess').textContent = has ? t().sitesOn : t().sitesOff;
    $('grantBtn').hidden = has;
  }
  const act = await send({ type: 'activity' });
  render(await notes(), (act && act.list) || []);
}

$('langBtn').addEventListener('click', async () => {
  lang = lang === 'ru' ? 'en' : 'ru';
  await chrome.storage.local.set({ uiLang: lang });
  applyCopy();
  refresh();
});
$('settingsBtn').addEventListener('click', () => { say(''); show('settings'); });
$('backBtn').addEventListener('click', () => { say(''); show('home'); });

$('dock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('ask').value.trim();
  if (!text) return;
  const list = await notes();
  list.push({ t: Date.now(), text: text.slice(0, 2000) });
  await chrome.storage.local.set({ panelNotes: list.slice(-40) });
  $('ask').value = '';
  refresh();
});
$('ask').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('dock').requestSubmit(); }
});
$('ask').addEventListener('input', () => {
  $('ask').style.height = 'auto';
  $('ask').style.height = Math.min($('ask').scrollHeight, 120) + 'px';
  $('send').disabled = !$('ask').value.trim();
});

$('pairBtn').addEventListener('click', async () => {
  say('');
  let origin;
  try { origin = new URL($('relay').value.trim()).origin; } catch { say(t().badUrl); return; }
  const pattern = origin + '/*';
  let granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) { say(t().noPerm); return; }
  const r = await send({ type: 'pair', relay: $('relay').value, code: $('code').value, name: $('devname').value });
  if (!r.ok) { say(r.error); return; }
  say(t().paired, true);
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
  say(t().unpairedMsg, true);
  refresh();
});
$('grantBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  say(ok ? t().granted : t().denied, ok);
  refresh();
});
$('saveLocal').addEventListener('click', async () => {
  const lines = (id) => $(id).value.split('\n');
  await send({ type: 'set_local', allowed: lines('localAllowed'), denied: lines('localDenied') });
  say(t().saved, true);
});
$('clearTrust').addEventListener('click', async () => { await send({ type: 'clear_trust' }); refresh(); });

const preview = new URLSearchParams(location.search).get('preview');
if (preview === 'en' || preview === 'ru') lang = preview;
const saved = preview ? null : await chrome.storage.local.get('uiLang');
if (saved && (saved.uiLang === 'ru' || saved.uiLang === 'en')) lang = saved.uiLang;
applyCopy();
$('send').disabled = true;

if (preview) {
  $('status').textContent = t().status.connected;
  $('dot').className = 'dot connected';
  render(
    [{ t: Date.now() - 60000, text: lang === 'ru' ? 'Посмотри цену на этой странице' : 'Check the price on this page' }],
    [{ t: Date.now() - 30000, agent: 'grok', cmd: 'tabs_open', host: 'example.com' }],
  );
} else {
  refresh();
  setInterval(refresh, 2000);
}
