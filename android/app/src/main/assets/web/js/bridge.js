// Messages to and from the Android side. The native object `bestNative` exists only for Best's
// own page (the app registers it for this origin alone).

const pending = new Map();
const listeners = new Map();
let nextId = 1;

const native = globalThis.bestNative;
if (native) {
  native.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && typeof msg.ev === 'string') {
      for (const fn of listeners.get(msg.ev) || []) {
        try { fn(msg.d); } catch (e) { console.error(e); }
      }
      return;
    }
    const p = msg && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.r); else p.reject(Object.assign(new Error(msg.e || 'FAILED'), { code: msg.e || 'FAILED' }));
  };
}

/** Calls a native method; resolves with its result, rejects with an Error whose .code is an error code. */
export function call(method, args = {}) {
  if (!native) return Promise.reject(Object.assign(new Error('NO_NATIVE'), { code: 'FAILED' }));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    native.postMessage(JSON.stringify({ id, m: method, a: args }));
  });
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export const hasNative = Boolean(native);
