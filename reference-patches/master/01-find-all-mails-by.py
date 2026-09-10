#!/usr/bin/env python3
import re
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <index-*.js>")
    sys.exit(2)

path = Path(sys.argv[1])
data = path.read_text(encoding="utf-8")

if "Find All Mails By" in data or "mfFindByOpen" in data:
    print("Find All Mails By: already patched")
    sys.exit(0)

anchor = "context-menu-actions"

candidates = []
search_pos = 0

while True:
    pos = data.find(anchor, search_pos)
    if pos < 0:
        break

    fn_start = data.rfind("function ", 0, pos)
    if fn_start >= 0:
        fn_end = data.find("function ", pos)
        fn_end = fn_end if fn_end != -1 else len(data)

        candidate = data[fn_start:fn_end]
        header_end = candidate.find("){")

        if header_end >= 0:
            candidate_header = candidate[:header_end + 2]

            if (
                "message:" in candidate_header
                and "onClose:" in candidate_header
                and "onAction:" in candidate_header
            ):
                candidates.append(
                    (pos, fn_start, fn_end, candidate, candidate_header)
                )

    search_pos = pos + len(anchor)

if len(candidates) != 1:
    raise SystemExit(
        f"ERROR: expected exactly 1 message context-menu function, found {len(candidates)}"
    )

pos, start, end, fn, header = candidates[0]

def grab(pattern, text, name):
    m = re.search(pattern, text)
    if not m:
        raise SystemExit(f"ERROR: could not detect {name}")
    return m.group(1)

message = grab(
    r'message:([A-Za-z_$][\w$]*)',
    header,
    "message alias"
)

onclose = grab(
    r'onClose:([A-Za-z_$][\w$]*)',
    header,
    "onClose alias"
)

onaction = grab(
    r'onAction:([A-Za-z_$][\w$]*)',
    header,
    "onAction alias"
)

react = grab(
    r'\(0,([A-Za-z_$][\w$]*)\.useState\)',
    fn,
    "React alias"
)

jsx = grab(
    r'\(0,([A-Za-z_$][\w$]*)\.jsx[s]?\)',
    fn,
    "JSX alias"
)

store = grab(
    rf'([A-Za-z_$][\w$]*)\(e=>e\.accounts\.find\(e=>e\.id==={re.escape(message)}\.account_id\)\)',
    fn,
    "store alias"
)

plugin_setter = grab(
    r'openSubmenu:e=>([A-Za-z_$][\w$]*)\(\(\)=>e\)',
    fn,
    "plugin submenu setter"
)

plugin_state = grab(
    rf'\[([A-Za-z_$][\w$]*),{re.escape(plugin_setter)}\]=\(0,[A-Za-z_$][\w$]*\.useState\)\(null\)',
    fn,
    "plugin submenu state"
)

# ------------------------------------------------------------
# 1. Add our own submenu state.
# Anchor on unread_count calculation instead of minified names.
# ------------------------------------------------------------

state_rx = re.compile(
    rf'([A-Za-z_$][\w$]*)=Number\.parseInt\({re.escape(message)}\.unread_count,10\)'
)

matches = list(state_rx.finditer(data[start:end if end != -1 else len(data)]))

if len(matches) != 1:
    raise SystemExit(
        f"ERROR: expected 1 unread_count state anchor, found {len(matches)}"
    )

m = matches[0]
old_state = m.group(0)
unread_var = m.group(1)

new_state = (
    f"[mfFindByOpen,setMfFindByOpen]=(0,{react}.useState)(!1),"
    + old_state
)

absolute_start = start + m.start()
absolute_end = start + m.end()

data = data[:absolute_start] + new_state + data[absolute_end:]


# ------------------------------------------------------------
# 2. Add search handler immediately before Escape key effect.
# ------------------------------------------------------------

escape_marker = f'e.key===`Escape`&&{onclose}()'

if data.count(escape_marker) != 1:
    raise SystemExit(
        f"ERROR: expected 1 Escape anchor, found {data.count(escape_marker)}"
    )

escape_pos = data.find(escape_marker)

effect_start = data.rfind(
    f"(0,{react}.useEffect)(",
    start,
    escape_pos
)

if effect_start < 0:
    raise SystemExit("ERROR: Escape useEffect start not found")

handler = (
    "let mfFindBySearch=mfMode=>{"
    "let mfRaw=mfMode===`sender`?"
    + message +
    ".from_email||``:"
    + message +
    ".subject||``,"
    "mfValue=String(mfRaw)"
    ".replace(/\"/g,` `)"
    ".replace(/\\s+/g,` `)"
    ".trim();"
    "if(!mfValue)return;"
    "let mfStore="
    + store +
    ".getState();"
    "mfStore.setSelectedAccount("
    + message +
    ".account_id,"
    + message +
    ".folder||`INBOX`),"
    "mfStore.setSearchQuery("
    "`${mfMode===`sender`?`from`:`subject`}:\"${mfValue}\" in:all`"
    "),"
    + onclose +
    "()};"
)

data = data[:effect_start] + handler + data[effect_start:]


# ------------------------------------------------------------
# 3. Insert parent context-menu item immediately after Forward.
# ------------------------------------------------------------

forward_action = f"action:()=>{onaction}(`forward`)}}]:[],"

if data.count(forward_action) != 1:
    raise SystemExit(
        f"ERROR: expected 1 Forward action anchor, found {data.count(forward_action)}"
    )

parent_item = (
    "{label:`Find All Mails By`,"
    "icon:(0," + jsx + ".jsxs)(`svg`,{"
    "width:`14`,height:`14`,viewBox:`0 0 24 24`,"
    "fill:`none`,stroke:`currentColor`,strokeWidth:`1.75`,"
    "children:["
    "(0," + jsx + ".jsx)(`circle`,{cx:`11`,cy:`11`,r:`7`}),"
    "(0," + jsx + ".jsx)(`line`,{x1:`16.5`,y1:`16.5`,x2:`21`,y2:`21`})"
    "]"
    "}),"
    "action:()=>setMfFindByOpen(!0),"
    "keepOpen:!0,"
    "hasSubmenu:!0"
    "},"
)

data = data.replace(
    forward_action,
    forward_action + parent_item,
    1
)


# ------------------------------------------------------------
# 4. Insert Sender / Subject submenu before normal submenus.
# ------------------------------------------------------------

plugin_prefix = (
    plugin_state
    + "?"
    + plugin_state
    + "(()=>"
    + plugin_setter
    + "(null)):"
)

if data.count(plugin_prefix) != 1:
    raise SystemExit(
        f"ERROR: expected 1 plugin submenu anchor, found {data.count(plugin_prefix)}"
    )

submenu = (
    "mfFindByOpen?(0," + jsx + ".jsxs)(" + jsx + ".Fragment,{children:["
    "(0," + jsx + ".jsxs)(`div`,{"
    "onClick:()=>setMfFindByOpen(!1),"
    "style:{"
    "display:`flex`,alignItems:`center`,gap:8,"
    "padding:`8px 14px`,cursor:`pointer`,"
    "borderBottom:`1px solid var(--border-subtle)`,"
    "color:`var(--text-secondary)`,fontSize:12"
    "},"
    "onMouseEnter:e=>e.currentTarget.style.background=`var(--bg-hover)`,"
    "onMouseLeave:e=>e.currentTarget.style.background=`transparent`,"
    "children:["
    "(0," + jsx + ".jsx)(`svg`,{"
    "width:`12`,height:`12`,viewBox:`0 0 24 24`,"
    "fill:`none`,stroke:`currentColor`,strokeWidth:`2.5`,"
    "children:(0," + jsx + ".jsx)(`polyline`,{points:`15 18 9 12 15 6`})"
    "}),"
    "`Find All Mails By`"
    "]"
    "}),"
    "[[`sender`,`Sender`,!!" + message + ".from_email],"
    "[`subject`,`Subject`,!!" + message + ".subject]]"
    ".map(([mfMode,mfLabel,mfEnabled])=>(0," + jsx + ".jsx)(`div`,{"
    "onClick:()=>{mfEnabled&&mfFindBySearch(mfMode)},"
    "style:{"
    "display:`flex`,alignItems:`center`,padding:`8px 14px`,"
    "cursor:mfEnabled?`pointer`:`default`,"
    "color:mfEnabled?`var(--text-primary)`:`var(--text-tertiary)`,"
    "fontSize:13"
    "},"
    "onMouseEnter:e=>{mfEnabled&&(e.currentTarget.style.background=`var(--bg-hover)`)},"
    "onMouseLeave:e=>{e.currentTarget.style.background=`transparent`},"
    "children:mfLabel"
    "},mfMode))"
    "]}):"
)

data = data.replace(
    plugin_prefix,
    plugin_prefix + submenu,
    1
)

path.write_text(data, encoding="utf-8")

print("Find All Mails By: PATCHED")
print("  message alias :", message)
print("  onClose alias :", onclose)
print("  onAction alias:", onaction)
print("  React alias   :", react)
print("  JSX alias     :", jsx)
print("  store alias   :", store)
