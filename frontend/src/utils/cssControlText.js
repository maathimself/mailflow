export function cssControlText(source, { preserveBrackets = false, preserveStrings = false } = {}) {
  let visible = '';
  let bracketDepth = 0;
  for (let cursor = 0, quote = ''; cursor < source.length;) {
    const char = source[cursor];
    if (char === '\\' && quote && preserveStrings) {
      let end = cursor + 1;
      let hexDigits = 0;
      while (end < source.length && hexDigits < 6 && /[\da-f]/i.test(source[end])) {
        end += 1;
        hexDigits += 1;
      }
      if (hexDigits && /[\t\n\f\r ]/.test(source[end] || '')) end += 1;
      else if (!hexDigits && source[end]) end += 1;
      visible += source.slice(cursor, end);
      cursor = end;
    } else if (char === '\\') {
      let end = cursor + 1;
      let hexDigits = 0;
      while (end < source.length && hexDigits < 6 && /[\da-f]/i.test(source[end])) {
        end += 1;
        hexDigits += 1;
      }
      if (hexDigits) {
        if ((preserveBrackets || !bracketDepth) && !quote) {
          visible += String.fromCodePoint(Math.min(
            Number.parseInt(source.slice(cursor + 1, end), 16), 0x10ffff,
          ));
        }
        if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
        else if (/[\t\n\f\r ]/.test(source[end] || '')) end += 1;
      } else if (source[end] === '\r' && source[end + 1] === '\n') {
        end += 2;
      } else if (/[\n\f\r]/.test(source[end] || '')) {
        end += 1;
      } else {
        if ((preserveBrackets || !bracketDepth) && !quote) visible += source[end] || '';
        end += 1;
      }
      cursor = end;
    } else if (quote) {
      if (preserveStrings) visible += char;
      if (char === quote) quote = '';
      cursor += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      if (preserveStrings) visible += char;
      cursor += 1;
    } else if (char === '[') {
      if (preserveBrackets) visible += char;
      else bracketDepth += 1;
      cursor += 1;
    } else if (char === ']') {
      if (preserveBrackets) visible += char;
      else bracketDepth = Math.max(0, bracketDepth - 1);
      cursor += 1;
    } else {
      if (preserveBrackets || !bracketDepth) visible += char;
      cursor += 1;
    }
  }
  return visible;
}
