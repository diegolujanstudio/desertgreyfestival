# Quickstart — 30 minutes from zero to live CMS

Everything is built. This is the exact checklist for the moment you're at the keyboard. About 30 min end-to-end.

## What's done (no action needed)

- ✅ Full Astro site, mobile-tuned
- ✅ Every piece of copy + image extracted into `src/data/*.json`
- ✅ All 13 components refactored to read from those JSON files
- ✅ Decap CMS at `/admin` with friendly labels for every section
- ✅ Cloudflare Worker code (magic-link auth + GitHub Git Gateway)
- ✅ `netlify.toml`, `wrangler.toml`, build scripts
- ✅ Two docs: `DEPLOYMENT.md` (full detail) and `CLIENT-CMS-GUIDE.md` (send to Justin)
- ✅ `dist/` is built and zipped at `dist.zip` (5.5 MB)

## What's left for you (30 min)

### 5 min — get code into GitHub

The repo at `github.com/diegolujanstudio/desertgreyfestival` is empty. Push the code from PowerShell:

```powershell
cd "C:\Users\diego\OneDrive - Diego Lujan Studio LLC\Claude\desert-grey-site"
git init
git add .
git commit -m "Initial commit — Desert Grey 2026 site + CMS"
git branch -M main
git remote add origin https://github.com/diegolujanstudio/desertgreyfestival.git
git push -u origin main
```

When git prompts for password, **paste a GitHub PAT** — create one at https://github.com/settings/tokens/new with `repo` scope. (This PAT is just for pushing once. The CMS uses a different PAT, below.)

While you're in GitHub settings, click **Settings → Danger Zone → Change repository visibility → Private**. Client sites should not be public.

### 3 min — create the long-lived PAT for the CMS

At https://github.com/settings/personal-access-tokens/new:
- Name: `desertgrey-cms`
- Expiration: 1 year
- Repository access: Only `diegolujanstudio/desertgreyfestival`
- Permissions → Repository → **Contents: Read and write**
- Generate, **copy the token**, paste somewhere safe.

### 5 min — sign up for Resend

1. https://resend.com → sign up (free, 3k emails/mo)
2. Either: **(a)** verify the domain `desertgreymusicfestival.com` (Resend gives 2 DNS records — paste in Cloudflare or Squarespace later), or **(b)** skip domain and use `onboarding@resend.dev` as the From: address.
3. API Keys → Create API Key → name `desertgrey-cms` → **copy the `re_...` key**.

### 8 min — deploy the Cloudflare Worker

```powershell
cd "C:\Users\diego\OneDrive - Diego Lujan Studio LLC\Claude\desert-grey-site\workers\cms-gateway"
npm install
npx wrangler login
npx wrangler kv namespace create CMS_KV
```

Wrangler will print a KV namespace `id`. **Copy that** into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`).

Edit `wrangler.toml`:
- `ALLOWED_EMAILS` — put your email + Justin's, comma-separated
- `FROM_EMAIL` — match what you verified in Resend (or `onboarding@resend.dev`)
- `SITE_URL` — leave as `https://desertgrey.netlify.app` for now

Set the three secrets:

```powershell
# Use this pre-generated session secret (or generate your own):
echo 58213a778e01e5de10cae644d36f05eab062dc82fe85160a12ddb140684a7756 | npx wrangler secret put SESSION_SECRET

# Paste the GitHub CMS PAT when prompted:
npx wrangler secret put GITHUB_TOKEN

# Paste the Resend API key when prompted:
npx wrangler secret put RESEND_API_KEY
```

Deploy:

```powershell
npx wrangler deploy
```

It'll print a URL like `https://desertgrey-cms.YOUR-SUBDOMAIN.workers.dev`. **Copy that URL.**

### 5 min — connect Netlify to GitHub + set env var

Open `https://app.netlify.com/projects/desertgrey` (already open in your DLS Chrome).

1. **Project configuration → Build & deploy → Continuous deployment → Link a repository** → GitHub → `diegolujanstudio/desertgreyfestival`. Netlify will read `netlify.toml` and auto-fill build settings.

2. **Project configuration → Environment variables → Add a single variable**:
   - Key: `CMS_WORKER_URL`
   - Value: the Worker URL from the step above (no trailing slash)

3. **Deploys → Trigger deploy → Clear cache and deploy site**.

Wait ~30 seconds. The new site (with CMS) goes live at `https://desertgrey.netlify.app`.

### 4 min — smoke test the CMS

1. Open `https://desertgrey.netlify.app/admin/` in an incognito window
2. Type your email → click "Send login link"
3. Open the email → click the magenta button → you land in the editor
4. Change a band name → click Publish
5. Watch the GitHub repo — a commit appears within seconds
6. Netlify rebuilds automatically — your change is live in 30s

If anything fails, check `DEPLOYMENT.md` for troubleshooting.

---

## Want to just update the design now (skip CMS for the moment)?

Even faster: drag `dist.zip` onto the Netlify Deploys page (already open in your Chrome). New design ships in 10 seconds. The CMS scaffolding rides along but won't be functional until you do the steps above.

---

## Worker URL placeholder

If your Worker URL isn't `https://desertgrey-cms.workers.dev`, also edit `public/admin/index.html` line ~88 to match, then rebuild. (Or just rely on the Netlify build's `CMS_WORKER_URL` env var — `scripts/inject-cms-config.mjs` patches it automatically.)
