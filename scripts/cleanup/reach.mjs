// 到達できない関数を数える (循環も拾う)。根 = 関数の外の文 (HTML・CSS・台本の地の文) と js/ 以下・sw.js。
// 使い方: node reach.mjs <root> [APPLY=1 で消す]   出力: 到達できない関数の一覧 (行・長さ)
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const apply = process.env.APPLY === '1';
const p = root + '/index.html';
const raw = fs.readFileSync(p, 'utf8');
const crlf = raw.includes('\r\n');
const lines = raw.replace(/\r\n/g, '\n').split('\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n') + '\n' + fs.readFileSync(root + '/sw.js', 'utf8');
const tests = walk(root + '/tests').filter(f => f.endsWith('.mjs')).map(f => [path.basename(f), fs.readFileSync(f, 'utf8')]);
const START = /^        (?:async )?function ([A-Za-z_$][\w$]*)\(/;
const fns = [];
for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i]);
    if (!m) continue;
    let b = i;
    // 1 行で閉じる関数 (function f() { … }) もある
    if (!/\}\s*(\/\/.*)?$/.test(lines[i]) || (lines[i].match(/\{/g) || []).length !== (lines[i].match(/\}/g) || []).length) {
        while (b < lines.length && lines[b] !== '        }') b++;
    }
    fns.push({ name: m[1], a: i, b });
    i = b;
}
const inFn = new Array(lines.length).fill(-1);
fns.forEach((f, k) => { for (let i = f.a; i <= f.b; i++) inFn[i] = k; });
const rootText = lines.filter((_, i) => inFn[i] < 0).join('\n') + '\n' + js;
const byName = new Map();
fns.forEach((f, k) => { if (!byName.has(f.name)) byName.set(f.name, []); byName.get(f.name).push(k); });
const names = [...byName.keys()];
const WORD = /[A-Za-z_$][\w$]*/g;
// 注釈の中の名前は「呼んでいる」に数えない: <!-- --> と /* */、行の頭からの // 、空白 2 つ以上のあとの // (文字列の中の URL を切らないため)
//   ★ 行ごとに見る (全体に正規表現を掛けると、文字列の中の「/*」から先を丸ごと食べる)。複数行の注釈は「行の頭が <!-- か /*」で始まるものだけ
const strip = (text) => {
    const out = []; let end = null;
    for (const l of text.split('\n')) {
        if (end) { if (l.includes(end)) end = null; out.push(''); continue; }
        const t = l.trimStart();
        if (t.startsWith('//')) { out.push(''); continue; }
        if (t.startsWith('<!--')) { if (!t.includes('-->')) end = '-->'; out.push(t.includes('-->') ? t.slice(t.indexOf('-->') + 3) : ''); continue; }
        if (t.startsWith('/*')) { if (!t.includes('*/')) end = '*/'; out.push(t.includes('*/') ? t.slice(t.indexOf('*/') + 2) : ''); continue; }
        out.push(l.replace(/\s{2,}\/\/.*$/, '').replace(/\s{2,}\/\*.*?\*\/\s*$/, ''));
    }
    return out.join('\n');
};
const mentions = (text0) => { const text = strip(text0); const s = new Set(); for (const m of text.matchAll(WORD)) if (byName.has(m[0])) s.add(m[0]); return s; };
const live = new Set(mentions(rootText));
const queue = [...live];
while (queue.length) {
    const n = queue.pop();
    for (const k of byName.get(n)) {
        const body = lines.slice(fns[k].a + 0, fns[k].b + 1).join('\n').replace(START, '');
        // 宣言の行の名前は自分なので外す
        const own = lines[fns[k].a].replace(START, 'function (');
        const text = own + '\n' + lines.slice(fns[k].a + 1, fns[k].b + 1).join('\n');
        for (const m of mentions(text)) if (!live.has(m)) { live.add(m); queue.push(m); }
    }
}
const dead = fns.filter(f => !live.has(f.name));
const total = dead.reduce((t, d) => t + (d.b - d.a + 1), 0);
console.log(`関数 ${fns.length} 個 (名前 ${names.length})・到達できない: ${dead.length} 個・${total} 行`);
for (const d of dead) {
    const t = tests.filter(([, s]) => new RegExp('(?<![\\w$])' + d.name.replace(/\$/g, '\\$') + '(?![\\w$])').test(s)).map(([n]) => n);
    console.log(`  ${String(d.b - d.a + 1).padStart(4)} 行  ${d.name}  (行 ${d.a + 1})${t.length ? '  テスト: ' + t.join(',') : ''}`);
}
if (apply && dead.length) {
    const kill = new Array(lines.length).fill(false);
    for (const d of dead) {
        for (let i = d.a; i <= d.b; i++) kill[i] = true;
        // 直前に貼り付いている注釈の行 (// …) も一緒に (空行で切れていたら残す)
        let i = d.a - 1;
        while (i >= 0 && /^        \/\//.test(lines[i]) && inFn[i] < 0) { kill[i] = true; i--; }
    }
    const out = lines.filter((_, i) => !kill[i]);
    // 続く空行は 1 つに
    const sq = []; for (const l of out) { if (l.trim() === '' && sq.length && sq[sq.length - 1].trim() === '') continue; sq.push(l); }
    fs.writeFileSync(p, crlf ? sq.join('\n').replace(/\n/g, '\r\n') : sq.join('\n'));
    console.log('消した: ' + dead.length + ' 個・' + (lines.length - sq.length) + ' 行');
}
