// The text shown here comes from the relay and the page; it is set with
// textContent only.
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);
let answered = false;

async function init() {
  const r = await chrome.runtime.sendMessage({ type: 'confirm_get', id });
  if (!r || !r.ok) { window.close(); return; }
  $('agent').textContent = r.req.agent;
  $('host').textContent = r.req.host;
  $('what').textContent = r.req.cmd + ': ' + r.req.description;
  $('mins').textContent = String(r.trustMinutes);
  if (['payment', 'delete', 'upload'].includes(r.req.kind)) $('trustRow').hidden = true;
}

async function answer(approve) {
  if (answered) return;
  answered = true;
  await chrome.runtime.sendMessage({ type: 'confirm_answer', id, approve, trust: approve && $('trust').checked });
  window.close();
}
$('allow').addEventListener('click', () => answer(true));
$('deny').addEventListener('click', () => answer(false));
init();
