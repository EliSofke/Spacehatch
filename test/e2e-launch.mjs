/**
 * Headless end-to-end launch test for Spacehatch (Variant C).
 * Drives the DEPLOYED page in headless Chromium: injects a Codespaces token,
 * clicks Launch, follows the on-page log, and (once a shell binds) types a
 * command and reads it back from the xterm buffer to prove read+write.
 *
 *   CODESPACES_TOKEN=github_pat_… node test/e2e-launch.mjs
 *
 * Optional env: PAGE_URL, OWNER, REPO, PROBE_CMD, MAX_MS, CHROME_BIN.
 */
import { chromium } from "playwright";

const TOKEN = process.env.CODESPACES_TOKEN;
if (!TOKEN) { console.error("set CODESPACES_TOKEN"); process.exit(2); }
const PAGE_URL = process.env.PAGE_URL || "https://elisofke.github.io/Spacehatch/";
const OWNER = process.env.OWNER || "EliSofke";
const REPO = process.env.REPO || "Spacehatch";
const PROBE_CMD = process.env.PROBE_CMD || "whoami; echo SPACEHATCH_MARKER_$((6*7))";
const MAX_MS = parseInt(process.env.MAX_MS || "300000", 10); // 5 min (provisioning)
const CHROME_BIN = process.env.CHROME_BIN || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.launch({
  headless: true,
  executablePath: CHROME_BIN,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await b.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const getLog = () => page.$eval("#log", (e) => e.textContent).catch(() => "");
const getTermText = () => page.evaluate(() => {
  const r = document.querySelector(".xterm-rows");
  return r ? r.innerText : (document.querySelector("#terminal")?.innerText || "");
}).catch(() => "");

try {
  console.log(`→ loading ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 60000 });
  const build = await page.evaluate(() => {
    const m = (document.getElementById("log")?.textContent || "").match(/spacehatch build (\S+ \S+)/);
    return m ? m[1] : "(unknown)";
  });
  console.log(`→ build: ${build}`);

  await page.fill("#token", TOKEN);
  await page.fill("#owner", OWNER).catch(() => {});
  await page.fill("#repo", REPO).catch(() => {});
  console.log(`→ launching ${OWNER}/${REPO} …`);
  await page.click("#btn-launch");

  // Follow the log until a terminal binds, a failure prints, or we time out.
  const start = Date.now();
  let lastLen = 0, outcome = null;
  while (Date.now() - start < MAX_MS) {
    const log = await getLog();
    if (log.length > lastLen) {
      // stream only the new tail, trimming the noisy relay:verbose spam
      const fresh = log.slice(lastLen).split("\n")
        .filter((l) => l.trim() && !/relay:verbose/.test(l))
        .join("\n");
      if (fresh.trim()) process.stdout.write(fresh + "\n");
      lastLen = log.length;
    }
    if (/shell bound to xterm/.test(log)) { outcome = "shell"; break; }
    if (/Launch failed:/.test(log)) { outcome = "fail"; break; }
    await sleep(1500);
  }
  if (!outcome) { console.log("‼ timed out waiting for outcome"); }

  if (outcome === "shell") {
    console.log("\n✓ shell bound — probing read/write …");
    await sleep(2500);
    const readBuf = () => page.evaluate(() => window.__shellOut || "").catch(() => "");
    const before = await readBuf();
    const readOk = /Welcome to Ubuntu|@|\$|~|➜/.test(before);

    const typeCmd = async (cmd) => {
      await page.evaluate(() => { try { window.__term && window.__term.focus(); } catch {} });
      await page.locator(".xterm-screen").click().catch(() => {});
      await page.locator(".xterm-helper-textarea").focus().catch(() => {});
      // insertText fires a single input event (no keydown/keypress), avoiding
      // the double-char dispatch seen with keyboard.type() in headless xterm.
      await page.keyboard.insertText(cmd);
      await page.keyboard.press("Enter");
    };
    const waitFor = async (needle, secs = 15) => {
      for (let i = 0; i < secs; i++) { await sleep(1000); if ((await readBuf()).includes(needle)) return true; }
      return false;
    };

    // 1) Real keyboard path (xterm → term.onData → channel). Also verify the
    // echoed command is NOT doubled (regression guard for double-wiring).
    await typeCmd("echo NODUP_$((40+7))");
    let kbOk = await waitFor("NODUP_47", 12);
    const bufK = await readBuf();
    const doubled = /NNOODDUUPP|eecchhoo|NODUP_4477/.test(bufK);
    if (!kbOk) { // fallback: direct channel inject, to isolate keyboard vs pipe
      await page.evaluate(() => window.__shellSend && window.__shellSend("echo CH_$((3*3))_OK\n"));
      var chOk = await waitFor("CH_9_OK", 12);
    }

    // 2) Stability: hold the session, then run another command after a pause.
    console.log("  holding session 45s to check relay stability (DO) …");
    await sleep(45000);
    const stillConnected = await page.evaluate(() => /connected|live|shell/.test(document.querySelector("#log")?.textContent.slice(-4000) || "") && !/Launch failed|disconnected/.test((document.querySelector(".bezel-title")?.textContent || "")));
    await typeCmd("echo STABLE_$((10+11))");
    const stableOk = await waitFor("STABLE_21", 15) || (await page.evaluate(() => { window.__shellSend && window.__shellSend("echo STABLE2_$((10+11))\n"); }), await waitFor("STABLE2_21", 12));

    const after = await readBuf();
    console.log("--- terminal buffer (tail, control chars stripped) ---\n" +
      after.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").filter((l) => l.trim()).slice(-14).join("\n"));
    console.log(`\nREAD ok: ${readOk} | keyboard write: ${kbOk} | char-doubling: ${doubled} | channel write: ${kbOk ? "n/a" : !!chOk} | STABLE after 45s: ${stableOk}`);
    console.log((readOk && (kbOk || chOk) && stableOk && !doubled) ? "\n★★ FULLY STABLE INTERACTIVE TERMINAL (read+write, no doubling, survives 45s)" : "\n△ partial — see flags above");
  }

  console.log("\n===== FINAL LOG (relay:verbose filtered) =====");
  const finalLog = await getLog();
  console.log(finalLog.split("\n").filter((l) => !/relay:verbose/.test(l)).join("\n"));
  if (pageErrors.length) console.log("\n=== pageerrors ===\n" + pageErrors.join("\n"));
} catch (e) {
  console.error("HARNESS ERROR:", e.message);
} finally {
  await b.close();
}
