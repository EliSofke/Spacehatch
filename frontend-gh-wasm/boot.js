// @ts-check
/**
 * Spacehatch gh-in-WASM bootstrap (host / driver layer).
 *
 * Runs GitHub's UNMODIFIED go-gh library (github.com/cli/go-gh/v2) compiled to
 * GOOS=js GOARCH=wasm, wired to xterm.js. No gh code is patched; all adaptation
 * lives here at the browser boundary:
 *   - argv/env injection (GH_TOKEN, GH_HOST) via the Go runtime,
 *   - stdout/stderr routed to xterm by patching the wasm_exec.js fs shim,
 *   - api.github.com rewritten to the Spacehatch worker proxy (CORS + User-Agent).
 */

/* global Terminal, FitAddon, Go */

const params = new URLSearchParams(location.search);
const PROXY = (params.get("proxy") || "https://spacehatch-auth.eli-sofke.workers.dev").replace(/\/+$/, "");
const AUTORUN_CMD = params.get("cmd");

const realFetch = globalThis.fetch.bind(globalThis);

// ---- terminal --------------------------------------------------------------
const term = new Terminal({ convertEol: true, fontSize: 13, theme: { background: "#0b0e14", foreground: "#c8d3e0" } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(/** @type {HTMLElement} */ (document.getElementById("term")));
fit.fit();
addEventListener("resize", () => fit.fit());

const dec = new TextDecoder();
/** @type {string} */ (globalThis.__ghOut = "");

/** @param {number} fd @param {Uint8Array} bytes */
function toTerm(fd, bytes) {
  const s = dec.decode(bytes, { stream: true });
  globalThis.__ghOut += s;
  term.write(fd === 2 ? "\x1b[31m" + s + "\x1b[0m" : s);
}

// ---- patch the wasm_exec.js fs shim so fd 1/2 reach xterm ------------------
const fs = /** @type {any} */ (globalThis).fs;
const origWriteSync = fs.writeSync ? fs.writeSync.bind(fs) : null;
const origWrite = fs.write ? fs.write.bind(fs) : null;
fs.writeSync = (/** @type {number} */ fd, /** @type {Uint8Array} */ buf) => {
  if (fd === 1 || fd === 2) { toTerm(fd, buf); return buf.length; }
  return origWriteSync ? origWriteSync(fd, buf) : buf.length;
};
fs.write = (/** @type {number} */ fd, /** @type {Uint8Array} */ buf, offset, length, position, callback) => {
  if (fd === 1 || fd === 2) { toTerm(fd, buf.subarray(offset, offset + length)); callback(null, length); return; }
  if (origWrite) return origWrite(fd, buf, offset, length, position, callback);
  callback(null, length);
};

// ---- redirect api.github.com to the worker proxy ---------------------------
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const PREFIX = "https://api.github.com/";
  if (url.startsWith(PREFIX)) {
    const rewritten = PROXY + "/gh-api/" + url.slice(PREFIX.length);
    return realFetch(rewritten, typeof input === "string" ? init : new Request(rewritten, /** @type {Request} */ (input)));
  }
  return realFetch(input, init);
};

// ---- run one `gh <args>` invocation ----------------------------------------
let busy = false;
/** @param {string} token @param {string[]} argv */
async function runGh(token, argv) {
  if (busy) return;
  busy = true;
  globalThis.__ghOut = "";
  globalThis.__ghDone = false;
  globalThis.__ghExit = undefined;
  term.writeln("\x1b[90m$ gh " + argv.join(" ") + "\x1b[0m");
  try {
    const go = new Go();
    go.argv = ["gh", ...argv];
    go.env = { GH_TOKEN: token, GITHUB_TOKEN: token, GH_HOST: "github.com", HOME: "/", PWD: "/" };
    go.exit = (code) => { globalThis.__ghExit = code; };
    const bytes = await realFetch("./gh.wasm").then((r) => r.arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    await go.run(instance);
    if (globalThis.__ghExit === undefined) globalThis.__ghExit = 0;
  } catch (e) {
    term.writeln("\x1b[31mboot error: " + (e && e.message ? e.message : e) + "\x1b[0m");
    globalThis.__ghExit = 255;
  } finally {
    term.writeln("\x1b[90m[exit " + globalThis.__ghExit + "]\x1b[0m");
    globalThis.__ghDone = true;
    busy = false;
  }
}

function tokenFromUi() {
  const h = new URLSearchParams(location.hash.slice(1));
  return h.get("token") || /** @type {HTMLInputElement} */ (document.getElementById("token")).value.trim();
}
function cmdFromUi() {
  return /** @type {HTMLInputElement} */ (document.getElementById("cmd")).value.trim().split(/\s+/).filter(Boolean);
}

document.getElementById("run").addEventListener("click", () => runGh(tokenFromUi(), cmdFromUi()));

// autorun for headless E2E: ?cmd=api+user#token=...
if (AUTORUN_CMD) {
  const argv = AUTORUN_CMD.trim().split(/\s+/).filter(Boolean);
  runGh(tokenFromUi(), argv);
}
