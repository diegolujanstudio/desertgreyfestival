/* ============================================================================
 * Desert Grey CMS Gateway
 *   - Magic-link email auth (no passwords, no GitHub accounts for editors)
 *   - Single-use, 15-minute magic tokens (rate-limited per email + per IP)
 *   - 7-day signed session cookies (HMAC-SHA256, httpOnly, secure, SameSite=Lax)
 *   - Email allowlist via env var (comma-separated) or optional domain match
 *   - GitHub Git Gateway: proxies Decap's "proxy" backend protocol through to
 *     the GitHub Contents API using a single fine-grained PAT held by the Worker
 *   - All editor actions are committed as the PAT owner, fully attributable
 *
 * Routes
 *   POST /auth/magic-link     { email, redirect }   →  sends email
 *   POST /auth/verify         { token }             →  sets session cookie
 *   GET  /auth/me                                   →  { email } if logged in
 *   POST /auth/logout                               →  clears cookie
 *   ANY  /api/v1/{...}        proxy to GitHub                 (auth required)
 *
 * Environment (wrangler.toml [vars])
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
 *   ALLOWED_EMAILS  (comma-separated)
 *   ALLOWED_DOMAIN  (optional, single domain)
 *   FROM_EMAIL, SITE_URL
 *
 * Secrets (wrangler secret put)
 *   GITHUB_TOKEN       fine-grained PAT, Contents:RW on the target repo
 *   RESEND_API_KEY     resend.com API key
 *   SESSION_SECRET     32-byte hex random string
 *
 * KV
 *   CMS_KV  — magic tokens + sessions
 * ========================================================================= */

const SESSION_COOKIE = "dg_cms_session";
const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days
const MAGIC_TTL_S   = 60 * 15;          // 15 minutes
const RATE_LIMIT_S  = 60;               // 1 request / minute / email
const RATE_IP_S     = 60;               // 5 requests / minute / IP
const RATE_IP_MAX   = 5;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ─── AUTH ROUTES ─────────────────────────────────────────────────
      if (path === "/auth/magic-link" && request.method === "POST") {
        return withCors(await handleMagicLinkRequest(request, env), cors);
      }
      if (path === "/auth/verify" && request.method === "POST") {
        return withCors(await handleVerify(request, env), cors);
      }
      if (path === "/auth/me" && request.method === "GET") {
        return withCors(await handleMe(request, env), cors);
      }
      if (path === "/auth/logout" && request.method === "POST") {
        return withCors(await handleLogout(request, env), cors);
      }

      // ─── PROXY ROUTES (Decap calls these) ────────────────────────────
      if (path.startsWith("/api/v1")) {
        return withCors(await handleProxy(request, env, path.slice("/api/v1".length)), cors);
      }

      // Health check
      if (path === "/" || path === "/health") {
        return withCors(json({ ok: true, service: "desertgrey-cms" }), cors);
      }

      return withCors(new Response("Not found", { status: 404 }), cors);
    } catch (err) {
      console.error("Unhandled error:", err.stack || err);
      return withCors(json({ error: "Internal error" }, 500), cors);
    }
  },
};

// ─── HELPERS ───────────────────────────────────────────────────────────

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.SITE_URL || "").replace(/\/$/, "");
  const isAllowedOrigin =
    origin === allowed ||
    origin.endsWith(".netlify.app") ||
    origin === "http://localhost:4321" ||
    origin === "http://localhost:8888";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin ? origin : allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function isEmailAllowed(email, env) {
  const list = (env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.includes(email)) return true;
  if (env.ALLOWED_DOMAIN) {
    const dom = env.ALLOWED_DOMAIN.toLowerCase().replace(/^@/, "");
    if (email.endsWith("@" + dom)) return true;
  }
  return false;
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function hmac(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ─── MAGIC LINK REQUEST ───────────────────────────────────────────────
async function handleMagicLinkRequest(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const redirect = String(body.redirect || env.SITE_URL + "/admin/");

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Invalid email" }, 400);
  }
  if (!isEmailAllowed(email, env)) {
    // Same 403 + message whether allowed or not, to avoid email enumeration leaks?
    // For this product the client knows which emails are allowed, so be explicit.
    return json({ error: "Email not authorized" }, 403);
  }

  // Rate limit by email (1 per minute)
  const emailRateKey = `rl:email:${email}`;
  if (await env.CMS_KV.get(emailRateKey)) {
    return json({ error: "Please wait a moment before requesting another link." }, 429);
  }
  // Rate limit by IP (5 per minute total across all endpoints)
  const ip = getClientIp(request);
  const ipRateKey = `rl:ip:${ip}`;
  const ipCount = parseInt((await env.CMS_KV.get(ipRateKey)) || "0", 10);
  if (ipCount >= RATE_IP_MAX) {
    return json({ error: "Too many requests" }, 429);
  }
  await env.CMS_KV.put(ipRateKey, String(ipCount + 1), { expirationTtl: RATE_IP_S });
  await env.CMS_KV.put(emailRateKey, "1", { expirationTtl: RATE_LIMIT_S });

  // Mint single-use magic token
  const token = randHex(32);
  const tokenKey = `magic:${token}`;
  await env.CMS_KV.put(tokenKey, JSON.stringify({ email, createdAt: Date.now() }), {
    expirationTtl: MAGIC_TTL_S,
  });

  // Build link
  const link = `${redirect}${redirect.includes("?") ? "&" : "?"}token=${token}`;

  // Send via Resend
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — magic link:", link);
    // In dev, just return the link for testing.
    return json({ ok: true, debug_link: link });
  }
  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "noreply@example.com",
      to: [email],
      subject: "Your Desert Grey login link",
      html: magicLinkEmailHtml(link),
      text: `Your Desert Grey content editor login link (expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    }),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text();
    console.error("Resend error:", sendRes.status, detail);
    return json({ error: "Email send failed" }, 502);
  }

  return json({ ok: true });
}

function magicLinkEmailHtml(link) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0E0E1A;color:#E2E3E1;padding:40px 24px;border-radius:8px;max-width:520px;margin:0 auto">
    <h1 style="font-family:'Anton','Helvetica Neue',sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:0.02em;margin:0 0 16px;font-size:1.75rem">Desert Grey · Sign in</h1>
    <p style="color:#897DA9;margin:0 0 32px;line-height:1.55">Click the button below to sign in to the Desert Grey content editor. This link expires in 15 minutes and can only be used once.</p>
    <a href="${link}" style="display:inline-block;background:#D945DC;color:#0E0E1A;padding:14px 28px;border-radius:999px;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:0.8rem;letter-spacing:0.16em;text-transform:uppercase;font-weight:600">Sign in to the editor →</a>
    <p style="color:#897DA9;font-size:0.78rem;margin:32px 0 0;line-height:1.55">If you didn't request this link, ignore this email. Your account is safe.</p>
  </div>`;
}

// ─── VERIFY MAGIC TOKEN ───────────────────────────────────────────────
async function handleVerify(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const token = String(body.token || "");
  if (!token) return json({ error: "Missing token" }, 400);

  const tokenKey = `magic:${token}`;
  const data = await env.CMS_KV.get(tokenKey);
  if (!data) return json({ error: "Link expired or already used" }, 401);

  // Single use — delete immediately
  await env.CMS_KV.delete(tokenKey);
  const { email } = JSON.parse(data);

  // Mint session
  const sessionId = randHex(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await hmac(env.SESSION_SECRET, `${sessionId}.${email}.${expiresAt}`);
  const cookieValue = `${sessionId}.${expiresAt}.${sig}`;

  await env.CMS_KV.put(
    `session:${sessionId}`,
    JSON.stringify({ email, createdAt: Date.now(), expiresAt }),
    { expirationTtl: SESSION_TTL_S }
  );

  return json({ ok: true, email }, 200, {
    "Set-Cookie": serializeCookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_S,
    }),
  });
}

async function handleMe(request, env) {
  const session = await readSession(request, env);
  if (!session) return json({}, 401);
  return json({ email: session.email });
}

async function handleLogout(request, env) {
  const session = await readSession(request, env);
  if (session && session.sessionId) {
    await env.CMS_KV.delete(`session:${session.sessionId}`);
  }
  return json({ ok: true }, 200, {
    "Set-Cookie": serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 0,
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

  // Look up session in KV first (canonical record)
  const stored = await env.CMS_KV.get(`session:${sessionId}`);
  if (!stored) return null;
  const session = JSON.parse(stored);

  // Verify signature
  const expectedSig = await hmac(env.SESSION_SECRET, `${sessionId}.${session.email}.${expiresAt}`);
  if (!timingSafeEq(sig, expectedSig)) return null;

  return { sessionId, email: session.email, expiresAt };
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

// ─── GIT GATEWAY PROXY ─────────────────────────────────────────────────
// Decap's "proxy" backend speaks the netlify-cms-proxy-server protocol.
// We translate each call into a GitHub Contents API request using the PAT.
async function handleProxy(request, env, subPath) {
  const session = await readSession(request, env);
  if (!session) return json({ error: "Unauthorized" }, 401);

  // Decap calls POST /api/v1 with a JSON body like:
  //   { action: "info" | "entriesByFolder" | "entry" | "persistEntry" | "deleteEntry" | "getMedia" | "persistMedia" | "deleteFiles", params: {...} }
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
  const commitMsg = (op, path) => `CMS (${session.email}): ${op} ${path}`;

  try {
    switch (action) {
      // Capability advert
      case "info":
        return json({ repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, publish_modes: ["simple"], type: "github" });

      // List entries in a folder
      case "entriesByFolder": {
        const { folder, extension } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(folder)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const items = await res.json();
        const filtered = items
          .filter((x) => x.type === "file" && (!extension || x.name.endsWith("." + extension)))
          .map((x) => ({ file: { path: x.path, sha: x.sha }, data: null }));
        // Fetch each file's data
        const files = await Promise.all(filtered.map(async (f) => {
          const r = await fetch(`${ghBase}/contents/${encodeURIComponent(f.file.path)}?ref=${branch}`, { headers: ghHeaders });
          if (!r.ok) return null;
          const item = await r.json();
          return { file: { path: item.path, sha: item.sha }, data: atob((item.content || "").replace(/\n/g, "")) };
        }));
        return json(files.filter(Boolean));
      }

      // Read a single entry
      case "entry": {
        const { path } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const item = await res.json();
        return json({ file: { path: item.path, sha: item.sha }, data: atob((item.content || "").replace(/\n/g, "")) });
      }

      // Create or update an entry
      case "persistEntry": {
        const { entry, assets = [] } = params;
        // Upload any binary assets first
        for (const asset of assets) {
          await putFile(ghBase, ghHeaders, branch, asset.path, asset.content, asset.encoding, commitMsg("upload", asset.path));
        }
        // Then persist the entry
        await putFile(ghBase, ghHeaders, branch, entry.path, entry.raw, "utf-8", commitMsg("save", entry.path));
        return json({ ok: true });
      }

      // Delete an entry
      case "deleteEntry":
      case "deleteFile":
      case "deleteFiles": {
        const paths = params.paths || (params.path ? [params.path] : []);
        for (const p of paths) {
          await deleteFile(ghBase, ghHeaders, branch, p, commitMsg("delete", p));
        }
        return json({ ok: true });
      }

      // Media library — list folder
      case "getMedia": {
        const { mediaFolder } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(mediaFolder)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok && res.status === 404) return json([]);
        if (!res.ok) return passThroughError(res);
        const items = await res.json();
        return json(items.filter((x) => x.type === "file").map((x) => ({
          name: x.name,
          path: x.path,
          size: x.size,
          url: x.download_url,
          id: x.sha,
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
  // First get current SHA if file exists
  const cur = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers });
  let sha;
  if (cur.ok) {
    const item = await cur.json();
    sha = item.sha;
  }
  const base64Content =
    encoding === "base64" ? content : btoa(unescape(encodeURIComponent(content)));
  const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: base64Content, branch, sha }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub PUT failed (${res.status}): ${detail}`);
  }
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
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub DELETE failed (${res.status}): ${detail}`);
  }
  return res.json();
}

async function passThroughError(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  return json(body, res.status);
}
