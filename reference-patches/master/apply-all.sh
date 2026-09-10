#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -ne 3 ]; then
    echo "Usage:"
    echo "  $0 <frontend-index.js> <hostValidation.js> <imapManager.js>"
    exit 2
fi

FRONTEND="$1"
HOST_VALIDATION="$2"
IMAP_MANAGER="$3"

for FILE in "$FRONTEND" "$HOST_VALIDATION" "$IMAP_MANAGER"; do
    if [ ! -f "$FILE" ]; then
        echo "ERROR: file not found: $FILE"
        exit 1
    fi
done

echo "========================================"
echo " MailFlow custom patch set"
echo "========================================"

echo
echo "=== FRONTEND ==="

python3 "$SCRIPT_DIR/01-find-all-mails-by.py" \
    "$FRONTEND"

python3 "$SCRIPT_DIR/02-group-by-date.py" \
    "$FRONTEND"

python3 "$SCRIPT_DIR/03-folder-colors.py" \
    "$FRONTEND"

echo
echo "=== BACKEND ==="

python3 "$SCRIPT_DIR/04-proton-bridge-private-ip.py" \
    "$HOST_VALIDATION"

python3 "$SCRIPT_DIR/05-proton-all-mail-sync.py" \
    "$IMAP_MANAGER"

echo
echo "=== VERIFY ==="

"$SCRIPT_DIR/verify.sh" \
    "$FRONTEND" \
    "$HOST_VALIDATION" \
    "$IMAP_MANAGER"

echo
echo "========================================"
echo " ALL MAILFLOW CUSTOM PATCHES APPLIED"
echo "========================================"
