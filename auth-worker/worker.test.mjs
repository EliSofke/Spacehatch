/**
 * Tests for the auth worker: the /tunnel + /port management proxies and the
 * /relay early-return guards. Mocks the upstream tunnels API via global fetch —
 * no network, no credentials. Run: node auth-worker/worker.test.mjs
 */
import worker from "./worker.js";

const env = { ALLOWED_ORIGIN: "https://elisofke.github.io" };
const GOOD = { cluster: "euw", tunnelId: "quick-field-77s07pp", token: "tok" };

let passed = 0;
function ok(cond, name) {
  if (!cond) throw new Error(`FAIL ${name}`);
  console.log(`PASS ${name}`);
  passed++;
}
function req(method, path, { body, origin, upgrade, subproto } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(upgrade ? { Upgrade: "websocket" } : {}),
      ...(subproto ? { "Sec-WebSocket-Protocol": subproto } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function mockUpstream({ status = 200, json, text }) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (text !== undefined ? text : JSON.stringify(json)),
    headers: { get: () => null },
  });
}

async function main() {
  // CORS preflight
  let res = await worker.fetch(req("OPTIONS", "/tunnel", { origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 204 && res.headers.get("Access-Control-Allow-Origin") === env.ALLOWED_ORIGIN, "OPTIONS → 204 + CORS");

  // /tunnel guards
  res = await worker.fetch(req("POST", "/tunnel", { body: GOOD, origin: "https://evil.example" }), env);
  ok(res.status === 403, "/tunnel foreign origin → 403");
  res = await worker.fetch(req("POST", "/tunnel", { body: { cluster: "??", tunnelId: "x" }, origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 400, "/tunnel bad params → 400");

  // /tunnel valid → rewrites clientRelayUri to our /relay proxy
  mockUpstream({ json: { endpoints: [{ clientRelayUri: "wss://euw-data.rel.tunnels.api.visualstudio.com/x" }] } });
  res = await worker.fetch(req("POST", "/tunnel", { body: GOOD, origin: env.ALLOWED_ORIGIN }), env);
  const t = await res.json();
  ok(res.status === 200 && t.endpoints[0].clientRelayUri === `wss://worker.example/relay/${GOOD.cluster}/${GOOD.tunnelId}`, "/tunnel rewrites clientRelayUri → /relay");

  // /port guards + happy path
  res = await worker.fetch(req("POST", "/port", { body: { ...GOOD, port: 2222 }, origin: "https://evil.example" }), env);
  ok(res.status === 403, "/port foreign origin → 403");
  res = await worker.fetch(req("POST", "/port", { body: { ...GOOD, port: 0 }, origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 400, "/port bad port → 400");
  mockUpstream({ status: 200, text: '{"portNumber":2222}' });
  res = await worker.fetch(req("POST", "/port", { body: { ...GOOD, port: 2222 }, origin: env.ALLOWED_ORIGIN }), env);
  const p = await res.json();
  ok(res.status === 200 && p.status === 200, "/port create → {status,body}");

  // /relay early guards (no Durable Object needed)
  res = await worker.fetch(req("GET", "/relay/euw/quick-field-77s07pp", { origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 426, "/relay without websocket upgrade → 426");
  res = await worker.fetch(req("GET", "/relay/??/x", { origin: env.ALLOWED_ORIGIN, upgrade: true }), env);
  ok(res.status === 400, "/relay bad path → 400");

  // unknown route
  res = await worker.fetch(req("POST", "/nope", { origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 404, "unknown path → 404");

  console.log(`\n${passed} checks passed`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
