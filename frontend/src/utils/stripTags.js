// Plain text of an HTML string, for counting or sending its words, not for display: each tag
// becomes a space. A tag cannot run past the next `<`, so the pattern stays linear on hostile
// input (`<[^>]+>` rescanned to the end of a body full of `<` from every one of them: about a
// second and a half for 160 KB of a crafted email, and quadratically worse beyond).
export function stripTags(html) {
  return String(html ?? '').replace(/<[^<>]*>/g, ' ');
}
