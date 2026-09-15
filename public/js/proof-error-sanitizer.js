// Shared by the browser reporter and the server. Sanitize before truncating so
// a size limit cannot cut off a closing quote/bracket and expose its contents.
export function sanitizeErrorText(value) {
  const text = typeof value === 'string' ? value : '';
  const pairs = { '"': '"', "'": "'", '`': '`', '“': '”', '<': '>', '[': ']' };
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    if (!pairs[text[i]]) { clean += text[i]; continue; }
    const ends = [pairs[text[i]]];
    // Drop nested regions as a whole, including escaped quotes. An unclosed
    // region is also private: discard the remainder rather than guess.
    while (++i < text.length && ends.length) {
      const end = ends[ends.length - 1];
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === end) {
        ends.pop();
        if (!ends.length) break;
      } else if ((end === '>' || end === ']') && pairs[text[i]]) {
        ends.push(pairs[text[i]]);
      }
    }
    clean += '[text]';
  }
  return clean.split('\n').map(line => {
    const frame = /^\s*at\s|@(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(line);
    // Keep URLs and frame identifiers intact while removing URL credentials.
    // V8/Firefox append :line:column after the URL, including its query.
    return line.split(/((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s()\[\]<>"'`“”]+)/gi).map((part, index) => {
      if (index % 2) {
        const base = part.split(/[?#]/, 1)[0];
        const position = frame && part !== base ? part.match(/:\d+:\d+$/)?.[0] || '' : '';
        return base + position;
      }
      if (frame) return part;
      return part.replace(/[\p{L}\p{M}]+(?:[ \t]+[\p{L}\p{M}]+)*/gu, run =>
        (run.match(/\p{L}/gu) || []).length > 40 ? '[text]' : run);
    }).join('');
  }).join('\n');
}
