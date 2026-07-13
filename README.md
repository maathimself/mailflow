<p align="center">
  <img src="media/mailflow-logo.png" width="200" alt="MailFlow Logo">
</p>

<p align="center">
  A self-hosted, unified webmail client. Connect multiple IMAP/SMTP accounts and manage them all in one clean interface.
</p>

<p align="center">
  <a href="#installation">Quick Start</a> ·
  <a href="#email-provider-setup">Setup Guide</a> ·
  <a href="https://mailflow.sh/#supporters">Contributing</a> ·
  <a href="https://mailflow.sh/#roadmap">Roadmap</a>
</p>

## Licensing

MailFlow is dual-licensed:

- **[AGPL-3.0](LICENSE)** — free for personal use, self-hosting, and open-source projects. If you modify and distribute or host MailFlow, you must publish your changes under the same license.
- **[Commercial License](LICENSE-COMMERCIAL)** — $500 per installation, one-time. For businesses or deployments where AGPL obligations cannot be met. [Purchase here](https://mailflow.sh/#pricing).

**Personal self-hosting is free and always will be.** This licensing model exists to protect the project from commercial exploitation while keeping MailFlow freely available to individuals and families.

If you contribute code, please read the [Contributor License Agreement](CLA.md). By submitting a pull request you agree to its terms.


## Features

- **Unified inbox** — all accounts merged in one view, sorted by date
- **Email categorization** — automatic inbox tabs (Primary, Newsletters, Social, Notifications, Other) sort incoming mail by type using header detection and sender heuristics; AI reclassify button for misclassifications
- **Unsubscribe** — one-click unsubscribe button appears in the message pane for detected newsletters; sends the request or opens the unsubscribe URL automatically
- **Conversation threads** — messages grouped into reply chains with inline sent replies
- **Rich text compose** — WYSIWYG editor with font family, size, color, highlight, tables, emoji, links, attachments, image resize handles, and Excel table paste
- **Attachments** — send and receive file attachments across all accounts
- **Multiple layouts** — classic, compact, wide reader, vertical split, and more
- **Multiple themes** — dark, light, and several color schemes; custom CSS field for per-user style overrides
- **Multi-language UI** — English, French, Spanish, Italian, German, Russian, and Simplified Chinese
- **Full-text search** — across all connected accounts simultaneously
- **Real-time notifications** — WebSocket-powered new-mail toasts and web push notifications
- **PWA** — installable as a desktop or mobile app with push notification support
- **Command palette** — Cmd+K / Ctrl+K quick-access for actions and navigation
- **Keyboard shortcuts** — full shortcut set, fully customisable per user
- **Smart contact autocomplete** — learns from sent mail to rank suggestions
- **Reply / Forward / Compose** — correct per-account SMTP routing; font family groups, email priority
- **Folder navigation** — expand any account to browse folders
- **Star, archive, delete, mark read/unread** — synced back to IMAP
- **Mark-as-read behavior** — choose immediate (on open), after a configurable delay in seconds, or manual (button only) per-user preference
- **Inbox rules** — automate actions (move, archive, delete, mark read, star) based on sender, subject, recipient, headers, body, or attachments
- **Block list** — automatically move mail from blocked senders to trash before inbox rules run
- **Spam reporting** — mark messages as spam or not spam from the context menu, toolbar, or bulk actions; feedback will feed into automated filtering in a future release
- **Snooze** — snooze messages until a chosen time; they reappear at the top of the inbox
- **AI assistant** — connect any OpenAI-compatible provider (local models or cloud); summarise threads, draft replies, ask questions about a message
- **Password recovery** — recover your account via a recovery email address configured in profile settings
- **User management** — admin panel, invite-only registration, invite emails
- **Two-factor authentication** — TOTP (any authenticator app), email OTP fallback, persistent device trust; admin-configurable enforcement policy
- **SSO / OIDC** — single sign-on via any OpenID Connect provider; group claims from the IdP can be mapped to the MailFlow admin role
- **Microsoft 365 / OAuth2** — work accounts via Azure App Registration; personal Outlook.com via device code flow
- **Todoist integration** — create tasks directly from emails; tasks include a deep link back to the original message
- **CardDAV** — expose your MailFlow contacts as a CardDAV address book for sync with phone and desktop contact apps; contact photos sync and appear as sender avatars in the message list
- **GTD workflow** — optional Getting-Things-Done rail: label threads Todo / Watch / Delegated / Someday / Reference (each backed by a real IMAP folder) with the t / w / d keys; opt in per account, see below

---

## GTD (Getting Things Done)

An optional Getting-Things-Done workflow, off by default and enabled per account
under Settings → Categories → GTD. When on, a rail beside the message list
groups threads into five states, each backed by a real IMAP folder — so the labels
are just server-side folders that sync to every mail client and survive MailFlow
itself:

- **Todo** / **Someday** — things you need to act on; the label clears itself once you reply.
- **Watch** / **Delegated** — things you're waiting on; the label clears itself once the other party replies.
- **Reference** — kept until you remove it by hand.

Label the selected thread from the keyboard — **t** for Todo, **w** for Watch,
**d** for Delegated (all remappable in the keyboard-shortcut settings) — or from the
context menu, which also covers Someday and Reference. Each state's folder name is
configurable per account, and accounts with GTD off behave exactly as before.

---

## Screenshots

<table>
  <tr>
    <td align="center"><img src="media/mailflow-ss-default.png" alt="Default dark theme"><br><sub>Default dark theme</sub></td>
    <td align="center"><img src="media/mailflow-ss-light.png" alt="Light theme"><br><sub>Light theme</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="media/mailflow-ss-catppuccin.png" alt="Catppuccin theme"><br><sub>Catppuccin theme</sub></td>
    <td align="center"><img src="media/mailflow-ss-gruvbox.png" alt="Gruvbox theme"><br><sub>Gruvbox theme</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="media/mailflow-ss-compose.png" alt="Compose window"><br><sub>Compose window</sub></td>
    <td align="center"><img src="media/mailflow-ss-collapsed-sidebar.png" alt="Collapsed sidebar"><br><sub>Collapsed sidebar</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="media/mailflow-ss-accounts.png" alt="Account management"><br><sub>Account management</sub></td>
    <td align="center"><img src="media/mailflow-ss-accounts-expanded.png" alt="Folder navigation"><br><sub>Folder navigation</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="media/mailflow-ss-layout.png" alt="Layout options"><br><sub>Layout options</sub></td>
    <td align="center"><img src="media/mailflow-ss-appearance.png" alt="Appearance settings"><br><sub>Appearance settings</sub></td>
  </tr>
</table>

---

## Installation

There are three ways to run MailFlow. The pre-built image method is recommended for most users.

---

## Option A — Pre-built images (recommended)

No cloning or building required. Docker pulls the pre-built images directly from GHCR.

### Prerequisites

- A server with Docker and Docker Compose installed

### 1. Download the compose file and default config

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/maathimself/mailflow/main/docker-compose.ghcr.yml
curl -o .env               https://raw.githubusercontent.com/maathimself/mailflow/main/.env.example
```

### 2. Configure environment

Edit `.env` — the required fields are:

| Variable | Description |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_PASSWORD` | `openssl rand -hex 16` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 3. Start

```bash
docker compose up -d
```

MailFlow will be available on port 443 (HTTPS, self-signed certificate) and port 80 (HTTP).

**Ports are configurable in `.env`:**

| Variable | Default | Description |
|---|---|---|
| `APP_PORT` | `443` | HTTPS port |
| `APP_HTTP_PORT` | `80` | HTTP port |

**Optional — automatic HTTPS via Let's Encrypt:** set `DOMAIN` and `ACME_EMAIL` in `.env`, download the HTTPS overlay, then restart:

```bash
curl -o docker-compose.https.yml https://raw.githubusercontent.com/maathimself/mailflow/main/docker-compose.https.yml
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https up -d
```

This adds a Caddy reverse proxy that handles certificate issuance and renewal automatically. Requires Docker Compose 2.21+, a public domain with DNS pointing at the server, and ports 80/443 open.

**Optional — behind your own reverse proxy:** point your proxy at port 80. Set `APP_HTTP_PORT` in `.env` if you need a different host port. Your proxy should forward `X-Forwarded-Proto: https` so that session cookies are marked Secure correctly.

### 4. Create your admin account

Open `https://your-domain.com` in a browser. The **first account registered becomes
the admin**. After registering, you can close registration and manage users from the
settings panel → Users tab.

### 5. Add your email accounts

In the settings panel → Accounts → Add Account.
Select a preset (Gmail, iCloud) or Custom for any IMAP server.

### Updating

```bash
docker compose pull
docker compose up -d
```

To pin to a specific version instead of `latest`, add `MAILFLOW_VERSION=1.9.0` to your `.env`.

---

## Option B — Build from source

### Prerequisites

- A server with Docker and Docker Compose installed

### 1. Get the code

```bash
git clone https://github.com/maathimself/mailflow.git mailflow
cd mailflow
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the required fields are:

| Variable | Description |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_PASSWORD` | `openssl rand -hex 16` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 3. Build and start

```bash
docker compose up -d --build
```

First build takes 2–3 minutes. MailFlow will be available on port 443 (HTTPS, self-signed certificate) and port 80 (HTTP).

**Optional — automatic HTTPS via Let's Encrypt:** set `DOMAIN` and `ACME_EMAIL` in `.env`, then start with the HTTPS overlay (requires Docker Compose 2.21+):

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https up -d --build
```

**Optional — behind your own reverse proxy:** point your proxy at port 80. Your proxy should forward `X-Forwarded-Proto: https` so that session cookies are marked Secure correctly.

### 4. Create your admin account

Open `https://your-domain.com` in a browser. The **first account registered becomes
the admin**. After registering, you can close registration and manage users from the
settings panel → Users tab.

### 5. Add your email accounts

In the settings panel → Accounts → Add Account.
Select a preset (Gmail, iCloud) or Custom for any IMAP server.

---

## Option C — Native install (no Docker)

Run MailFlow directly on any Linux, macOS, or BSD machine using Node.js, PostgreSQL, and Redis.
No container runtime required. The steps below use Ubuntu/Debian; adapt package manager commands for other platforms.

### Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org) or via your package manager
- **PostgreSQL 16+**
- **Redis 7+**
- **nginx** — serves the built frontend and proxies API/WebSocket requests to the backend

### 1. Install system dependencies

**Ubuntu / Debian:**
```bash
# Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql redis-server nginx
```

**macOS (Homebrew):**
```bash
brew install node@20 postgresql@16 redis nginx
brew services start postgresql@16
brew services start redis
```

### 2. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER mailflow WITH PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE mailflow OWNER mailflow;
SQL
```

### 3. Get the code

```bash
git clone https://github.com/maathimself/mailflow.git /opt/mailflow
cd /opt/mailflow
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. In addition to the required secrets, set these for a native install:

| Variable | Value |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_HOST` | `localhost` |
| `DB_NAME` | `mailflow` |
| `DB_USER` | `mailflow` |
| `DB_PASSWORD` | password you set in step 2 |
| `REDIS_URL` | `redis://localhost:6379` — or `redis+unix:///path/to/redis.sock` for a Unix socket |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 5. Build the frontend

```bash
cd /opt/mailflow/frontend
npm ci
npm run build
# Built files are written to /opt/mailflow/frontend/dist
```

### 6. Install backend dependencies

```bash
cd /opt/mailflow/backend
npm ci --omit=dev
```

### 7. Configure nginx

A ready-to-use nginx config is provided in `contrib/nginx.conf`. Copy it, update the `root` path, then enable it:

```bash
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo cp /opt/mailflow/contrib/nginx.conf /etc/nginx/sites-available/mailflow
```

Open `/etc/nginx/sites-available/mailflow` and replace `/path/to/mailflow/frontend/dist` with `/opt/mailflow/frontend/dist`.

The provided config listens on port 80 for use behind a TLS-terminating reverse proxy (Nginx/Caddy/Traefik). If you want nginx to terminate TLS directly, uncomment the HTTPS server block in the file and set your certificate paths. A quick self-signed cert:

```bash
sudo mkdir -p /etc/ssl/mailflow
sudo openssl req -x509 -nodes -newkey rsa:4096 -days 3650 \
  -keyout /etc/ssl/mailflow/key.pem \
  -out    /etc/ssl/mailflow/cert.pem \
  -subj "/CN=mailflow"
```

Enable the site and reload nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/mailflow /etc/nginx/sites-enabled/mailflow
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 8. Run the backend

**Option A — systemd (recommended for production):**

```bash
sudo cp /opt/mailflow/contrib/mailflow.service /etc/systemd/system/mailflow.service
# Edit the service file if your install path or user differs from the defaults
sudo systemctl daemon-reload
sudo systemctl enable --now mailflow
sudo systemctl status mailflow
```

**Option B — PM2:**

```bash
sudo npm install -g pm2
cd /opt/mailflow/backend
pm2 start src/index.js --name mailflow
pm2 save
pm2 startup   # follow the printed command to register auto-start on boot
```

**Option C — foreground (testing only):**

```bash
cd /opt/mailflow/backend
node src/index.js
```

### 9. Create your admin account

Open the app in a browser. The **first account registered becomes the admin**. After registering, close open registration from Settings → Users.

### 10. Add your email accounts

In the settings panel → Accounts → Add Account.

### Updating

```bash
cd /opt/mailflow
git pull
cd frontend && npm ci && npm run build && cd ..
cd backend && npm ci --omit=dev && cd ..
sudo systemctl restart mailflow   # or: pm2 restart mailflow
```

---

## Email Provider Setup

### Gmail

Gmail requires an **App Password** (not your normal password):

1. Enable 2-step verification on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Create a new App Password — name it "MailFlow"
4. Use the 16-character password in the MailFlow account form

| Setting | Value |
|---|---|
| IMAP Host | `imap.gmail.com` |
| IMAP Port | `993` |
| SMTP Host | `smtp.gmail.com` |
| SMTP Port | `587` |
| Username | your Gmail address |

### iCloud / Apple Mail

1. Go to [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords
2. Generate a password — name it "MailFlow"

| Setting | Value |
|---|---|
| IMAP Host | `imap.mail.me.com` |
| IMAP Port | `993` |
| SMTP Host | `smtp.mail.me.com` |
| SMTP Port | `587` |
| Username | your full iCloud email (`you@icloud.com`) |

### Microsoft 365 / Outlook (OAuth2)

**Work / school accounts (Microsoft 365):** require modern auth via Azure App Registration:

1. In MailFlow settings → Integrations → Microsoft 365 — follow the Azure App
   Registration instructions shown there
2. After saving the config, click **Connect Microsoft account**

**Personal accounts (Outlook.com / Hotmail):** no Azure registration needed — uses the device code flow:

1. Settings → Accounts → Add Account → Outlook.com / Hotmail
2. MailFlow displays a short code — visit [microsoft.com/devicelogin](https://microsoft.com/devicelogin) and enter it to authorise

### Custom IMAP

Any standard IMAP/SMTP server works. Use port 993 for IMAP (TLS) and
587 (STARTTLS) or 465 (TLS) for SMTP.

---

## Management

```bash
# View all logs
docker compose logs -f

# View backend logs only
docker compose logs -f backend

# Stop
docker compose down

# Stop and delete all data (destructive)
docker compose down -v

# Update to latest images (pre-built install)
docker compose pull && docker compose up -d

# Rebuild after a code change (Docker build-from-source install)
docker compose up -d --build

# Update a native install
git pull && \
  cd frontend && npm ci && npm run build && cd .. && \
  cd backend && npm ci --omit=dev && cd .. && \
  sudo systemctl restart mailflow   # or: pm2 restart mailflow
```

## Backup and Restore

```bash
# Backup database
docker exec mailflow-postgres pg_dump -U mailflow mailflow \
  > mailflow-$(date +%Y%m%d).sql

# Restore database
cat mailflow-YYYYMMDD.sql | \
  docker exec -i mailflow-postgres psql -U mailflow -d mailflow
```

---

## Architecture

### Default deployment (self-signed HTTPS)

```
Browser (HTTPS / HTTP)
  │
  ▼
nginx  (frontend container — ports 443 + 80)
  │
  ├── /api/*  → Node.js backend (port 3000)
  ├── /oauth/ → Node.js backend (port 3000)
  └── /ws     → Node.js backend WebSocket (port 3000)
                    │
                    ├── PostgreSQL  (messages, accounts, users)
                    ├── Redis       (sessions)
                    └── IMAP        (outbound to mail servers)
```

nginx and the backend communicate on an internal Docker network. PostgreSQL and Redis are not exposed outside that network.

### With your own reverse proxy

```
Browser (HTTPS)
  │
  ▼
Your proxy  (Nginx / Traefik / Caddy / etc. — TLS termination)
  │  X-Forwarded-Proto: https
  ▼
nginx  (frontend container — port 80)
  │
  └── backend, PostgreSQL, Redis (internal network, unchanged)
```

### With automatic HTTPS (--profile https)

```
Browser (HTTPS)
  │
  ▼
Caddy  (ports 80/443 — TLS termination, auto Let's Encrypt)
  │
  ▼
nginx  (frontend container — internal only)
  │
  └── backend, PostgreSQL, Redis (internal network, unchanged)
```

## Supporters

MailFlow is free and open source. If it's useful to you, consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support_MailFlow-FF5E5B?logo=ko-fi&logoColor=white&style=for-the-badge)](https://ko-fi.com/mailflow)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub_Sponsors-Sponsor-ea4aaa?logo=github-sponsors&logoColor=white&style=for-the-badge)](https://github.com/sponsors/maathimself)

### GitHub Sponsors

<!-- SPONSORS-START -->
<a href="https://github.com/Rainson12" title="Rainson12"><img src="https://avatars.githubusercontent.com/u/13119203?s=64&u=d18af1210e56533c4b5808986de75dbb28227599&v=4" width="48" height="48" alt="Rainson12" style="border-radius:50%;margin:4px"></a>
<a href="https://github.com/MikeScanlan5" title="MikeScanlan5"><img src="https://avatars.githubusercontent.com/u/44779151?s=64&u=e7dfabc231fa876f879e63b4cd1c897036751467&v=4" width="48" height="48" alt="MikeScanlan5" style="border-radius:50%;margin:4px"></a>
<a href="https://github.com/rahhing" title="rahhing"><img src="https://avatars.githubusercontent.com/u/192337730?s=64&u=ef3c773f0ccac769353d63545e0ff6a0c885294a&v=4" width="48" height="48" alt="rahhing" style="border-radius:50%;margin:4px"></a>
<!-- SPONSORS-END -->

---

## Star History

[![Stargazers over time](.github/assets/star-history.svg)](https://github.com/maathimself/mailflow/stargazers)

---

## Upgrading

### GTD

GTD is opt-in per account (**Settings → Categories → GTD**). Migrations for the new schema are additive and apply automatically on first startup. No operator action needed.

### v2.2.0 – v2.4.1

No manual migration steps required. All schema changes apply automatically on first startup.

### v2.1.0

No manual migration steps required. All schema changes apply automatically on first startup.

### v2.0.0

No manual migration steps required. All schema changes apply automatically on first startup.

`ENCRYPTION_KEY` is now required at startup. The server will refuse to start if the variable is missing or not exactly 64 hex characters. Generate one with `openssl rand -hex 32` before upgrading if you have not already set this.

### v1.9.0

Two database migrations (`0019_user_integrations`, `0020_mfa_device_trust`) run automatically on startup. No manual steps required.

2FA is off by default. Existing users are unaffected unless an admin enables enforcement under **Settings → Security**.

### Mail Server Connection Policy (earlier releases)

**Breaking change for accounts with "Skip TLS verification" enabled.**

An earlier release introduced an admin-controlled connection policy (Settings → Security → Mail Server Connection Policy). TLS verification is now enforced by default at the server level.

If any accounts were configured with **Skip TLS verification** (e.g. for a self-signed certificate on a local IMAP server), those accounts will stop syncing after upgrading from an older version. To restore connectivity, an admin must enable **Allow insecure TLS** in Settings → Security before or immediately after deploying.

---

## Security notes

- The first registered user becomes the admin automatically
- Close open registration in Settings → Users once you've set up your accounts
- Use the invite system to onboard additional users
- Enable two-factor authentication in Settings → Security — supports TOTP (authenticator app), email OTP fallback, and persistent device trust. TOTP codes are one-time and cannot be replayed within their validity window
- Session cookies are `HttpOnly`, `SameSite=Lax`, with a 7-day TTL. The `Secure` flag is set automatically when the connection is HTTPS (direct or via a proxy that forwards `X-Forwarded-Proto: https`)
- Passwords are bcrypt-hashed (cost factor 12)
- Login and registration endpoints are rate-limited (10 attempts per 15 minutes per IP)
- Password reset tokens are consumed atomically — concurrent reset requests cannot both succeed
- Database and Redis are not exposed outside the Docker network
- IMAP/SMTP credentials are stored at rest in the database (standard for webmail clients — protect access to your server and database volume accordingly)
- All responses include `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` security headers
- Email HTML is sanitized before rendering, including stripping external `url()` references from CSS style blocks to prevent tracking
