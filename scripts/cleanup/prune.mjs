// run-tests.mjs の「消した機能を見ている assert」を機械的に外す (1 周に 1 テスト 1 文・外した文はすべて記録する)。
//   node prune.mjs <root> <元の版の index.html> <記録の出力>     ROUNDS=40
// 外すのは: 落ちた文 (またはその文が使う変数の定義) が「無くなった名前」に触れているとき / 外した定義を使っていて「X is not defined」のとき。
// それ以外は手で見る (最後に一覧を出す)。
import fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
const [root, oldFile, logFile] = process.argv.slice(2);
const ROUNDS = Number(process.env.ROUNDS || 40);
const read = (f) => fs.readFileSync(f, 'utf8');
const decls = (t) => { const s = new Set(); for (const m of t.matchAll(/^\s{8,}(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)) s.add(m[1]); for (const m of t.matchAll(/^        (?:let|const|var) ([A-Za-z_$][\w$]*)/gm)) s.add(m[1]); return s; };
const newDecl = decls(read(root + '/index.html').replace(/\r\n/g, '\n'));
const gone = [...decls(read(oldFile).replace(/\r\n/g, '\n'))].filter(n => !newDecl.has(n));
const extras = (process.env.EXTRAS ? read(process.env.EXTRAS) : '').split(/\s+/).filter(Boolean);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const goneRe = new RegExp('(?<![\\w$-])(?:' + [...gone, ...extras].sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![\\w$-])');
const tp = root + '/tests/run-tests.mjs';
const raw0 = read(tp); const crlf = raw0.includes('\r\n');
let src = raw0.replace(/\r\n/g, '\n').split('\n');
const log = []; const manual = new Map(); const stuck = new Set();
const indentOf = (l) => l.match(/^\s*/)[0].length;
const DBG = "console.error(`     ${e.message}`);";
const DBG2 = "console.error(`     ${String(e.message).split('\\n')[0]}`); console.error('     @L' + ((String(e.stack).match(/_rt-debug\\.mjs:(\\d+)/g) || []).map(x => x.split(':')[1]).join(',')));";
for (let round = 1; round <= ROUNDS; round++) {
    fs.writeFileSync(root + '/tests/_rt-debug.mjs', src.join('\n').split(DBG).join(DBG2));
    const r = spawnSync('node', ['tests/_rt-debug.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout + '\n' + r.stderr).replace(/\r\n/g, '\n').split('\n');
    const fails = [];
    for (let i = 0; i < out.length; i++) {
        if (!/^\s+❌/.test(out[i])) continue;
        const name = out[i].replace(/^\s+❌\s*/, ''); const msg = (out[i + 1] || '').trim();
        const at = (out.slice(i + 1, i + 4).join('\n').match(/@L([\d,]*)/) || [])[1] || '';
        fails.push({ name, msg, frames: at.split(',').filter(Boolean).map(Number) });
    }
    const summary = out.filter(l => /passed, .* failed/.test(l)).pop() || '(集計の行が無い)';
    if (!fails.length) { console.log(`周 ${round}: ${summary} — 落ちるテストなし`); break; }
    const cuts = []; manual.clear();
    for (const f of fails) {
        if (f.frames.length < 2) { manual.set(f.name, f.msg + ' (行が取れない)'); continue; }
        const head = f.frames[f.frames.length - 1] - 1;
        const ind = indentOf(src[head]); let end = head + 1; while (end < src.length && !(indentOf(src[end]) === ind && /^\s*\}\)/.test(src[end]))) end++;
        // テストの本体の中の、いちばん内側の枠 (helper の中で投げたときは、それを呼んだ行)
        const inBody = f.frames.slice(0, -1).map(x => x - 1).filter(x => x > head && x < end);
        if (!inBody.length) { manual.set(f.name, f.msg + ' (本体の行が無い)'); continue; }
        const L = inBody[inBody.length - 1];
        // 文の範囲: L と、L より字下げの深い続きの行。閉じかっこだけの行 (字下げが同じで ) や ] } で始まる) も含める
        let M = L; const li = indentOf(src[L]);
        while (M + 1 < end && (src[M + 1].trim() === '' ? false : (indentOf(src[M + 1]) > li || (indentOf(src[M + 1]) === li && /^\s*[\)\]\}]/.test(src[M + 1]))))) M++;
        const text = src.slice(L, M + 1).join('\n');
        const body = src.slice(head, L);
        const defOf = (id) => { for (let k = body.length - 1; k >= 0; k--) { if (new RegExp('(?:const|let|var)\\s+(?:\\{[^}]*\\b' + esc(id) + '\\b[^}]*\\}|\\[[^\\]]*\\b' + esc(id) + '\\b[^\\]]*\\]|' + esc(id) + ')\\s*=').test(body[k])) { let e2 = k; const bi = indentOf(body[k]); while (e2 + 1 < body.length && indentOf(body[e2 + 1]) > bi && body[e2 + 1].trim() !== '') e2++; return body.slice(k, e2 + 1).join('\n'); } } return null; };
        const touches = (t, depth) => {
            if (goneRe.test(t)) return true;
            if (depth <= 0) return false;
            const ids = new Set([...t.matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]));
            for (const id of ids) { const d = defOf(id); if (d && d !== t && touches(d, depth - 1)) return true; }
            return false;
        };
        const undef = (f.msg.match(/^([A-Za-z_$][\w$]*) is not defined/) || [])[1];
        if (stuck.has(f.name)) { manual.set(f.name, `(外すと構文が壊れる文) ${f.msg.slice(0, 120)}  @${L + 1}\n        ${text.split('\n')[0].trim().slice(0, 260)}`); continue; }
        const why = touches(text, 3) ? '無くなった名前に触れている' : (undef && !defOf(undef)) ? `このテストの中にもう定義の無い ${undef} を使っている` : null;
        // ★ テンプレート文字列の途中で切らない (バッククォートが奇数個の文は、外すと構文が壊れる) → 手で見る
        if (why && (text.match(/`/g) || []).length % 2 === 1) { manual.set(f.name, `(バッククォートが閉じていない文) ${f.msg.slice(0, 120)}  @${L + 1}\n        ${text.split('\n')[0].trim().slice(0, 260)}`); continue; }
        if (!why) { manual.set(f.name, `${f.msg.slice(0, 140)}  @${L + 1}\n        ${text.split('\n')[0].trim().slice(0, 260)}`); continue; }
        cuts.push({ L, M, name: f.name, why, msg: f.msg, text });
    }
    console.log(`周 ${round}: ${summary} — 外す ${cuts.length}・手で見る ${manual.size}`);
    if (!cuts.length) break;
    // 1 つずつ外して、そのたびに構文を確かめる (壊れたら戻して「手で見る」へ)
    let applied = 0;
    for (const c of cuts.sort((a, b) => b.L - a.L)) {
        const keep = src.slice();
        src.splice(c.L, c.M - c.L + 1);
        fs.writeFileSync(root + '/tests/_rt-check.mjs', src.join('\n'));
        const ck = spawnSync('node', ['--check', 'tests/_rt-check.mjs'], { cwd: root, encoding: 'utf8' });
        if (ck.status !== 0) { src = keep; stuck.add(c.name); continue; }
        log.push({ round, line: c.L + 1, name: c.name, why: c.why, msg: c.msg, text: c.text }); applied++;
    }
    try { fs.unlinkSync(root + '/tests/_rt-check.mjs'); } catch { /* noop */ }
    if (!applied) break;
}
fs.writeFileSync(tp, crlf ? src.join('\n').replace(/\n/g, '\r\n') : src.join('\n'));
try { fs.unlinkSync(root + '/tests/_rt-debug.mjs'); } catch { /* noop */ }
const byTest = new Map(); for (const x of log) { if (!byTest.has(x.name)) byTest.set(x.name, []); byTest.get(x.name).push(x); }
let o = `外した文: ${log.length} (テスト ${byTest.size} 個)\n`;
for (const [n, xs] of byTest) { o += `\n■ ${n.slice(0, 150)}\n`; for (const x of xs) o += `  [${x.round}] ${x.msg.slice(0, 90)}\n      ${x.text.replace(/\s+/g, ' ').slice(0, 330)}\n`; }
o += `\n\n===== 手で見るもの: ${manual.size}\n`; for (const [n, m] of manual) o += `\n□ ${n.slice(0, 150)}\n    ${m}\n`;
fs.writeFileSync(logFile, o);
console.log(`外した文 ${log.length}・手で見る ${manual.size} → ${logFile}`);
