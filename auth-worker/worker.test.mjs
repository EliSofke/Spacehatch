/**
 * Tests for the auth worker. Mocks GitHub's token endpoint (global fetch) and
 * exercises the worker's own logic — no network, no real credentials.
 * Run: node auth-worker/worker.test.mjs
 */
import worker from "./worker.js";

const env = {
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "secret",
  ALLOWED_ORIGIN: "https://elisofke.github.io",
};

let passed = 0;
function ok(cond, name) {
  if (!cond) throw new Error(`FAIL ${name}`);
  console.log(`PASS ${name}`);
  passed++;
}

function req(method, path, { body, origin } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function mockGitHub(response) {
  globalThis.fetch = async () => ({
    json: async () => response,
  });
}

async function main() {
  // 1. CORS preflight
  let res = await worker.fetch(req("OPTIONS", "/token", { origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 204, "OPTIONS preflight → 204");
  ok(
    res.headers.get("Access-Control-Allow-Origin") === env.ALLOWED_ORIGIN,
    "preflight echoes the allowed origin",
  );

  // 2. Origin guard
  res = await worker.fetch(
    req("POST", "/token", { body: { code: "c", code_verifier: "v" }, origin: "https://evil.example" }),
    env,
  );
  ok(res.status === 403, "foreign origin → 403");

  // 3. Missing input
  res = await worker.fetch(req("POST", "/token", { body: {}, origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 400, "missing code/verifier → 400");

  // 4. Successful exchange
  mockGitHub({ access_token: "gho_test123", scope: "codespace,repo" });
  res = await worker.fetch(
    req("POST", "/token", { body: { code: "c", code_verifier: "v" }, origin: env.ALLOWED_ORIGIN }),
    env,
  );
  let data = await res.json();
  ok(res.status === 200 && data.access_token === "gho_test123", "valid exchange → token");
  ok(data.scope === "codespace,repo", "scope passed through");
  ok(!("client_secret" in data), "secret never leaks in the response");

  // 5. Upstream error passthrough
  mockGitHub({ error: "bad_verification_code", error_description: "expired" });
  res = await worker.fetch(
    req("POST", "/token", { body: { code: "c", code_verifier: "v" }, origin: env.ALLOWED_ORIGIN }),
    env,
  );
  data = await res.json();
  ok(res.status === 502 && data.detail === "expired", "upstream error → 502 with detail");

  // 6. Wrong path
  res = await worker.fetch(req("POST", "/nope", { origin: env.ALLOWED_ORIGIN }), env);
  ok(res.status === 404, "unknown path → 404");

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
