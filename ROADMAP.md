# MailExpert roadmap

Now / Next / Later, without dates. The detailed plan with acceptance criteria is
[docs/superpowers/plans/2026-09-11-mailexpert-shared-gmail-mvp.md](docs/superpowers/plans/2026-09-11-mailexpert-shared-gmail-mvp.md);
the target architecture is [docs/architecture/team-mail-system-handoff.md](docs/architecture/team-mail-system-handoff.md).

## Done

- Fork, full MailExpert rebrand and removal of upstream-only content.
- Full dependency modernization: Express 5, ImapFlow 2, Nodemailer 10, connect-redis 10 / Redis 6, React 19, React Router 7, Zustand 5, Tailwind 4, Electron 44.
- Google OAuth 2.0 for Gmail: PKCE S256, one-time Redis state, strict ID token checks, encrypted tokens, admin configuration and connect/reconnect UI.
- One OAuth token manager for every IMAP/SMTP path, with forced refresh on authentication failure and a persistent "reconnect required" state.
- Real IMAP authentication errors and bounded retry cooldowns instead of reconnect storms.
- Sidebar mailbox filter and per-mailbox connection health.
- Selected upstream MailFlow fixes (see [upstream PR assessment](docs/architecture/upstream-pr-assessment.md)).

## Now

- Deployment and Google OAuth runbooks: separate development and production Google Cloud projects, consent screen mode, redirect URIs, secret rotation, revoke and data removal.
- Live OAuth lifecycle check on real accounts: consent, refresh after expiry, revoke, reconnect.
- Clean deployment from the documentation with backup and restore of PostgreSQL together with the encryption key.

## Next

- Gmail scale test in waves of 10 → 25 → 50 → 100 mailboxes: memory, CPU, IMAP connections, provider errors and UI latency on the target server.
- 24-hour stability run, controlled restart and restore.
- Google OAuth app verification for production use with personal Gmail accounts.

## Later

- Owned-domain mailboxes through a separate Postfix/Dovecot mail node behind Microsoft EOP.
- Individual manager identities, an action journal and mailbox membership, if per-person accountability becomes a requirement.

Have a request or found a bug? [Open an issue](https://github.com/wyrtensi/MailExpert/issues).
