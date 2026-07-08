// End-to-end test for gh-in-WASM.
// Serves frontend-gh-wasm and routes /gh-api/* through the REAL worker code
// (auth-worker/worker.js), then drives the page headless: runs `gh api user`
// (unmodified go-gh -> WASM) and asserts the live GitHub API returned a login.
//   GH_TOKEN=... CHROME_BIN=... node test/gh-wasm-e2e.mjs
import http from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { chromium } from "playwright";

const FE = path.resolve(process.env.FE_DIR || fileURLToPath(new URL("../frontend-gh-wasm", import.meta.url)));
const PAGE = process.env.PAGE || "/index.html";
if (!existsSync(path.join(FE, path.dirname(PAGE), "gh.wasm"))) {
  console.error("gh.wasm not found — build it first: bash gh-wasm-src/build.sh");
  process.exit(1);
}
const worker = (await import("../auth-worker/worker.js")).default;
const PORT = 8123;
const ORIGIN = `http://localhost:${PORT}`;
const TOKEN = process.env.GH_TOKEN || "";
const CMD = process.env.CMD || "api user";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, ORIGIN);
  if (u.pathname.startsWith("/gh-api/")) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(ORIGIN + req.url, { method: req.method, headers });
    const resp = await worker.fetch(request, { ALLOWED_ORIGIN: ORIGIN });
    res.statusCode = resp.status;
    resp.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await resp.arrayBuffer()));
    return;
  }
  const p = u.pathname === "/" ? "/index.html" : u.pathname;
  try {
    const data = await readFile(path.join(FE, p));
    res.setHeader("Content-Type", MIME[path.extname(p)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const target = `${ORIGIN}${PAGE}?cmd=${encodeURIComponent(CMD)}&proxy=${encodeURIComponent(ORIGIN)}#token=${encodeURIComponent(TOKEN)}`;
let ok = false, out = "", exit;
try {
  await page.goto(target, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => globalThis.__ghDone === true, { timeout: 60000 });
  out = await page.evaluate(() => globalThis.__ghOut);
  exit = await page.evaluate(() => globalThis.__ghExit);
  console.log("exit:", exit);
  console.log("output (first 400):", JSON.stringify(out.slice(0, 400)));
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
  ok = exit === 0 && /^\s*[[{]/.test(out); // valid JSON object/array from GitHub
} catch (e) {
  console.log("harness error:", e.message);
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
}
await browser.close();
server.close();
console.log(ok ? "\n✅ E2E PASS: unmodified gh (go-gh) in WASM reached the live GitHub API" : "\n❌ E2E FAIL");
process.exit(ok ? 0 : 1);
