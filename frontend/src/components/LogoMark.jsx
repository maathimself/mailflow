// Shared MailFlow logo mark — used in Sidebar and LoginPage.
// Reads the active theme's accent hex directly from THEMES so the SVG colour
// matches var(--accent) without relying on CSS variable resolution in SVG.
import { useStore } from '../store/index.js';
import { THEMES } from '../themes.js';

export default function LogoMark({ size = 32 }) {
  const theme = useStore(s => s.theme);
  const accent = THEMES[theme]?.vars['--accent'] ?? '#7c6af7';

  const id = `lm_${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <defs>
        {/* Tonal overlay: white top-left → dark bottom-right for depth */}
        <linearGradient id={`tonal_${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="rgba(255,255,255,0.22)"/>
          <stop offset="100%" stopColor="rgba(0,0,0,0.28)"/>
        </linearGradient>
        {/* Top-gloss highlight */}
        <linearGradient id={`sh_${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(255,255,255,0.14)"/>
          <stop offset="100%" stopColor="rgba(255,255,255,0)"/>
        </linearGradient>
        <clipPath id={`ec_${id}`}>
          <rect x="5" y="10.5" width="22" height="15" rx="2.5"/>
        </clipPath>
      </defs>

      {/* Background — accent hex passed directly, re-renders when theme changes */}
      <rect width="32" height="32" rx="7.5" fill={accent}/>
      {/* Tonal gradient overlay for depth */}
      <rect width="32" height="32" rx="7.5" fill={`url(#tonal_${id})`}/>
      {/* Top-gloss highlight */}
      <rect width="32" height="16" rx="7.5" fill={`url(#sh_${id})`}/>

      {/* Envelope drop shadow */}
      <rect x="5" y="11.5" width="22" height="15" rx="2.5" fill="rgba(0,0,0,0.18)"/>
      {/* Envelope body */}
      <rect x="5" y="10.5" width="22" height="15" rx="2.5" fill="white"/>

      {/* Flap fold — subtle triangle shading */}
      <path
        d="M5,10.5 L16,20.5 L27,10.5 Z"
        fill="rgba(0,0,0,0.08)"
        clipPath={`url(#ec_${id})`}
      />
      {/* Flap crease line */}
      <path
        d="M5,10.5 L16,20.5 L27,10.5"
        fill="none"
        stroke="rgba(0,0,0,0.28)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        clipPath={`url(#ec_${id})`}
      />

      {/* Bottom corner seam lines */}
      <line x1="5"  y1="25.5" x2="13" y2="20" stroke="rgba(0,0,0,0.14)" strokeWidth="1.1"/>
      <line x1="27" y1="25.5" x2="19" y2="20" stroke="rgba(0,0,0,0.14)" strokeWidth="1.1"/>
    </svg>
  );
}
