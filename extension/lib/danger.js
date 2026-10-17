// Classification of risky actions and of fields the agent may never fill.
// Pure functions: they take a plain descriptor made by the page script.

const SECRET_RE = /(^|[^a-z])(pass(word|wd)?|pwd|otp|cvv|cvc|2fa|mfa|passcode)([^a-z]|$)|парол|одноразов|одноразовый|cc-(number|csc|exp)|one-time-code|card.?number|номер.?карты/i;

// A field the agent must never type into: passwords, one-time codes, card data.
export function isSecretField(d) {
  if (!d) return false;
  if (String(d.type).toLowerCase() === 'password') return true;
  const hay = [d.autocomplete, d.name, d.id, d.ariaLabel, d.placeholder, d.label].filter(Boolean).join(' ');
  if (/(current-password|new-password|one-time-code|cc-number|cc-csc)/i.test(d.autocomplete || '')) return true;
  return SECRET_RE.test(hay);
}

// A login field: any text input in a form that also holds a password input.
export function isLoginField(d) {
  return !!(d && d.formHasPassword);
}

const PAY_RE = /\b(pay|buy|purchase|checkout|place order|order now|transfer|donate)\b|оплат|купить|купи\b|заказать|оформить заказ|перевести|перевод|пожертв/i;
const DELETE_RE = /\b(delete|remove|erase|destroy|deactivate|close account|unsubscribe|cancel (order|subscription))\b|удал|стереть|деактив|закрыть аккаунт|отменить (заказ|подписк)|отписат/i;
const SEND_RE = /\b(send|submit|publish|post|confirm|sign|approve)\b|отправ|опублик|подтверд|подписать|разместить/i;
const DOWNLOAD_EXT = /\.(zip|rar|7z|exe|msi|dmg|pkg|apk|iso|deb|rpm|sh|bat|ps1|jar)(\?|#|$)/i;

// Returns null for harmless clicks or {kind, reason}. kind decides whether a
// "trust this agent here" grant may skip the window: payment, delete and
// upload never can.
export function classifyClick(d) {
  if (!d) return null;
  const text = [d.text, d.ariaLabel, d.value, d.title].filter(Boolean).join(' ').slice(0, 300);
  if (String(d.type).toLowerCase() === 'file') return { kind: 'upload', reason: 'откроет выбор файла' };
  const isLink = String(d.tag).toLowerCase() === 'a' && !d.isSubmit; // "Payment methods" in a menu is not a payment
  if (!isLink && PAY_RE.test(text)) return { kind: 'payment', reason: 'похоже на оплату или заказ: «' + clip(text) + '»' };
  if (!isLink && DELETE_RE.test(text)) return { kind: 'delete', reason: 'похоже на удаление: «' + clip(text) + '»' };
  if (d.download || (d.href && DOWNLOAD_EXT.test(d.href))) return { kind: 'download', reason: 'скачает файл' };
  const isSubmit = d.isSubmit;
  if (isSubmit && String(d.formMethod).toLowerCase() === 'post') {
    return { kind: 'submit', reason: 'отправит форму' + (text ? ': «' + clip(text) + '»' : '') };
  }
  if (isSubmit && SEND_RE.test(text)) return { kind: 'submit', reason: 'отправит форму: «' + clip(text) + '»' };
  return null;
}

export const NEVER_TRUSTED = new Set(['payment', 'delete', 'upload']);

function clip(s) { return s.length > 80 ? s.slice(0, 77) + '...' : s; }
