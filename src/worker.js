// Derived from barretlee/cloudflare-proxy (MIT, Copyright 2023 Barret李靖).
const UPSTREAM = "https://api.openai.com";
const encoder = new TextEncoder();
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,256}$/;
const HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
];
const REQUEST_HEADERS = new Set([
  "authorization", "content-type", "content-encoding", "accept", "accept-encoding",
  "user-agent", "openai-organization", "openai-project", "openai-beta",
  "idempotency-key", "x-client-request-id",
]);

function error(status, message) {
  return Response.json({ error: { message, type: "proxy_error" } }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

async function validToken(supplied, expected) {
  if (typeof expected !== "string" || !TOKEN_FORMAT.test(expected) ||
      typeof supplied !== "string" || !TOKEN_FORMAT.test(supplied)) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  // Workers' native constant-time comparison, over equal-sized digests.
  return crypto.subtle.timingSafeEqual(a, b);
}

function methodsFor(path) {
  if (path === "/v1/chat/completions" || path === "/v1/responses") return ["POST"];
  if (path === "/v1/models" || /^\/v1\/models\/[A-Za-z0-9_.:-]+$/.test(path)) return ["GET"];
  if (/^\/v1\/responses\/resp_[A-Za-z0-9_-]+$/.test(path)) return ["GET", "DELETE"];
  if (/^\/v1\/responses\/resp_[A-Za-z0-9_-]+\/input_items$/.test(path)) return ["GET"];
  if (/^\/v1\/responses\/resp_[A-Za-z0-9_-]+\/cancel$/.test(path)) return ["POST"];
  return [];
}

function hopHeaders(headers) {
  return new Set([...HOP_HEADERS,
    ...(headers.get("connection") || "").split(",").map(x => x.trim().toLowerCase()),
  ]);
}

function requestHeaders(source) {
  const headers = new Headers();
  const hop = hopHeaders(source);
  for (const [key, value] of source) {
    if (!hop.has(key) && (REQUEST_HEADERS.has(key) || key.startsWith("x-stainless-"))) {
      headers.set(key, value);
    }
  }
  return headers;
}

function responseHeaders(source) {
  const headers = new Headers(source);
  for (const name of hopHeaders(source)) if (name) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-") ||
        ["set-cookie", "x-proxy-token", "authorization", "proxy-authorization"].includes(name)) {
      headers.delete(name);
    }
  }
  headers.set("Cache-Control", "no-store");
  return headers;
}

// fetchUpstream is injected only by local tests; no request/env value selects it.
export async function handleRequest(request, env, fetchUpstream = fetch) {
  if (!await validToken(request.headers.get("X-Proxy-Token"), env.PROXY_TOKEN)) {
    return error(403, "Proxy access denied");
  }
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(authorization)) {
    return error(401, "A valid Bearer Authorization header is required");
  }
  const url = new URL(request.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") return error(400, "Invalid URL");
  const methods = methodsFor(url.pathname);
  if (methods.length === 0) return error(404, "Unsupported API path");
  if (!methods.includes(request.method)) return error(405, "Unsupported HTTP method");
  if (request.headers.has("upgrade") || hopHeaders(request.headers).has("authorization")) {
    return error(400, "Unsupported transport headers");
  }
  // Assign fields, never resolve a client-controlled URL against the upstream.
  const target = new URL(UPSTREAM);
  target.pathname = url.pathname;
  target.search = url.search;
  try {
    const response = await fetchUpstream(target.href, {
      method: request.method,
      headers: requestHeaders(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: request.signal,
      redirect: "manual",
      // Fetch cache disabled, including model listing and stored responses.
      cache: "no-store",
      duplex: "half",
    });
    // Never redirect a client carrying X-Proxy-Token to another origin.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return error(502, "Upstream redirect refused");
    }
    // Keep the fetch body and encoding header paired; Workers handles passthrough.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
    });
  } catch {
    // Do not disclose exception messages: they can contain URLs or credentials.
    return error(request.signal.aborted ? 499 : 502,
      request.signal.aborted ? "Client request cancelled" : "Upstream connection failed");
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
