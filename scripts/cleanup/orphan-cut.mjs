// 1 回しか出てこない台本の変数・定数の宣言を消す (1 行で終わるものだけ。複数行のものは名前を出して止めない)。なくなるまで繰り返す
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const p = root + '/index.html';
const raw = fs.readFileSync(p, 'utf8'); const crlf = raw.includes('\r\n');
let lines = raw.replace(/\r\n/g, '\n').split('\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const strip = (ls) => { const out = []; let end = null; for (const l of ls) { if (end) { if (l.includes(end)) end = null; out.push(''); continue; } const t = l.trimStart(); if (t.startsWith('//')) { out.push(''); continue; } if (t.startsWith('<!--')) { if (!t.includes('-->')) end = '-->'; out.push(''); continue; } if (t.startsWith('/*')) { if (!t.includes('*/')) end = '*/'; out.push(''); continue; } out.push(l.replace(/\s{2,}\/\/.*$/, '')); } return out; };
let total = 0; const multi = new Set();
for (let round = 0; round < 8; round++) {
    const all = strip(lines).join('\n') + '\n' + js;
    const count = (n) => (all.match(new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])', 'g')) || []).length;
    const kill = new Set();
    lines.forEach((l, i) => {
        const m = /^        (?:let|const|var) ([A-Za-z_$][\w$]*)/.exec(l);
        if (!m || count(m[1]) > 1) return;
        const codePart = l.replace(/\s{2,}\/\/.*$/, '').trimEnd();
        const opens = (codePart.match(/[\{\[\(]/g) || []).length, closes = (codePart.match(/[\}\]\)]/g) || []).length;
        if (!codePart.endsWith(';') || opens !== closes || /,\s*[A-Za-z_$][\w$]*\s*=/.test(codePart.replace(/\([^)]*\)|\{[^}]*\}|\[[^\]]*\]|'[^']*'|"[^"]*"/g, ''))) { multi.add(`${i + 1}: ${m[1]}`); return; }
        kill.add(i);
        // 直前に貼り付いた注釈の行も (空行で切れていたら残す)
        let k = i - 1; while (k >= 0 && /^        \/\//.test(lines[k]) && !kill.has(k)) { kill.add(k); k--; }
    });
    if (!kill.size) break;
    total += [...kill].length;
    lines = lines.filter((_, i) => !kill.has(i));
}
const sq = []; for (const l of lines) { if (l.trim() === '' && sq.length && sq[sq.length - 1].trim() === '') continue; sq.push(l); }
fs.writeFileSync(p, crlf ? sq.join('\n').replace(/\n/g, '\r\n') : sq.join('\n'));
console.log('消した行: ' + total + ' / 手で見るもの (複数行・同じ行に 2 つ): ' + ([...multi].join(' | ') || 'なし'));
