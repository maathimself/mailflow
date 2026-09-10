#!/usr/bin/env python3
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <imapManager.js>")
    sys.exit(2)

path = Path(sys.argv[1])
data = path.read_text(encoding="utf-8")

guard1 = "AND LOWER(messages.folder) <> 'all mail'"
guard2 = "AND LOWER($1::text) <> 'all mail'"

if guard1 in data or guard2 in data:
    if guard1 in data and guard2 in data:
        print("Proton All Mail sync: already patched")
        sys.exit(0)

    raise SystemExit(
        "ERROR: partial All Mail patch detected; refusing to continue"
    )

anchor = (
    "    AND COALESCE((SELECT special_use FROM folders "
    "WHERE account_id = $3::uuid AND path = $1::text), '') "
    "NOT IN ('\\\\All', '\\\\Important')`;"
)

replacement = (
    "    AND COALESCE((SELECT special_use FROM folders "
    "WHERE account_id = $3::uuid AND path = $1::text), '') "
    "NOT IN ('\\\\All', '\\\\Important')\n"
    "    AND LOWER(messages.folder) <> 'all mail'\n"
    "    AND LOWER($1::text) <> 'all mail'`;"
)

count = data.count(anchor)

if count != 1:
    raise SystemExit(
        f"ERROR: expected exactly 1 relocation SQL anchor, found {count}"
    )

data = data.replace(anchor, replacement, 1)

path.write_text(data, encoding="utf-8")

print("Proton All Mail sync: PATCHED")
print("  existing All Mail row relocation blocked")
print("  relocation into All Mail blocked")
print("  delete/archive behavior untouched")
