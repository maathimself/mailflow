import { useStore } from '../store/index.js';

// A mailbox's mark (#376): its emoji where one is set (Settings > Accounts), otherwise its color
// dot. `size` is the dot's; an emoji is drawn about twice as tall so it reads at a glance.
export default function AccountMark({ accountId, color, size = 6, style }) {
  const icon = useStore(s => (accountId ? s.accounts.find(a => a.id === accountId)?.icon : null));
  if (icon) {
    return (
      <span aria-hidden="true" style={{
        fontSize: Math.round(size * 2), lineHeight: 1, flexShrink: 0, display: 'inline-block', borderRadius: 3, ...style,
      }}>
        {icon}
      </span>
    );
  }
  return <div style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, ...style }} />;
}
