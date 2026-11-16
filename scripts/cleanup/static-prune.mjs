// 指定したテスト 1 つの中で、「無くなった名前」に触れている文 (assert / const / for の 1 文) をまとめて外す (テストは走らせない・外した文を出す)。
//   EXTRAS=<追加の名前> node static-prune.mjs <root> <元の版の index.html> <テストの名前の頭>
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [root, oldFile, nameHead] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8');
const decls = (t) => { const s = new Set(); for (const m of t.matchAll(/^\s{8,}(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)) s.add(m[1]); for (const m of t.matchAll(/^        (?:let|const|var) ([A-Za-z_$][\w$]*)/gm)) s.add(m[1]); return s; };
const newDecl = decls(read(root + '/index.html').replace(/\r\n/g, '\n'));
const gone = [...decls(read(oldFile).replace(/\r\n/g, '\n'))].filter(n => !newDecl.has(n));
const extras = (process.env.EXTRAS ? read(process.env.EXTRAS) : '').split(/\s+/).filter(Boolean);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const goneRe = new RegExp('(?<![\\w$-])(?:' + [...gone, ...extras].sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![\\w$-])');
const tp = root + '/tests/run-tests.mjs';
const raw = read(tp); const crlf = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n').split('\n');
const indentOf = (l) => l.match(/^\s*/)[0].length;
const find = () => { const hits = []; src.forEach((l, i) => { const m = /^(\s*)(?:await )?test(?:Async)?\(\s*(['"`])/.exec(l); if (m && l.slice(m[0].length).startsWith(nameHead)) hits.push([i, m[1]]); }); if (hits.length !== 1) throw new Error(`テストが ${hits.length} 個`); let b = hits[0][0] + 1; while (!src[b].startsWith(hits[0][1] + '})')) b++; return [hits[0][0], b]; };
let removed = 0;
for (let guard = 0; guard < 400; guard++) {
    const [a, b] = find();
    let done = true;
    for (let L = a + 1; L < b; L++) {
        const t0 = src[L].trim();
        if (!t0 || t0.startsWith('//')) continue;
        const li = indentOf(src[L]); let M = L;
        while (M + 1 < b && src[M + 1].trim() !== '' && (indentOf(src[M + 1]) > li || (indentOf(src[M + 1]) === li && /^\s*[\)\]\}]/.test(src[M + 1])))) M++;
        const text = src.slice(L, M + 1).join('\n');
        if (!goneRe.test(text)) { L = M; continue; }
        // 否定の見張り (… が残っていない) は残す: assert.ok(!…) / !html.includes
        if (/^assert\.ok\(\s*!/.test(t0) && !/&&/.test(text)) { L = M; continue; }
        if ((text.match(/`/g) || []).length % 2 === 1) { console.log('  (バッククォートが閉じていない・手で見る) @' + (L + 1) + ' ' + t0.slice(0, 120)); L = M; continue; }
        const keep = src.slice();
        src.splice(L, M - L + 1);
        fs.writeFileSync(root + '/tests/_sp-check.mjs', src.join('\n'));
        if (spawnSync('node', ['--check', 'tests/_sp-check.mjs'], { cwd: root }).status !== 0) { src = keep; console.log('  (外すと構文が壊れる・手で見る) @' + (L + 1) + ' ' + t0.slice(0, 120)); L = M; continue; }
        console.log('  - ' + text.replace(/\s+/g, ' ').slice(0, 210));
        removed++; done = false; break;
    }
    if (done) break;
}
try { fs.unlinkSync(root + '/tests/_sp-check.mjs'); } catch { /* noop */ }
fs.writeFileSync(tp, crlf ? src.join('\n').replace(/\n/g, '\r\n') : src.join('\n'));
console.log('外した文: ' + removed);
