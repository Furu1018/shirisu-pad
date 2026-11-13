// 練習モード (偽のサーバ・本番へは通信しない) で全タブを開き、画面写真と数字を取る。
// 念のため supabase への通信は全部落とす。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
const ROOT = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(buf); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-shots-'));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const done = () => { try { chrome.kill(); } catch { } try { server.close(); } catch { } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } };
process.on('exit', done);
let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await wait(250); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });
let id = 0; const waits = new Map(); const errors = [];
const send = (method, params = {}, sessionId) => new Promise((ok, ng) => { const i = ++id; waits.set(i, { ok, ng }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.ng(new Error(m.error.message)) : w.ok(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false }, sessionId: m.sessionId }));
    if (m.method === 'Fetch.requestPaused') {
        const { ok } = judge(m.params.request);   // Supabase は全部落とす・ほかは GET / HEAD / OPTIONS だけ通す
        ws.send(JSON.stringify({ id: ++id, method: ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', params: ok ? { requestId: m.params.requestId } : { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId }));
    }
};
const STAT = `(() => {
  const root = document.querySelector('.tab-content.active') || document.body;
  const vis = (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  const all = [...root.querySelectorAll('*')].filter(vis);
  const fs = new Map(), col = new Map(), rad = new Map(), bh = new Map();
  let small = 0, textEls = 0;
  for (const el of all) {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const cs = getComputedStyle(el);
    if (own) { textEls++; fs.set(cs.fontSize, (fs.get(cs.fontSize) || 0) + 1); col.set(cs.color, (col.get(cs.color) || 0) + 1); if (parseFloat(cs.fontSize) < 11) small++; }
    if (el.tagName === 'BUTTON') { const r = el.getBoundingClientRect(); const k = Math.round(r.height); bh.set(k, (bh.get(k) || 0) + 1); rad.set(cs.borderRadius, (rad.get(cs.borderRadius) || 0) + 1); }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + '×' + v).join(' ');
  const btns = all.filter(e => e.tagName === 'BUTTON');
  const tiny = btns.filter(b => { const r = b.getBoundingClientRect(); return r.height < 36 || r.width < 36; }).length;
  return { h: document.documentElement.scrollHeight, overflowX: document.documentElement.scrollWidth - innerWidth, nodes: root.querySelectorAll('*').length, visNodes: all.length,
    cards: [...root.querySelectorAll('.dc-card')].filter(vis).length, details: [...root.querySelectorAll('details')].filter(vis).length,
    buttons: btns.length, tinyButtons: tiny, inputs: all.filter(e => /INPUT|SELECT|TEXTAREA/.test(e.tagName)).length,
    fontSizes: fs.size, fontTop: top(fs, 12), small, textEls, colors: col.size, btnHeights: top(bh, 10), btnRadius: top(rad, 8) };
})()`;
const READ_PROD = false;   // 練習モードの写真は本番を 1 本も読まない
// ★ 全部の通信を見張る (Codex 再監査 027423a)。通すのは GET / HEAD / OPTIONS だけ。Supabase は**このアプリのプロジェクトのホスト**の 表 (/rest/v1/) と 保存領域 (/storage/v1/) だけ
const SB_ORIGIN = (fs.readFileSync(path.join(ROOT, 'js/supabase-client.js'), 'utf8').match(/const SUPABASE_URL = '(https:\/\/[a-z0-9]+\.supabase\.co)'/) || [])[1];
if (!SB_ORIGIN) { console.error('js/supabase-client.js から Supabase のホストを読めません'); process.exit(1); }
const judge = (rq) => {
    let u; try { u = new URL(rq.url); } catch (e) { return { ok: false, sb: false }; }
    const sb = /(^|\.)supabase\.(co|in|com|net)$/.test(u.hostname);
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(rq.method);
    return { sb, ok: safe && (!sb || (READ_PROD && u.origin === SB_ORIGIN && /^\/(rest|storage)\/v1\//.test(u.pathname))) };
};
// ★ 守り (Codex 監査 9e7f6a3): ページの通信は CDP の Fetch で止めているが、Service Worker と WebSocket はそこを通らない → どのページでも最初に使えなくする
const GUARD = `try { delete Navigator.prototype.serviceWorker; } catch (e) {}   // 'serviceWorker' in navigator が false = 非対応の端末と同じ道を通る
window.WebSocket = function () { throw new Error('WebSocket は調査の道具が止めています'); };
window.EventSource = function () { throw new Error('EventSource は調査の道具が止めています'); };
window.Worker = function () { throw new Error('Worker は調査の道具が止めています'); };
window.SharedWorker = function () { throw new Error('SharedWorker は調査の道具が止めています'); };
try { Navigator.prototype.sendBeacon = function () { return false; }; } catch (e) {}`;
const report = [];
for (const [scenario, W, H] of [['member', 390, 844], ['ops-eve', 390, 844], ['ops-day', 390, 844], ['member', 1366, 800], ['ops-day', 1366, 800]]) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => send(method, params, sid);
    await S('Page.enable'); await S('Runtime.enable');
    await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await S('Page.addScriptToEvaluateOnNewDocument', { source: GUARD });
    await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
    const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    await S('Page.navigate', { url: `${ORIGIN}/index.html?practice=${scenario}` }); await wait(6000);
    // 練習の案内 (ドック・シート) は写真の邪魔なので隠す
    await ev(`(() => { const st = document.createElement('style'); st.textContent = '[id^="practice"], .practice-dock, #padPracticeDock, [class*="pg-"] { display: none !important; }'; document.head.appendChild(st); return 1; })()`);
    const shot = async (name) => {
        await ev(`window.scrollTo(0,0)`); await wait(300);
        const st = await ev(STAT);
        const h = Math.min(st.h, 5200);
        const { data } = await S('Page.captureScreenshot', { format: 'jpeg', quality: 62, captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: h, scale: W > 700 ? 0.6 : 1 } });
        const f = `${scenario}_${W}_${name}.jpg`; fs.writeFileSync(path.join(OUT, f), Buffer.from(data, 'base64'));
        report.push({ f, ...st }); console.log(f, JSON.stringify(st));
    };
    const tabs = ['mypage', 'raid', 'mock', 'ops', 'ranking', 'slv-ranking', 'settings', 'help', 'member-admin'];
    for (const t of tabs) {
        const t0 = Date.now();
        const ok = await ev(`(() => { try { switchTab('${t}'); return document.querySelector('.tab-content.active')?.id || null; } catch (e) { return 'ERR ' + e.message; } })()`);
        await wait(2500);
        if (ok !== 'tab-' + t) { console.log(`  (${scenario} ${t} → ${ok})`); if (!ok || String(ok).startsWith('ERR')) continue; }
        if (t === 'ops') {
            const n = await ev(`document.querySelectorAll('#opsSubTabs button').length`);
            if (!n) { await shot('ops'); continue; }
            for (let i = 0; i < n; i++) {
                const label = await ev(`(() => { const b = document.querySelectorAll('#opsSubTabs button')[${i}]; if (!b) return null; b.click(); return b.textContent.trim(); })()`);
                await wait(2500); await shot('ops' + (i + 1)); console.log('   ↑', label);
            }
        } else await shot(t);
    }
    await send('Target.closeTarget', { targetId });
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('--- エラー', errors.length); for (const e of [...new Set(errors)].slice(0, 15)) console.log('  ' + String(e).slice(0, 300));
ws.close(); done(); process.exit(0);
