# Deployment — Desert Grey CMS

Everything you need to get from "code on your laptop" to "Justin can edit the site from his phone." About 30 minutes end-to-end.

## Accounts you need

You already have:

- ✅ GitHub: `https://github.com/diegolujanstudio`
- ✅ Netlify project: `https://app.netlify.com/projects/desertgrey/overview`
- ✅ Cloudflare account

You need to create:

| Service | Why | Free tier | Link |
|---|---|---|---|
| **Resend** | Sends the magic-link emails | 3,000 emails/mo, 100/day | https://resend.com |

That's it. One new account.

---

## Step 1 — Push the code to GitHub

The repo already exists at `github.com/diegolujanstudio/desertgreyfestival`. From your machine:

```bash
cd "C:\Users\diego\OneDrive - Diego Lujan Studio LLC\Claude\desert-grey-site"
git init
git add .
git commit -m "Initial commit — Desert Grey 2026 site + CMS"
git branch -M main
git remote add origin https://github.com/diegolujanstudio/desertgreyfestival.git
git push -u origin main
```

If git asks for credentials, use a Personal Access Token (next step) as the password.

---

## Step 2 — Create a fine-grained GitHub PAT

This is what the Worker uses to commit edits on behalf of the client.

1. Go to https://github.com/settings/personal-access-tokens/new
2. **Token name:** `desertgrey-cms`
3. **Expiration:** 1 year (set a calendar reminder to rotate)
4. **Repository access:** Only select repositories → `diegolujanstudio/desertgreyfestival`
5. **Permissions → Repository permissions:**
   - **Contents:** Read and write
   - **Metadata:** Read-only (auto-selected)
6. Click **Generate token** → copy it immediately (you can't see it again).

Save it somewhere safe (1Password, Bitwarden, etc.). You'll paste it in Step 5.

---

## Step 3 — Sign up for Resend (email service)

1. Go to https://resend.com → sign up with your email
2. After verification, click **Domains → Add Domain**
3. Add `desertgreymusicfestival.com`
4. Resend gives you 2 DNS records (TXT + MX). You'll add these in Cloudflare in Step 6.
5. Go to **API Keys → Create API Key** → name it `desertgrey-cms`, full access, copy the `re_...` key.

(If you don't want to set up domain verification right now, you can skip the domain and use Resend's free shared-sending domain `onboarding@resend.dev` — set `FROM_EMAIL = "onboarding@resend.dev"` in the Worker config. The "From" address will look generic, but it'll work for the client.)

---

## Step 4 — Create the Cloudflare KV namespace

This stores magic-link tokens and session cookies.

```bash
cd workers/cms-gateway
npm install
npx wrangler login          # opens browser → authorize Wrangler to use your CF account
npx wrangler kv namespace create CMS_KV
```

The output will look like:

```
✨ Success!
[[kv_namespaces]]
binding = "CMS_KV"
id = "1a2b3c4d5e6f..."
```

Copy that `id`. Open `workers/cms-gateway/wrangler.toml` and replace `REPLACE_WITH_KV_ID` with the real ID.

---

## Step 5 — Configure Worker secrets + edit env vars

Still in `workers/cms-gateway/`:

```bash
# generate a random session-signing secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# copy that hex string and paste when wrangler prompts you:
npx wrangler secret put SESSION_SECRET

# paste the GitHub PAT you made in Step 2:
npx wrangler secret put GITHUB_TOKEN

# paste the Resend API key from Step 3:
npx wrangler secret put RESEND_API_KEY
```

Then open `wrangler.toml` and edit:

- `ALLOWED_EMAILS` — comma-separated list of every editor's email. Start with you + Justin, add others as needed.
- `FROM_EMAIL` — match this to your verified Resend sender domain.
- `SITE_URL` — `https://desertgrey.netlify.app` for now; change to `https://desertgreymusicfestival.com` after DNS cutover.

---

## Step 6 — Deploy the Worker

```bash
cd workers/cms-gateway
npx wrangler deploy
```

Output looks like:

```
Deployed desertgrey-cms triggers (X.XXs)
  https://desertgrey-cms.YOUR-CF-SUBDOMAIN.workers.dev
```

**Copy that URL — you need it for Netlify in Step 7.**

---

## Step 7 — Connect Netlify to GitHub + set env vars

1. Go to https://app.netlify.com/projects/desertgrey/overview
2. **Project configuration → Build & deploy → Continuous deployment → Link repository**
3. Pick GitHub → `diegolujanstudio/desertgreyfestival`
4. Build settings: should auto-fill from `netlify.toml`. Confirm:
   - Build command: `npm run build && node scripts/inject-cms-config.mjs`
   - Publish directory: `dist`
5. **Project configuration → Environment variables → Add variable:**
   - Key: `CMS_WORKER_URL`
   - Value: the worker URL from Step 6 (no trailing slash)
6. **Deploys → Trigger deploy → Clear cache and deploy site**

The deploy should succeed in ~30 seconds. Visit `https://desertgrey.netlify.app/admin/` — you should see the Desert Grey login screen.

---

## Step 8 — Smoke test

1. At `/admin/`, type your email → click **Send login link**
2. Check your inbox for the Desert Grey email
3. Click the button → you should land in the Decap CMS editor
4. Edit something small (e.g. change a band name) → click **Publish**
5. Watch your GitHub repo — a commit should appear within seconds
6. Netlify auto-rebuilds → site updates in ~30s

If anything fails:
- **Email never arrives:** Resend dashboard → Logs (most common: from address not verified)
- **"Email not authorized":** the email isn't in `ALLOWED_EMAILS` in `wrangler.toml` — fix and redeploy
- **CMS won't load:** browser dev console — usually a missing `CMS_WORKER_URL` env var in Netlify

---

## Step 9 — Point the real domain (later)

When you're ready to switch `desertgreymusicfestival.com` from the old Google Site to Netlify:

1. In Netlify: **Domain management → Add custom domain → desertgreymusicfestival.com**
2. Netlify gives you 2 DNS records (an apex `A` and a `www` `CNAME`).
3. In your Cloudflare dashboard → **Websites → Add a site** → `desertgreymusicfestival.com`.
4. CF will show you their nameservers. **Have Justin paste those at Squarespace Domains** (still 15-min screenshare).
5. Once CF is authoritative, in CF DNS: paste the two Netlify records.
6. Wait ~5 min, Netlify auto-provisions HTTPS, site goes live on the real domain.

Update `wrangler.toml` `SITE_URL` to the real domain and redeploy the Worker.

---

## Adding new editors later

1. Open `workers/cms-gateway/wrangler.toml`
2. Add the email to `ALLOWED_EMAILS = "you@x.com,justin@x.com,new-person@x.com"`
3. `cd workers/cms-gateway && npx wrangler deploy`
4. Tell them: go to `https://desertgreymusicfestival.com/admin/`

That's it. No GitHub accounts, no invites, no permissions screens.

---

## Rotating credentials

Every 12 months (set a calendar reminder):

- **GitHub PAT:** regenerate at https://github.com/settings/personal-access-tokens → `wrangler secret put GITHUB_TOKEN`
- **Session secret:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → `wrangler secret put SESSION_SECRET` (this logs everyone out and forces re-login — expected)
- **Resend key:** same pattern — generate new in Resend dashboard, `wrangler secret put RESEND_API_KEY`
