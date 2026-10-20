// The AI's plain-text suggestion as editor HTML, for Apply.
//
// A blank line between paragraphs stays a blank line, as an empty paragraph, the way Enter
// pressed twice leaves it: the editor sets paragraphs almost touching, so without it a suggestion
// that read well in the panel ran together in the message. A single line break stays a line break.
//
// The text is escaped. The model is asked for plain text, but what it returns can follow what it
// was given, and markup in it, such as a link, must not become real markup in the user's message.
export function aiTextToHtml(text) {
  // Trailing spaces go line by line: a pattern for them retries from every space, which on a long
  // run of spaces from a runaway model takes time growing with its square.
  const escaped = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return escaped.split(/\n{2,}/)
    .map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('<p></p>');
}
