/**
 * Spacehatch auth worker — the minimal backend that lets the browser skip
 * manual token entry.
 *
 * Why this exists: GitHub's OAuth token endpoint has no CORS and still
 * requires the client_secret, so a browser cannot complete the code→token
 * exchange itself, even with PKCE. This worker does exactly that one hop and
 * nothing else. It is stateless: no sessions, no storage.
 *
 * Runtime: written as a standard `export default { fetch }` handler, so it
 * runs on Cloudflare Workers as-is and ports trivially to Vercel/Netlify
 * functions or a tiny Node server (see auth-worker/README.md).
 *
 * Endpoints:
 *   OPTIONS *          → CORS preflight
 *   POST   /token      → { code, code_verifier } → { access_token, scope }
 *
 * Secrets (env): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_ORIGIN
 *   ALLOWED_ORIGIN is the exact Pages origin, e.g. https://elisofke.github.io
 */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "POST" || url.pathname !== "/token") {
      return json({ error: "not_found" }, 404, env);
    }

    // Only serve the configured Pages origin — this worker mints access tokens,
    // so it must not be callable from arbitrary sites.
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: "forbidden_origin" }, 403, env);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400, env);
    }
    const { code, code_verifier } = payload || {};
    if (!code || !code_verifier) {
      return json({ error: "missing_code_or_verifier" }, 400, env);
    }

    // The one privileged hop: exchange code → token with the client secret and
    // the PKCE verifier. This is what a browser cannot do (no CORS + secret).
    const ghRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        code_verifier,
      }),
    });

    const data = await ghRes.json().catch(() => ({}));
    if (!data.access_token) {
      return json(
        { error: "exchange_failed", detail: data.error_description || data.error || "unknown" },
        502,
        env,
      );
    }

    // Return only the token and its scope — never the client secret.
    return json({ access_token: data.access_token, scope: data.scope || "" }, 200, env);
  },
};
