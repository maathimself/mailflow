import { format, isToday, isYesterday, isThisYear } from 'date-fns';

// Compact relative date label shared by MessageList and the GTD display surfaces.
// Guards an invalid date to '' so a malformed value can never throw from
// date-fns format().
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return '';
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  if (isThisYear(d)) return format(d, 'MMM d');
  return format(d, 'MMM d, yyyy');
}
