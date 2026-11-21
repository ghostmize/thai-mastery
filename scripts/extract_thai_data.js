// Shared helper: pulls top-level data constants out of the single-file Thai app so Node scripts can audit them.
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'thai_reading_path_adaptive_mastery_engine.html');

// Finds the end of a JS literal starting at `start` (which must point at [ or {), skipping strings & comments.
function matchLiteral(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('Unbalanced literal at ' + start);
}

function extractConst(src, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const end = matchLiteral(src, start);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src.slice(start, end)});`)();
}

function loadThaiData(names) {
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  const out = { src };
  names.forEach(n => { out[n] = extractConst(src, n); });
  return out;
}

module.exports = { loadThaiData, extractConst, matchLiteral, HTML_PATH };
