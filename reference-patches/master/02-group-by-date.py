#!/usr/bin/env python3
import re
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <index-*.js>")
    sys.exit(2)

path = Path(sys.argv[1])
data = path.read_text(encoding="utf-8")

if "mfDateGroup=" in data:
    print("Group By Date: already patched")
    sys.exit(0)


# ------------------------------------------------------------
# 1. Detect the displayed-message list from the unique
#    .current.displayMessages=<alias> assignment.
# ------------------------------------------------------------

dm = list(re.finditer(
    r'([A-Za-z_$][\w$]*)\.current\.displayMessages=([A-Za-z_$][\w$]*);',
    data
))

if len(dm) != 1:
    raise SystemExit(
        f"ERROR: expected 1 displayMessages assignment, found {len(dm)}"
    )

display_anchor = dm[0].group(0)
messages = dm[0].group(2)


# ------------------------------------------------------------
# 2. Detect threaded render map.
# ------------------------------------------------------------

thread_rx = re.compile(
    rf'\?{re.escape(messages)}\.map\('
    rf'([A-Za-z_$][\w$]*)=>\{{let '
    rf'([A-Za-z_$][\w$]*)=\1\.thread_id\|\|\1\.id'
)

thread_matches = list(thread_rx.finditer(data))

if len(thread_matches) != 1:
    raise SystemExit(
        f"ERROR: expected 1 threaded message map, found {len(thread_matches)}"
    )

thread_open = thread_matches[0].group(0)
thread_msg = thread_matches[0].group(1)
thread_key = thread_matches[0].group(2)

thread_search_start = thread_matches[0].end()

thread_return_rx = re.compile(
    rf'return\(0,([A-Za-z_$][\w$]*)\.jsx\)'
    rf'\(([A-Za-z_$][\w$]*),\{{message:{re.escape(thread_msg)},'
)

thread_return = thread_return_rx.search(
    data,
    thread_search_start,
    thread_search_start + 5000
)

if not thread_return:
    raise SystemExit("ERROR: threaded message component render not found")

jsx = thread_return.group(1)
thread_component = thread_return.group(2)
thread_return_old = thread_return.group(0)


# ------------------------------------------------------------
# 3. Detect normal-message render map after threaded map.
# ------------------------------------------------------------

normal_rx = re.compile(
    rf'\):{re.escape(messages)}\.map\('
    rf'([A-Za-z_$][\w$]*)=>\{{let '
    rf'([A-Za-z_$][\w$]*)='
)

normal_match = normal_rx.search(
    data,
    thread_return.end(),
    thread_return.end() + 10000
)

if not normal_match:
    raise SystemExit("ERROR: normal message map not found")

normal_open = normal_match.group(0)
normal_msg = normal_match.group(1)

normal_return_rx = re.compile(
    rf'return\(0,{re.escape(jsx)}\.jsx\)'
    rf'\(([A-Za-z_$][\w$]*),\{{message:{re.escape(normal_msg)},'
)

normal_return = normal_return_rx.search(
    data,
    normal_match.end(),
    normal_match.end() + 5000
)

if not normal_return:
    raise SystemExit("ERROR: normal message component render not found")

normal_component = normal_return.group(1)
normal_return_old = normal_return.group(0)


# ------------------------------------------------------------
# 4. Validate exact boundaries before changing anything.
# ------------------------------------------------------------

thread_close_and_normal_open = (
    f"}},{thread_key})}}"
    + normal_open
)

if data.count(thread_close_and_normal_open) != 1:
    raise SystemExit(
        "ERROR: threaded->normal render boundary is not unique"
    )

normal_close = f"}},{normal_msg}.id)}}),"

normal_return_pos = data.find(normal_return_old)

if normal_return_pos < 0:
    raise SystemExit("ERROR: normal render start disappeared")

normal_close_pos = data.find(normal_close, normal_return_pos)

if normal_close_pos < 0 or normal_close_pos - normal_return_pos > 10000:
    raise SystemExit("ERROR: normal render closing boundary not found")


# ------------------------------------------------------------
# 5. Date-group helpers.
#
#    Today      = today
#    Yesterday  = previous calendar day
#    This Week  = current week starting Monday,
#                 excluding Today and Yesterday
#    Older      = everything before current week
#
#    Uses local browser calendar dates.
# ------------------------------------------------------------

helpers = (
    "let mfDateGroup=mfMessage=>{"
    "let mfDate=new Date(mfMessage?.date),mfToday=new Date;"
    "if(Number.isNaN(mfDate.getTime()))return`Older`;"
    "mfDate.setHours(0,0,0,0),"
    "mfToday.setHours(0,0,0,0);"
    "let mfYesterday=new Date(mfToday);"
    "mfYesterday.setDate(mfYesterday.getDate()-1);"
    "let mfWeekStart=new Date(mfToday),"
    "mfDay=mfWeekStart.getDay();"
    "mfWeekStart.setDate("
    "mfWeekStart.getDate()-(mfDay===0?6:mfDay-1)"
    ");"
    "return mfDate.getTime()===mfToday.getTime()?`Today`:"
    "mfDate.getTime()===mfYesterday.getTime()?`Yesterday`:"
    "mfDate.getTime()>=mfWeekStart.getTime()&&"
    "mfDate.getTime()<mfYesterday.getTime()?`This Week`:`Older`"
    "},"
    "mfDateHeader=mfLabel=>(0," + jsx + ".jsx)(`div`,{"
    "style:{"
    "padding:`8px 12px 6px`,"
    "fontSize:11,"
    "fontWeight:700,"
    "textTransform:`uppercase`,"
    "letterSpacing:`0.04em`,"
    "color:`var(--text-tertiary)`,"
    "background:`var(--bg-primary)`,"
    "borderBottom:`1px solid var(--border-subtle)`"
    "},"
    "children:mfLabel"
    "});"
)

data = data.replace(
    display_anchor,
    display_anchor + helpers,
    1
)


# ------------------------------------------------------------
# 6. Threaded list:
#    add index argument and wrap each existing row in Fragment
#    with a visual date header when the group changes.
# ------------------------------------------------------------

thread_open_new = thread_open.replace(
    f"{messages}.map({thread_msg}=>",
    f"{messages}.map(({thread_msg},mfDgIndex)=>",
    1
)

data = data.replace(thread_open, thread_open_new, 1)

thread_return_new = (
    f"return(0,{jsx}.jsxs)({jsx}.Fragment,{{children:["
    f"(!mfDgIndex||"
    f"mfDateGroup({thread_msg})!==mfDateGroup({messages}[mfDgIndex-1]))"
    f"&&mfDateHeader(mfDateGroup({thread_msg})),"
    f"(0,{jsx}.jsx)({thread_component},{{message:{thread_msg},"
)

data = data.replace(
    thread_return_old,
    thread_return_new,
    1
)


# ------------------------------------------------------------
# 7. Boundary between threaded and normal maps:
#    close Fragment and add index argument to normal map.
# ------------------------------------------------------------

normal_open_new = normal_open.replace(
    f"{messages}.map({normal_msg}=>",
    f"{messages}.map(({normal_msg},mfDgIndex)=>",
    1
)

boundary_new = (
    f"}},{thread_key})]}}"
    f",{thread_key})}}"
    + normal_open_new
)

data = data.replace(
    thread_close_and_normal_open,
    boundary_new,
    1
)


# ------------------------------------------------------------
# 8. Normal list:
#    same visual grouping, preserving existing row component.
# ------------------------------------------------------------

normal_return_new = (
    f"return(0,{jsx}.jsxs)({jsx}.Fragment,{{children:["
    f"(!mfDgIndex||"
    f"mfDateGroup({normal_msg})!==mfDateGroup({messages}[mfDgIndex-1]))"
    f"&&mfDateHeader(mfDateGroup({normal_msg})),"
    f"(0,{jsx}.jsx)({normal_component},{{message:{normal_msg},"
)

data = data.replace(
    normal_return_old,
    normal_return_new,
    1
)

# Re-find closing boundary after previous insertions.
normal_return_pos = data.find(normal_return_new)

if normal_return_pos < 0:
    raise SystemExit("ERROR: patched normal render start not found")

normal_close_pos = data.find(normal_close, normal_return_pos)

if normal_close_pos < 0 or normal_close_pos - normal_return_pos > 10000:
    raise SystemExit("ERROR: patched normal render closing boundary not found")

normal_close_new = (
    f"}},{normal_msg}.id)]}}"
    f",{normal_msg}.id)}}),"
)

data = (
    data[:normal_close_pos]
    + normal_close_new
    + data[normal_close_pos + len(normal_close):]
)


path.write_text(data, encoding="utf-8")

print("Group By Date: PATCHED")
print("  message list       :", messages)
print("  JSX alias          :", jsx)
print("  threaded component :", thread_component)
print("  normal component   :", normal_component)
