/* ============================================================================
 * Desert Grey CMS Gateway — username/password edition
 *   - Single admin user with username + password (PBKDF2-SHA256 hashed)
 *   - Signed session cookies (HMAC-SHA256, httpOnly, secure, SameSite=Lax)
 *   - Rate-limited login (5 attempts / min / IP)
 *   - GitHub Git Gateway: proxies Decap's "proxy" backend protocol through
 *     to the GitHub Contents API using a single fine-grained PAT
 *
 * Routes
 *   POST /auth/login    { username, password }    →  sets session cookie
 *   GET  /auth/me                                  →  { username } if logged in
 *   POST /auth/logout                              →  clears cookie
 *   POST /api/v1                                   →  Decap proxy (auth required)
 *
 * Environment (wrangler.toml [vars])
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
 *   ADMIN_USERNAME    (the only allowed username, e.g. "admin")
 *   SITE_URL          (your Netlify URL — used for CORS allowlist)
 *
 * Secrets (wrangler secret put)
 *   GITHUB_TOKEN          GitHub fine-grained PAT (Contents:RW)
 *   ADMIN_PASSWORD_HASH   PBKDF2 hash of admin password
 *                         Format: "pbkdf2$iter$saltHex$hashHex"
 *                         Generate with: see DEPLOYMENT.md
 *   SESSION_SECRET        32-byte hex random string for signing cookies
 *
 * KV
 *   CMS_KV  — session storage + rate limiting
 * ========================================================================= */

const SESSION_COOKIE = "dg_cms_session";
const SESSION_TTL_S  = 60 * 60 * 24 * 7;  // 7 days
const RATE_IP_S      = 60;
const RATE_IP_MAX    = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (path === "/auth/login"  && request.method === "POST") return withCors(await handleLogin(request, env), cors);
      if (path === "/auth/me"     && request.method === "GET")  return withCors(await handleMe(request, env), cors);
      if (path === "/auth/logout" && request.method === "POST") return withCors(await handleLogout(request, env), cors);
      if (path.startsWith("/api/v1"))                            return withCors(await handleProxy(request, env), cors);
      if (path === "/" || path === "/health") return withCors(json({ ok: true, service: "desertgrey-cms" }), cors);
      return withCors(new Response("Not found", { status: 404 }), cors);
    } catch (err) {
      console.error("Unhandled error:", err.stack || err);
      return withCors(json({ error: "Internal error" }, 500), cors);
    }
  },
};

// ─── CORS / helpers ─────────────────────────────────────────────────
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.SITE_URL || "").replace(/\/$/, "");
  const isAllowed =
    origin === allowed ||
    origin.endsWith(".netlify.app") ||
    origin === "http://localhost:4321" ||
    origin === "http://localhost:8888";
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}
function withCors(response, headers) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
function getClientIp(request) { return request.headers.get("CF-Connecting-IP") || "unknown"; }
function randHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b) {
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return bytesToHex(sig);
}

// PBKDF2 password verification
//   stored format: "pbkdf2$<iterations>$<saltHex>$<hashHex>"
async function verifyPbkdf2(stored, password) {
  if (!stored || !stored.startsWith("pbkdf2$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const iterations = parseInt(parts[1], 10);
  const saltBytes = hexToBytes(parts[2]);
  const expectedHashHex = parts[3];
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return timingSafeEq(bytesToHex(bits), expectedHashHex);
}

// ─── LOGIN ─────────────────────────────────────────────────────────
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  // Rate limit per IP
  const ip = getClientIp(request);
  const ipRateKey = `rl:ip:${ip}`;
  const ipCount = parseInt((await env.CMS_KV.get(ipRateKey)) || "0", 10);
  if (ipCount >= RATE_IP_MAX) return json({ error: "Too many attempts" }, 429);
  await env.CMS_KV.put(ipRateKey, String(ipCount + 1), { expirationTtl: RATE_IP_S });

  // Compare
  const expectedUser = (env.ADMIN_USERNAME || "admin").trim();
  if (!timingSafeEq(username, expectedUser)) return json({ error: "Invalid credentials" }, 401);
  const ok = await verifyPbkdf2(env.ADMIN_PASSWORD_HASH, password);
  if (!ok) return json({ error: "Invalid credentials" }, 401);

  // Mint session
  const sessionId = randHex(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await hmacHex(env.SESSION_SECRET, `${sessionId}.${username}.${expiresAt}`);
  const cookieValue = `${sessionId}.${expiresAt}.${sig}`;
  await env.CMS_KV.put(`session:${sessionId}`, JSON.stringify({ username, createdAt: Date.now(), expiresAt }), {
    expirationTtl: SESSION_TTL_S,
  });

  return json({ ok: true, username }, 200, {
    "Set-Cookie": serializeCookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_S,
    }),
  });
}

async function handleMe(request, env) {
  const s = await readSession(request, env);
  if (!s) return json({}, 401);
  return json({ username: s.username });
}

async function handleLogout(request, env) {
  const s = await readSession(request, env);
  if (s && s.sessionId) await env.CMS_KV.delete(`session:${s.sessionId}`);
  return json({ ok: true }, 200, {
    "Set-Cookie": serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 0,
    }),
  });
}

async function readSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, expStr, sig] = parts;
  const expiresAt = parseInt(expStr, 10);
  if (!sessionId || !expiresAt || isNaN(expiresAt)) return null;
  if (Math.floor(Date.now() / 1000) > expiresAt) return null;
  const stored = await env.CMS_KV.get(`session:${sessionId}`);
  if (!stored) return null;
  const session = JSON.parse(stored);
  const expectedSig = await hmacHex(env.SESSION_SECRET, `${sessionId}.${session.username}.${expiresAt}`);
  if (!timingSafeEq(sig, expectedSig)) return null;
  return { sessionId, username: session.username, expiresAt };
}

function serializeCookie(name, value, opts = {}) {
  const segs = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) segs.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) segs.push(`Path=${opts.path}`);
  if (opts.httpOnly) segs.push("HttpOnly");
  if (opts.secure) segs.push("Secure");
  if (opts.sameSite) segs.push(`SameSite=${opts.sameSite}`);
  return segs.join("; ");
}

// ─── GIT GATEWAY PROXY ─────────────────────────────────────────────
async function handleProxy(request, env) {
  const session = await readSession(request, env);
  if (!session) return json({ error: "Unauthorized" }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const { action, params } = payload || {};
  if (!action) return json({ error: "Missing action" }, 400);

  const ghBase = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const ghHeaders = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "desertgrey-cms-gateway",
  };
  const branch = env.GITHUB_BRANCH || "main";
  const commitMsg = (op, path) => `CMS (${session.username}): ${op} ${path}`;

  try {
    switch (action) {
      case "info":
        return json({ repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, publish_modes: ["simple"], type: "github" });

      case "entriesByFolder": {
        const { folder, extension } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(folder)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const items = await res.json();
        const filtered = items
          .filter((x) => x.type === "file" && (!extension || x.name.endsWith("." + extension)));
        const files = await Promise.all(filtered.map(async (f) => {
          const r = await fetch(`${ghBase}/contents/${encodeURIComponent(f.path)}?ref=${branch}`, { headers: ghHeaders });
          if (!r.ok) return null;
          const item = await r.json();
          return { file: { path: item.path, sha: item.sha }, data: atob((item.content || "").replace(/\n/g, "")) };
        }));
        return json(files.filter(Boolean));
      }

      case "entry": {
        const { path } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const item = await res.json();
        return json({ file: { path: item.path, sha: item.sha }, data: atob((item.content || "").replace(/\n/g, "")) });
      }

      case "persistEntry": {
        const { entry, assets = [] } = params;
        for (const asset of assets) {
          await putFile(ghBase, ghHeaders, branch, asset.path, asset.content, asset.encoding, commitMsg("upload", asset.path));
        }
        await putFile(ghBase, ghHeaders, branch, entry.path, entry.raw, "utf-8", commitMsg("save", entry.path));
        return json({ ok: true });
      }

      case "deleteEntry":
      case "deleteFile":
      case "deleteFiles": {
        const paths = params.paths || (params.path ? [params.path] : []);
        for (const p of paths) {
          await deleteFile(ghBase, ghHeaders, branch, p, commitMsg("delete", p));
        }
        return json({ ok: true });
      }

      case "getMedia": {
        const { mediaFolder } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(mediaFolder)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok && res.status === 404) return json([]);
        if (!res.ok) return passThroughError(res);
        const items = await res.json();
        return json(items.filter((x) => x.type === "file").map((x) => ({
          name: x.name, path: x.path, size: x.size, url: x.download_url, id: x.sha,
        })));
      }
      case "getMediaFile": {
        const { path } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const item = await res.json();
        return json({ id: item.sha, name: item.name, path: item.path, size: item.size, url: item.download_url });
      }
      case "persistMedia": {
        const { asset } = params;
        await putFile(ghBase, ghHeaders, branch, asset.path, asset.content, asset.encoding, commitMsg("upload", asset.path));
        return json({ name: asset.path.split("/").pop(), path: asset.path, size: asset.content.length });
      }
      case "deleteMedia": {
        const { path } = params;
        await deleteFile(ghBase, ghHeaders, branch, path, commitMsg("delete", path));
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("Proxy error:", err.stack || err);
    return json({ error: err.message || "Proxy error" }, 500);
  }
}

async function putFile(ghBase, headers, branch, path, content, encoding, message) {
  const cur = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers });
  let sha;
  if (cur.ok) { sha = (await cur.json()).sha; }
  const base64Content = encoding === "base64" ? content : btoa(unescape(encodeURIComponent(content)));
  const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: base64Content, branch, sha }),
  });
  if (!res.ok) throw new Error(`GitHub PUT failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function deleteFile(ghBase, headers, branch, path, message) {
  const cur = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers });
  if (!cur.ok) throw new Error(`Cannot read ${path} for delete`);
  const item = await cur.json();
  const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha: item.sha, branch }),
  });
  if (!res.ok) throw new Error(`GitHub DELETE failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function passThroughError(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  return json(body, res.status);
}
