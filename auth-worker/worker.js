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
 *   OPTIONS *                     → CORS preflight
 *   POST   /token                 → { code, code_verifier } → { access_token }
 *   POST   /tunnel                → { cluster, tunnelId, token } → Tunnel JSON
 *                                   (endpoints[0].clientRelayUri rewritten to
 *                                   this worker's /relay proxy)
 *   GET    /relay/<cluster>/<id>  → WebSocket proxy to the dev-tunnels relay
 *                                   (server-side auth; bridges the SSH stream,
 *                                   which stays end-to-end encrypted)
 *
 * Secrets (env): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_ORIGIN
 *   In PAT-only mode only ALLOWED_ORIGIN matters (/token is unused).
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // ---- /relay/<cluster>/<tunnelId> : WebSocket proxy -----------------------
    //   Browser <-> worker <-> dev-tunnels relay. The worker opens the relay WS
    //   SERVER-SIDE (Authorization header, no browser Origin), which a browser
    //   cannot do, then bridges bytes. The SSH session is end-to-end encrypted
    //   between the browser and the codespace, so the worker sees only
    //   ciphertext. This sidesteps both a possible origin restriction and the
    //   browser's inability to send auth headers on a WebSocket.
    if (url.pathname.startsWith("/relay/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.ALLOWED_ORIGIN) {
        return new Response("forbidden origin", { status: 403 });
      }
      const parts = url.pathname.split("/").filter(Boolean); // [relay, cluster, tunnelId]
      const cluster = parts[1];
      const tunnelId = parts[2];
      if (!cluster || !tunnelId ||
          !/^[a-z0-9]{2,12}$/.test(cluster) || !/^[a-z0-9-]{3,60}$/.test(tunnelId)) {
        return new Response("bad relay path", { status: 400 });
      }

      // The SDK's browser path appends the tunnel connect token as an extra
      // subprotocol; pull it out here and use it as the upstream header auth.
      const KNOWN = new Set(["tunnel-relay-client-v2-dev", "tunnel-relay-client"]);
      const offered = (request.headers.get("Sec-WebSocket-Protocol") || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const token = offered.find((p) => !KNOWN.has(p));
      const knownOffered = offered.filter((p) => KNOWN.has(p)).join(", ") ||
        "tunnel-relay-client-v2-dev, tunnel-relay-client";
      if (!token) {
        return new Response("missing token subprotocol", { status: 401 });
      }

      const upstreamUrl =
        `https://${cluster}-data.rel.tunnels.api.visualstudio.com/api/v1/Client/Connect/${tunnelId}`;
      let upstreamResp;
      try {
        upstreamResp = await fetch(upstreamUrl, {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Protocol": knownOffered,
            Authorization: `tunnel ${token}`,
          },
        });
      } catch (e) {
        return new Response(`upstream connect error: ${e.message}`, { status: 502 });
      }
      const upstream = upstreamResp.webSocket;
      if (!upstream) {
        return new Response(`upstream did not upgrade (status ${upstreamResp.status})`, { status: 502 });
      }
      upstream.accept();

      const pair = new WebSocketPair();
      const clientSide = pair[0];
      const serverSide = pair[1];
      serverSide.accept();

      // Only 1000 and 3000-4999 are valid close codes to send; sanitize.
      const safeCode = (c) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
      const closeSafely = (ws, c, r) => { try { ws.close(safeCode(c), r ? String(r).slice(0, 120) : undefined); } catch { /* already closed */ } };

      // Keep the Worker invocation (and thus the outbound relay WebSocket)
      // alive until either side closes. Without this, a plain Worker tears the
      // upstream WebSocket down shortly after fetch() returns, which showed up
      // as the tunnel session dropping every ~10s and reconnecting.
      let resolveDone;
      const done = new Promise((res) => { resolveDone = res; });
      const finish = () => { try { resolveDone(); } catch { /* already */ } };

      serverSide.addEventListener("message", (e) => { try { upstream.send(e.data); } catch { /* dropped */ } });
      upstream.addEventListener("message", (e) => { try { serverSide.send(e.data); } catch { /* dropped */ } });
      serverSide.addEventListener("close", (e) => { closeSafely(upstream, e.code, e.reason); finish(); });
      upstream.addEventListener("close", (e) => { closeSafely(serverSide, e.code, e.reason); finish(); });
      serverSide.addEventListener("error", () => { closeSafely(upstream, 1011); finish(); });
      upstream.addEventListener("error", () => { closeSafely(serverSide, 1011); finish(); });
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(done);

      const negotiated = upstreamResp.headers.get("Sec-WebSocket-Protocol") || "tunnel-relay-client-v2-dev";
      return new Response(null, {
        status: 101,
        webSocket: clientSide,
        headers: { "Sec-WebSocket-Protocol": negotiated },
      });
    }

    // ---- /tunnel : proxy the tunnels management GET (CORS-locked to --------
    //      vscode.dev) so the browser can obtain endpoints (clientRelayUri,
    //      hostPublicKeys) for TunnelRelayTunnelClient.connect().
    if (request.method === "POST" && url.pathname === "/tunnel") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.ALLOWED_ORIGIN) {
        return json({ error: "forbidden_origin" }, 403, env);
      }
      let p;
      try {
        p = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400, env);
      }
      const { cluster, tunnelId, token } = p || {};
      // cluster ids are short lowercase (e.g. euw); tunnelId is [a-z0-9-].
      if (!cluster || !tunnelId || !token ||
          !/^[a-z0-9]{2,12}$/.test(cluster) || !/^[a-z0-9-]{3,60}$/.test(tunnelId)) {
        return json({ error: "invalid_tunnel_params" }, 400, env);
      }
      const upstream =
        `https://${cluster}.rel.tunnels.api.visualstudio.com/tunnels/${tunnelId}` +
        `?api-version=2023-09-27-preview&includePorts=true`;
      const r = await fetch(upstream, {
        headers: { Authorization: `tunnel ${token}`, Accept: "application/json" },
      });
      let body = await r.text();
      // Rewrite the relay endpoint to our WS proxy so the browser connects here
      // (server-side auth, no origin) instead of directly to the relay.
      if (r.ok) {
        try {
          const obj = JSON.parse(body);
          if (obj && Array.isArray(obj.endpoints) && obj.endpoints[0]) {
            obj.endpoints[0].clientRelayUri = `wss://${url.host}/relay/${cluster}/${tunnelId}`;
          }
          body = JSON.stringify(obj);
        } catch { /* pass through unmodified on parse failure */ }
      }
      // Pass the (rewritten) tunnels service response through with CORS headers.
      return new Response(body, {
        status: r.status,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
    }

    // Create (forward) a tunnel port via the management API — CORS-locked, so
    // proxied here. Mirrors gh's ForwardPort → CreateTunnelPort (PUT .../ports/N).
    if (request.method === "POST" && url.pathname === "/port") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.ALLOWED_ORIGIN) {
        return json({ error: "forbidden_origin" }, 403, env);
      }
      let p;
      try { p = await request.json(); } catch { return json({ error: "invalid_json" }, 400, env); }
      const { cluster, tunnelId, port, token } = p || {};
      if (!cluster || !tunnelId || !token || !Number.isInteger(port) ||
          !/^[a-z0-9]{2,12}$/.test(cluster) || !/^[a-z0-9-]{3,60}$/.test(tunnelId) ||
          port < 1 || port > 65535) {
        return json({ error: "invalid_port_params" }, 400, env);
      }
      const upstream =
        `https://${cluster}.rel.tunnels.api.visualstudio.com/tunnels/${tunnelId}/ports/${port}` +
        `?api-version=2023-09-27-preview`;
      const r = await fetch(upstream, {
        method: "PUT",
        headers: {
          Authorization: `tunnel ${token}`,
          "If-Not-Match": "*",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ portNumber: port, protocol: "http" }),
      });
      const body = await r.text();
      return new Response(JSON.stringify({ status: r.status, body: body.slice(0, 400) }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
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
