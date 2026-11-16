// 落ちたテストごとに、テストの範囲 (行) と落ちた assert の前後を出す。 node failctx.mjs <root> <_rt-debug の出力> [前] [後] [幅]
import fs from 'node:fs';
const [root, outFile, B = '2', A = '3', W = '330'] = process.argv.slice(2);
const src = fs.readFileSync(root + '/tests/run-tests.mjs', 'utf8').replace(/\r\n/g, '\n').split('\n');
const out = fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n').split('\n');
// テストの頭の行: test('…' / await testAsync('…'
const heads = []; src.forEach((l, i) => { if (/^(?:await )?test(?:Async)?\(/.test(l)) heads.push(i); });
const rangeOf = (ln) => { let h = -1; for (const x of heads) { if (x <= ln) h = x; else break; } const nx = heads.find(x => x > h) ?? src.length; let e = nx - 1; while (e > h && !/^\}\);?\s*$/.test(src[e])) e--; return [h, e]; };
let k = 0;
for (let i = 0; i < out.length; i++) {
    if (!/^\s+❌/.test(out[i])) continue;
    const name = out[i].replace(/^\s+❌\s*/, '');
    const msg = (out[i + 1] || '').trim();
    const at = (out[i + 2] || '').match(/@L([\d,]*)/);
    const lns = at ? at[1].split(',').filter(Boolean).map(Number) : [];
    const ln = lns[0] ? lns[0] - 1 : -1;
    // 積み重ねの最後の行 = test( を呼んだ行。そこから、同じ字下げの「});」まで
    const h = lns.length ? lns[lns.length - 1] - 1 : -1;
    let e = h; if (h >= 0) { const ind = src[h].match(/^\s*/)[0]; e = h + 1; while (e < src.length && !(src[e].startsWith(ind + '});') || src[e].startsWith(ind + '})'))) e++; }
    k++;
    console.log(`\n#${k} [${h + 1}-${e + 1}] ${name.slice(0, 120)}\n   → ${msg.slice(0, 160)}  @${lns.join(',')}`);
    if (ln >= 0) for (let x = Math.max(h, ln - Number(B)); x <= Math.min(e, ln + Number(A)); x++) console.log(`${String(x + 1).padStart(6)}${x === ln ? ' >' : '  '}${[...src[x]].slice(0, Number(W)).join('')}`);
}
