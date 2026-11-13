// 本番の DB を読むだけ (GET/HEAD/OPTIONS 以外は落とす) で、起動の重さと待機中の通信を測る
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
const ROOT = process.argv[2], ROLE_ID = Number(process.argv[3]), OPS = process.argv[4] === 'ops', THROTTLE = Number(process.argv[5] || 4);
const CHROME = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__blank') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end('<!doctype html><title>b</title>'); return; }
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(buf); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-perf-'));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const done = () => { try { chrome.kill(); } catch { } try { server.close(); } catch { } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } };
process.on('exit', done);
let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await wait(250); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });
let id = 0; const waits = new Map(); const reqs = [], blocked = [], errors = [];
const send = (method, params = {}, sessionId) => new Promise((ok, ng) => { const i = ++id; waits.set(i, { ok, ng }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
let t0 = 0;
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.ng(new Error(m.error.message)) : w.ok(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false }, sessionId: m.sessionId }));
    if (m.method === 'Fetch.requestPaused') {
        const rq = m.params.request;
        // 読むだけ: GET / HEAD / OPTIONS のうち、表の読み取り (/rest/v1/) と保存領域の読み取り (/storage/v1/) だけ通す。Edge Function (/functions/) などは GET でも落とす
        const ok = ['GET', 'HEAD', 'OPTIONS'].includes(rq.method) && /^https:\/\/[^/]+\/(rest|storage)\/v1\//.test(rq.url);
        if (!ok) blocked.push(`${rq.method} ${rq.url.replace(/^https:\/\/[^/]+/, '').slice(0, 70)}`);
        if (t0 && rq.method !== 'OPTIONS') reqs.push({ t: Date.now() - t0, m: rq.method, u: rq.url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*/, '') });
        ws.send(JSON.stringify({ id: ++id, method: ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', params: ok ? { requestId: m.params.requestId } : { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId: m.sessionId }));
    }
};
// ★ 守り (Codex 監査 9e7f6a3): ページの通信は CDP の Fetch で止めているが、Service Worker と WebSocket はそこを通らない → どのページでも最初に使えなくする
const GUARD = `try { delete Navigator.prototype.serviceWorker; } catch (e) {}   // 'serviceWorker' in navigator が false = 非対応の端末と同じ道を通る
window.WebSocket = function () { throw new Error('WebSocket は調査の道具が止めています'); };
window.EventSource = function () { throw new Error('EventSource は調査の道具が止めています'); };`;
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params) => send(method, params, sid);
await S('Page.enable'); await S('Runtime.enable'); await S('Performance.enable');
await S('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }, { urlPattern: '*supabase.in*' }] });
await S('Page.addScriptToEvaluateOnNewDocument', { source: GUARD });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
await S('Page.navigate', { url: ORIGIN + '/__blank' }); await wait(400);
await ev(`localStorage.setItem('shirisuPad.currentPlayer', JSON.stringify({ id: ${ROLE_ID}, name: 'probe' })); ${OPS ? `localStorage.setItem('shirisuko_ops_mode_v1', JSON.stringify({ [${ROLE_ID}]: true }));` : ''} 1`);
await S('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
t0 = Date.now();
await S('Page.navigate', { url: ORIGIN + '/' });
// 起動の幕が消えるまで
let bootMs = null;
for (let i = 0; i < 240 && bootMs == null; i++) { await wait(250); try { if (await ev(`(() => { const o = document.querySelector('.boot-loading-overlay, #bootLoadingOverlay'); return document.readyState === 'complete' && (!o || o.offsetParent === null || getComputedStyle(o).display === 'none' || getComputedStyle(o).opacity === '0'); })()`)) bootMs = Date.now() - t0; } catch { } }
await wait(Math.max(0, 15000 - (Date.now() - t0)));
const metrics = Object.fromEntries((await S('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const nav = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByType('paint'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: Math.round(p.find(x => x.name === 'first-contentful-paint')?.startTime || 0), res: performance.getEntriesByType('resource').length, nodes: document.querySelectorAll('*').length, long: 0 }; })()`);
const boot15 = reqs.filter(r => r.t <= 15000);
console.log(`■ 起動 (${OPS ? '運営' : 'メンバー'}・CPU ${THROTTLE} 倍遅い): 幕が消える ${bootMs}ms / FCP ${nav.fcp}ms / DCL ${nav.dcl}ms / load ${nav.load}ms`);
console.log(`  スクリプト ${(metrics.ScriptDuration * 1000).toFixed(0)}ms・レイアウト ${(metrics.LayoutDuration * 1000).toFixed(0)}ms・スタイル ${(metrics.RecalcStyleDuration * 1000).toFixed(0)}ms・JS ヒープ ${(metrics.JSHeapUsedSize / 1048576).toFixed(1)}MB・DOM ${nav.nodes} 個・読み込んだファイル ${nav.res}`);
const by = new Map(); boot15.forEach(r => by.set(r.u, (by.get(r.u) || 0) + 1));
console.log(`  起動 15 秒の Supabase 通信 ${boot15.length} 本 (種類 ${by.size}):`); console.log('   ' + [...by.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u.replace('/rest/v1/', '')}×${n}`).join('  '));
// 待機 60 秒
const mark = Date.now() - t0; await S('Emulation.setCPUThrottlingRate', { rate: 1 }); await wait(60000);
const idle = reqs.filter(r => r.t > mark); const by2 = new Map(); idle.forEach(r => by2.set(r.u, (by2.get(r.u) || 0) + 1));
console.log(`■ そのまま 60 秒置く: 通信 ${idle.length} 本`); console.log('   ' + [...by2.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u.replace('/rest/v1/', '')}×${n}`).join('  '));
// タブ切り替えの時間
await S('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
for (const t of ['raid', 'ranking', 'settings', 'ops', 'mypage']) {
    const before = reqs.length;
    const ms = await ev(`(async () => { const a = performance.now(); switchTab('${t}'); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return Math.round(performance.now() - a); })()`);
    await wait(3000); console.log(`  タブ ${t}: 切り替え ${ms}ms・通信 ${reqs.length - before} 本`);
}
console.log('■ 例外', errors.length, [...new Set(errors)].slice(0, 5).map(e => String(e).slice(0, 200)));
console.log('■ 止めた書き込み', blocked.length, [...new Set(blocked)].slice(0, 8));
const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(ROOT, f))).length;
console.log('■ 転送の大きさ (gzip): index.html', (gz('index.html') / 1024).toFixed(0) + 'KB', '/ supabase-client.js', (gz('js/supabase-client.js') / 1024).toFixed(0) + 'KB', '/ optimal-plan.js', (gz('js/optimal-plan.js') / 1024).toFixed(0) + 'KB', '/ domain 全部', (fs.readdirSync(path.join(ROOT, 'js/domain')).reduce((a, f) => a + gz('js/domain/' + f), 0) / 1024).toFixed(0) + 'KB');
ws.close(); done(); process.exit(0);
