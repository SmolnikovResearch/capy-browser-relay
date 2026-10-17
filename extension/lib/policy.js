// Local enforcement of site policy. The relay sends allowed_domains and
// denied_hosts with every command; the extension checks them itself and also
// applies a built-in floor and the owner's local lists, so a compromised relay
// cannot widen access.

// Never reachable, whatever anybody says. Mirrors the relay's list.
export const BUILTIN_DENIED = [
  'chromewebstore.google.com', 'accounts.google.com', 'mail.google.com', 'mail.yandex.ru',
  'sberbank.ru', 'online.sberbank.ru', 'tbank.ru', 'tinkoff.ru', 'vtb.ru', 'alfabank.ru',
  'paypal.com', 'gosuslugi.ru',
];

export function parseHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u;
}

export function hostMatches(host, pattern) {
  let p = String(pattern || '').trim().toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) p = p.slice(2);
  if (!p) return false;
  return host === p || host.endsWith('.' + p);
}

function isWebstore(u) {
  return u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore');
}

// Is this host on a deny list (built-in floor, relay list, owner list)?
export function isDenied(raw, relayDenied = [], localDenied = []) {
  const u = parseHttpUrl(raw);
  if (!u) return true;
  const host = u.hostname.toLowerCase();
  if (isWebstore(u)) return true;
  return [...BUILTIN_DENIED, ...relayDenied, ...localDenied].some((d) => hostMatches(host, d));
}

// May the agent touch this URL? Empty allowlist allows nothing. localAllowed,
// when non-empty, narrows further (the owner's own list).
export function isAllowed(raw, { allowed = [], denied = [], localAllowed = [], localDenied = [] } = {}) {
  const u = parseHttpUrl(raw);
  if (!u) return false;
  if (isDenied(raw, denied, localDenied)) return false;
  const host = u.hostname.toLowerCase();
  if (!allowed.some((p) => hostMatches(host, p))) return false;
  if (localAllowed.length && !localAllowed.some((p) => hostMatches(host, p))) return false;
  return true;
}
