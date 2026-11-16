// 撤去の検算: 元の版では宣言されていて、いまの版には無い名前 (関数・台本の変数) が、いまの版のコード (注釈を除く)・js/・tests/ にまだ出てこないか
//   node dangling.mjs <root> <元の版の index.html>
import fs from 'node:fs';
import path from 'node:path';
const [root, oldFile] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const decls = (t) => { const s = new Set(); for (const m of t.matchAll(/^\s{8,}(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)) s.add(m[1]); for (const m of t.matchAll(/^        (?:let|const|var) ([A-Za-z_$][\w$]*)/gm)) s.add(m[1]); return s; };
const oldT = read(oldFile), newT = read(root + '/index.html');
const gone = [...decls(oldT)].filter(n => !decls(newT).has(n));
const strip = (t) => { const out = []; let end = null; for (const l of t.split('\n')) { if (end) { if (l.includes(end)) end = null; out.push(''); continue; } const x = l.trimStart(); if (x.startsWith('//')) { out.push(''); continue; } if (x.startsWith('<!--')) { if (!x.includes('-->')) end = '-->'; out.push(''); continue; } if (x.startsWith('/*') || x.startsWith('*')) { if (x.startsWith('/*') && !x.includes('*/')) end = '*/'; out.push(''); continue; } out.push(l.replace(/\s{2,}\/\/.*$/, '')); } return out; };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = [['index.html', strip(newT)], ...walk(root + '/js').filter(f => f.endsWith('.js')).map(f => [path.relative(root, f), strip(read(f))]), ['sw.js', strip(read(root + '/sw.js'))]];
const tests = walk(root + '/tests').filter(f => f.endsWith('.mjs')).map(f => [path.relative(root, f), read(f).split('\n')]);
console.log(`無くなった宣言: ${gone.length} 個`);
let bad = 0;
for (const n of gone) {
    const re = new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])');
    const hits = []; for (const [f, ls] of files) ls.forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}`); });
    if (hits.length) { bad++; console.log(`  ★ ${n} ← ${hits.slice(0, 6).join(' ')}`); }
}
console.log(bad ? `コードに残っている: ${bad} 個` : 'コードに残っている参照は無い');
const tHits = new Map();
for (const n of gone) { const re = new RegExp('(?<![\\w$])' + n.replace(/\$/g, '\\$') + '(?![\\w$])'); for (const [f, ls] of tests) { const c = ls.filter(l => re.test(l)).length; if (c) { if (!tHits.has(f)) tHits.set(f, []); tHits.get(f).push(`${n}×${c}`); } } }
console.log('テストが参照している、無くなった名前:');
for (const [f, a] of tHits) console.log(`  ${f} (${a.length}): ${a.join(' ').slice(0, 900)}`);
