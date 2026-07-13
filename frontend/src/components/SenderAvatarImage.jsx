import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/index.js';
import { avatarImageCandidates } from '../utils/senderAvatar.js';

const imageStyle = {
  position: 'absolute', inset: 0,
  width: '100%', height: '100%', objectFit: 'cover',
};

export default function SenderAvatarImage({ email, hasContactPhoto }) {
  const loaded = useStore(state => state.senderFaviconsLoaded);
  const enabled = useStore(state => state.senderFavicons);
  const candidates = useMemo(() => avatarImageCandidates({
    email,
    hasContactPhoto,
    senderFavicons: loaded && enabled,
  }), [email, hasContactPhoto, loaded, enabled]);
  const [failed, setFailed] = useState(() => new Set());

  useEffect(() => { setFailed(new Set()); }, [email, hasContactPhoto, loaded, enabled]);

  const active = candidates.find(candidate => !failed.has(candidate.src));
  if (!active) return null;
  // Favicons are commonly alpha-transparent PNGs; back them with an opaque
  // themed surface so the initial letter and sender colour don't bleed through.
  const style = active.kind === 'favicon'
    ? { ...imageStyle, background: 'var(--bg-elevated)' }
    : imageStyle;
  return (
    <img
      key={active.src}
      src={active.src}
      alt=""
      loading="lazy"
      decoding="async"
      style={style}
      onError={() => setFailed(current => new Set(current).add(active.src))}
    />
  );
}
