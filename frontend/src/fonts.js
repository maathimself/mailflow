// Each font set defines:
//   sans  — UI chrome, body text, message list
//   mono  — code, headers display, email metadata
//   display — headings, subject lines (can be serif/expressive)
//   googleFonts — query string for Google Fonts API

export const FONT_SETS = {
  default: {
    label: 'MailFlow Default',
    description: 'DM Sans × Fraunces — refined and contemporary',
    preview: { heading: 'Fraunces', body: 'DM Sans' },
    vars: {
      '--font-sans': "'DM Sans', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Fraunces', serif",
    },
    googleFonts: 'family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300&family=JetBrains+Mono:wght@400;500',
  },

  editorial: {
    label: 'Editorial',
    description: 'Playfair Display × Lato — newspaper gravitas',
    preview: { heading: 'Playfair Display', body: 'Lato' },
    vars: {
      '--font-sans': "'Lato', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Playfair Display', serif",
    },
    googleFonts: 'family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=Lato:wght@300;400;700&family=Fira+Code:wght@400;500',
  },

  geometric: {
    label: 'Geometric',
    description: 'Outfit × Plus Jakarta Sans — clean and modern',
    preview: { heading: 'Outfit', body: 'Plus Jakarta Sans' },
    vars: {
      '--font-sans': "'Plus Jakarta Sans', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Outfit', sans-serif",
    },
    googleFonts: 'family=Outfit:wght@300;400;500;600&family=Plus+Jakarta+Sans:wght@300;400;500;600&family=Space+Mono:wght@400;700',
  },

  humanist: {
    label: 'Humanist',
    description: 'Nunito × Libre Baskerville — warm and readable',
    preview: { heading: 'Libre Baskerville', body: 'Nunito' },
    vars: {
      '--font-sans': "'Nunito', sans-serif",
      '--font-mono': "'Inconsolata', monospace",
      '--font-display': "'Libre Baskerville', serif",
    },
    googleFonts: 'family=Nunito:wght@300;400;500;600&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inconsolata:wght@400;500',
  },

  grotesque: {
    label: 'Grotesque',
    description: 'Syne × IBM Plex Sans — Swiss-style precision',
    preview: { heading: 'Syne', body: 'IBM Plex Sans' },
    vars: {
      '--font-sans': "'IBM Plex Sans', sans-serif",
      '--font-mono': "'IBM Plex Mono', monospace",
      '--font-display': "'Syne', sans-serif",
    },
    googleFonts: 'family=Syne:wght@400;600;700&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;1,400&family=IBM+Plex+Mono:wght@400;500',
  },

  literary: {
    label: 'Literary',
    description: 'Cormorant × Raleway — elegant and expressive',
    preview: { heading: 'Cormorant Garamond', body: 'Raleway' },
    vars: {
      '--font-sans': "'Raleway', sans-serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cormorant Garamond', serif",
    },
    googleFonts: 'family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Raleway:wght@300;400;500;600&family=Courier+Prime:ital,wght@0,400;1,400',
  },

  technical: {
    label: 'Technical',
    description: 'Geist × Geist Mono — developer aesthetic',
    preview: { heading: 'Geist', body: 'Geist' },
    vars: {
      '--font-sans': "'Geist', sans-serif",
      '--font-mono': "'Geist Mono', monospace",
      '--font-display': "'Geist', sans-serif",
    },
    googleFonts: 'family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500',
  },

  rounded: {
    label: 'Rounded',
    description: 'Quicksand × Nunito — friendly and approachable',
    preview: { heading: 'Quicksand', body: 'Nunito' },
    vars: {
      '--font-sans': "'Nunito', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Quicksand', sans-serif",
    },
    googleFonts: 'family=Quicksand:wght@400;500;600&family=Nunito:wght@300;400;500&family=Fira+Code:wght@400;500',
  },

  academic: {
    label: 'Academic',
    description: 'EB Garamond × Source Sans — scholarly and timeless',
    preview: { heading: 'EB Garamond', body: 'Source Sans 3' },
    vars: {
      '--font-sans': "'Source Sans 3', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'EB Garamond', serif",
    },
    googleFonts: 'family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=Source+Sans+3:wght@300;400;600&family=Source+Code+Pro:wght@400;500',
  },

  futurist: {
    label: 'Futurist',
    description: 'Space Grotesk × Oxanium — sci-fi forward',
    preview: { heading: 'Oxanium', body: 'Space Grotesk' },
    vars: {
      '--font-sans': "'Space Grotesk', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Oxanium', sans-serif",
    },
    googleFonts: 'family=Oxanium:wght@400;600;700&family=Space+Grotesk:wght@300;400;500;600&family=Space+Mono:wght@400;700',
  },

  bodoni: {
    label: 'Bodoni',
    description: 'Bodoni Moda × Karla — high-contrast classical elegance',
    preview: { heading: 'Bodoni Moda', body: 'Karla' },
    vars: {
      '--font-sans': "'Karla', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Bodoni Moda', serif",
    },
    googleFonts: 'family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,600;1,6..96,400&family=Karla:ital,wght@0,300;0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500',
  },

  poppins: {
    label: 'Poppins',
    description: 'Poppins — geometric rounded modern',
    preview: { heading: 'Poppins', body: 'Poppins' },
    vars: {
      '--font-sans': "'Poppins', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Poppins', sans-serif",
    },
    googleFonts: 'family=Poppins:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Fira+Code:wght@400;500',
  },

  cinzel: {
    label: 'Cinzel',
    description: 'Cinzel × Spectral — Roman classical authority',
    preview: { heading: 'Cinzel', body: 'Spectral' },
    vars: {
      '--font-sans': "'Spectral', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cinzel', serif",
    },
    googleFonts: 'family=Cinzel:wght@400;600;700&family=Spectral:ital,wght@0,300;0,400;0,600;1,400&family=Courier+Prime:wght@400;700',
  },

  typewriter: {
    label: 'Typewriter',
    description: 'Special Elite × Crimson Pro — vintage press feel',
    preview: { heading: 'Special Elite', body: 'Crimson Pro' },
    vars: {
      '--font-sans': "'Crimson Pro', serif",
      '--font-mono': "'Special Elite', cursive",
      '--font-display': "'Special Elite', cursive",
    },
    googleFonts: 'family=Special+Elite&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400',
  },

  newspaper: {
    label: 'Newspaper',
    description: 'Oswald × Lora — bold editorial contrast',
    preview: { heading: 'Oswald', body: 'Lora' },
    vars: {
      '--font-sans': "'Lora', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Oswald', sans-serif",
    },
    googleFonts: 'family=Oswald:wght@400;500;600&family=Lora:ital,wght@0,400;0,600;1,400&family=Courier+Prime:wght@400;700',
  },

  magazine: {
    label: 'Magazine',
    description: 'Abril Fatface × Barlow — glossy bold impact',
    preview: { heading: 'Abril Fatface', body: 'Barlow' },
    vars: {
      '--font-sans': "'Barlow', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Abril Fatface', display",
    },
    googleFonts: 'family=Abril+Fatface&family=Barlow:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Fira+Code:wght@400;500',
  },

  swiss: {
    label: 'Swiss',
    description: 'Onest × Figtree — neutral Swiss modernism',
    preview: { heading: 'Onest', body: 'Figtree' },
    vars: {
      '--font-sans': "'Figtree', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Onest', sans-serif",
    },
    googleFonts: 'family=Onest:wght@300;400;500;600&family=Figtree:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Space+Mono:wght@400;700',
  },

  manrope: {
    label: 'Manrope',
    description: 'Manrope — geometric grotesk unity',
    preview: { heading: 'Manrope', body: 'Manrope' },
    vars: {
      '--font-sans': "'Manrope', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Manrope', sans-serif",
    },
    googleFonts: 'family=Manrope:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500',
  },

  studio: {
    label: 'Studio',
    description: 'Bebas Neue × Work Sans — bold branding energy',
    preview: { heading: 'Bebas Neue', body: 'Work Sans' },
    vars: {
      '--font-sans': "'Work Sans', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Bebas Neue', display",
    },
    googleFonts: 'family=Bebas+Neue&family=Work+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Space+Mono:wght@400;700',
  },

  ink: {
    label: 'Ink',
    description: 'Merriweather × Merriweather Sans — warm print companion',
    preview: { heading: 'Merriweather', body: 'Merriweather Sans' },
    vars: {
      '--font-sans': "'Merriweather Sans', sans-serif",
      '--font-mono': "'Inconsolata', monospace",
      '--font-display': "'Merriweather', serif",
    },
    googleFonts: 'family=Merriweather:ital,wght@0,300;0,400;0,700;1,400&family=Merriweather+Sans:ital,wght@0,300;0,400;0,500;1,400&family=Inconsolata:wght@400;500',
  },

  atlas: {
    label: 'Atlas',
    description: 'Josefin Slab × Josefin Sans — geometric slab harmony',
    preview: { heading: 'Josefin Slab', body: 'Josefin Sans' },
    vars: {
      '--font-sans': "'Josefin Sans', sans-serif",
      '--font-mono': "'Space Mono', monospace",
      '--font-display': "'Josefin Slab', serif",
    },
    googleFonts: 'family=Josefin+Slab:ital,wght@0,300;0,400;0,600;1,400&family=Josefin+Sans:ital,wght@0,300;0,400;0,600;1,400&family=Space+Mono:wght@400;700',
  },

  noto: {
    label: 'Noto',
    description: 'Noto Serif × Noto Sans — universal multilingual clarity',
    preview: { heading: 'Noto Serif', body: 'Noto Sans' },
    vars: {
      '--font-sans': "'Noto Sans', sans-serif",
      '--font-mono': "'Noto Sans Mono', monospace",
      '--font-display': "'Noto Serif', serif",
    },
    googleFonts: 'family=Noto+Serif:ital,wght@0,400;0,600;1,400&family=Noto+Sans:ital,wght@0,300;0,400;0,500;1,400&family=Noto+Sans+Mono:wght@400;500',
  },

  heritage: {
    label: 'Heritage',
    description: 'Cardo × Cabin — old-world serif meets modern sans',
    preview: { heading: 'Cardo', body: 'Cabin' },
    vars: {
      '--font-sans': "'Cabin', sans-serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cardo', serif",
    },
    googleFonts: 'family=Cardo:ital,wght@0,400;0,700;1,400&family=Cabin:ital,wght@0,400;0,500;0,600;1,400&family=Courier+Prime:wght@400;700',
  },

  gothic: {
    label: 'Gothic',
    description: 'Cinzel Decorative × Lora — ornate and ceremonial',
    preview: { heading: 'Cinzel Decorative', body: 'Lora' },
    vars: {
      '--font-sans': "'Lora', serif",
      '--font-mono': "'Courier Prime', monospace",
      '--font-display': "'Cinzel Decorative', serif",
    },
    googleFonts: 'family=Cinzel+Decorative:wght@400;700&family=Lora:ital,wght@0,400;0,600;1,400&family=Courier+Prime:wght@400;700',
  },

  retro: {
    label: 'Retro',
    description: 'Pacifico × Josefin Sans — playful vintage charm',
    preview: { heading: 'Pacifico', body: 'Josefin Sans' },
    vars: {
      '--font-sans': "'Josefin Sans', sans-serif",
      '--font-mono': "'Special Elite', cursive",
      '--font-display': "'Pacifico', cursive",
    },
    googleFonts: 'family=Pacifico&family=Josefin+Sans:ital,wght@0,300;0,400;0,600;1,400&family=Special+Elite',
  },

  yeseva: {
    label: 'Display',
    description: 'Yeseva One × Karla — dramatic display contrast',
    preview: { heading: 'Yeseva One', body: 'Karla' },
    vars: {
      '--font-sans': "'Karla', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Yeseva One', serif",
    },
    googleFonts: 'family=Yeseva+One&family=Karla:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Fira+Code:wght@400;500',
  },

  terminal: {
    label: 'Terminal',
    description: 'Share Tech Mono — pure monospace terminal',
    preview: { heading: 'Share Tech Mono', body: 'Share Tech Mono' },
    vars: {
      '--font-sans': "'Share Tech Mono', monospace",
      '--font-mono': "'Share Tech Mono', monospace",
      '--font-display': "'Share Tech Mono', monospace",
    },
    googleFonts: 'family=Share+Tech+Mono',
  },

  pt: {
    label: 'PT Classic',
    description: 'PT Serif × PT Sans — Russian typographic tradition',
    preview: { heading: 'PT Serif', body: 'PT Sans' },
    vars: {
      '--font-sans': "'PT Sans', sans-serif",
      '--font-mono': "'PT Mono', monospace",
      '--font-display': "'PT Serif', serif",
    },
    googleFonts: 'family=PT+Serif:ital,wght@0,400;0,700;1,400&family=PT+Sans:ital,wght@0,400;0,700;1,400&family=PT+Mono',
  },

  marcellus: {
    label: 'Marcellus',
    description: 'Marcellus SC × Open Sans — small caps authority',
    preview: { heading: 'Marcellus SC', body: 'Open Sans' },
    vars: {
      '--font-sans': "'Open Sans', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'Marcellus SC', serif",
    },
    googleFonts: 'family=Marcellus+SC&family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Source+Code+Pro:wght@400;500',
  },

  monochrome: {
    label: 'Monochrome',
    description: 'JetBrains Mono — pure programmer aesthetic',
    preview: { heading: 'JetBrains Mono', body: 'JetBrains Mono' },
    vars: {
      '--font-sans': "'JetBrains Mono', monospace",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'JetBrains Mono', monospace",
    },
    googleFonts: 'family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400',
  },

  rozha: {
    label: 'Rozha',
    description: 'Rozha One × Barlow — bold Indian type meets European sans',
    preview: { heading: 'Rozha One', body: 'Barlow' },
    vars: {
      '--font-sans': "'Barlow', sans-serif",
      '--font-mono': "'Fira Code', monospace",
      '--font-display': "'Rozha One', serif",
    },
    googleFonts: 'family=Rozha+One&family=Barlow:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Fira+Code:wght@400;500',
  },

  spectral: {
    label: 'Spectral',
    description: 'Spectral × Open Sans — screen-optimized serif',
    preview: { heading: 'Spectral', body: 'Open Sans' },
    vars: {
      '--font-sans': "'Open Sans', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'Spectral', serif",
    },
    googleFonts: 'family=Spectral:ital,wght@0,300;0,400;0,600;1,400&family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Source+Code+Pro:wght@400;500',
  },

  work: {
    label: 'Work Sans',
    description: 'Work Sans — clean variable workhorse',
    preview: { heading: 'Work Sans', body: 'Work Sans' },
    vars: {
      '--font-sans': "'Work Sans', sans-serif",
      '--font-mono': "'JetBrains Mono', monospace",
      '--font-display': "'Work Sans', sans-serif",
    },
    googleFonts: 'family=Work+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500',
  },

  neuton: {
    label: 'Neuton',
    description: 'Neuton × Open Sans — refined book serif',
    preview: { heading: 'Neuton', body: 'Open Sans' },
    vars: {
      '--font-sans': "'Open Sans', sans-serif",
      '--font-mono': "'Inconsolata', monospace",
      '--font-display': "'Neuton', serif",
    },
    googleFonts: 'family=Neuton:ital,wght@0,300;0,400;0,700;1,400&family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Inconsolata:wght@400;500',
  },

  cabin: {
    label: 'Cabin',
    description: 'Cabin — humanist sans crafted for digital',
    preview: { heading: 'Cabin', body: 'Cabin' },
    vars: {
      '--font-sans': "'Cabin', sans-serif",
      '--font-mono': "'Source Code Pro', monospace",
      '--font-display': "'Cabin', sans-serif",
    },
    googleFonts: 'family=Cabin:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Source+Code+Pro:wght@400;500',
  },
};

let loadedFonts = new Set();

export function applyFontSet(fontKey) {
  const set = FONT_SETS[fontKey] || FONT_SETS.default;
  const root = document.documentElement;

  // Apply CSS variables
  for (const [key, value] of Object.entries(set.vars)) {
    root.style.setProperty(key, value);
  }

  // Load Google Fonts if not already loaded
  if (!loadedFonts.has(fontKey) && set.googleFonts) {
    const existing = document.getElementById(`font-link-${fontKey}`);
    if (!existing) {
      const link = document.createElement('link');
      link.id = `font-link-${fontKey}`;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?${set.googleFonts}&display=swap`;
      document.head.appendChild(link);
    }
    loadedFonts.add(fontKey);
  }
}
