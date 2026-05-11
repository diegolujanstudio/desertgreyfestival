/* ============================================================================
 * Desert Grey CMS Gateway — Netlify Function edition
 *   - Username/password admin auth (single user)
 *   - PBKDF2-SHA256 password verification
 *   - HMAC-SHA256 signed stateless session cookies (no KV needed)
 *   - GitHub Git Gateway: proxies Decap's "proxy" backend → GitHub Contents API
 *
 * Routes (after /.netlify/functions/cms/ prefix)
 *   POST /auth/login    { username, password }   →  sets session cookie
 *   GET  /auth/me                                 →  { username } if logged in
 *   POST /auth/logout                             →  clears cookie
 *   POST /api/v1                                  →  Decap proxy (auth required)
 *
 * Environment variables (set in Netlify project → Environment variables):
 *   ADMIN_USERNAME          (e.g. "admin")
 *   ADMIN_PASSWORD_HASH     ("pbkdf2$iter$saltHex$hashHex")
 *   SESSION_SECRET          (32-byte hex)
 *   GITHUB_TOKEN            (fine-grained PAT, Contents:RW)
 *   GITHUB_OWNER            (e.g. "diegolujanstudio")
 *   GITHUB_REPO             (e.g. "desertgreyfestival")
 *   GITHUB_BRANCH           (e.g. "main")
 *   SITE_URL                (e.g. "https://desertgrey.netlify.app")
 * ========================================================================= */

const crypto = require("node:crypto");

const SESSION_COOKIE = "dg_cms_session";
const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days

exports.handler = async (event) => {
  const env = process.env;
  // Strip netlify functions prefix
  let path = event.path || "/";
  path = path.replace(/^\/\.netlify\/functions\/cms/, "");
  if (path === "" || path === "/") path = "/health";
  const method = event.httpMethod;

  const cors = corsHeaders(event, env);

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  try {
    if (path === "/auth/login"  && method === "POST") return cors_merge(await handleLogin(event, env), cors);
    if (path === "/auth/me"     && method === "GET")  return cors_merge(await handleMe(event, env), cors);
    if (path === "/auth/logout" && method === "POST") return cors_merge(await handleLogout(event, env), cors);
    if (path.startsWith("/api/v1"))                    return cors_merge(await handleProxy(event, env), cors);
    if (path === "/health") return cors_merge(json({ ok: true, service: "desertgrey-cms" }), cors);
    return cors_merge({ statusCode: 404, body: "Not found" }, cors);
  } catch (err) {
    console.error("Unhandled error:", err.stack || err);
    return cors_merge(json({ error: "Internal error" }, 500), cors);
  }
};

function corsHeaders(event, env) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
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
function cors_merge(resp, cors) {
  return { ...resp, headers: { ...(resp.headers || {}), ...cors } };
}
function json(obj, status = 200, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(obj),
  };
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function randHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function verifyPassword(expectedPlain, given) {
  if (!expectedPlain || typeof given !== "string") return false;
  if (expectedPlain.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedPlain), Buffer.from(given));
}

function parseCookies(event) {
  const cookieHeader = (event.headers && (event.headers.cookie || event.headers.Cookie)) || "";
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  });
  return out;
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

// ─── LOGIN ─────────────────────────────────────────────────────────
async function handleLogin(event, env) {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json({ error: "Bad JSON" }, 400); }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const expectedUser = (env.ADMIN_USERNAME || "admin").trim();
  if (!timingSafeEq(username, expectedUser)) return json({ error: "Invalid credentials" }, 401);
  if (!verifyPassword(env.ADMIN_PASSWORD, password)) return json({ error: "Invalid credentials" }, 401);

  const sessionId = randHex(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = hmac(env.SESSION_SECRET, `${sessionId}.${username}.${expiresAt}`);
  const cookieValue = `${sessionId}.${username}.${expiresAt}.${sig}`;

  return json({ ok: true, username }, 200, {
    "Set-Cookie": serializeCookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_S,
    }),
  });
}

function readSession(event, env) {
  const cookies = parseCookies(event);
  const value = cookies[SESSION_COOKIE];
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [sessionId, username, expStr, sig] = parts;
  const expiresAt = parseInt(expStr, 10);
  if (!sessionId || !username || !expiresAt || isNaN(expiresAt)) return null;
  if (Math.floor(Date.now() / 1000) > expiresAt) return null;
  const expectedSig = hmac(env.SESSION_SECRET, `${sessionId}.${username}.${expiresAt}`);
  if (!timingSafeEq(sig, expectedSig)) return null;
  return { sessionId, username, expiresAt };
}

async function handleMe(event, env) {
  const s = readSession(event, env);
  if (!s) return json({}, 401);
  return json({ username: s.username });
}

async function handleLogout(event, env) {
  return json({ ok: true }, 200, {
    "Set-Cookie": serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 0,
    }),
  });
}

// ─── GIT GATEWAY PROXY ─────────────────────────────────────────────
async function handleProxy(event, env) {
  const session = readSession(event, env);
  if (!session) return json({ error: "Unauthorized" }, 401);

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return json({ error: "Bad JSON" }, 400); }
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
  const commitMsg = (op, p) => `CMS (${session.username}): ${op} ${p}`;

  try {
    switch (action) {
      case "info":
        return json({ repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, publish_modes: ["simple"], type: "github" });

      case "allowedActions":
        return json([
          "info", "allowedActions",
          "entriesByFolder", "entriesByFiles", "getEntry", "entry",
          "persistEntry", "deleteEntry", "deleteEntries",
          "getMedia", "getMediaFile", "persistMedia", "deleteMedia",
        ]);

      case "entriesByFolder": {
        const { folder, extension } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(folder)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const items = await res.json();
        const filtered = items.filter((x) => x.type === "file" && (!extension || x.name.endsWith("." + extension)));
        const files = await Promise.all(filtered.map(async (f) => {
          const r = await fetch(`${ghBase}/contents/${encodeURIComponent(f.path)}?ref=${branch}`, { headers: ghHeaders });
          if (!r.ok) return null;
          const item = await r.json();
          return { file: { path: item.path, sha: item.sha }, data: Buffer.from(item.content || "", "base64").toString("utf-8") };
        }));
        return json(files.filter(Boolean));
      }

      case "entriesByFiles": {
        // For files-collections: params.files is an array of { path, label } objects
        const requestedFiles = params.files || [];
        const results = await Promise.all(requestedFiles.map(async (f) => {
          const r = await fetch(`${ghBase}/contents/${encodeURIComponent(f.path)}?ref=${branch}`, { headers: ghHeaders });
          if (!r.ok) return null;
          const item = await r.json();
          return { file: { path: item.path, sha: item.sha, label: f.label }, data: Buffer.from(item.content || "", "base64").toString("utf-8") };
        }));
        return json(results.filter(Boolean));
      }

      case "entry":
      case "getEntry": {
        const { path } = params;
        const res = await fetch(`${ghBase}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers: ghHeaders });
        if (!res.ok) return passThroughError(res);
        const item = await res.json();
        return json({ file: { path: item.path, sha: item.sha }, data: Buffer.from(item.content || "", "base64").toString("utf-8") });
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
      case "deleteEntries":
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
        return json({ name: asset.path.split("/").pop(), path: asset.path, size: (asset.content || "").length });
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
  if (cur.ok) sha = (await cur.json()).sha;
  const base64Content = encoding === "base64" ? content : Buffer.from(content, "utf-8").toString("base64");
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
