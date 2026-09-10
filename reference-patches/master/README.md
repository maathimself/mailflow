# MailFlow Custom Patch Set

This directory contains the reusable MailFlow custom patch set that must be
applied after every upstream MailFlow update.

Current verified baseline:

- MailFlow 3.3.0
- Frontend stock bundle tested:
  `index-Bi-CjFg3.original.js`
- Backend stock source tested:
  `hostValidation.js`
  `imapManager.js`

The patch set is designed to fail safely if upstream code changes enough that
a known anchor can no longer be found.

Do not patch the production containers directly.

---

# Custom patches

## 1. Find All Mails By

File:

`01-find-all-mails-by.py`

Adds this message context-menu item:

    Find All Mails By >
        Sender
        Subject

Important behavior:

- Search is scoped only to the email account that owns the selected message.
- It must never search all configured accounts.
- The selected account is switched before the search query is applied.
- Search uses MailFlow's `in:all` scope inside that selected account.

Conceptually:

    setSelectedAccount(message.account_id, message.folder || "INBOX")
    setSearchQuery('from:"..." in:all')

or:

    setSearchQuery('subject:"..." in:all')

---

## 2. Group By Date

File:

`02-group-by-date.py`

Adds visual message-list separators:

    Today
    Yesterday
    This Week
    Older

Rules:

- Today = current local calendar day.
- Yesterday = previous local calendar day.
- This Week = current week starting Monday, excluding Today and Yesterday.
- Older = everything before the current week.

This is visual grouping only.

It must not alter:

- message sorting
- pagination
- infinite scrolling
- selection
- threaded view behavior
- context menus
- unread state
- message actions

Both normal and threaded message lists are patched.

---

## 3. Folder Colors

File:

`03-folder-colors.py`

Adds:

    Right click folder
        Color >
            16-color palette
            Custom color...
            Reset color

Works in:

- normal folder tree
- Favorites

Storage:

    localStorage key:
    mailflow_folder_colors

Folder identity:

    accountId:path

Tree and Favorites use the same stored value.

Only the folder icon is colored.

The patch must not color:

- folder row
- folder name
- unread counter
- account dot
- hover background
- selected background

Icon rendering:

- stroke = selected color
- fill = 8% selected color + 92% MailFlow secondary background

Palette:

    #5B8DEF  #67B7E8  #4FB7C5  #55B89C
    #69B96E  #9DBE5B  #D7B94E  #D8A94F
    #E79A55  #E77D6B  #E16D73  #D97AA8
    #C96B8F  #9A78DF  #737DD8  #8A91A8

The parent folder context menu must remain open while the separate Color
submenu is being used.

The `mailflow_folder_colors` localStorage key is intentionally preserved and
must not be cleared during MailFlow updates.

---

## 4. Proton Bridge private-IP exception

File:

`04-proton-bridge-private-ip.py`

Backend source:

    backend/src/services/hostValidation.js

MailFlow normally blocks private and reserved IP addresses as SSRF protection.

Proton Bridge is reachable from the MailFlow Docker network through:

    172.18.0.1

The patch allows ONLY:

    172.18.0.1

All other private/reserved IPv4 and IPv6 addresses remain blocked.

The exception is applied to all three relevant IPv4 validation paths:

- direct IPv4 validation
- resolved IPv4 validation
- connection/final resolved IPv4 validation

Do not replace the general SSRF protection with an allow-private option.

---

## 5. Proton All Mail sync preservation

File:

`05-proton-all-mail-sync.py`

Backend source:

    backend/src/services/imapManager.js

Patch location:

    RELOCATE_MESSAGE_SQL

Proton Bridge exposes an `All Mail` folder, but it may not be marked with
MailFlow's expected `special_use = \All`.

Without this patch MailFlow's relocation logic can collapse the All Mail row
and the physical-folder row into one database row during sync/backfill.

The patch adds:

    AND LOWER(messages.folder) <> 'all mail'
    AND LOWER($1::text) <> 'all mail'

Meaning:

- an existing All Mail database row cannot be relocated out of All Mail
- another physical-folder row cannot be relocated into All Mail

This allows both rows to coexist.

IMPORTANT:

This patch is for sync/backfill relocation only.

Do NOT add the old experimental Proton All Mail Delete/Archive workaround.

Delete and archive behavior must remain stock MailFlow behavior.

---

# Files

Expected master directory:

    /opt/mailflow/patches/master/

Files:

    01-find-all-mails-by.py
    02-group-by-date.py
    03-folder-colors.py
    04-proton-bridge-private-ip.py
    05-proton-all-mail-sync.py
    apply-all.sh
    verify.sh
    README.md

---

# apply-all.sh

Usage:

    ./master/apply-all.sh \
      <frontend-index.js> \
      <hostValidation.js> \
      <imapManager.js>

Example:

    ./master/apply-all.sh \
      work/frontend/index-XXXXXXXX.js \
      work/backend/hostValidation.js \
      work/backend/imapManager.js

The script applies patches in this exact order:

    1. Find All Mails By
    2. Group By Date
    3. Folder Colors
    4. Proton Bridge private-IP exception
    5. Proton All Mail sync preservation

Then it automatically runs `verify.sh`.

Every patch is idempotent.

Running the patch set a second time should report:

    Find All Mails By: already patched
    Group By Date: already patched
    Folder Colors: already patched
    Proton Bridge private IP: already patched
    Proton All Mail sync: already patched

---

# verify.sh

Usage:

    ./master/verify.sh \
      <frontend-index.js> \
      <hostValidation.js> \
      <imapManager.js>

Successful result:

    ALL MAILFLOW PATCH MARKERS VERIFIED

Verification includes:

Frontend:

- Find All Mails By menu
- account-scoped search handler
- date grouping helper
- normal/threaded date headers
- folder-color storage
- folder icon wrapping
- custom/reset color options
- palette markers

Backend:

- direct Proton Bridge IP exception
- resolved Proton Bridge IP exceptions
- All Mail relocation OUT guard
- All Mail relocation IN guard

---

# Procedure after a future MailFlow update

Never overwrite the known-good production image first.

Use this workflow:

    CURRENT WORKING IMAGE
            |
            v
    PULL NEW UPSTREAM IMAGE
            |
            v
    EXTRACT NEW CLEAN FILES
            |
            v
    APPLY MASTER PATCH SET
            |
            v
    VERIFY + SYNTAX CHECK
            |
            v
    BUILD NEW TEST IMAGE
            |
            v
    TEST MAILFLOW
            |
            v
    SWITCH PRODUCTION
            |
            v
    KEEP PREVIOUS IMAGE FOR ROLLBACK

---

# 1. Preserve current working images

Before updating, record the currently running images:

    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

Also inspect local MailFlow images:

    docker images | grep -E 'mailflow|REPOSITORY'

Do not delete the currently working custom frontend or backend image.

Do not run:

    docker image prune -a

until the old known-good rollback images are intentionally no longer needed.

---

# 2. Pull the new upstream images

Pull the official MailFlow frontend and backend images.

Do not modify production Compose yet.

Record image IDs and upstream MailFlow version/revision if available.

---

# 3. Extract clean upstream files

From the new frontend image extract the active compiled JS bundle.

From the new backend image extract:

    /app/src/services/hostValidation.js
    /app/src/services/imapManager.js

Always patch clean upstream files.

Never use an already patched file as the starting point for a new MailFlow
version.

---

# 4. Apply the custom patch set

Run:

    ./master/apply-all.sh \
      <new-frontend-bundle> \
      <new-hostValidation.js> \
      <new-imapManager.js>

If any patch reports an anchor error:

STOP.

Do not force the patch.

It means upstream MailFlow changed the relevant code and that patch must be
reviewed against the new version.

---

# 5. Run syntax checks

Frontend bundle:

    node --check <frontend-bundle>

Backend:

    node --check <hostValidation.js>
    node --check <imapManager.js>

No output means syntax is valid.

---

# 6. Build new custom images

Build new versioned image tags.

Example naming:

    mailflow-frontend-custom:<VERSION>-custom
    mailflow-backend-custom:<VERSION>-proton

Never reuse the old known-good image tag while testing a new version.

---

# 7. Test before switching production

Test at minimum:

## Find All Mails By

- right-click a message
- verify Sender search
- verify Subject search
- verify results remain inside only the selected account

## Group By Date

Verify:

- Today
- Yesterday
- This Week
- Older

Also test:

- threaded mode
- normal mode
- scrolling
- selection
- pagination/infinite loading

## Folder Colors

Test:

- normal folder tree
- Favorites
- palette color
- Custom color
- Reset color
- page refresh
- same folder color in Favorites and tree
- context menu stays open while using Color submenu

## Proton Bridge

Test Proton account connection through:

    172.18.0.1

Verify normal private/reserved IP addresses are still rejected.

## Proton All Mail

Refresh/sync/backfill Proton folders.

Verify:

- All Mail messages remain visible
- physical-folder sibling rows remain visible
- refreshing All Mail does not collapse/move rows
- normal Delete/Archive behavior remains unchanged

---

# 8. Switch production only after testing

Only after all checks pass should Docker Compose be changed to use the new
custom image tags.

Restart only the necessary MailFlow services.

Then inspect:

    docker compose ps
    docker logs --since 5m mailflow-frontend
    docker logs --since 5m mailflow-backend

Look for errors before considering the update complete.

---

# 9. Rollback

If the new version fails:

- switch Compose back to the previous custom frontend/backend image tags
- recreate/restart the affected services
- verify MailFlow is back to the previous known-good state

This is why previous working images must not be deleted during the update.

---

# Important rules

1. Never patch production containers directly.
2. Always start from clean upstream files.
3. Never overwrite the previous known-good image.
4. Every patch must pass `verify.sh`.
5. Every JavaScript file must pass `node --check`.
6. If a semantic anchor no longer matches, stop and inspect the new upstream
   code.
7. Do not blindly port old minified variable names to a new frontend build.
8. Keep the Proton Bridge exception restricted to exactly `172.18.0.1`.
9. Keep the Proton All Mail patch limited to relocation/sync preservation.
10. Do not restore the rejected experimental All Mail Delete/Archive patch.

---

# Verified MailFlow 3.3.0 result

The full clean-stock test chain successfully produced:

    Find All Mails By: PATCHED
    Group By Date: PATCHED
    Folder Colors: PATCHED
    Proton Bridge private IP: PATCHED
    Proton All Mail sync: PATCHED

Verification result:

    ALL MAILFLOW PATCH MARKERS VERIFIED

Second pass:

    Find All Mails By: already patched
    Group By Date: already patched
    Folder Colors: already patched
    Proton Bridge private IP: already patched
    Proton All Mail sync: already patched

This confirms that the complete patch chain is currently reproducible and
idempotent.
