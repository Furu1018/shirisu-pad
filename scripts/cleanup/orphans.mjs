// 関数を消したあとに残った「使われていない台本の変数・定数」(字下げ 8 の let / const / var) と、もう無い id を指す CSS / getElementById を数える
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const lines = fs.readFileSync(root + '/index.html', 'utf8').replace(/\r\n/g, '\n').split('\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const strip = (ls) => { const out = []; let end = null; for (const l of ls) { if (end) { if (l.includes(end)) end = null; out.push(''); continue; } const t = l.trimStart(); if (t.startsWith('//')) { out.push(''); continue; } if (t.startsWith('<!--')) { if (!t.includes('-->')) end = '-->'; out.push(''); continue; } if (t.startsWith('/*')) { if (!t.includes('*/')) end = '*/'; out.push(''); continue; } out.push(l.replace(/\s{2,}\/\/.*$/, '')); } return out; };
const code = strip(lines);
const all = code.join('\n') + '\n' + js;
const count = (n) => (all.match(new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])', 'g')) || []).length;
console.log('== 1 回しか出てこない台本の変数・定数 (宣言だけ)');
lines.forEach((l, i) => {
    const m = /^        (?:let|const|var) ([A-Za-z_$][\w$]*)/.exec(l);
    if (!m) return;
    const c = count(m[1]);
    if (c <= 1) console.log(`  ${i + 1}: ${m[1]}  ${l.trim().slice(0, 110)}`);
});
// 同じ行に並んだ 2 つ目以降の宣言 (let a = 1, b = 2)
console.log('== id: 台本・CSS が指しているのに、文書に無い id (静的な HTML と、台本が id="…" で作るもの)');
const text = lines.join('\n');
const made = new Set([...text.matchAll(/\bid=\\?["'`]([A-Za-z][\w-]*)/g)].map(m => m[1]));
[...text.matchAll(/\.id = ['"]([A-Za-z][\w-]*)['"]/g)].forEach(m => made.add(m[1]));
const want = new Map();
for (const m of all.matchAll(/getElementById\(['"]([A-Za-z][\w-]*)['"]\)/g)) want.set(m[1], (want.get(m[1]) || 0) + 1);
const miss = [...want.entries()].filter(([id]) => !made.has(id));
console.log('  getElementById: ' + (miss.map(([id, c]) => `${id}×${c}`).join(' ') || '(なし)'));
const cssEnd = lines.findIndex(l => /<\/style>/.test(l));
const css = lines.slice(0, cssEnd).join('\n');
const cssIds = new Set([...css.matchAll(/#([A-Za-z][\w-]*)/g)].map(m => m[1]).filter(x => !/^[0-9a-fA-F]{3,8}$/.test(x)));
console.log('  CSS の #id: ' + ([...cssIds].filter(id => !made.has(id)).join(' ') || '(なし)'));
