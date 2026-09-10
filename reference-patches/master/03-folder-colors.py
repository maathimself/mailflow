#!/usr/bin/env python3
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <index-*.js>")
    sys.exit(2)

path = Path(sys.argv[1])
data = path.read_text(encoding="utf-8")

if "mailflow_folder_colors" in data or "MailFlowFolderColorMenu" in data:
    print("Folder Colors: already patched")
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


# ============================================================
# 0. Keep parent folder context menu open while interacting
#    with the separate Folder Color submenu.
# ============================================================

parent_menu_old = (
    "o.current&&!o.current.contains(e.target)&&u.current()"
)

parent_menu_new = (
    "o.current&&!o.current.contains(e.target)&&"
    "!e.target.closest?.(`[data-mf-folder-color-menu]`)&&u.current()"
)

replace_once(
    parent_menu_old,
    parent_menu_new,
    "parent menu color-submenu guard"
)


# ============================================================
# 1. Generic context-menu row:
#    forward hasSubmenu and render the > indicator.
# ============================================================

old_menu_row_call = (
    "(0,J.jsx)(Ir,{icon:e.icon,label:e.label,danger:e.danger,"
    "disabled:e.disabled,onClick:()=>{e.action(),e.keepOpen||a()}},t)"
)

new_menu_row_call = (
    "(0,J.jsx)(Ir,{icon:e.icon,label:e.label,danger:e.danger,"
    "disabled:e.disabled,hasSubmenu:e.hasSubmenu,"
    "onClick:()=>{e.action(),e.keepOpen||a()}},t)"
)

replace_once(
    old_menu_row_call,
    new_menu_row_call,
    "context-menu hasSubmenu forwarding"
)


old_ir = (
    "function Ir({icon:e,label:t,onClick:n,danger:r,disabled:i})"
    "{let[a,o]=(0,H.useState)(!1);"
    "return(0,J.jsxs)(`div`,{"
    "onClick:i?void 0:n,"
    "onMouseEnter:()=>!i&&o(!0),"
    "onMouseLeave:()=>o(!1),"
    "style:{display:`flex`,alignItems:`center`,gap:9,"
    "padding:`6px 13px`,cursor:i?`default`:`pointer`,"
    "background:a?r?`rgba(248,113,113,0.08)`:`var(--bg-hover)`:`transparent`,"
    "color:i?`var(--text-tertiary)`:r?a?`var(--red)`:"
    "`var(--text-secondary)`:`var(--text-primary)`,"
    "transition:`background 0.08s, color 0.08s`,fontSize:13,opacity:i?.5:1},"
    "children:["
    "(0,J.jsx)(`span`,{style:{flexShrink:0,display:`flex`,"
    "color:i?`var(--text-tertiary)`:r&&a?`var(--red)`:"
    "`var(--text-tertiary)`},children:e}),"
    "t]})}"
)

new_ir = (
    "function Ir({icon:e,label:t,onClick:n,danger:r,disabled:i,hasSubmenu:a})"
    "{let[o,s]=(0,H.useState)(!1);"
    "return(0,J.jsxs)(`div`,{"
    "onClick:i?void 0:n,"
    "onMouseEnter:()=>!i&&s(!0),"
    "onMouseLeave:()=>s(!1),"
    "style:{display:`flex`,alignItems:`center`,gap:9,"
    "padding:`6px 13px`,cursor:i?`default`:`pointer`,"
    "background:o?r?`rgba(248,113,113,0.08)`:`var(--bg-hover)`:`transparent`,"
    "color:i?`var(--text-tertiary)`:r?o?`var(--red)`:"
    "`var(--text-secondary)`:`var(--text-primary)`,"
    "transition:`background 0.08s, color 0.08s`,fontSize:13,opacity:i?.5:1},"
    "children:["
    "(0,J.jsx)(`span`,{style:{flexShrink:0,display:`flex`,"
    "color:i?`var(--text-tertiary)`:r&&o?`var(--red)`:"
    "`var(--text-tertiary)`},children:e}),"
    "(0,J.jsx)(`span`,{style:{flex:1},children:t}),"
    "a&&(0,J.jsx)(`svg`,{width:`12`,height:`12`,viewBox:`0 0 24 24`,"
    "fill:`none`,stroke:`var(--text-tertiary)`,strokeWidth:`2`,"
    "style:{flexShrink:0},"
    "children:(0,J.jsx)(`polyline`,{points:`9 18 15 12 9 6`})})"
    "]})}"
)

replace_once(
    old_ir,
    new_ir,
    "context-menu submenu arrow"
)


# ============================================================
# 2. Folder icon color helper + 16-color submenu.
# ============================================================

sidebar_anchor = "function Lr(){"

if data.count(sidebar_anchor) != 1:
    raise SystemExit(
        f"ERROR: sidebar function: expected exactly 1 anchor, "
        f"found {data.count(sidebar_anchor)}"
    )

helpers = r'''

function MailFlowFolderIcon(e,t){if(!t)return e;return H.cloneElement(e,{stroke:t,fill:`color-mix(in srgb, ${t} 8%, var(--bg-secondary) 92%)`,style:{...(e.props?.style||{}),color:t}})}

function MailFlowFolderColorMenu({x:e,y:t,current:n,onPick:r,onCustom:i,onReset:a,onClose:o}){let s=(0,H.useRef)(null),c=Ar(),[l,u]=(0,H.useState)({x:e,y:t}),d=[`#5B8DEF`,`#67B7E8`,`#4FB7C5`,`#55B89C`,`#69B96E`,`#9DBE5B`,`#D7B94E`,`#D8A94F`,`#E79A55`,`#E77D6B`,`#E16D73`,`#D97AA8`,`#C96B8F`,`#9A78DF`,`#737DD8`,`#8A91A8`];(0,H.useEffect)(()=>{if(!s.current)return;let n=s.current.getBoundingClientRect(),r=window.innerWidth,i=window.innerHeight,a=e+n.width>r?Math.max(4,e-n.width-214):e,o=t+n.height>i?Math.max(4,i-n.height-4):t;u({x:a,y:o})},[e,t]);(0,H.useEffect)(()=>{let e=e=>{s.current&&!s.current.contains(e.target)&&o()},t=e=>{e.key===`Escape`&&o()};return document.addEventListener(`mousedown`,e),document.addEventListener(`keydown`,t),()=>{document.removeEventListener(`mousedown`,e),document.removeEventListener(`keydown`,t)}},[o]);return(0,J.jsxs)(`div`,{"data-mf-folder-color-menu":`1`,ref:s,style:{position:`fixed`,left:jr(l.x,c),top:jr(l.y,c),width:174,background:`var(--bg-elevated)`,border:`1px solid var(--border)`,borderRadius:10,zIndex:4100,boxShadow:`var(--shadow-modal)`,padding:8,animation:`ctxIn 0.1s ease`},children:[(0,J.jsx)(`div`,{style:{display:`grid`,gridTemplateColumns:`repeat(4, 28px)`,gap:7,justifyContent:`center`,padding:`2px 0 8px`},children:d.map(e=>(0,J.jsx)(`button`,{title:e,onClick:t=>{t.stopPropagation(),r(e)},style:{width:28,height:28,borderRadius:7,border:n?.toLowerCase()===e.toLowerCase()?`2px solid var(--text-primary)`:`1px solid var(--border)`,background:e,cursor:`pointer`,padding:0,boxShadow:n?.toLowerCase()===e.toLowerCase()?`0 0 0 2px var(--bg-elevated)`:`none`}},e))}),(0,J.jsx)(`div`,{style:{height:1,background:`var(--border-subtle)`,margin:`1px -8px 4px`}}),(0,J.jsx)(Ir,{label:`Custom color...`,icon:(0,J.jsx)(`svg`,{width:`14`,height:`14`,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,strokeWidth:`1.75`,children:(0,J.jsx)(`circle`,{cx:`12`,cy:`12`,r:`8`})}),onClick:i}),(0,J.jsx)(Ir,{label:`Reset color`,disabled:!n,icon:(0,J.jsxs)(`svg`,{width:`14`,height:`14`,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,strokeWidth:`1.75`,children:[(0,J.jsx)(`path`,{d:`M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8`}),(0,J.jsx)(`polyline`,{points:`3 3 3 8 8 8`})]}),onClick:a})]})}

'''

data = data.replace(
    sidebar_anchor,
    helpers + sidebar_anchor,
    1
)

print("  OK: folder icon helper + color palette")


# ============================================================
# 3. Sidebar state + localStorage persistence.
# ============================================================

state_anchor = (
    "(0,H.useEffect)(()=>{I&&b(!1)},[i,a]);"
    "let[R,z]=(0,H.useState)(null)"
)

state_replacement = (
    "(0,H.useEffect)(()=>{I&&b(!1)},[i,a]);"
    "let[mfFolderColors,mfSetFolderColors]=(0,H.useState)(()=>{"
    "try{let e=JSON.parse(localStorage.getItem(`mailflow_folder_colors`)||`{}`);"
    "return e&&typeof e===`object`?e:{}}catch{return{}}}),"
    "[mfColorMenu,mfSetColorMenu]=(0,H.useState)(null),"
    "mfFolderKey=(e,t)=>`${e}:${t}`,"
    "mfSetFolderColor=(e,t,n)=>{"
    "mfSetFolderColors(r=>{let i={...r},a=mfFolderKey(e,t);"
    "n?i[a]=n:delete i[a];"
    "try{localStorage.setItem(`mailflow_folder_colors`,JSON.stringify(i))}catch{}"
    "return i})},"
    "mfCustomFolderColor=(e,t)=>{"
    "let n=document.createElement(`input`);"
    "n.type=`color`,"
    "n.value=mfFolderColors[mfFolderKey(e,t)]||`#5B8DEF`,"
    "n.style.position=`fixed`,"
    "n.style.opacity=`0`,"
    "n.style.pointerEvents=`none`,"
    "document.body.appendChild(n),"
    "n.addEventListener(`change`,()=>{"
    "mfSetFolderColor(e,t,n.value),n.remove()},{once:!0}),"
    "n.addEventListener(`cancel`,()=>n.remove(),{once:!0}),"
    "n.click()},"
    "[R,z]=(0,H.useState)(null)"
)

replace_once(
    state_anchor,
    state_replacement,
    "folder color state/localStorage"
)


# ============================================================
# 4. Favorites folder icon.
#    Only the icon is changed.
# ============================================================

favorite_icon_old = (
    "children:Nr(c,f?.special_use,d.folder_mappings)"
)

favorite_icon_new = (
    "children:MailFlowFolderIcon("
    "Nr(c,f?.special_use,d.folder_mappings),"
    "mfFolderColors[mfFolderKey(s,c)])"
)

replace_once(
    favorite_icon_old,
    favorite_icon_new,
    "Favorites folder icon"
)


# ============================================================
# 5. Normal folder-tree icon.
# ============================================================

folder_icon_old = (
    "children:Nr(g.path,g.special_use,t.folder_mappings)"
)

folder_icon_new = (
    "children:MailFlowFolderIcon("
    "Nr(g.path,g.special_use,t.folder_mappings),"
    "mfFolderColors[mfFolderKey(t.id,g.path)])"
)

replace_once(
    folder_icon_old,
    folder_icon_new,
    "normal folder icon"
)


# ============================================================
# 6. Add Color > to shared folder context menu.
#    Because Favorites and tree folders use this same menu,
#    both receive the same Color submenu.
# ============================================================

color_anchor = (
    "}}]:[],{separator:!0},"
    "{label:e(`sidebar.folderMenu.rename`)"
)

color_item = (
    "}}]:[],"
    "{label:`Color`,"
    "icon:(0,J.jsx)(`svg`,{"
    "width:`14`,height:`14`,viewBox:`0 0 24 24`,"
    "fill:mfFolderColors[mfFolderKey(t,r.path)]||`none`,"
    "stroke:mfFolderColors[mfFolderKey(t,r.path)]||`currentColor`,"
    "strokeWidth:`1.75`,"
    "children:(0,J.jsx)(`circle`,{cx:`12`,cy:`12`,r:`7`})"
    "}),"
    "hasSubmenu:!0,"
    "keepOpen:!0,"
    "action:()=>mfSetColorMenu({"
    "x:Oe.x+214,y:Oe.y,accountId:t,path:r.path"
    "})},"
    "{separator:!0},"
    "{label:e(`sidebar.folderMenu.rename`)"
)

replace_once(
    color_anchor,
    color_item,
    "Color context-menu item"
)


# ============================================================
# 7. Render the actual color submenu.
# ============================================================

render_anchor = (
    ")(Oe.accountId,Oe.folderObj),"
    "onClose:()=>ke(null)}),"
    "U&&"
)

render_replacement = (
    ")(Oe.accountId,Oe.folderObj),"
    "onClose:()=>ke(null)}),"
    "mfColorMenu&&(0,J.jsx)(MailFlowFolderColorMenu,{"
    "x:mfColorMenu.x,"
    "y:mfColorMenu.y,"
    "current:mfFolderColors["
    "mfFolderKey(mfColorMenu.accountId,mfColorMenu.path)],"
    "onPick:e=>{"
    "mfSetFolderColor(mfColorMenu.accountId,mfColorMenu.path,e),"
    "mfSetColorMenu(null),ke(null)},"
    "onCustom:()=>{"
    "let e=mfColorMenu.accountId,t=mfColorMenu.path;"
    "mfCustomFolderColor(e,t),mfSetColorMenu(null),ke(null)},"
    "onReset:()=>{"
    "mfSetFolderColor(mfColorMenu.accountId,mfColorMenu.path,null),"
    "mfSetColorMenu(null),ke(null)},"
    "onClose:()=>mfSetColorMenu(null)"
    "}),"
    "U&&"
)

replace_once(
    render_anchor,
    render_replacement,
    "color submenu render"
)


# ============================================================
# Final internal verification.
# ============================================================

required = [
    "mailflow_folder_colors",
    "MailFlowFolderIcon(",
    "MailFlowFolderColorMenu",
    "Custom color...",
    "Reset color",
    "hasSubmenu:!0",
    "#5B8DEF",
    "#8A91A8",
]

for marker in required:
    if marker not in data:
        raise SystemExit(f"ERROR: final marker missing: {marker}")

path.write_text(data, encoding="utf-8")

print("Folder Colors: PATCHED")
