/**
 * Spacehatch auth worker — the small serverless piece the browser-only terminal
 * needs. It does the few things a browser can't do itself, and nothing else.
 * Stateless except for the relay Durable Object; no sessions, no user storage.
 *
 * Endpoints:
 *   OPTIONS *                     → CORS preflight
 *   POST   /tunnel                → { cluster, tunnelId, token } → Tunnel JSON
 *                                   (endpoints[0].clientRelayUri rewritten to
 *                                   this worker's /relay proxy). The tunnels
 *                                   management API is CORS-locked to vscode.dev.
 *   POST   /port                  → { cluster, tunnelId, port, token } → creates
 *                                   a tunnel port (PUT .../ports/N), also
 *                                   CORS-locked. Used to expose the sshd port.
 *   GET    /relay/<cluster>/<id>  → WebSocket bridge to the dev-tunnels relay,
 *                                   handled by the RelayProxy Durable Object
 *                                   (server-side header auth, no browser origin).
 *                                   The SSH session stays end-to-end encrypted,
 *                                   so the worker only ever sees ciphertext.
 *
 * Config (env): ALLOWED_ORIGIN — the exact Pages origin
 *   (e.g. https://elisofke.github.io). No secrets required.
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

function ghCorsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type, X-GitHub-Api-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- /gh-api/<path> : GitHub REST API proxy ------------------------------
    //   The browser cannot call api.github.com directly (no CORS) and cannot set
    //   a User-Agent (a forbidden header GitHub requires). The caller supplies
    //   its own bearer token; the worker only relays it and injects User-Agent.
    if (url.pathname.startsWith("/gh-api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: ghCorsHeaders(env) });
      }
      const ghOrigin = request.headers.get("Origin");
      if (ghOrigin && ghOrigin !== env.ALLOWED_ORIGIN) {
        return new Response("forbidden origin", { status: 403 });
      }
      const ghPath = url.pathname.slice("/gh-api/".length);
      const target = "https://api.github.com/" + ghPath + url.search;
      const fwd = new Headers();
      const auth = request.headers.get("Authorization");
      if (auth) fwd.set("Authorization", auth);
      fwd.set("Accept", request.headers.get("Accept") || "application/vnd.github+json");
      fwd.set("User-Agent", "spacehatch-gh-wasm");
      fwd.set("X-GitHub-Api-Version", request.headers.get("X-GitHub-Api-Version") || "2022-11-28");
      const ct = request.headers.get("Content-Type");
      if (ct) fwd.set("Content-Type", ct);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      let upstream;
      try {
        upstream = await fetch(target, {
          method: request.method,
          headers: fwd,
          body: hasBody ? request.body : undefined,
        });
      } catch (e) {
        return new Response("upstream error: " + e.message, { status: 502, headers: ghCorsHeaders(env) });
      }
      const respHeaders = new Headers(ghCorsHeaders(env));
      respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      for (const h of ["X-RateLimit-Remaining", "X-RateLimit-Limit", "Link"]) {
        const v = upstream.headers.get(h);
        if (v) respHeaders.set(h, v);
      }
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

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
      // Hand the WebSocket bridge to a Durable Object (keyed by tunnel). A plain
      // Worker tears the outbound relay WS down shortly after fetch() returns
      // (the ~10s "Error reading from stream" drops); a DO holds it for the
      // whole session.
      const id = env.RELAY.idFromName(tunnelId);
      return env.RELAY.get(id).fetch(request);
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

    return json({ error: "not_found" }, 404, env);
  },
};


// ---- Durable Object: holds the relay WebSocket bridge for the whole session --
export class RelayProxy {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // [relay, cluster, tunnelId]
    const cluster = parts[1];
    const tunnelId = parts[2];

    // The SDK appends the tunnel connect token as an extra WS subprotocol.
    const KNOWN = new Set(["tunnel-relay-client-v2-dev", "tunnel-relay-client"]);
    const offered = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const token = offered.find((p) => !KNOWN.has(p));
    const knownOffered = offered.filter((p) => KNOWN.has(p)).join(", ") ||
      "tunnel-relay-client-v2-dev, tunnel-relay-client";
    if (!token) return new Response("missing token subprotocol", { status: 401 });

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

    const safeCode = (c) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
    const closeSafely = (ws, c, r) => { try { ws.close(safeCode(c), r ? String(r).slice(0, 120) : undefined); } catch { /* already closed */ } };

    serverSide.addEventListener("message", (e) => { try { upstream.send(e.data); } catch { /* dropped */ } });
    upstream.addEventListener("message", (e) => { try { serverSide.send(e.data); } catch { /* dropped */ } });
    serverSide.addEventListener("close", (e) => closeSafely(upstream, e.code, e.reason));
    upstream.addEventListener("close", (e) => closeSafely(serverSide, e.code, e.reason));
    serverSide.addEventListener("error", () => closeSafely(upstream, 1011));
    upstream.addEventListener("error", () => closeSafely(serverSide, 1011));

    // Keep references so the bridge isn't collected while the session is live.
    this._bridge = { serverSide, upstream };

    const negotiated = upstreamResp.headers.get("Sec-WebSocket-Protocol") || "tunnel-relay-client-v2-dev";
    return new Response(null, {
      status: 101,
      webSocket: clientSide,
      headers: { "Sec-WebSocket-Protocol": negotiated },
    });
  }
}
