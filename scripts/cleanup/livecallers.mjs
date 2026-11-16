// 「消すと決めた関数」の一覧 (K) から始めて、K の関数だけが呼んでいる関数も K に足し (閉包)、最後に「K の外から K を呼んでいる行」を出す。
//   node livecallers.mjs <root> <K の名前を並べたファイル>      出力: 閉包で増えた名前 / 外からの呼び出し (行番号・持ち主・行の文字)
import fs from 'node:fs';
import path from 'node:path';
const [root, kFile] = process.argv.slice(2);
const lines = fs.readFileSync(root + '/index.html', 'utf8').replace(/\r\n/g, '\n').split('\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const START = /^        (?:async )?function ([A-Za-z_$][\w$]*)\(/;
const fns = []; const owner = new Array(lines.length).fill(null);
for (let i = 0; i < lines.length; i++) { const m = START.exec(lines[i]); if (!m) continue; let b = i; if ((lines[i].match(/\{/g) || []).length !== (lines[i].match(/\}/g) || []).length) while (b < lines.length && lines[b] !== '        }') b++; fns.push({ name: m[1], a: i, b }); for (let k = i; k <= b; k++) owner[k] = m[1]; i = b; }
const names = new Set(fns.map(f => f.name));
const isComment = (l) => /^\s*(\/\/|<!--|\/\*|\*)/.test(l);
const code = (l) => l.replace(/\s{2,}\/\/.*$/, '');
const WORD = /[A-Za-z_$][\w$]*/g;
// refs[name] = [{ line, owner }]
const refs = new Map();
lines.forEach((l, i) => { if (isComment(l)) return; const c = code(l); for (const m of c.matchAll(WORD)) { const n = m[0]; if (!names.has(n)) continue; if (owner[i] === n && START.test(l)) continue; if (!refs.has(n)) refs.set(n, []); refs.get(n).push({ line: i, owner: owner[i] }); } });
const jsNames = new Set([...js.matchAll(WORD)].map(m => m[0]));
const K = new Set(fs.readFileSync(kFile, 'utf8').split(/\s+/).filter(Boolean));
for (const k of K) if (!names.has(k)) console.log('  (? 関数が無い: ' + k + ')');
// 閉包: 参照がすべて K の関数の中からだけの関数は K に入れる (js/ から呼ばれるもの・関数の外から呼ばれるものは入れない)
let grew = true; const added = [];
while (grew) { grew = false; for (const f of fns) { if (K.has(f.name) || jsNames.has(f.name)) continue; const r = refs.get(f.name) || []; if (r.length && r.every(x => x.owner && (K.has(x.owner) || x.owner === f.name))) { K.add(f.name); added.push(f.name); grew = true; } } }
console.log(`K ${K.size} 個 (閉包で足した ${added.length}: ${added.join(' ')})`);
const total = fns.filter(f => K.has(f.name)).reduce((t, f) => t + f.b - f.a + 1, 0);
console.log(`K の行数: ${total}`);
console.log('\n== K の外から K を呼んでいる行 (これを手で外す)');
const out = [];
for (const k of [...K].sort()) for (const r of (refs.get(k) || [])) if (!r.owner || !K.has(r.owner)) out.push([r.line, `${String(r.line + 1).padStart(6)} [${r.owner || '関数の外'}] → ${k}: ${lines[r.line].trim().slice(0, 170)}`]);
const seen = new Set();
for (const [, s] of out.sort((x, y) => x[0] - y[0])) { if (seen.has(s)) continue; seen.add(s); console.log(s); }
for (const k of K) if (jsNames.has(k)) console.log('  ★ js/ から呼ばれている: ' + k);
fs.writeFileSync(kFile + '.closed', [...K].join('\n'));
