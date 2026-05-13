/* global TextEncoder, TextDecoder */
// WebCrypto envelope for end-to-end encrypted topic messages.
//
// Envelope shape (JSON, base64url fields, stored verbatim in messages.message):
//   { v: 1, alg: "A256GCM-PBKDF2",
//     kdf: { salt, iter },
//     iv,
//     ct }
//
// Key derivation: PBKDF2-HMAC-SHA-256 -> 32-byte AES-GCM key.
// The server never sees the passphrase or derived key.

const ENVELOPE_VERSION = 1;
const ENVELOPE_ALG = 'A256GCM-PBKDF2';
const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

(typeof self !== 'undefined' ? self : window).PigeonCrypto = (function () {
  function b64uEncode(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uDecode(str) {
    const padding = '='.repeat((4 - (str.length % 4)) % 4);
    const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function randomBytes(n) {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return arr;
  }

  function newSalt() {
    return b64uEncode(randomBytes(SALT_BYTES));
  }

  async function deriveKey(passphrase, saltB64u, iterations) {
    const salt = b64uDecode(saltB64u);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  // fields: { title?, message, tags?, click?, image?, markdown? }
  // Returns the envelope JSON string (to be sent as the HTTP body).
  async function encryptFields(key, fields, saltB64u, iterations) {
    const iv = randomBytes(IV_BYTES);
    const plaintext = new TextEncoder().encode(JSON.stringify(fields));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return JSON.stringify({
      v: ENVELOPE_VERSION,
      alg: ENVELOPE_ALG,
      kdf: { salt: saltB64u, iter: iterations },
      iv: b64uEncode(iv),
      ct: b64uEncode(ct),
    });
  }

  // Detects whether a string looks like our envelope. Cheap parse that never throws.
  function parseEnvelope(str) {
    if (typeof str !== 'string' || str.length < 8 || str[0] !== '{') return null;
    let obj;
    try { obj = JSON.parse(str); } catch { return null; }
    if (!obj || obj.v !== ENVELOPE_VERSION || obj.alg !== ENVELOPE_ALG) return null;
    if (!obj.kdf || typeof obj.kdf.salt !== 'string' || typeof obj.kdf.iter !== 'number') return null;
    if (typeof obj.iv !== 'string' || typeof obj.ct !== 'string') return null;
    return obj;
  }

  // Decrypts an envelope object using a pre-derived key.
  async function decryptEnvelope(key, envelope) {
    const iv = b64uDecode(envelope.iv);
    const ct = b64uDecode(envelope.ct);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plaintext);
    return JSON.parse(text);
  }

  return {
    ENVELOPE_VERSION,
    ENVELOPE_ALG,
    PBKDF2_ITERATIONS,
    b64uEncode,
    b64uDecode,
    newSalt,
    deriveKey,
    encryptFields,
    parseEnvelope,
    decryptEnvelope,
  };
})();
