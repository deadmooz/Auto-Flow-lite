import vm from 'node:vm';
import { createRequire } from 'node:module';

/*
 * Sandbox for {{ expressions }} and the Code node.
 *
 * STRONG mode (default, package "isolated-vm"): every node run gets its own V8 isolate with a memory cap and a
 * wall-clock timeout, executed on a separate thread so the server never freezes. No Node.js globals exist inside.
 *
 * BASIC mode (automatic fallback when isolated-vm could not be installed, or LITEFOREFLOW_SANDBOX=vm): a locked-down
 * node:vm context (no require/process, no eval, timeouts). Perfectly fine on your own computer; it has no memory cap and
 * runs on the main thread, so do not offer a server in BASIC mode to people you do not trust.
 *
 * Data crosses the boundary only as JSON strings in both modes, so no host object or constructor is reachable.
 * One Sandbox is created per node run and every item gets a fresh, cheap context. Always call dispose() afterwards.
 */

const MEMORY_MB = Number(process.env.SANDBOX_MEMORY_MB) || 64;
const MAX_RESULT_CHARS = 5_000_000;
const MAX_LOG_LINES = 200;

let ivmModule;
const loadIvm = () => {
  if (ivmModule !== undefined) return ivmModule;
  try {
    ivmModule = process.env.LITEFOREFLOW_SANDBOX === 'vm' ? null : createRequire(import.meta.url)('isolated-vm');
  } catch {
    ivmModule = null;
  }
  return ivmModule;
};

export const sandboxMode = () => (loadIvm() ? 'isolated-vm' : 'basic');

let warned = false;
function warnBasic() {
  if (warned) return;
  warned = true;
  console.warn('[liteforeflow] Using the built-in basic code sandbox (the stronger "isolated-vm" is not installed). '
    + 'This is fine on your own computer. If other people will use this server, run: npm install isolated-vm');
}

const BOOTSTRAP = `
(function () {
  Object.assign(globalThis, JSON.parse(globalThis.__raw));
  delete globalThis.__raw;
  const raw = globalThis.$input;
  if (raw && Array.isArray(raw.all)) {
    const all = raw.all.map((j) => ({ json: j }));
    globalThis.$input = { all: () => all, first: () => all[0], last: () => all[all.length - 1], item: { json: globalThis.$json } };
  }
  const logs = [];
  globalThis.__logs = logs;
  const fmt = (x) => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } };
  globalThis.console = { log: (...a) => { if (logs.length < ${MAX_LOG_LINES}) logs.push(a.map(fmt).join(' ').slice(0, 2000)); } };
  globalThis.console.info = globalThis.console.warn = globalThis.console.error = globalThis.console.log;
})();
`;

export class SandboxError extends Error {}

const friendly = (e) => {
  const m = String(e?.message ?? e);
  if (/timed out/i.test(m)) return 'timed out (possible infinite loop)';
  if (/memory limit|disposed/i.test(m)) return 'ran out of memory';
  return m;
};

const checkSize = (out) => {
  if (typeof out === 'string' && out.length > MAX_RESULT_CHARS) throw new Error('result is too large');
  return out;
};

export class Sandbox {
  #iso = null;

  #isolate() {
    if (!this.#iso || this.#iso.isDisposed) this.#iso = new (loadIvm().Isolate)({ memoryLimit: MEMORY_MB });
    return this.#iso;
  }

  /** Creates a context pre-loaded with `data` (a JSON-serialisable object of globals). */
  context(data) {
    return loadIvm() ? this.#strongContext(data) : this.#basicContext(data);
  }

  #strongContext(data) {
    const iso = this.#isolate();
    const ctx = iso.createContextSync();
    try {
      ctx.global.setSync('__raw', JSON.stringify(data));
      iso.compileScriptSync(BOOTSTRAP).runSync(ctx, { timeout: 1000 }); // trusted, bounded setup code
    } catch (e) {
      ctx.release();
      throw new SandboxError(friendly(e));
    }
    return {
      /** Runs untrusted source that evaluates to a string, off the event loop. Resolves to that string. */
      run: async (source, timeoutMs) => {
        try {
          return checkSize(await iso.compileScriptSync(source).run(ctx, { timeout: timeoutMs }));
        } catch (e) {
          throw new SandboxError(friendly(e));
        }
      },
      release: () => { try { ctx.release(); } catch { /* isolate already gone */ } },
    };
  }

  #basicContext(data) {
    warnBasic();
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    try {
      ctx.__raw = JSON.stringify(data);
      vm.runInContext(BOOTSTRAP, ctx, { timeout: 1000 });
    } catch (e) {
      throw new SandboxError(friendly(e));
    }
    return {
      run: async (source, timeoutMs) => {
        try {
          return checkSize(new vm.Script(source).runInContext(ctx, { timeout: timeoutMs }));
        } catch (e) {
          throw new SandboxError(friendly(e));
        }
      },
      release: () => {},
    };
  }

  dispose() {
    if (this.#iso && !this.#iso.isDisposed) this.#iso.dispose();
    this.#iso = null;
  }
}
