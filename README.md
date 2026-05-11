# Desert Grey Music Festival — Website + CMS

Static site for the 2026 Desert Grey Music Festival, plus a self-hosted CMS so the client and his team can edit copy, images, and video without touching code or having GitHub accounts.

## Stack

- **Astro** — static site generator
- **Decap CMS** at `/admin` — friendly editor UI
- **Cloudflare Worker** — magic-link auth + GitHub Git Gateway
- **Resend** — magic-link email delivery
- **Netlify** — hosting + auto-deploy on every push to `main`

## Layout

```
src/
  components/    Astro components (read content from src/data/*.json)
  data/          All editable content lives here as JSON
  layouts/       Page shells
  pages/         Routes
  styles/        Global CSS

public/
  admin/         Decap CMS editor UI (config.yml + index.html)
  uploads/       CMS-uploaded media (images, video)
  *.png / *.ico  Static favicons

workers/cms-gateway/
  src/index.js   CF Worker: magic-link auth + GitHub proxy
  wrangler.toml  Worker config + env vars

scripts/
  inject-cms-config.mjs   Netlify post-build: injects Worker URL into /admin

netlify.toml     Netlify build + headers
```

## Local development

```bash
npm install
npm run dev      # → http://localhost:4321
```

For local-only content edits, edit `src/data/*.json` directly. The CMS at `/admin` needs the Worker live to log in.

## Deploying

See **DEPLOYMENT.md** for the full one-time setup (~30 min, all browser + CLI steps).

For ongoing changes:

```bash
git add -A
git commit -m "your message"
git push origin main
```

Netlify auto-deploys in ~30 seconds.

## Editing content as a client

See **CLIENT-CMS-GUIDE.md** — share that doc directly with Justin and the team.

## Adding a new editor

Open `workers/cms-gateway/wrangler.toml`, add the email to `ALLOWED_EMAILS`, then:

```bash
cd workers/cms-gateway
npx wrangler deploy
```
