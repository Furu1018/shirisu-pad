// <style> の中のクラス・id のうち、<style> の外 (HTML・台本・js/) に 1 回も出てこないものを数える。
//   node css-orphans.mjs <root>            … 一覧
//   APPLY=1 BASE=<元の版の一覧.json> …   … 元の版では使われていた (= 今回の撤去で孤立した) ものだけ、その規則を消す
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const p = root + '/index.html';
const raw = fs.readFileSync(p, 'utf8'); const crlf = raw.includes('\r\n');
const s = raw.replace(/\r\n/g, '\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
// <style> の区画 (複数あり得る)
const blocks = []; { const re = /<style[^>]*>([\s\S]*?)<\/style>/g; let m; while ((m = re.exec(s))) blocks.push({ a: m.index + m[0].indexOf('>') + 1, b: m.index + m[0].length - 8 }); }
const inStyle = (i) => blocks.some(b => i >= b.a && i < b.b);
let outside = ''; { let last = 0; for (const b of blocks) { outside += s.slice(last, b.a); last = b.b; } outside += s.slice(last); } outside += '\n' + js;
const css = blocks.map(b => s.slice(b.a, b.b)).join('\n');
const noComment = css.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
const names = new Set();
for (const m of noComment.matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)) { if (m[1] === '#' && /^[0-9a-fA-F]{3,8}$/.test(m[2])) continue; names.add(m[1] + m[2]); }
const used = (n) => new RegExp('(?<![\\w-])' + n.slice(1).replace(/[-]/g, '\\-') + '(?![\\w-])').test(outside);
const orphan = [...names].filter(n => !used(n)).sort();
if (process.env.LIST) { fs.writeFileSync(process.env.LIST, JSON.stringify(orphan)); }
if (!process.env.APPLY) { console.log(`<style> の中の名前 ${names.size} 個・外に出てこない: ${orphan.length} 個`); console.log(orphan.join(' ')); process.exit(0); }
const base = new Set(JSON.parse(fs.readFileSync(process.env.BASE, 'utf8')));
const target = new Set(orphan.filter(n => !base.has(n)));
console.log('今回の撤去で孤立した名前: ' + target.size + ' 個\n' + [...target].join(' '));
// 規則を読む: 区画ごとに、波かっこの対応で「選択子 { 本体 }」を取り出す (@media などは中へ入る・@keyframes / @font-face は触らない)
const cuts = [];   // [a, b, 差し替え]
// ★ :not(.x) の中の名前は「その部品が要る」ではない (無ければ常に真) → 数えない。規則はそのまま残す (書き換えない)
const hasTarget = (sel) => [...sel.replace(/:not\([^()]*\)/g, '').matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)].some(m => target.has(m[1] + m[2]));
const parse = (a, b) => {
    let i = a;
    while (i < b) {
        // 注釈・空白を飛ばす
        if (/\s/.test(s[i])) { i++; continue; }
        if (s.startsWith('/*', i)) { i = s.indexOf('*/', i) + 2; continue; }
        const open = s.indexOf('{', i); if (open < 0 || open >= b) break;
        const semi = s.indexOf(';', i);
        if (semi >= 0 && semi < open) { i = semi + 1; continue; }   // @import など
        let depth = 1, j = open + 1;
        while (j < b && depth) { if (s.startsWith('/*', j)) { j = s.indexOf('*/', j) + 2; continue; } if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
        const sel = s.slice(i, open).trim();
        if (sel.startsWith('@')) { if (/^@(media|supports)/.test(sel)) parse(open + 1, j - 1); }
        else {
            const parts = sel.split(',').map(x => x.trim());
            const keep = parts.filter(x => !hasTarget(x));
            if (keep.length === 0) cuts.push([i, j, '']);
            else if (keep.length < parts.length) cuts.push([i, open, keep.join(', ') + ' ']);
        }
        i = j;
    }
};
for (const blk of blocks) parse(blk.a, blk.b);
let out = s;
const before = s.split('\n').length;
for (let [a, b, rep] of cuts.sort((x, y) => y[0] - x[0])) {
    if (rep === '') {
        // 規則が行をまるごと占めていたら、その行ごと消す (前の字下げ・後ろの空白・同じ行に続く注釈・改行 1 つ)
        let a2 = a; while (a2 > 0 && (out[a2 - 1] === ' ' || out[a2 - 1] === '\t')) a2--;
        const lineStart = a2 === 0 || out[a2 - 1] === '\n';
        let b2 = b; while (out[b2] === ' ' || out[b2] === '\t') b2++;
        if (out.startsWith('/*', b2)) { const e = out.indexOf('*/', b2) + 2; const nl = out.indexOf('\n', b2); if (e > 1 && (nl < 0 || e <= nl)) { b2 = e; while (out[b2] === ' ' || out[b2] === '\t') b2++; } }
        if (lineStart && out[b2] === '\n') { a = a2; b = b2 + 1; }
    }
    out = out.slice(0, a) + rep + out.slice(b);
}
// ---- 規則を消して宙に浮いた注釈と、使われなくなった @keyframes ----
const styleSpans = (t) => { const r = []; const re = /<style[^>]*>([\s\S]*?)<\/style>/g; let m; while ((m = re.exec(t))) r.push([m.index + m[0].indexOf('>') + 1, m.index + m[0].length - 8]); return r; };
// 行の頭から始まる注釈のうち「宙に浮いている」もの = 直後が 別の注釈 / } / </style> / 空行。戻り値は [a, b, 本文]
const dangling = (t) => {
    const res = [];
    for (const [sa, sb] of styleSpans(t)) {
        let i = sa;
        while (i < sb) {
            const c = t.indexOf('/*', i); if (c < 0 || c >= sb) break;
            const e = t.indexOf('*/', c) + 2; if (e < 2) break;
            let ls = c; while (ls > 0 && (t[ls - 1] === ' ' || t[ls - 1] === '\t')) ls--;
            const atLineStart = t[ls - 1] === '\n';
            let q = e, nl = 0; while (q < sb && /\s/.test(t[q])) { if (t[q] === '\n') nl++; q++; }
            const next = t.slice(q, q + 2);
            if (atLineStart && (next === '/*' || next[0] === '}' || q >= sb || nl >= 2)) res.push([ls, e, t.slice(c, e)]);
            i = e;
        }
    }
    return res;
};
const wasDangling = new Set(dangling(s).map(x => x[2]));
let dropped = 0, kf = 0;
for (let round = 0; round < 6; round++) {
    let changed = false;
    // 使われなくなった @keyframes (名前が自分の定義にしか出てこない)
    for (const [sa, sb] of styleSpans(out).reverse()) {
        const blk = out.slice(sa, sb);
        const defs = [...blk.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)\s*\{/g)].reverse();
        for (const m of defs) {
            const name = m[1];
            const uses = (out.match(new RegExp('(?<![\\w-])' + name.replace(/-/g, '\\-') + '(?![\\w-])', 'g')) || []).length + (js.match(new RegExp('(?<![\\w-])' + name.replace(/-/g, '\\-') + '(?![\\w-])', 'g')) || []).length;
            if (uses > 1) continue;
            const wasUsed = (s.match(new RegExp('(?<![\\w-])' + name.replace(/-/g, '\\-') + '(?![\\w-])', 'g')) || []).length > 1;
            if (!wasUsed) continue;   // 元から使われていなかったものは触らない
            let a = sa + m.index, depth = 1, j = a + m[0].length;
            while (depth) { if (out[j] === '{') depth++; else if (out[j] === '}') depth--; j++; }
            let a2 = a; while (out[a2 - 1] === ' ' || out[a2 - 1] === '\t') a2--;
            let b2 = j; while (out[b2] === ' ' || out[b2] === '\t') b2++;
            if (out[a2 - 1] === '\n' && out[b2] === '\n') { a = a2; j = b2 + 1; }
            out = out.slice(0, a) + out.slice(j); kf++; changed = true;
        }
    }
    const d = dangling(out).filter(x => !wasDangling.has(x[2])).reverse();
    for (const [a, b] of d) { let b2 = b; while (out[b2] === ' ' || out[b2] === '\t') b2++; if (out[b2] === '\n') b2++; out = out.slice(0, a) + out.slice(b2); dropped++; changed = true; }
    if (!changed) break;
}
// <style> の中の、空白だけの行が続いたら 1 つに
{ const sp = styleSpans(out).reverse(); for (const [sa, sb] of sp) { const blk = out.slice(sa, sb).replace(/\n([ \t]*\n){2,}/g, '\n\n'); out = out.slice(0, sa) + blk + out.slice(sb); } }
fs.writeFileSync(p, crlf ? out.replace(/\n/g, '\r\n') : out);
console.log(`消した規則・選択子: ${cuts.length} か所 / 宙に浮いた注釈 ${dropped} / 使われなくなった @keyframes ${kf}・行 ${before} → ${out.split('\n').length}`);
