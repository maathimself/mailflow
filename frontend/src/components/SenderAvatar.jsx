import { senderColor } from '../themes.js';
import SenderAvatarImage from './SenderAvatarImage.jsx';

// The sender's initial on their color, under their photo or favicon when there is one: the
// reader's header, and each conversation card in the Gmail layout. The name is always beside it.
export default function SenderAvatar({ message, className }) {
  return (
    <div className={className} aria-hidden="true" style={{
      width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
      background: senderColor(message.from_email || message.from_name),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 16, fontWeight: 700, color: 'white',
      position: 'relative', overflow: 'hidden',
    }}>
      {(message.from_name || message.from_email || '?')[0].toUpperCase()}
      <SenderAvatarImage
        email={message.from_email}
        hasContactPhoto={message.has_contact_photo}
      />
    </div>
  );
}
