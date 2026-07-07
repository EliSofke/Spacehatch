"use strict";
/** Integration test for the terminal bridge (run against a local instance). */
const { WebSocket } = require("ws");

const MAGIC = Buffer.from("\x00CTL", "latin1");
const url = "ws://127.0.0.1:7681/ws?cols=100&rows=30";

function controlFrame(obj) {
  return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(obj))]);
}

async function main() {
  // 1. Origin guard: cross-origin upgrade must be rejected.
  await new Promise((resolve, reject) => {
    const bad = new WebSocket(url, { headers: { origin: "https://evil.example" } });
    bad.on("open", () => reject(new Error("cross-origin upgrade was accepted")));
    bad.on("error", () => resolve());
  });
  console.log("PASS origin guard rejects cross-origin upgrade");

  // 2. Same-origin session: prompt output, echo round-trip, resize.
  const ws = new WebSocket(url, { headers: { origin: "http://127.0.0.1:7681" } });
  let received = "";
  ws.on("message", (data) => (received += data.toString("utf8")));

  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  await new Promise((r) => setTimeout(r, 1200)); // let the shell print a prompt
  if (received.length === 0) throw new Error("no PTY output received");
  console.log("PASS PTY produces output (prompt)");

  ws.send(controlFrame({ type: "resize", cols: 132, rows: 40 }));
  ws.send("stty size; echo MARKER_$((6*7))\n");
  await new Promise((r) => setTimeout(r, 1200));
  if (!received.includes("MARKER_42")) throw new Error("echo round-trip failed");
  console.log("PASS keystroke round-trip (MARKER_42)");
  if (!received.includes("40 132")) throw new Error("resize not applied (stty size)");
  console.log("PASS resize control frame applied (40 132)");

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
