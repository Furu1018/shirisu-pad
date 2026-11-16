// 名前を誰が呼んでいるか (関数名つき・注釈の行は除く)。 node who.mjs <root> NAME [NAME...]
import fs from 'node:fs';
const [root, ...names] = process.argv.slice(2);
const lines = fs.readFileSync(root + '/index.html', 'utf8').replace(/\r\n/g, '\n').split('\n');
const START = /^        (?:async )?function ([A-Za-z_$][\w$]*)\(/;
const owner = new Array(lines.length).fill('(関数の外)');
for (let i = 0; i < lines.length; i++) { const m = START.exec(lines[i]); if (!m) continue; let b = i; if ((lines[i].match(/\{/g) || []).length !== (lines[i].match(/\}/g) || []).length) while (b < lines.length && lines[b] !== '        }') b++; for (let k = i; k <= b; k++) owner[k] = m[1]; i = b; }
for (const n of names) {
    const re = new RegExp('(?<![\\w$])' + n.replace(/\$/g, '\\$') + '(?![\\w$])');
    const hits = [];
    lines.forEach((l, i) => { if (!re.test(l) || /^\s*(\/\/|<!--|\/\*)/.test(l)) return; if (START.test(l) && START.exec(l)[1] === n) return; hits.push(`${i + 1}:${owner[i]}`); });
    console.log(`${n} ← ${hits.length ? hits.join('  ') : '(呼ばれていない)'}`);
}
