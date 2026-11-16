// 消した宣言 (関数・変数) の名前が、注釈や文に残っている行を出す (index.html と js/)。
//   node scripts/cleanup/stale-comments.mjs <root> <元の版の index.html>
// コードの参照は dangling.mjs が見る。こちらは「読む人を迷わせる古い説明」を探す用 (直すかは手で決める)。
import fs from 'node:fs';
import path from 'node:path';
const [root, oldFile] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const decls = (t) => {
    const s = new Set();
    for (const m of t.matchAll(/^\s{8,}(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)) s.add(m[1]);
    for (const m of t.matchAll(/^        (?:let|const|var) ([A-Za-z_$][\w$]*)/gm)) s.add(m[1]);
    return s;
};
const now = read(root + '/index.html');
const nd = decls(now);
const gone = [...decls(read(oldFile))].filter(n => !nd.has(n) && n.length > 5);
if (!gone.length) { console.log('無くなった宣言は無い'); process.exit(0); }
const re = new RegExp('(?<![\\w$])(' + gone.map(x => x.replace(/\$/g, '\\$')).join('|') + ')(?![\\w$])', 'g');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
let n = 0;
for (const f of [root + '/index.html', ...walk(root + '/js').filter(x => x.endsWith('.js'))]) {
    read(f).split('\n').forEach((l, i) => {
        const m = l.match(re);
        if (m) { n++; console.log(`${path.relative(root, f)}:${i + 1}: [${[...new Set(m)].join(' ')}] ${l.trim().slice(0, 150)}`); }
    });
}
console.log(n ? `残っている行 ${n}` : '消した名前に触れている行は無い');
