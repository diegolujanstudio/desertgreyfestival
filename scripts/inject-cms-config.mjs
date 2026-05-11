// Post-build step: injects the Cloudflare Worker URL into /admin/index.html
// so the CMS can authenticate. The worker URL comes from a Netlify env var.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), "dist");
const adminHtml = resolve(distDir, "admin", "index.html");
const adminCfg  = resolve(distDir, "admin", "config.yml");

const workerUrl = (process.env.CMS_WORKER_URL || "").replace(/\/$/, "");
if (!workerUrl) {
  console.warn("⚠️  CMS_WORKER_URL not set — admin login will fail until you deploy the worker and set this env var in Netlify.");
}

// 1. Inject into admin/index.html
if (existsSync(adminHtml)) {
  const html = readFileSync(adminHtml, "utf8");
  const injected = html.replace(
    "window.__CMS_WORKER_URL__ || 'https://desertgrey-cms.workers.dev'",
    `'${workerUrl || "https://desertgrey-cms.workers.dev"}'`
  );
  writeFileSync(adminHtml, injected);
  console.log(`✅ Injected worker URL into /admin/index.html: ${workerUrl || "(default fallback)"}`);
}

// 2. Replace placeholder in admin/config.yml
if (existsSync(adminCfg) && workerUrl) {
  const yml = readFileSync(adminCfg, "utf8");
  const injected = yml.replace("__INJECTED_AT_RUNTIME__", `${workerUrl}/api/v1`);
  writeFileSync(adminCfg, injected);
  console.log(`✅ Injected worker URL into /admin/config.yml`);
}
