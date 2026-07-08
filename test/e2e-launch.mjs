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
    await sleep(2000);
    const readBuf = () => page.evaluate(() => window.__shellOut || "").catch(() => "");
    const before = await readBuf();
    console.log("READ buffer so far (tail):\n" + before.split("\n").filter(Boolean).slice(-6).join("\n"));
    const readOk = /Welcome to Ubuntu|@|\$|~/.test(before);

    const marker = "SPACEHATCH_MARKER_42";
    const waitMarker = async (label) => {
      for (let i = 0; i < 15; i++) { await sleep(1000); if ((await readBuf()).includes(marker)) { console.log(`  ✓ marker via ${label}`); return true; } }
      return false;
    };
    // Real path: type into the xterm textarea.
    await page.click("#terminal").catch(() => {});
    await page.locator(".xterm-helper-textarea").focus().catch(() => {});
    await page.keyboard.type(PROBE_CMD);
    await page.keyboard.press("Enter");
    let writeOk = await waitMarker("keyboard");
    // Fallback: inject directly over the channel to isolate keyboard vs pipe.
    if (!writeOk) {
      console.log("  (keyboard path no marker — trying direct channel send)");
      await page.evaluate((c) => window.__shellSend && window.__shellSend(c + "\n"), PROBE_CMD);
      writeOk = await waitMarker("channel");
    }
    const after = await readBuf();
    console.log("--- terminal buffer after probe (tail) ---\n" + after.split("\n").filter(Boolean).slice(-14).join("\n"));
    console.log(`\nREAD ok: ${readOk} | WRITE round-trip (${marker}) ok: ${writeOk}`);
    console.log(writeOk ? "\n★ INTERACTIVE SHELL CONFIRMED (read+write)" : "\n△ shell bound but write round-trip not confirmed");
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
