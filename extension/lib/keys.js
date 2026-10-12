// Device key. ECDSA P-256, generated in the browser, private half
// non-extractable and stored as a CryptoKey in IndexedDB (chrome.storage
// cannot hold one). The public half (base64 SPKI) goes to the relay at pairing
// and is also kept in chrome.storage.local so the two can be cross-checked.

const DB = 'capy-browser';
const STORE = 'keys';
const ID = 'device';

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const loadKeyPair = () => idb('readonly', (s) => s.get(ID));
export const deleteKeyPair = () => idb('readwrite', (s) => s.delete(ID));

export async function createKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await idb('readwrite', (s) => s.put(kp, ID));
  return kp;
}

export async function getOrCreateKeyPair() {
  return (await loadKeyPair()) || (await createKeyPair());
}

export function b64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

export async function publicKeyB64(kp) {
  return b64(await crypto.subtle.exportKey('spki', kp.publicKey));
}

// P1363 (r||s) signature, base64: what the relay verifies.
export async function sign(kp, message) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(message));
  return b64(sig);
}

// Startup check: the stored public key must be the one of the key pair we
// hold, and the pair must sign and verify. Returns {ok, reason}.
export async function verifyStoredKey(storedPubB64) {
  const kp = await loadKeyPair();
  if (!kp) return { ok: false, reason: 'no_key' };
  if (!storedPubB64) return { ok: false, reason: 'no_stored_public_key' };
  const pub = await publicKeyB64(kp);
  if (pub !== storedPubB64) return { ok: false, reason: 'public_key_mismatch' };
  const msg = 'selftest|' + crypto.randomUUID();
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(msg));
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, new TextEncoder().encode(msg));
  return ok ? { ok: true } : { ok: false, reason: 'selftest_failed' };
}
