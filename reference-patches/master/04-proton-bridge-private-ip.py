#!/usr/bin/env python3
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <hostValidation.js>")
    sys.exit(2)

path = Path(sys.argv[1])
data = path.read_text(encoding="utf-8")

allowed_ip = "172.18.0.1"

if (
    f'bare !== "{allowed_ip}"' in data
    or f"bare !== '{allowed_ip}'" in data
):
    print("Proton Bridge private IP: already patched")
    sys.exit(0)


def replace_once(old, new, name):
    global data

    count = data.count(old)

    if count != 1:
        raise SystemExit(
            f"ERROR: {name}: expected exactly 1 anchor, found {count}"
        )

    data = data.replace(old, new, 1)
    print(f"  OK: {name}")


replace_once(
    "if (isIPv4(bare) && isPrivateIPv4(bare)) "
    "return 'Host cannot be a private or reserved IP address';",

    f'if (isIPv4(bare) && isPrivateIPv4(bare) '
    f'&& bare !== "{allowed_ip}") '
    "return 'Host cannot be a private or reserved IP address';",

    "direct IPv4 validation"
)


replace_once(
    "if (isIPv4(addr) && isPrivateIPv4(addr)) "
    "return 'Host resolves to a private or reserved IP address';",

    f'if (isIPv4(addr) && isPrivateIPv4(addr) '
    f'&& addr !== "{allowed_ip}") '
    "return 'Host resolves to a private or reserved IP address';",

    "resolved IPv4 validation"
)


replace_once(
    "if (isIPv4(addr) && isPrivateIPv4(addr)) "
    "throw new Error('Host resolves to a private or reserved IP address');",

    f'if (isIPv4(addr) && isPrivateIPv4(addr) '
    f'&& addr !== "{allowed_ip}") '
    "throw new Error('Host resolves to a private or reserved IP address');",

    "connection IPv4 validation"
)


path.write_text(data, encoding="utf-8")

print("Proton Bridge private IP: PATCHED")
print(f"  allowed IP only: {allowed_ip}")
