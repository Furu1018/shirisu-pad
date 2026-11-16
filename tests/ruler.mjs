// ============================================================================
// 📏 物差しの検査 (全体の見直し 段階 2・2026-11-16〜) — 本物のブラウザで、揃え終わったタブに「物差しから外れた部品」が 0 個なのを確かめる
//   node tests/ruler.mjs            揃え終わったタブ (下の DONE) を全部
//   TABS=raid node tests/ruler.mjs  まだ揃えていないタブの外れを一覧で見る (落ちない・下調べ用)。運営タブの中の小タブは TABS=ops/メンバー,ops/組む,ops/戦況
// ----------------------------------------------------------------------------
// ★ Chrome が要る (無ければ「スキップ」と出して終わる)。CHROME=<実行ファイル> で場所を指定できる。練習モードで開くので、本番へは書かない。
// 物差し (ふるりの決定 2026-11-14「顔つきは今のまま、物差しだけ揃える」・正本は docs/段階2_物差し_2026-11-14.md):
//   文字   11 / 12 / 14 / 16 / 20 px (24px 以上はそのまま)。表と 1 人 1 行の一覧の中だけ 9 / 10 px
//   角丸   短い辺が 24px 未満の部品 4 / ボタン・欄・チップ 8 / 中の箱 14 / カード 22 px / 丸 (短い辺の半分以上)
//   押すもの 高さ 40px 以上。一覧の行の中の小さいボタン・文字だけのリンクは見た目を変えず、押せる範囲だけ広げる (class hit40)
// 画面を足したり、文字の大きさ・角丸を書くときは、この数字から選ぶ。揃え終わったタブを DONE に足すと、戻ったときにここで落ちる。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 揃え終わったタブ (ここに足す)。開く場面は、そのタブの中身が変わる所を選ぶ (練習の編・途中の課題・幅)
const DONE = {
    mypage: ['member:390', 'member&start=schedule:390', 'member&start=report:390', 'ops-eve:390', 'ops-day:390', 'member&start=report:1366', 'ops-day:1366'],
    'ops/メンバー': ['ops-eve:390', 'ops-day:390', 'ops-day:1366'],   // 運営タブの小タブ (段階のバー・ヒーロー・👥 メンバー状況・📸 模擬の取り込み・一斉通知・Discord 用の文面)
};
const ONLY = (process.env.TABS || '').split(',').filter(Boolean);
const PLAN = ONLY.length ? Object.fromEntries(ONLY.map(t => [t, DONE[t] || ['member:390', 'ops-eve:390', 'ops-day:390', 'ops-day:1366']])) : DONE;
const STRICT = !ONLY.length || ONLY.every(t => DONE[t]);

const CHROME = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!CHROME) { console.log('スキップ: Chrome が見つかりません (CHROME=<実行ファイル> で指定できます)'); process.exit(0); }
if (typeof WebSocket !== 'function') { console.log('スキップ: この Node には WebSocket がありません (Node 22 以上で動きます)'); process.exit(0); }

// ---- 物差し (ブラウザの中で動く)。docs/段階2_物差し_2026-11-14.md の検査と同じもの ----
const CHECK = `(() => {
    const roots = [document.querySelector('.tab-content.active'), document.querySelector('.header'), document.getElementById('bottomNav')].filter(Boolean);
    const els = []; for (const r of roots) { els.push(r); for (const e of r.querySelectorAll('*')) els.push(e); }
    // 縦に伸ばさない所 (表・1 人 1 行の一覧 = 👥 メンバー状況の行 .dc-mb-row・盤の駒と名前の札): 小さい文字 9 / 10px と、行の中の小さいボタンを認める
    const dense = (e) => !!e.closest('table, .dc-mb-row, [class*="table"], .obr, .obpc, .db-tag');
    const ownText = (e) => [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim());
    const snapF = (px) => px < 11.3 ? 11 : px < 12.8 ? 12 : px < 15 ? 14 : px < 17.5 ? 16 : px < 24 ? 20 : px;
    const where = (e) => { let n = e; while (n && n !== document.body) { if (n.id) return '#' + n.id; n = n.parentElement; } return ''; };
    const sig = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
    const out = [];
    for (const e of els) {
        const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue;
        const txt = (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 18);
        if (ownText(e)) { const px = parseFloat(cs.fontSize); let t = snapF(px); if (dense(e) && px < 11) t = px < 9.75 ? 9 : 10; if (Math.abs(t - px) > 0.01) out.push(['文字', px + '→' + t, where(e), sig(e), txt]); }
        const r = parseFloat(cs.borderTopLeftRadius); const short = Math.min(b.height, b.width);
        if (r > 0 && r < short / 2 - 0.5) { const t = short < 24 ? 4 : r <= 10.5 ? 8 : r <= 18 ? 14 : 22; if (t !== r) out.push(['角丸', r + '→' + t, where(e), sig(e), Math.round(b.width) + 'x' + Math.round(b.height) + ' ' + txt]); }
        if (e.matches('button, [role="button"], a.btn, select, input[type="text"], input[type="number"]') && !dense(e) && !e.classList.contains('hit40') && b.height >= 24 && b.height < 40 && b.width >= 24) out.push(['高さ', Math.round(b.height) + '→40', where(e), sig(e), txt]);
        // hit40 (見た目を変えずに押せる範囲を広げる) は、class があるだけで通さない。2 つとも満たすこと:
        //   ① 押せる範囲 (::before) の高さが 40px 以上 (数字)  ② その範囲の点が、実際にこのボタンに当たる (::before が無い・消えている・pointer-events が無い・親で切れている・別の部品に覆われている、を拾う)。
        //   ② はボタンを画面の真ん中に寄せ (すぐ動かす — なめらかなスクロールの途中を測らない)、左・中・右 × 上 19.5px・真ん中・下 19.5px の 9 点で elementFromPoint を見る。押したあとの動き (disabled など) までは見ない
        if (e.classList.contains('hit40')) {
            const hb = parseFloat(getComputedStyle(e, '::before').height);
            e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            const q = e.getBoundingClientRect(); const cy = q.top + q.height / 2;
            const hitAt = (x, dy) => { const g = document.elementFromPoint(x, cy + dy); return !!g && (g === e || e.contains(g)); };
            const xs = [q.left + 2, q.left + q.width / 2, q.right - 2]; const miss = [];
            for (const x of xs) for (const dy of [-19.5, 0, 19.5]) if (!hitAt(x, dy)) miss.push(Math.round(x - q.left) + ',' + dy);
            if (!(hb >= 39.5) || miss.length) out.push(['高さ', 'hit40 の押せる範囲 ' + (Number.isFinite(hb) ? Math.round(hb * 10) / 10 : '?') + 'px→40 (当たらない点 ' + (miss.join(' ') || 'なし') + ')', where(e), sig(e), txt]);
        }
    }
    return out;
})()`;

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
    });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-ruler-'));
const debugPort = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (_) { /* noop */ } try { server.close(); } catch (_) { /* noop */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* noop */ } };
process.on('exit', cleanup);

let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch (_) { await wait(250); } }
if (!ver) { console.error('NG: Chrome に接続できません'); process.exit(2); }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });
let id = 0; const waits = new Map(); const errors = [];
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.ng(new Error(m.error.message)) : w.ok(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false }, sessionId: m.sessionId }));
};
const send = (method, params = {}, sessionId) => new Promise((ok, ng) => { const i = ++id; waits.set(i, { ok, ng }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

let failed = 0, checked = 0;
for (const [tab, scenes] of Object.entries(PLAN)) {
    for (const scene of scenes) {
        const [scenario, w] = scene.split(':'); const W = Number(w), H = W > 700 ? 800 : 844;
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const S = (method, params) => send(method, params, sessionId);
        const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
        await S('Page.enable'); await S('Runtime.enable');
        await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
        await S('Page.navigate', { url: `${ORIGIN}/index.html?practice=${scenario}` });
        // 読み込みは時計でなく状態で待つ (途中の課題から入ると、準備のあとにもう一度読み込み直す): 練習の案内が出てから、少し置く
        let ready = false;
        for (let i = 0; i < 80 && !ready; i++) { await wait(500); try { ready = await ev(`!!(window.PAD_PRACTICE && document.getElementById('pmDock') && document.readyState === 'complete' && typeof switchTab === 'function')`); } catch (_) { /* 読み込み直しの最中 */ } }
        await wait(2500);
        const [tabId, sub] = tab.split('/');   // 'ops/組む' = 運営タブの中の小タブ (名前の一部で指す)
        let v = null, label = `${tab} — ${scenario} ${W}px`;
        try {
            // 練習の案内 (上の帯・枠) と使い方ツアーは検査の対象でない (本番の画面に無い / 別の画面)
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '#pmDock, #pmRing, #tourOverlay { display: none !important; }'; document.head.appendChild(st); return 1; })()`);
            let active = await ev(`(() => { switchTab(${JSON.stringify(tabId)}); return document.querySelector('.tab-content.active')?.id || null; })()`);
            if (sub && active === 'tab-' + tabId) {
                // 小タブは、タブの中身が出てから押す (運営タブは盤面を読んでから小タブを描く)
                let hit = false;
                for (let i = 0; i < 20 && !hit; i++) { await wait(500); hit = await ev(`(() => { const b = [...document.querySelectorAll('#opsSubTabs button')].find(x => x.textContent.includes(${JSON.stringify(sub)})); if (!b) return false; b.click(); return true; })()`); }
                if (!hit) active = '小タブ「' + sub + '」が無い';
            }
            // ★ 中身が落ち着くまで待つ (Codex 監査 fc127f8): タブの中の部品の数と文字の量が 3 回続けて同じになるまで (最長 20 秒)。非同期の描画の途中 (読み込み中・空) を検査して通さない
            //   「同じ」は 部品の数 + 文字の中身 (長さでなく中身 — 同じ長さの別の文に差し替わったのを見逃さない) + タブの高さ + 押せない・隠した・選んだ部品の数。早く揃っても 5 秒は見る (遅れて来る描画: 配信・通知・更新履歴)。
            //   ★ これは「描き終わったか」の目安で、証明ではない (5 秒より後に来る描画・見た目だけの変化は拾えない)。練習モードは端末の中の偽のサーバで動くので、通信待ちは無い
            const SHAPE = `(() => { const t = document.querySelector('.tab-content.active'); if (!t) return ''; const s = t.innerText || ''; let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return t.id + ':' + t.querySelectorAll('*').length + ':' + h + ':' + t.scrollHeight + ':' + t.querySelectorAll('[disabled], [hidden], [aria-pressed="true"]').length; })()`;
            let same = 0, last = ''; const t0 = Date.now();
            for (let i = 0; i < 28 && (same < 3 || Date.now() - t0 < 5000); i++) { await wait(700); const now = await ev(SHAPE); same = (now && now === last) ? same + 1 : 0; last = now; }
            const body = await ev(`(() => { const t = document.querySelector('.tab-content.active'); const vis = t ? [...t.querySelectorAll('*')].filter(e => e.getClientRects().length && [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) : []; return { n: vis.length, loading: vis.filter(e => /^(読み込み中|Loading)/.test(e.textContent.trim())).length }; })()`);
            if (active !== 'tab-' + tabId || !last.startsWith('tab-' + tabId + ':')) label += ` (開けない → ${active} / 検査のとき ${last.split(':')[0]})`;
            else if (same < 3) label += ' (20 秒待っても中身が落ち着かない)';
            else if (body.n < 20 || body.loading) label += ` (中身が出ていない: 文字のある部品 ${body.n} 個・読み込み中 ${body.loading} 個)`;
            else v = await ev(CHECK);
        } catch (e) { label += ' (検査が動かない: ' + String(e.message || e).slice(0, 120) + ')'; }
        await send('Target.closeTarget', { targetId });
        checked++;
        if (v && v.length === 0) { console.log(`  ✅ ${label}: 外れ 0`); continue; }
        if (!v) { console.log(`  ${STRICT ? '❌' : '・'} ${label}`); if (STRICT) failed++; continue; }
        if (STRICT) failed++;
        console.log(`  ${STRICT ? '❌' : '・'} ${label}: 外れ ${v.length} 個 (文字 ${v.filter(x => x[0] === '文字').length}・角丸 ${v.filter(x => x[0] === '角丸').length}・高さ ${v.filter(x => x[0] === '高さ').length})`);
        const grp = new Map(); for (const x of v) { const k = x.slice(0, 4).join(' | '); const g = grp.get(k) || { n: 0, ex: x[4] }; g.n++; grp.set(k, g); }
        for (const [k, g] of [...grp.entries()].sort((p, q) => q[1].n - p[1].n).slice(0, STRICT ? 12 : 60)) console.log('       ' + String(g.n).padStart(3) + '  ' + k + '  「' + g.ex + '」');
    }
}
ws.close();
if (errors.length) { failed++; console.log('  ❌ 画面でエラー: ' + [...new Set(errors)].slice(0, 3).map(e => String(e).slice(0, 200)).join(' / ')); }
console.log(failed ? `\nNG: ${failed} 件 (物差しは docs/段階2_物差し_2026-11-14.md)` : `\nOK: ${checked} 場面`);
cleanup();
process.exit(failed ? 1 : 0);
