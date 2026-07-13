import { useEffect, useId, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { computeSpriteLayout } from '../utils/gtd.js';

// Inbox-zero pet: a configured imported pet when one is set and its cached assets
// load, otherwise the built-in SVG dog. Static at rest, animated on hover (CSS, not
// video, so it can respond to hover). The dog is the fallback for no-pet, a meta load
// failure, and a spritesheet load error — there is never a broken-image state.
export default function GtdZeroPet({ size = 104 }) {
  const petSlug = useStore(s => s.gtdPetSlug);
  const [meta, setMeta] = useState(null);        // null = loading/none, object = loaded, 'error'
  const [sheetFailed, setSheetFailed] = useState(false);

  useEffect(() => {
    if (!petSlug) { setMeta(null); setSheetFailed(false); return; }
    let cancelled = false;
    setMeta(null);
    setSheetFailed(false);
    api.getGtdPetMeta(petSlug)
      .then(m => { if (!cancelled) setMeta(m && m.descriptor ? m : 'error'); })
      .catch(() => { if (!cancelled) setMeta('error'); });
    return () => { cancelled = true; };
  }, [petSlug]);

  if (petSlug && meta && meta !== 'error' && meta.descriptor && !sheetFailed) {
    return (
      <SpritePet
        slug={petSlug}
        descriptor={meta.descriptor}
        size={size}
        onSheetError={() => setSheetFailed(true)}
      />
    );
  }

  // A configured pet whose meta is still loading renders an empty sized box (no dog
  // flash); no pet, or any load/parse error, renders the dog.
  if (petSlug && meta === null) {
    return <div style={{ width: size, height: size }} aria-hidden="true" />;
  }
  return <DogPet size={size} />;
}

// Sprite pet: one frame shown at rest (the static frame), the hover row looped via
// a CSS steps() background-position animation. Dimensions come from the pure frame-math
// helper; a hidden probe <img> flips to the dog if the sheet fails to load. The class
// and keyframes are scoped to this instance (useId) because the rail and the settings
// preview mount their own GtdZeroPet at different sizes — a shared class or keyframes
// name would let one instance's dimensions win the cascade for both.
function SpritePet({ slug, descriptor, size, onSheetError }) {
  const L = computeSpriteLayout({ ...descriptor, size });
  const sheetUrl = api.gtdPetSheetUrl(slug);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const cls = `gtd-pet-sprite-${uid}`;
  const anim = `gtd-pet-run-${uid}`;
  const duration = Math.max(0.4, L.hoverCount * 0.12);
  return (
    <>
      <style>{`
        .${cls}{
          width:${L.dispW}px;height:${L.dispH}px;cursor:pointer;
          background-image:url(${sheetUrl});background-repeat:no-repeat;
          background-size:${L.bgW}px ${L.bgH}px;
          background-position:${L.staticX}px ${L.staticY}px;
        }
        .${cls}:hover{animation:${anim} ${duration}s steps(${L.hoverCount}) infinite;}
        @keyframes ${anim}{
          from{background-position:${L.hoverX0}px ${L.hoverY}px;}
          to{background-position:${L.hoverX1}px ${L.hoverY}px;}
        }
        @media (prefers-reduced-motion: reduce){.${cls}:hover{animation:none;}}
      `}</style>
      <div className={cls} aria-hidden="true" />
      <img src={sheetUrl} alt="" style={{ display: 'none' }} onError={onSheetError} />
    </>
  );
}

// The approved SVG dog from the GTD mock. Class names are gtd-pet-scoped so the
// keyframes never collide.
function DogPet({ size = 104 }) {
  return (
    <>
      <style>{`
        .gtd-pet{cursor:pointer;animation:gtd-pet-bob 3.2s ease-in-out infinite}
        .gtd-pet:hover{animation:gtd-pet-jump .55s cubic-bezier(.36,.07,.19,.97) infinite}
        .gtd-pet .gtd-pet-tail{transform-origin:36px 82px;animation:gtd-pet-tail 1.8s ease-in-out infinite}
        .gtd-pet:hover .gtd-pet-tail{animation:gtd-pet-tail .22s ease-in-out infinite}
        .gtd-pet .gtd-pet-ear{transform-origin:60px 26px}
        .gtd-pet:hover .gtd-pet-ear{animation:gtd-pet-ear .55s ease-in-out infinite}
        .gtd-pet .gtd-pet-tongue{opacity:0;transition:opacity .15s}
        .gtd-pet:hover .gtd-pet-tongue{opacity:1}
        @keyframes gtd-pet-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
        @keyframes gtd-pet-jump{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-16px) rotate(-4deg)}60%{transform:translateY(0) rotate(2deg)}}
        @keyframes gtd-pet-tail{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(16deg)}}
        @keyframes gtd-pet-ear{0%,100%{transform:rotate(0)}40%{transform:rotate(-13deg)}}
        @media (prefers-reduced-motion: reduce){
          .gtd-pet,.gtd-pet:hover,.gtd-pet .gtd-pet-tail,.gtd-pet:hover .gtd-pet-tail,.gtd-pet:hover .gtd-pet-ear{animation:none}
        }
      `}</style>
      <svg className="gtd-pet" width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
        <g className="gtd-pet-tail"><path d="M38 84 Q20 78 24 60 Q26 51 34 50 Q29 60 35 67 Q41 73 43 80 Z" fill="#C98F4F"/></g>
        <path d="M34 96 Q32 64 54 56 L76 56 Q94 62 92 86 Q91 98 80 100 L46 100 Q36 100 34 96Z" fill="#E8B87D"/>
        <path d="M54 100 Q52 84 60 76 Q68 84 66 100 Z" fill="#F7E7CD"/>
        <rect x="46" y="86" width="10" height="16" rx="5" fill="#E8B87D"/>
        <rect x="64" y="86" width="10" height="16" rx="5" fill="#E8B87D"/>
        <circle cx="74" cy="42" r="24" fill="#E8B87D"/>
        <g className="gtd-pet-ear"><path d="M58 24 Q52 6 64 8 Q72 10 70 25 Q64 21 58 24Z" fill="#C98F4F"/></g>
        <path d="M89 23 Q99 6 105 15 Q109 22 97 31 Q94 25 89 23Z" fill="#C98F4F"/>
        <ellipse cx="81" cy="52" rx="13" ry="10" fill="#F7E7CD"/>
        <circle cx="83" cy="46" r="4" fill="#3a3a42"/>
        <path d="M61 41 q4 -5 8 0" stroke="#3a3a42" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
        <path d="M88 37 q4 -5 8 0" stroke="#3a3a42" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
        <path d="M79 55 q3 5 8 3" stroke="#3a3a42" strokeWidth="2" fill="none" strokeLinecap="round"/>
        <path className="gtd-pet-tongue" d="M83 59 q3 8 -3 9 q-5 1 -4 -6 Z" fill="#f08a9b"/>
        <circle cx="57" cy="49" r="4" fill="rgba(248,113,113,.35)"/>
        <path d="M56 65 L92 65 Q96 69 92 73 L56 73 Q52 69 56 65Z" fill="#2FBD85"/>
        <circle cx="74" cy="76" r="3.4" fill="#F5D547"/>
      </svg>
    </>
  );
}
