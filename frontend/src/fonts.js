// Each font set defines:
//   sans  — UI chrome, body text, message list
//   mono  — code, headers display, email metadata
//   display — headings, subject lines (can be serif/expressive)

export const FONT_SETS = {
  default: {
    label: 'MailFlow Default',
    description: 'DM Sans × Fraunces — refined and contemporary',
    preview: { heading: 'Fraunces', body: 'DM Sans', mono: 'JetBrains Mono' },
    vars: {
      '--font-sans': "'DM Sans', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Fraunces', serif",
    },
  },

  editorial: {
    label: 'Editorial',
    description: 'Playfair Display × Lato — newspaper gravitas',
    preview: { heading: 'Playfair Display', body: 'Lato', mono: 'Fira Code' },
    vars: {
      '--font-sans': "'Lato', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Playfair Display', serif",
    },
  },

  geometric: {
    label: 'Geometric',
    description: 'Outfit × Plus Jakarta Sans — clean and modern',
    preview: { heading: 'Outfit', body: 'Plus Jakarta Sans', mono: 'Space Mono' },
    vars: {
      '--font-sans': "'Plus Jakarta Sans', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Outfit', sans-serif",
    },
  },

  humanist: {
    label: 'Humanist',
    description: 'Libre Baskerville × Mulish — warm and readable',
    preview: { heading: 'Libre Baskerville', body: 'Mulish', mono: 'Inconsolata' },
    vars: {
      '--font-sans': "'Mulish', sans-serif",
      '--font-mono': "'Inconsolata', monospace",
      '--font-display': "'Libre Baskerville', serif",
    },
  },

  grotesque: {
    label: 'Grotesque',
    description: 'Syne × IBM Plex Sans — Swiss-style precision',
    preview: { heading: 'Syne', body: 'IBM Plex Sans', mono: 'IBM Plex Mono' },
    vars: {
      '--font-sans': "'IBM Plex Sans', sans-serif",
      '--font-mono': "'IBM Plex Mono', monospace",
      '--font-display': "'Syne', sans-serif",
    },
  },

  literary: {
    label: 'Literary',
    description: 'Cormorant × Raleway — elegant and expressive',
    preview: { heading: 'Cormorant Garamond', body: 'Raleway', mono: 'Courier Prime' },
    vars: {
      '--font-sans': "'Raleway', sans-serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cormorant Garamond', serif",
    },
  },

  technical: {
    label: 'Technical',
    description: 'Geist × Geist Mono — developer aesthetic',
    preview: { heading: 'Geist', body: 'Geist', mono: 'Geist Mono' },
    vars: {
      '--font-sans': "'Geist', sans-serif",
      '--font-mono': "'Geist Mono', monospace",
      '--font-display': "'Geist', sans-serif",
    },
  },

  rounded: {
    label: 'Rounded',
    description: 'Quicksand × Nunito — friendly and approachable',
    preview: { heading: 'Quicksand', body: 'Nunito', mono: 'Fira Code' },
    vars: {
      '--font-sans': "'Nunito', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Quicksand', sans-serif",
    },
  },

  academic: {
    label: 'Academic',
    description: 'EB Garamond × Source Sans — scholarly and timeless',
    preview: { heading: 'EB Garamond', body: 'Source Sans 3', mono: 'Source Code Pro' },
    vars: {
      '--font-sans': "'Source Sans 3', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'EB Garamond', serif",
    },
  },

  futurist: {
    label: 'Futurist',
    description: 'Space Grotesk × Oxanium — sci-fi forward',
    preview: { heading: 'Oxanium', body: 'Space Grotesk', mono: 'Space Mono' },
    vars: {
      '--font-sans': "'Space Grotesk', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Oxanium', sans-serif",
    },
  },

  bodoni: {
    label: 'Bodoni',
    description: 'Bodoni Moda × Karla — high-contrast classical elegance',
    preview: { heading: 'Bodoni Moda', body: 'Karla', mono: 'JetBrains Mono' },
    vars: {
      '--font-sans': "'Karla', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Bodoni Moda', serif",
    },
  },

  poppins: {
    label: 'Poppins',
    description: 'Poppins — geometric rounded modern',
    preview: { heading: 'Poppins', body: 'Poppins', mono: 'Fira Code' },
    vars: {
      '--font-sans': "'Poppins', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Poppins', sans-serif",
    },
  },

  cinzel: {
    label: 'Cinzel',
    description: 'Cinzel × Spectral — Roman classical authority',
    preview: { heading: 'Cinzel', body: 'Spectral', mono: 'Courier Prime' },
    vars: {
      '--font-sans': "'Spectral', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cinzel', serif",
    },
  },

  typewriter: {
    label: 'Typewriter',
    description: 'Special Elite × Crimson Pro — vintage press feel',
    preview: { heading: 'Special Elite', body: 'Crimson Pro', mono: 'Courier Prime' },
    vars: {
      '--font-sans': "'Crimson Pro', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Special Elite', cursive",
    },
  },

  newspaper: {
    label: 'Newspaper',
    description: 'Oswald × Lora — bold editorial contrast',
    preview: { heading: 'Oswald', body: 'Lora', mono: 'Courier Prime' },
    vars: {
      '--font-sans': "'Lora', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Oswald', sans-serif",
    },
  },

  magazine: {
    label: 'Magazine',
    description: 'Abril Fatface × Barlow — glossy bold impact',
    preview: { heading: 'Abril Fatface', body: 'Barlow', mono: 'Fira Code' },
    vars: {
      '--font-sans': "'Barlow', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Abril Fatface', cursive",
    },
  },


  swiss: {
    label: 'Swiss',
    description: 'Onest × Figtree — neutral Swiss modernism',
    preview: { heading: 'Onest', body: 'Figtree', mono: 'Space Mono' },
    vars: {
      '--font-sans': "'Figtree', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Onest', sans-serif",
    },
  },

  manrope: {
    label: 'Manrope',
    description: 'Manrope — geometric grotesk unity',
    preview: { heading: 'Manrope', body: 'Manrope', mono: 'JetBrains Mono' },
    vars: {
      '--font-sans': "'Manrope', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Manrope', sans-serif",
    },
  },

  studio: {
    label: 'Studio',
    description: 'Bebas Neue × Barlow — bold branding energy',
    preview: { heading: 'Bebas Neue', body: 'Barlow', mono: 'Space Mono' },
    vars: {
      '--font-sans': "'Barlow', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Bebas Neue', sans-serif",
    },
  },

  ink: {
    label: 'Ink',
    description: 'Merriweather × Merriweather Sans — warm print companion',
    preview: { heading: 'Merriweather', body: 'Merriweather Sans', mono: 'Inconsolata' },
    vars: {
      '--font-sans': "'Merriweather Sans', sans-serif",
      '--font-mono': "'Inconsolata', monospace",
      '--font-display': "'Merriweather', serif",
    },
  },

  atlas: {
    label: 'Atlas',
    description: 'Josefin Slab × Josefin Sans — geometric slab harmony',
    preview: { heading: 'Josefin Slab', body: 'Josefin Sans', mono: 'Space Mono' },
    vars: {
      '--font-sans': "'Josefin Sans', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Josefin Slab', serif",
    },
  },

  noto: {
    label: 'Noto',
    description: 'Noto Serif × Noto Sans — universal multilingual clarity',
    preview: { heading: 'Noto Serif', body: 'Noto Sans', mono: 'Noto Sans Mono' },
    vars: {
      '--font-sans': "'Noto Sans', sans-serif",
      '--font-mono': "'Noto Sans Mono', monospace",
      '--font-display': "'Noto Serif', serif",
    },
  },

  heritage: {
    label: 'Heritage',
    description: 'Cardo × Cabin — old-world serif meets modern sans',
    preview: { heading: 'Cardo', body: 'Cabin', mono: 'Courier Prime' },
    vars: {
      '--font-sans': "'Cabin', sans-serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cardo', serif",
    },
  },

  gothic: {
    label: 'Gothic',
    description: 'Cinzel Decorative × Lora — ornate and ceremonial',
    preview: { heading: 'Cinzel Decorative', body: 'Lora', mono: 'Courier Prime' },
    vars: {
      '--font-sans': "'Lora', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cinzel Decorative', serif",
    },
  },

  retro: {
    label: 'Retro',
    description: 'Pacifico × Josefin Sans — playful vintage charm',
    preview: { heading: 'Pacifico', body: 'Josefin Sans', mono: 'Special Elite' },
    vars: {
      '--font-sans': "'Josefin Sans', sans-serif",
      '--font-mono': "'Special Elite', cursive",
      '--font-display': "'Pacifico', cursive",
    },
  },

  yeseva: {
    label: 'Display',
    description: 'Yeseva One × Karla — dramatic display contrast',
    preview: { heading: 'Yeseva One', body: 'Karla', mono: 'Fira Code' },
    vars: {
      '--font-sans': "'Karla', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Yeseva One', serif",
    },
  },

  terminal: {
    label: 'Terminal',
    description: 'Share Tech Mono — pure monospace terminal',
    preview: { heading: 'Share Tech Mono', body: 'Share Tech Mono', mono: 'Share Tech Mono' },
    vars: {
      '--font-sans': "'Share Tech Mono', monospace",
      '--font-mono': "'Share Tech Mono', monospace",
      '--font-display': "'Share Tech Mono', monospace",
    },
  },

  pt: {
    label: 'PT Classic',
    description: 'PT Serif × PT Sans — Russian typographic tradition',
    preview: { heading: 'PT Serif', body: 'PT Sans', mono: 'PT Mono' },
    vars: {
      '--font-sans': "'PT Sans', sans-serif",
      '--font-mono': "'PT Mono', monospace",
      '--font-display': "'PT Serif', serif",
    },
  },

  marcellus: {
    label: 'Marcellus',
    description: 'Marcellus SC × Open Sans — small caps authority',
    preview: { heading: 'Marcellus SC', body: 'Open Sans', mono: 'Source Code Pro' },
    vars: {
      '--font-sans': "'Open Sans', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'Marcellus SC', serif",
    },
  },

  monochrome: {
    label: 'Monochrome',
    description: 'JetBrains Mono — pure programmer aesthetic',
    preview: { heading: 'JetBrains Mono', body: 'JetBrains Mono', mono: 'JetBrains Mono' },
    vars: {
      '--font-sans': "'JetBrains Mono', monospace",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'JetBrains Mono', monospace",
    },
  },

  rozha: {
    label: 'Rozha',
    description: 'Rozha One × Barlow — bold Indian type meets European sans',
    preview: { heading: 'Rozha One', body: 'Barlow', mono: 'Fira Code' },
    vars: {
      '--font-sans': "'Barlow', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Rozha One', serif",
    },
  },

  spectral: {
    label: 'Spectral',
    description: 'Spectral × Lato — screen-optimized serif',
    preview: { heading: 'Spectral', body: 'Lato', mono: 'Source Code Pro' },
    vars: {
      '--font-sans': "'Lato', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'Spectral', serif",
    },
  },

  work: {
    label: 'Work Sans',
    description: 'Work Sans — clean variable workhorse',
    preview: { heading: 'Work Sans', body: 'Work Sans', mono: 'JetBrains Mono' },
    vars: {
      '--font-sans': "'Work Sans', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Work Sans', sans-serif",
    },
  },

  neuton: {
    label: 'Neuton',
    description: 'Neuton × Hind — refined book serif',
    preview: { heading: 'Neuton', body: 'Hind', mono: 'Inconsolata' },
    vars: {
      '--font-sans': "'Hind', sans-serif",
      '--font-mono': "'Inconsolata', monospace",
      '--font-display': "'Neuton', serif",
    },
  },

  cabin: {
    label: 'Cabin',
    description: 'Cabin — humanist sans crafted for digital',
    preview: { heading: 'Cabin', body: 'Cabin', mono: 'Source Code Pro' },
    vars: {
      '--font-sans': "'Cabin', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'Cabin', sans-serif",
    },
  },
};

// Fonts are self-hosted and declared up front in public/fonts/fonts.css (loaded from
// index.html), so there is nothing to fetch at runtime. Kept as an exported no-op
// because AdminPanel still imports it. A declared @font-face never downloads until the
// active font-family references it, so switching sets costs no network request.
export function loadFontSet() {}

// Apply a font set: update the CSS custom properties. The self-hosted @font-face rules
// are already present, so the browser lazy-loads only the active set's files.
export function applyFontSet(fontKey) {
  const set = FONT_SETS[fontKey] || FONT_SETS.default;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(set.vars)) {
    root.style.setProperty(key, value);
  }
}

// Font size scaling is applied reactively in MailApp via the store's fontSize
// value using CSS transform, so no root-level changes are needed here.
export function applyFontSize() {}
