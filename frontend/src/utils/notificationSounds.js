let _audioCtx = null;

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume();
  }
  return _audioCtx;
}

function note(ac, freq, type, vol, startTime, duration) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(vol, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

export const NOTIFICATION_SOUNDS = {
  tritone:    { label: 'Tri-tone',    description: 'iPhone classic' },
  marimba:    { label: 'Marimba',     description: 'Warm wooden tones' },
  xylophone:  { label: 'Xylophone',   description: 'Bright ascending' },
  belltower:  { label: 'Bell Tower',  description: 'Deep resonant bell' },
  vibraphone: { label: 'Vibraphone',  description: 'Smooth long tone' },
  fanfare:    { label: 'Fanfare',     description: 'Short victory tune' },
  windchimes: { label: 'Wind Chimes', description: 'Cascading highs' },
  bamboo:     { label: 'Bamboo',      description: 'Woody double knock' },
  orchestra:  { label: 'Orchestra',   description: 'Full ensemble hit' },
  slack:      { label: 'Slack',       description: 'Soft pop' },
  tweet:      { label: 'Tweet',       description: 'Bird chirp' },
};

const SYNTHS = {
  tritone(ac) {
    const t = ac.currentTime;
    note(ac, 1047, 'sine', 0.32, t, 0.12);
    note(ac, 1319, 'sine', 0.32, t + 0.14, 0.12);
    note(ac, 1568, 'sine', 0.35, t + 0.28, 0.16);
  },

  marimba(ac) {
    const t = ac.currentTime;
    const hit = (freq, start, vol) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(vol, start);
      g.gain.exponentialRampToValueAtTime(vol * 0.25, start + 0.07);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.85);
      o.start(start); o.stop(start + 0.9);
    };
    hit(784, t, 0.38);
    hit(988, t + 0.22, 0.34);
    hit(1175, t + 0.44, 0.3);
  },

  xylophone(ac) {
    const t = ac.currentTime;
    note(ac, 523, 'triangle', 0.38, t, 0.4);
    note(ac, 659, 'triangle', 0.38, t + 0.18, 0.4);
    note(ac, 784, 'triangle', 0.38, t + 0.36, 0.4);
  },

  belltower(ac) {
    const t = ac.currentTime;
    note(ac, 220, 'sine', 0.35, t, 2.5);
    note(ac, 550, 'sine', 0.18, t, 2.0);
    note(ac, 440, 'sine', 0.14, t, 1.8);
    note(ac, 660, 'sine', 0.09, t, 1.4);
    note(ac, 1100, 'sine', 0.05, t, 1.0);
  },

  vibraphone(ac) {
    const t = ac.currentTime;
    note(ac, 622, 'sine', 0.32, t, 2.0);
    note(ac, 1244, 'sine', 0.07, t, 1.4);
    note(ac, 1866, 'sine', 0.03, t, 0.9);
  },

  fanfare(ac) {
    const t = ac.currentTime;
    note(ac, 523, 'triangle', 0.22, t, 0.18);
    note(ac, 659, 'triangle', 0.22, t + 0.2, 0.18);
    note(ac, 784, 'triangle', 0.22, t + 0.4, 0.18);
    note(ac, 1047, 'triangle', 0.26, t + 0.6, 0.55);
  },

  windchimes(ac) {
    const t = ac.currentTime;
    const tones   = [1319, 1568, 1760, 2093, 1480, 1661, 1976];
    const offsets = [0, 0.14, 0.29, 0.41, 0.57, 0.71, 0.84];
    tones.forEach((freq, i) => {
      note(ac, freq, 'triangle', 0.16, t + offsets[i], 0.9);
    });
  },

  bamboo(ac) {
    const t = ac.currentTime;
    const knock = (start) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.type = 'triangle';
      o.frequency.setValueAtTime(900, start);
      o.frequency.exponentialRampToValueAtTime(250, start + 0.07);
      g.gain.setValueAtTime(0.45, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      o.start(start); o.stop(start + 0.12);
    };
    knock(t);
    knock(t + 0.22);
  },

  orchestra(ac) {
    const t = ac.currentTime;
    note(ac, 55,  'sine', 0.35, t, 0.65);
    note(ac, 110, 'sine', 0.25, t, 0.55);
    note(ac, 220, 'sine', 0.18, t, 0.45);
    note(ac, 440, 'triangle', 0.1, t, 0.3);
    note(ac, 880, 'triangle', 0.05, t, 0.2);
  },

  slack(ac) {
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.14);
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.start(t); o.stop(t + 0.25);
  },

  tweet(ac) {
    const t = ac.currentTime;
    const chirp = (start, f0, f1) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, start);
      o.frequency.exponentialRampToValueAtTime(f1, start + 0.1);
      g.gain.setValueAtTime(0.24, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      o.start(start); o.stop(start + 0.15);
    };
    chirp(t,        1200, 2000);
    chirp(t + 0.18, 1400, 2200);
    chirp(t + 0.36, 1600, 2400);
  },
};

// Call inside a user-gesture handler (file upload, settings click) so the
// AudioContext is unlocked before a notification arrives later.
export function warmUpAudioContext() {
  try { getAudioCtx(); } catch (_) {}
}

export function playCustomSound(dataUrl) {
  if (!dataUrl) return;
  // Decode the base64 data URL manually — fetch('data:...') is blocked by
  // CSP connect-src and new Audio().play() is blocked by autoplay policy.
  try {
    const ac = getAudioCtx();
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ac.decodeAudioData(bytes.buffer)
      .then(decoded => {
        const src  = ac.createBufferSource();
        const gain = ac.createGain();
        src.buffer = decoded;
        src.connect(gain);
        gain.connect(ac.destination);
        gain.gain.setValueAtTime(0.8, ac.currentTime);
        const play = () => src.start();
        return ac.state === 'suspended' ? ac.resume().then(play) : play();
      })
      .catch(() => {});
  } catch (_) {}
}

export function playNotificationSound(id, customDataUrl) {
  if (!id || id === 'none') return;
  if (id === 'custom') {
    playCustomSound(customDataUrl);
    return;
  }
  try {
    const ac = getAudioCtx();
    SYNTHS[id]?.(ac);
  } catch (_) {}
}
