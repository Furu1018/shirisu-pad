// 名前 (変数でも関数でも) を、K の外のどの関数が使っているか。 node whoK.mjs <root> <K.closed> NAME...
import fs from 'node:fs';
const [root, kFile, ...names] = process.argv.slice(2);
const K = new Set(fs.readFileSync(kFile, 'utf8').split(/\s+/).filter(Boolean));
const lines = fs.readFileSync(root + '/index.html', 'utf8').replace(/\r\n/g, '\n').split('\n');
const START = /^        (?:async )?function ([A-Za-z_$][\w$]*)\(/;
const owner = new Array(lines.length).fill('(関数の外)');
for (let i = 0; i < lines.length; i++) { const m = START.exec(lines[i]); if (!m) continue; let b = i; if ((lines[i].match(/\{/g) || []).length !== (lines[i].match(/\}/g) || []).length) while (b < lines.length && lines[b] !== '        }') b++; for (let k = i; k <= b; k++) owner[k] = m[1]; i = b; }
for (const n of names) {
    const re = new RegExp('(?<![\w$.])' + n.replace(/\$/g, '\$') + '(?![\w$])');
    const by = new Map(); let inK = 0;
    lines.forEach((l, i) => { if (!re.test(l) || /^\s*(\/\/|<!--|\/\*)/.test(l)) return; if (K.has(owner[i])) { inK++; return; } if (!by.has(owner[i])) by.set(owner[i], []); by.get(owner[i]).push(i + 1); });
    console.log(`${n}: K の中 ${inK} 回 / 外 → ${[...by.entries()].map(([o, ls]) => `${o}@${ls.slice(0, 4).join(',')}${ls.length > 4 ? '…' : ''}`).join('  ') || '(なし)'}`);
}
