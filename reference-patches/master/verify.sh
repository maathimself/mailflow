#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "Usage:"
    echo "  $0 <frontend-index.js> <hostValidation.js> <imapManager.js>"
    exit 2
fi

FRONTEND="$1"
HOST_VALIDATION="$2"
IMAP_MANAGER="$3"

fail=0

check_count() {
    local file="$1"
    local marker="$2"
    local expected="$3"
    local name="$4"

    local count
    count="$(grep -oF "$marker" "$file" 2>/dev/null | wc -l | tr -d ' ')"

    if [ "$count" = "$expected" ]; then
        printf 'OK   %-35s %s\n' "$name" "$count"
    else
        printf 'FAIL %-35s expected=%s found=%s\n' \
            "$name" "$expected" "$count"
        fail=1
    fi
}

echo "=== FRONTEND ==="

check_count "$FRONTEND" \
    "Find All Mails By" 2 \
    "Find All Mails By"

check_count "$FRONTEND" \
    "mfFindBySearch" 2 \
    "FindBy search handler"

check_count "$FRONTEND" \
    'setSelectedAccount(' 1 \
    "account-scoped FindBy"

check_count "$FRONTEND" \
    "mfDateGroup=" 1 \
    "date grouping helper"

check_count "$FRONTEND" \
    "mfDateHeader(mfDateGroup(" 2 \
    "date headers render paths"

check_count "$FRONTEND" \
    '`Today`' 1 \
    "Today group"

check_count "$FRONTEND" \
    '`This Week`' 1 \
    "This Week group"

check_count "$FRONTEND" \
    "mailflow_folder_colors" 2 \
    "folder color storage"

check_count "$FRONTEND" \
    "MailFlowFolderIcon(" 3 \
    "folder icon coloring"

check_count "$FRONTEND" \
    "Custom color..." 1 \
    "custom color option"

check_count "$FRONTEND" \
    "Reset color" 1 \
    "reset color option"

check_count "$FRONTEND" \
    "#5B8DEF" 2 \
    "palette first color"

check_count "$FRONTEND" \
    "#8A91A8" 1 \
    "palette last color"


echo
echo "=== BACKEND / PROTON BRIDGE ==="

check_count "$HOST_VALIDATION" \
    'bare !== "172.18.0.1"' 1 \
    "direct private-IP exception"

check_count "$HOST_VALIDATION" \
    'addr !== "172.18.0.1"' 2 \
    "resolved private-IP exceptions"

check_count "$IMAP_MANAGER" \
    "LOWER(messages.folder) <> 'all mail'" 1 \
    "All Mail relocation OUT guard"

check_count "$IMAP_MANAGER" \
    "LOWER(\$1::text) <> 'all mail'" 1 \
    "All Mail relocation IN guard"


echo
if [ "$fail" -ne 0 ]; then
    echo "PATCH VERIFICATION FAILED"
    exit 1
fi

echo "ALL MAILFLOW PATCH MARKERS VERIFIED"
