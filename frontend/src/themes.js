export const THEMES = {
  dark: {
    label: 'Dark',
    description: 'Default dark theme',
    preview: ['#0f0f11', '#161619', '#7c6af7', '#e8e8ed'],
    vars: {
      '--bg-primary': '#0f0f11',
      '--bg-secondary': '#161619',
      '--bg-tertiary': '#1e1e23',
      '--bg-elevated': '#242429',
      '--bg-hover': '#2a2a30',
      '--border': '#2e2e35',
      '--border-subtle': '#232328',
      '--text-primary': '#e8e8ed',
      '--text-secondary': '#9898a8',
      '--text-tertiary': '#5a5a6a',
      '--accent': '#7c6af7',
      '--accent-dim': '#3d3569',
      '--accent-glow': 'rgba(124,106,247,0.15)',
      '--green': '#4ade80',
      '--red': '#f87171',
      '--amber': '#fbbf24',
    }
  },

  light: {
    label: 'Light',
    description: 'Clean light theme',
    preview: ['#f8f8fc', '#ffffff', '#6366f1', '#1a1a2e'],
    vars: {
      '--bg-primary': '#f0f0f5',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#f5f5fa',
      '--bg-elevated': '#ffffff',
      '--bg-hover': '#ebebf5',
      '--border': '#d8d8e8',
      '--border-subtle': '#e8e8f0',
      '--text-primary': '#1a1a2e',
      '--text-secondary': '#4a4a6a',
      '--text-tertiary': '#8888aa',
      '--accent': '#6366f1',
      '--accent-dim': '#e0e0ff',
      '--accent-glow': 'rgba(99,102,241,0.12)',
      '--green': '#16a34a',
      '--red': '#dc2626',
      '--amber': '#d97706',
    }
  },

  gruvbox: {
    label: 'Gruvbox',
    description: 'Retro groove',
    preview: ['#282828', '#3c3836', '#d79921', '#ebdbb2'],
    vars: {
      '--bg-primary': '#1d2021',
      '--bg-secondary': '#282828',
      '--bg-tertiary': '#32302f',
      '--bg-elevated': '#3c3836',
      '--bg-hover': '#504945',
      '--border': '#504945',
      '--border-subtle': '#3c3836',
      '--text-primary': '#ebdbb2',
      '--text-secondary': '#d5c4a1',
      '--text-tertiary': '#928374',
      '--accent': '#d79921',
      '--accent-dim': '#3c3401',
      '--accent-glow': 'rgba(215,153,33,0.15)',
      '--green': '#b8bb26',
      '--red': '#fb4934',
      '--amber': '#fe8019',
    }
  },

  catppuccin_mocha: {
    label: 'Catppuccin Mocha',
    description: 'Soothing pastel dark',
    preview: ['#1e1e2e', '#181825', '#cba6f7', '#cdd6f4'],
    vars: {
      '--bg-primary': '#1e1e2e',
      '--bg-secondary': '#181825',
      '--bg-tertiary': '#313244',
      '--bg-elevated': '#45475a',
      '--bg-hover': '#585b70',
      '--border': '#45475a',
      '--border-subtle': '#313244',
      '--text-primary': '#cdd6f4',
      '--text-secondary': '#bac2de',
      '--text-tertiary': '#6c7086',
      '--accent': '#cba6f7',
      '--accent-dim': '#2a1f3d',
      '--accent-glow': 'rgba(203,166,247,0.15)',
      '--green': '#a6e3a1',
      '--red': '#f38ba8',
      '--amber': '#fab387',
    }
  },

  catppuccin_latte: {
    label: 'Catppuccin Latte',
    description: 'Soothing pastel light',
    preview: ['#eff1f5', '#e6e9ef', '#8839ef', '#4c4f69'],
    vars: {
      '--bg-primary': '#eff1f5',
      '--bg-secondary': '#e6e9ef',
      '--bg-tertiary': '#dce0e8',
      '--bg-elevated': '#ffffff',
      '--bg-hover': '#ccd0da',
      '--border': '#ccd0da',
      '--border-subtle': '#dce0e8',
      '--text-primary': '#4c4f69',
      '--text-secondary': '#5c5f77',
      '--text-tertiary': '#9ca0b0',
      '--accent': '#8839ef',
      '--accent-dim': '#e5d4fc',
      '--accent-glow': 'rgba(136,57,239,0.1)',
      '--green': '#40a02b',
      '--red': '#d20f39',
      '--amber': '#df8e1d',
    }
  },

  nord: {
    label: 'Nord',
    description: 'Arctic, north-bluish',
    preview: ['#2e3440', '#3b4252', '#88c0d0', '#eceff4'],
    vars: {
      '--bg-primary': '#2e3440',
      '--bg-secondary': '#3b4252',
      '--bg-tertiary': '#434c5e',
      '--bg-elevated': '#4c566a',
      '--bg-hover': '#5a6477',
      '--border': '#4c566a',
      '--border-subtle': '#434c5e',
      '--text-primary': '#eceff4',
      '--text-secondary': '#e5e9f0',
      '--text-tertiary': '#7b88a1',
      '--accent': '#88c0d0',
      '--accent-dim': '#1e3040',
      '--accent-glow': 'rgba(136,192,208,0.15)',
      '--green': '#a3be8c',
      '--red': '#bf616a',
      '--amber': '#ebcb8b',
    }
  },

  tokyo_night: {
    label: 'Tokyo Night',
    description: 'City lights after dark',
    preview: ['#1a1b26', '#16161e', '#7aa2f7', '#c0caf5'],
    vars: {
      '--bg-primary': '#1a1b26',
      '--bg-secondary': '#16161e',
      '--bg-tertiary': '#1f2335',
      '--bg-elevated': '#24283b',
      '--bg-hover': '#292e42',
      '--border': '#292e42',
      '--border-subtle': '#1f2335',
      '--text-primary': '#c0caf5',
      '--text-secondary': '#a9b1d6',
      '--text-tertiary': '#565f89',
      '--accent': '#7aa2f7',
      '--accent-dim': '#1a2342',
      '--accent-glow': 'rgba(122,162,247,0.15)',
      '--green': '#9ece6a',
      '--red': '#f7768e',
      '--amber': '#e0af68',
    }
  },

  solarized: {
    label: 'Solarized Dark',
    description: 'Precision colors for machines',
    preview: ['#002b36', '#073642', '#268bd2', '#839496'],
    vars: {
      '--bg-primary': '#002b36',
      '--bg-secondary': '#073642',
      '--bg-tertiary': '#083f4d',
      '--bg-elevated': '#0a4555',
      '--bg-hover': '#0d5060',
      '--border': '#0d5060',
      '--border-subtle': '#083f4d',
      '--text-primary': '#839496',
      '--text-secondary': '#657b83',
      '--text-tertiary': '#4a6068',
      '--accent': '#268bd2',
      '--accent-dim': '#0a2a3d',
      '--accent-glow': 'rgba(38,139,210,0.15)',
      '--green': '#859900',
      '--red': '#dc322f',
      '--amber': '#b58900',
    }
  },

  dracula: {
    label: 'Dracula',
    description: 'Dark theme for the night owl',
    preview: ['#282a36', '#1e1f29', '#bd93f9', '#f8f8f2'],
    vars: {
      '--bg-primary': '#282a36',
      '--bg-secondary': '#1e1f29',
      '--bg-tertiary': '#313244',
      '--bg-elevated': '#44475a',
      '--bg-hover': '#4d5068',
      '--border': '#44475a',
      '--border-subtle': '#313244',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#e0e0e8',
      '--text-tertiary': '#6272a4',
      '--accent': '#bd93f9',
      '--accent-dim': '#2a1f45',
      '--accent-glow': 'rgba(189,147,249,0.15)',
      '--green': '#50fa7b',
      '--red': '#ff5555',
      '--amber': '#ffb86c',
    }
  },

  rose_pine: {
    label: 'Rosé Pine',
    description: 'All natural pine, faux fur',
    preview: ['#191724', '#1f1d2e', '#c4a7e7', '#e0def4'],
    vars: {
      '--bg-primary': '#191724',
      '--bg-secondary': '#1f1d2e',
      '--bg-tertiary': '#26233a',
      '--bg-elevated': '#2a2837',
      '--bg-hover': '#31304a',
      '--border': '#31304a',
      '--border-subtle': '#26233a',
      '--text-primary': '#e0def4',
      '--text-secondary': '#c5c3d6',
      '--text-tertiary': '#6e6a86',
      '--accent': '#c4a7e7',
      '--accent-dim': '#2a1f3d',
      '--accent-glow': 'rgba(196,167,231,0.15)',
      '--green': '#9ccfd8',
      '--red': '#eb6f92',
      '--amber': '#f6c177',
    }
  },

  midnight_blue: {
    label: 'Midnight Blue',
    description: 'Deep navy with electric blue — bold and immersive',
    preview: ['#070d1a', '#0d1629', '#3b9eff', '#c8e0ff'],
    vars: {
      '--bg-primary': '#070d1a',
      '--bg-secondary': '#0d1629',
      '--bg-tertiary': '#112040',
      '--bg-elevated': '#162850',
      '--bg-hover': '#1c3060',
      '--border': '#1c3060',
      '--border-subtle': '#112040',
      '--text-primary': '#c8e0ff',
      '--text-secondary': '#7aacff',
      '--text-tertiary': '#3a5880',
      '--accent': '#3b9eff',
      '--accent-dim': '#0a1e40',
      '--accent-glow': 'rgba(59,158,255,0.15)',
      '--green': '#4ade80',
      '--red': '#f87171',
      '--amber': '#fbbf24',
    }
  },

  cyberpunk: {
    label: 'Cyberpunk',
    description: 'Dark neon with hot pink — electric and futuristic',
    preview: ['#0a0010', '#110020', '#ff00aa', '#f0d0ff'],
    vars: {
      '--bg-primary': '#0a0010',
      '--bg-secondary': '#110020',
      '--bg-tertiary': '#1a0030',
      '--bg-elevated': '#240040',
      '--bg-hover': '#2e0050',
      '--border': '#3d0070',
      '--border-subtle': '#1a0030',
      '--text-primary': '#f0d0ff',
      '--text-secondary': '#c080ff',
      '--text-tertiary': '#803080',
      '--accent': '#ff00aa',
      '--accent-dim': '#3d0025',
      '--accent-glow': 'rgba(255,0,170,0.18)',
      '--green': '#00ff9d',
      '--red': '#ff3860',
      '--amber': '#ffdd00',
    }
  },

  forest: {
    label: 'Forest',
    description: 'Deep green with emerald — lush and organic',
    preview: ['#0a1a0d', '#0f2214', '#00c896', '#c8f0d0'],
    vars: {
      '--bg-primary': '#0a1a0d',
      '--bg-secondary': '#0f2214',
      '--bg-tertiary': '#152d1a',
      '--bg-elevated': '#1c3a21',
      '--bg-hover': '#244a2a',
      '--border': '#244a2a',
      '--border-subtle': '#152d1a',
      '--text-primary': '#c8f0d0',
      '--text-secondary': '#7acc90',
      '--text-tertiary': '#3a6644',
      '--accent': '#00c896',
      '--accent-dim': '#003325',
      '--accent-glow': 'rgba(0,200,150,0.15)',
      '--green': '#5af0a0',
      '--red': '#ff6b6b',
      '--amber': '#ffd166',
    }
  },

  sunset: {
    label: 'Sunset',
    description: 'Warm dark amber with golden orange — rich and warm',
    preview: ['#130b00', '#1e1100', '#ff9900', '#ffe8c8'],
    vars: {
      '--bg-primary': '#130b00',
      '--bg-secondary': '#1e1100',
      '--bg-tertiary': '#2a1800',
      '--bg-elevated': '#382200',
      '--bg-hover': '#452c00',
      '--border': '#503500',
      '--border-subtle': '#2a1800',
      '--text-primary': '#ffe8c8',
      '--text-secondary': '#e0b880',
      '--text-tertiary': '#805030',
      '--accent': '#ff9900',
      '--accent-dim': '#3d2200',
      '--accent-glow': 'rgba(255,153,0,0.15)',
      '--green': '#7cb87a',
      '--red': '#ff5555',
      '--amber': '#ffcc44',
    }
  },

  executive: {
    label: 'Executive',
    description: 'Dark navy with antique gold — formal and authoritative',
    preview: ['#0a0d1a', '#101525', '#c8a840', '#ddd0b0'],
    vars: {
      '--bg-primary': '#0a0d1a',
      '--bg-secondary': '#101525',
      '--bg-tertiary': '#161d32',
      '--bg-elevated': '#1e273f',
      '--bg-hover': '#25304e',
      '--border': '#2c3a5a',
      '--border-subtle': '#161d32',
      '--text-primary': '#ddd0b0',
      '--text-secondary': '#b0a080',
      '--text-tertiary': '#605840',
      '--accent': '#c8a840',
      '--accent-dim': '#2d2000',
      '--accent-glow': 'rgba(200,168,64,0.15)',
      '--green': '#6ab87a',
      '--red': '#c85050',
      '--amber': '#d4933a',
    }
  },

  parchment: {
    label: 'Parchment',
    description: 'Cream and sepia — classic and scholarly',
    preview: ['#f5f0e8', '#ede7d8', '#8b4513', '#2a1f10'],
    vars: {
      '--bg-primary': '#f5f0e8',
      '--bg-secondary': '#ede7d8',
      '--bg-tertiary': '#e5ddc8',
      '--bg-elevated': '#f8f4ec',
      '--bg-hover': '#ddd5c0',
      '--border': '#c8bea8',
      '--border-subtle': '#e0d8c5',
      '--text-primary': '#2a1f10',
      '--text-secondary': '#5a4830',
      '--text-tertiary': '#9a8868',
      '--accent': '#8b4513',
      '--accent-dim': '#f0e8d8',
      '--accent-glow': 'rgba(139,69,19,0.12)',
      '--green': '#3a7a3a',
      '--red': '#9a2020',
      '--amber': '#b87820',
    }
  },

  slate_pro: {
    label: 'Slate Pro',
    description: 'Blue-grey with sky blue — professional and crisp',
    preview: ['#1a1f2e', '#1f2540', '#4a90d9', '#d0d8f0'],
    vars: {
      '--bg-primary': '#1a1f2e',
      '--bg-secondary': '#1f2540',
      '--bg-tertiary': '#252c4a',
      '--bg-elevated': '#2c3455',
      '--bg-hover': '#333d64',
      '--border': '#3a4570',
      '--border-subtle': '#252c4a',
      '--text-primary': '#d0d8f0',
      '--text-secondary': '#90a0c8',
      '--text-tertiary': '#505880',
      '--accent': '#4a90d9',
      '--accent-dim': '#0a1a30',
      '--accent-glow': 'rgba(74,144,217,0.15)',
      '--green': '#5ab880',
      '--red': '#e86060',
      '--amber': '#dba840',
    }
  },

  monokai: {
    label: 'Monokai',
    description: 'The classic developer color scheme',
    preview: ['#272822', '#1e1f1a', '#ae81ff', '#f8f8f2'],
    vars: {
      '--bg-primary': '#272822',
      '--bg-secondary': '#1e1f1a',
      '--bg-tertiary': '#2d2e27',
      '--bg-elevated': '#383930',
      '--bg-hover': '#44453c',
      '--border': '#44453c',
      '--border-subtle': '#2d2e27',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#cfcfc2',
      '--text-tertiary': '#75715e',
      '--accent': '#ae81ff',
      '--accent-dim': '#2a1f45',
      '--accent-glow': 'rgba(174,129,255,0.15)',
      '--green': '#a6e22e',
      '--red': '#f92672',
      '--amber': '#e6db74',
    }
  },

  high_contrast: {
    label: 'High Contrast',
    description: 'Pure black with vivid yellow — maximum readability',
    preview: ['#000000', '#0a0a0a', '#f5e642', '#ffffff'],
    vars: {
      '--bg-primary': '#000000',
      '--bg-secondary': '#0a0a0a',
      '--bg-tertiary': '#111111',
      '--bg-elevated': '#1a1a1a',
      '--bg-hover': '#222222',
      '--border': '#333333',
      '--border-subtle': '#1a1a1a',
      '--text-primary': '#ffffff',
      '--text-secondary': '#cccccc',
      '--text-tertiary': '#888888',
      '--accent': '#f5e642',
      '--accent-dim': '#2a2600',
      '--accent-glow': 'rgba(245,230,66,0.15)',
      '--green': '#00ff00',
      '--red': '#ff4444',
      '--amber': '#ffaa00',
    }
  },

  espresso: {
    label: 'Espresso',
    description: 'Coffee brown with copper — warm and inviting',
    preview: ['#1a1008', '#221508', '#d4773a', '#f5e8d0'],
    vars: {
      '--bg-primary': '#1a1008',
      '--bg-secondary': '#221508',
      '--bg-tertiary': '#2e1d0d',
      '--bg-elevated': '#3c2714',
      '--bg-hover': '#4a321c',
      '--border': '#5a3d22',
      '--border-subtle': '#2e1d0d',
      '--text-primary': '#f5e8d0',
      '--text-secondary': '#d0b080',
      '--text-tertiary': '#806040',
      '--accent': '#d4773a',
      '--accent-dim': '#3d1800',
      '--accent-glow': 'rgba(212,119,58,0.15)',
      '--green': '#7aaa6a',
      '--red': '#d45555',
      '--amber': '#e0a040',
    }
  },
};

// ── Color helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function lighten(hex, t) {
  return '#' + hexToRgb(hex)
    .map(c => Math.min(255, Math.round(c + (255 - c) * t)).toString(16).padStart(2, '0'))
    .join('');
}

function darken(hex, t) {
  return '#' + hexToRgb(hex)
    .map(c => Math.round(c * (1 - t)).toString(16).padStart(2, '0'))
    .join('');
}

function buildFaviconSvg(accent) {
  const light = lighten(accent, 0.25);
  const dark  = darken(accent, 0.30);
  const [dr, dg, db] = hexToRgb(dark);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${light}"/>
      <stop offset="100%" stop-color="${dark}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.14)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
    <clipPath id="ec">
      <rect x="5" y="10.5" width="22" height="15" rx="2.5"/>
    </clipPath>
  </defs>
  <rect width="32" height="32" rx="7.5" fill="url(#bg)"/>
  <rect width="32" height="16" rx="7.5" fill="url(#shine)"/>
  <rect x="5" y="11.5" width="22" height="15" rx="2.5" fill="rgba(0,0,0,0.18)"/>
  <rect x="5" y="10.5" width="22" height="15" rx="2.5" fill="white"/>
  <path d="M5,10.5 L16,20.5 L27,10.5 Z" fill="rgba(${dr},${dg},${db},0.10)" clip-path="url(#ec)"/>
  <path d="M5,10.5 L16,20.5 L27,10.5" fill="none" stroke="rgba(${dr},${dg},${db},0.38)" stroke-width="1.4" stroke-linejoin="round" clip-path="url(#ec)"/>
  <line x1="5" y1="25.5" x2="13" y2="20" stroke="rgba(${dr},${dg},${db},0.16)" stroke-width="1.1"/>
  <line x1="27" y1="25.5" x2="19" y2="20" stroke="rgba(${dr},${dg},${db},0.16)" stroke-width="1.1"/>
</svg>`;
}

// ── Theme application ─────────────────────────────────────────────────────────

export function applyTheme(themeName) {
  const theme = THEMES[themeName] || THEMES.dark;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }

  // Update browser tab favicon to match the active accent colour.
  // Remove and re-add the element — browsers (especially Chrome) ignore href
  // changes on an existing <link rel="icon"> due to aggressive favicon caching.
  const accent = theme.vars['--accent'];
  if (accent && accent.startsWith('#')) {
    const svgStr = buildFaviconSvg(accent);
    const dataUri = 'data:image/svg+xml,' + encodeURIComponent(svgStr);
    document.querySelectorAll("link[rel~='icon']").forEach(l => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = dataUri;
    document.head.appendChild(link);
  }
}
