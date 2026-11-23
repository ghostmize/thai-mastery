// Simulates the live 2-person conversation generator for every Street node at every difficulty
// and flags conversations that don't hang together (repeated lines, mismatched Q/A, greetings mid-chat...).
// Usage: node scripts/simulate_convos.js [--diff standard] [--node s3_n3] [--quiet]
const { loadThaiData, matchLiteral } = require('./extract_thai_data.js');

const CONSTS = ['STREET_DB', 'STREET_CURRICULUM', 'THAI_CONVO_TURNS_MAP', 'THAI_CONVO_TIERS_MAP',
  'THAI_CONVO_SCRIPTS_MAP', 'THAI_COMPATIBLE_REPLIES', 'CURVEBALL_CHOICE_GROUPS', 'COMPOUND_DOMAINS', 'COMPOUND_CONFLICTS'];
const FUNCS = ['getTieredDialoguePair', 'canShareCurveballChoice', 'canCombineCompoundTurns', 'getConvoTurnDataForItem',
  'isItemDomainCompatibleWithNode', 'getKnownPoolForConversation', 'createCompoundOldNewTurn', 'isCompatibleTurnReply',
  'isReasonableConvoOption', 'getThaiTwoPersonCast', 'buildScriptedConvoExchange', 'createLiveConversationStep', 'getPastLearnedStreetItems',
  'getBonusThemeItemsForNode', 'buildConvoExchangePlan', 'getConvoScenePlan'];

const d = loadThaiData([]);
const src = d.src;

function extractFn(name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return '';
  // skip the parameter list (may contain default objects)
  let i = m.index + m[0].length, depth = 1;
  while (depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
  const bodyStart = src.indexOf('{', i);
  return src.slice(m.index, matchLiteral(src, bodyStart));
}
function extractConstSrc(name) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(src);
  if (!m) return '';
  let start = m.index + m[0].length;
  if (src.startsWith('new Set(', start)) {
    const end = matchLiteral(src, start + 8);
    return `const ${name} = new Set(${src.slice(start + 8, end)});`;
  }
  return `const ${name} = ${src.slice(start, matchLiteral(src, start))};`;
}
const setConsts = ['CURVEBALL_DINE_OR_GO_IDS', 'CURVEBALL_FOLLOWUP_ADDON_IDS'];

const code = [
  ...CONSTS.map(extractConstSrc), ...setConsts.map(extractConstSrc), ...FUNCS.map(extractFn),
  'return { createLiveConversationStep, STREET_CURRICULUM, STREET_DB, appState };'
].join('\n\n');

const appState = { courseLevel: 2, itemStats: {}, levelOverdrive: false, convoDifficulty: null };
// eslint-disable-next-line no-new-func
const env = new Function('appState', 'getAllWords', 'getEffectiveCourseLevel', 'UNITS_CURRICULUM',
  code.replace('return { createLiveConversationStep, STREET_CURRICULUM, STREET_DB, appState };',
    'return { createLiveConversationStep, STREET_CURRICULUM, STREET_DB };'))(
  appState, () => [], () => (appState.levelOverdrive || appState.courseLevel === 3 ? 3 : appState.courseLevel), []);

const args = process.argv.slice(2);
const onlyDiff = args.includes('--diff') ? args[args.indexOf('--diff') + 1] : null;
const onlyNode = args.includes('--node') ? args[args.indexOf('--node') + 1] : null;
const quiet = args.includes('--quiet');
const DIFFS = ['easier', 'standard', 'harder', 'overdrive'];

const norm = s => (s || '').replace(/[\s?!.,]/g, '').replace(/(ครับ|ค่ะ|คะ|คับ|นะ)/g, '');
const GREET = /^(สวัสดี|พี่ครับ|น้องครับ|ลุงครับ)/;
const issues = [];
let total = 0;

env.STREET_CURRICULUM.forEach(unit => unit.nodes.forEach(node => {
  if (onlyNode && node.id !== onlyNode) return;
  DIFFS.forEach(diff => {
    if (onlyDiff && diff !== onlyDiff) return;
    appState.courseLevel = diff === 'easier' ? 1 : diff === 'standard' ? 2 : 3;
    appState.levelOverdrive = diff === 'overdrive';
    appState.convoDifficulty = null;
    const step = env.createLiveConversationStep(node, diff, 0);
    total++;
    const L = step.dialogueLines;
    const probs = [];
    const seenA = {}, seenB = {};
    L.forEach((l, i) => {
      const k = norm(l.script);
      const bucket = l.speaker === 'A' ? seenA : seenB;
      if (bucket[k] !== undefined) probs.push(`line ${i + 1} repeats line ${bucket[k] + 1} (${l.speaker}): ${l.script}`);
      else bucket[k] = i;
      if (l.speaker === 'A' && i > 0 && GREET.test(l.script)) probs.push(`line ${i + 1} re-greets mid-conversation: ${l.script}`);
      if (i > 0 && norm(L[i - 1].script) && norm(l.script).includes(norm(L[i - 1].script)) && l.speaker === 'B' && l.script.trim().endsWith('?') === false && L[i - 1].script.trim().endsWith('?') === false)
        probs.push(`line ${i + 1} just parrots line ${i}: ${l.script}`);
    });
    // partner asks something the user already answered earlier
    for (let i = 3; i < L.length; i += 2) {
      for (let j = 1; j < i; j += 2) if (norm(L[i].script) === norm(L[j].script)) probs.push(`reply ${i + 1} identical to earlier reply ${j + 1}`);
    }
    // Your-turn options: duplicated or no wrong option
    step.questions.forEach(q => {
      const s = q.options.map(o => norm(o.script));
      if (new Set(s).size !== s.length) probs.push(`Q${q.qIdx + 1} has duplicate options`);
      if (!q.options.some(o => !o.isCorrect)) probs.push(`Q${q.qIdx + 1} has no wrong option`);
    });
    if (probs.length) issues.push({ node: node.id, diff, probs });
    if (!quiet) {
      console.log(`\n=== ${node.id} [${diff}] ${node.title} — ${step.cast.speakerA} / ${step.cast.speakerB}`);
      L.forEach((l, i) => console.log(`  ${i + 1}. ${l.speaker}${l.isSpiral ? '*' : ' '} ${l.script}   — ${l.meaning}`));
      probs.forEach(p => console.log(`   !! ${p}`));
    }
  });
}));

console.log(`\n${issues.length}/${total} conversations flagged`);
if (quiet) issues.forEach(x => console.log(`${x.node} [${x.diff}]\n  - ${x.probs.join('\n  - ')}`));
