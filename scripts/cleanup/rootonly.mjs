// 台本の地の文 (関数の外) でしか使われていない変数・定数を出す (関数の中・HTML・js/ のどこからも読まれない = 初期化の残り)。
//   node rootonly.mjs <root>     出力: 名前・宣言の行・地の文で触っている行
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const lines = fs.readFileSync(root + '/index.html', 'utf8').replace(/\r\n/g, '\n').split('\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const START = /^        (?:async )?function ([A-Za-z_$][\w$]*)\(/;
const inFn = new Array(lines.length).fill(false);
for (let i = 0; i < lines.length; i++) { const m = START.exec(lines[i]); if (!m) continue; let b = i; if ((lines[i].match(/\{/g) || []).length !== (lines[i].match(/\}/g) || []).length) while (b < lines.length && lines[b] !== '        }') b++; for (let k = i; k <= b; k++) inFn[k] = true; i = b; }
// 台本の区画 (<script> … </script>) の中か
const inScript = new Array(lines.length).fill(false); { let on = false; lines.forEach((l, i) => { if (/<script\b[^>]*>\s*$/.test(l) && !/src=/.test(l)) { on = true; return; } if (/<\/script>/.test(l)) on = false; inScript[i] = on; }); }
const isComment = (l) => /^\s*(\/\/|<!--|\/\*|\*)/.test(l);
const code = (l) => l.replace(/\s{2,}\/\/.*$/, '');
const decl = [];
lines.forEach((l, i) => {
    if (inFn[i] || !inScript[i]) return;
    const m = /^        (let|const|var) (.+)$/.exec(l); if (!m) return;
    // 宣言の頭の名前と、「, 名前 =」で並んだ名前 (かっこ・文字列の中は見ない粗い切り方)
    const flat = code(m[2]).replace(/\([^()]*\)|\{[^{}]*\}|\[[^\[\]]*\]|'[^']*'|"[^"]*"|`[^`]*`/g, '');
    const names = [/^([A-Za-z_$][\w$]*)/.exec(flat)?.[1], ...[...flat.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*(?==|,|;|$)/g)].map(x => x[1])].filter(Boolean);
    for (const n of names) decl.push({ n, i });
});
const out = [];
for (const d of decl) {
    const re = new RegExp('(?<![\\w$.])' + d.n.replace(/\$/g, '\\$') + '(?![\\w$])');
    if (re.test(js)) continue;
    let fn = 0, html = 0; const top = [];
    lines.forEach((l, i) => { if (isComment(l) || !re.test(code(l))) return; if (inFn[i]) fn++; else if (!inScript[i]) html++; else top.push(i + 1); });
    if (fn === 0 && html === 0) out.push(`${d.n} (宣言 ${d.i + 1}) 地の文: ${top.join(',')}`);
}
console.log(out.join('\n') || '(なし)');
