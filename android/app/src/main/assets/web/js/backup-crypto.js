// Encrypted backups, the same format as Best for Windows (main.js encryptBackup / decryptBackup):
// { app: 'best-encrypted', version: 1, cipher: 'aes-256-gcm', kdf: { name: 'scrypt', N, r, p, salt },
//   iv, tag, data } with base64 fields. The key comes from the password with scrypt (RFC 7914),
// written here because WebCrypto has no scrypt; AES-GCM and PBKDF2 come from WebCrypto.

const subtle = globalThis.crypto.subtle;
const KDF = { N: 2 ** 15, r: 8, p: 1 };
const ALLOWED_N = [2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17];

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, length) {
  const key = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 }, key, length * 8));
}

function salsa208(B, x) {
  for (let i = 0; i < 16; i++) x[i] = B[i];
  const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}

/** BlockMix: B (2r blocks of 16 words) → Y, using X (16 words) and x (scratch). */
function blockMix(B, Y, r, X, x) {
  X.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa208(X, x);
    Y.set(X, (i % 2 === 0 ? i / 2 : r + (i - 1) / 2) * 16);
  }
}

function roMix(B, r, N) {
  const words = 32 * r;
  const V = new Int32Array(words * N);
  const X = new Int32Array(words);
  const Y = new Int32Array(words);
  const T = new Int32Array(16);
  const x = new Int32Array(16);
  X.set(B);
  for (let i = 0; i < N; i++) {
    V.set(X, i * words);
    blockMix(X, Y, r, T, x);
    X.set(Y);
  }
  for (let i = 0; i < N; i++) {
    const j = X[(2 * r - 1) * 16] & (N - 1);
    for (let k = 0; k < words; k++) X[k] ^= V[j * words + k];
    blockMix(X, Y, r, T, x);
    X.set(Y);
  }
  B.set(X);
}

/** scrypt(password, salt, N, r, p) → 32 bytes. */
export async function scrypt(password, salt, { N, r, p }, length = 32) {
  const pw = new TextEncoder().encode(String(password).normalize('NFC'));
  const Bbytes = await pbkdf2(pw, salt, p * 128 * r);
  const words = 32 * r;
  for (let i = 0; i < p; i++) {
    const view = new DataView(Bbytes.buffer, i * 128 * r, 128 * r);
    const B = new Int32Array(words);
    for (let k = 0; k < words; k++) B[k] = view.getInt32(k * 4, true);
    roMix(B, r, N);
    for (let k = 0; k < words; k++) view.setInt32(k * 4, B[k], true);
  }
  return pbkdf2(pw, Bbytes, length);
}

async function aesKey(password, salt, kdf) {
  return subtle.importKey('raw', await scrypt(password, salt, kdf), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Text → encrypted backup object (same as Windows). */
export async function encryptBackup(text, password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(password, salt, KDF), new TextEncoder().encode(text)));
  return {
    app: 'best-encrypted', version: 1, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', ...KDF, salt: b64(salt) },
    iv: b64(iv), tag: b64(out.subarray(out.length - 16)), data: b64(out.subarray(0, out.length - 16)),
  };
}

/** Encrypted backup object → text; throws { code: 'INVALID_BACKUP' | 'BACKUP_BAD_PASSWORD' }. */
export async function decryptBackup(box, password) {
  const k = box && box.kdf;
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!k || k.name !== 'scrypt' || box.cipher !== 'aes-256-gcm' || !ALLOWED_N.includes(k.N) || k.r !== 8 || k.p !== 1) throw fail('INVALID_BACKUP');
  let iv; let tag; let data; let salt;
  try { iv = unb64(box.iv); tag = unb64(box.tag); data = unb64(box.data); salt = unb64(k.salt); } catch { throw fail('INVALID_BACKUP'); }
  const joined = new Uint8Array(data.length + tag.length);
  joined.set(data);
  joined.set(tag, data.length);
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(password, salt, k), joined);
    return new TextDecoder().decode(plain);
  } catch {
    throw fail('BACKUP_BAD_PASSWORD');
  }
}
