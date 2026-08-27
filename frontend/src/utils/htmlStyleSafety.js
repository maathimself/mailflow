const HTML_SPACE = /\s/;

function stripStyleAttributesFromTag(tag) {
  let cursor = 1;
  while (cursor < tag.length && !/[\s/>]/.test(tag[cursor])) cursor += 1;
  const removals = [];

  while (cursor < tag.length - 1) {
    const whitespaceStart = cursor;
    while (HTML_SPACE.test(tag[cursor] || '')) cursor += 1;
    if (tag[cursor] === '>' || (tag[cursor] === '/' && tag[cursor + 1] === '>')) break;

    const nameStart = cursor;
    while (cursor < tag.length && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const style = cursor === nameStart + 5
      && tag.slice(nameStart, cursor).toLowerCase() === 'style';
    while (HTML_SPACE.test(tag[cursor] || '')) cursor += 1;
    if (tag[cursor] === '=') {
      cursor += 1;
      while (HTML_SPACE.test(tag[cursor] || '')) cursor += 1;
      const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor++] : '';
      if (quote) {
        while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
        if (tag[cursor] === quote) cursor += 1;
      } else {
        while (cursor < tag.length && !/[\s>]/.test(tag[cursor])) cursor += 1;
      }
    }
    if (style) removals.push([whitespaceStart, cursor]);
  }

  if (!removals.length) return tag;
  let clean = '';
  let copiedThrough = 0;
  for (const [start, end] of removals) {
    clean += tag.slice(copiedThrough, start);
    copiedThrough = end;
  }
  return clean + tag.slice(copiedThrough);
}

export function stripOpeningTagStyleAttributes(html) {
  const source = String(html || '');
  let clean = '';
  let copiedThrough = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) break;
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4);
      if (close < 0) break;
      cursor = close + 3;
      continue;
    }
    const first = source[open + 1];
    if (!first || !/[a-z]/i.test(first)) {
      cursor = open + 1;
      continue;
    }

    let end = open + 2;
    let quote = '';
    while (end < source.length) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      end += 1;
    }
    if (end >= source.length) break;

    clean += source.slice(copiedThrough, open);
    clean += stripStyleAttributesFromTag(source.slice(open, end + 1));
    copiedThrough = end + 1;
    cursor = end + 1;
  }

  return clean + source.slice(copiedThrough);
}
