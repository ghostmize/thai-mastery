// Audits every 2-person convo line for words the learner has NOT been taught yet at that point in the course.
// Usage: node scripts/audit_convo_vocab.js [--json] [--node s3_n1]
const { loadThaiData } = require('./extract_thai_data.js');

const d = loadThaiData(['WORDS_DB', 'STREET_DB', 'STREET_CURRICULUM', 'THAI_CONVO_TURNS_MAP', 'THAI_CONVO_TIERS_MAP', 'THAI_CORE_FUNCTION_WORDS', 'THAI_CONVO_GLOSSARY']);
const args = process.argv.slice(2);
const onlyNode = args.includes('--node') ? args[args.indexOf('--node') + 1] : null;

const CORE = d.THAI_CORE_FUNCTION_WORDS || { ครับ: 1, ค่ะ: 1, คะ: 1, คับ: 1 };
const GLOSS = d.THAI_CONVO_GLOSSARY || {};
const seg = new Intl.Segmenter('th', { granularity: 'word' });
const THAI_RE = /[\u0E00-\u0E7F]/;

function itemPhrases(item) {
  const out = [];
  if (item.thai) out.push(item.thai);
  (item.words || []).forEach(w => w.th && out.push(w.th));
  return out.map(s => s.replace(/\s+/g, '').replace(/[?!.,]/g, '')).filter(Boolean);
}

// Marks known phrase coverage (longest first), then segments leftover spans into unknown words.
function findUnknown(text, knownList) {
  const s = text.replace(/[?!.,]/g, ' ');
  const covered = new Array(s.length).fill(false);
  knownList.forEach(k => {
    let from = 0;
    while (true) {
      const pos = s.indexOf(k, from);
      if (pos === -1) break;
      for (let i = pos; i < pos + k.length; i++) covered[i] = true;
      from = pos + 1;
    }
  });
  const unknown = [];
  let span = '';
  const flush = () => {
    if (!span) return;
    for (const t of seg.segment(span)) {
      if (t.isWordLike && THAI_RE.test(t.segment) && !CORE[t.segment]) unknown.push(t.segment);
    }
    span = '';
  };
  for (let i = 0; i < s.length; i++) {
    if (covered[i] || s[i] === ' ') flush(); else span += s[i];
  }
  flush();
  return unknown;
}

const streetById = Object.fromEntries(d.STREET_DB.map(s => [s.id, s]));
const knownSoFar = [];
const report = [];
const freq = {};

d.STREET_CURRICULUM.forEach(unit => {
  unit.nodes.forEach(node => {
    const items = (node.itemIds || []).map(id => streetById[id]).filter(Boolean);
    const knownHere = [...knownSoFar, ...items.flatMap(itemPhrases), ...Object.keys(GLOSS).filter(k => GLOSS[k].known)];
    const knownSorted = [...new Set(knownHere)].sort((a, b) => b.length - a.length);
    items.forEach(item => {
      const variants = [];
      const m = d.THAI_CONVO_TURNS_MAP[item.id];
      if (m) variants.push(['base', m]);
      const t = d.THAI_CONVO_TIERS_MAP[item.id];
      if (t) Object.entries(t).forEach(([tier, pair]) => variants.push([tier, pair]));
      variants.forEach(([tier, pair]) => {
        ['partner', 'user'].forEach(role => {
          const line = pair[role];
          if (!line || !line.script) return;
          const unk = findUnknown(line.script, knownSorted);
          unk.forEach(u => { freq[u] = freq[u] || { n: 0, glossed: !!GLOSS[u], firstNode: node.id }; freq[u].n++; });
          if (unk.length) report.push({ node: node.id, item: item.id, tier, role, script: line.script, unknown: unk, unglossed: unk.filter(u => !GLOSS[u]) });
        });
      });
    });
    knownSoFar.push(...items.flatMap(itemPhrases));
  });
});

if (args.includes('--json')) {
  console.log(JSON.stringify({ report, freq }, null, 1));
} else {
  report.filter(r => !onlyNode || r.node === onlyNode).forEach(r => {
    console.log(`${r.node} ${r.item} [${r.tier}/${r.role}] ${r.script}\n    unknown: ${r.unknown.join(' | ')}${r.unglossed.length ? '   (no gloss: ' + r.unglossed.join(' ') + ')' : ''}`);
  });
  const sorted = Object.entries(freq).sort((a, b) => b[1].n - a[1].n);
  console.log('\n=== Unknown word frequency ===');
  console.log(sorted.map(([w, f]) => `${w}:${f.n}${f.glossed ? '' : '*'}`).join('  '));
  const userLines = report.filter(r => r.role === 'user' && (r.tier === 'base' || r.tier === 'standard' || r.tier === 'easier'));
  console.log(`\nUser (learner) lines with unknown words at easier/standard: ${userLines.length}`);
  console.log(`Unglossed unknown words: ${sorted.filter(([, f]) => !f.glossed).length}`);
}
