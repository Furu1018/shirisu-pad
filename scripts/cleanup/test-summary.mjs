// 仕分けのあとの run-tests.mjs を、元の版 (git HEAD) とテストごとに比べる: 行数・assert の数 (元 → いま)。 node test-summary.mjs <root> <元の版の run-tests.mjs>
import fs from 'node:fs';
const [root, oldFile] = process.argv.slice(2);
const parse = (file) => {
    const ls = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const m = new Map();
    for (let i = 0; i < ls.length; i++) {
        const h = /^(\s*)(?:await )?test(?:Async)?\(\s*(['"`])(.*)$/.exec(ls[i]);
        if (!h) continue;
        const ind = h[1]; const q = h[2];
        const name = h[3].slice(0, h[3].indexOf(q) >= 0 ? h[3].indexOf(q) : undefined);
        let e = i + 1; while (e < ls.length && !ls[e].startsWith(ind + '})')) e++;
        const body = ls.slice(i, e + 1);
        m.set(name, { a: i + 1, b: e + 1, lines: body.length, asserts: body.filter(l => /\bassert\b/.test(l)).length });
        i = e;
    }
    return m;
};
const A = parse(oldFile), B = parse(root + '/tests/run-tests.mjs');
console.log(`テスト: 元 ${A.size} / いま ${B.size}`);
const rows = [];
for (const [n, a] of A) { const b = B.get(n); if (!b) { rows.push(`  (無い)                 ${n.slice(0, 110)}`); continue; } if (a.asserts !== b.asserts || a.lines !== b.lines) rows.push(`  assert ${String(a.asserts).padStart(3)} → ${String(b.asserts).padStart(3)} (行 ${String(a.lines).padStart(3)} → ${String(b.lines).padStart(3)}) @${b.a}  ${n.slice(0, 110)}`); }
console.log(rows.join('\n'));
