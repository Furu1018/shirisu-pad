// ============================================================================
// 🎮 練習モードの通し確認 (本物のブラウザで、案内の枠だけを押して最後まで進める)
//   node tests/practice-e2e.mjs          スマホ幅
//   PC=1 node tests/practice-e2e.mjs     PC 幅 (サイドバーの出る幅) も
// ----------------------------------------------------------------------------
// ★ Chrome が要る (無ければ「スキップ」と出して終わる)。CHROME=<実行ファイル> で場所を指定できる。
//   ほかのテストと違い**画面を実際に動かす**ので 1〜2 分かかる。練習モード (js/practice/) や、
//   案内が指す画面 (ホーム・模擬の提出シート・申請シート・凸報告) を触ったら流すこと。
// 守りたい約束:
//   1. 案内の枠 (#pmRing) が出ている場所を押すだけで、メンバー編が最後まで進む (= 案内が本物の画面と合っている)
//   2. その間、画面でエラーが 1 つも出ない
//   3. 本物の Supabase へは キャラ表の GET だけ (書き込みは 0)
//   4. やめると本番に戻り、本番の名乗り (端末の記憶) は練習の前と同じ
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!CHROME) { console.log('スキップ: Chrome が見つかりません (CHROME=<実行ファイル> で指定できます)'); process.exit(0); }
if (typeof WebSocket !== 'function') { console.log('スキップ: この Node には WebSocket がありません (Node 22 以上で動きます)'); process.exit(0); }

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__blank') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end('<!doctype html><title>blank</title>'); return; }
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-e2e-'));
const debugPort = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (_) { /* noop */ } try { server.close(); } catch (_) { /* noop */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* noop */ } };
process.on('exit', cleanup);

async function openPage({ width, height, mobile }) {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch (_) { await wait(250); } }
    if (!ver) throw new Error('Chrome に接続できません');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });
    let id = 0; const waits = new Map();
    const page = { errors: [], net: [], dialogs: [] };
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.ng(new Error(m.error.message)) : w.ok(m.result); return; }
        if (m.method === 'Runtime.exceptionThrown') page.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
        if (m.method === 'Network.requestWillBeSent') page.net.push({ method: m.params.request.method, url: m.params.request.url });
        if (m.method === 'Page.javascriptDialogOpening') {   // 画面の confirm / alert は「はい」で進める (本物の画面が出す確認)
            page.dialogs.push(m.params.message);
            ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId: m.sessionId }));
        }
    };
    const send = (method, params = {}, sessionId) => new Promise((ok, ng) => { const i = ++id; waits.set(i, { ok, ng }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => send(method, params, sessionId);
    await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    page.S = S;
    page.goto = async (url, ms) => { await S('Page.navigate', { url }); await wait(ms); };
    page.eval = async (expr) => {
        const r = await Promise.race([S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
            new Promise((_, ng) => setTimeout(() => ng(new Error('画面が 20 秒返事をしません')), 20000))]);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    };
    page.close = async () => { await send('Target.closeTarget', { targetId }); ws.close(); };
    return page;
}

const STATE = `(() => {
  const d = document.getElementById('pmDock'); if (!d) return null;
  const ring = document.getElementById('pmRing'); const shown = ring && ring.style.display !== 'none';
  let under = null, tag = null;
  if (shown) { const r = ring.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (el) { under = String(el.innerText || el.value || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 24); tag = el.tagName; } }
  return { cnt: d.querySelector('.pm-cnt')?.innerText || (d.querySelector('.pm-done') ? 'DONE' : '-'), title: d.querySelector('.pm-top b')?.innerText || '',
    text: d.querySelector('.pm-in p')?.innerText || '', assume: d.querySelector('[data-pm=assume]')?.innerText || null, where: !!d.querySelector('[data-pm=where]'), ring: shown, under, tag };
})()`;
// 案内の枠の真ん中にあるものを押す (入力欄なら数字を入れる)。枠は pointer-events:none なので、拾うのは本物の画面の要素
const PRESS = `(() => { const r = document.getElementById('pmRing').getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!el) return 'none';
  if (el.tagName === 'INPUT') { el.focus(); el.value = '33.1'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return '入力'; }
  (el.closest('button,[onclick],a,label') || el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return '押す'; })()`;

async function run(label, size) {
    const problems = [], trail = [];
    const p = await openPage(size);
    // 本番の名乗りを置いておく (練習が書き換えないことを最後に見る)
    await p.goto(`${ORIGIN}/__blank`, 500);
    await p.eval(`localStorage.setItem('shirisuPad.currentPlayer', JSON.stringify({ id: 24, name: '本物の人' })); localStorage.setItem('shirisuPad.tourCompleted', '1');`);
    await p.goto(`${ORIGIN}/index.html?practice=member`, 6500);
    const boot = JSON.parse(await p.eval(`JSON.stringify({ practice: !!window.PAD_PRACTICE, players: window.PAD_PRACTICE?.db?.tables?.players?.length || 0,
        me: (typeof getCurrentIdentity === 'function' ? getCurrentIdentity() : null), dock: !!document.getElementById('pmDock') })`));
    if (!boot.practice || boot.players !== 31 || boot.me?.id !== 9101 || !boot.dock) problems.push(`練習モードで起動していない: ${JSON.stringify(boot)}`);
    let last = '', same = 0, done = false;
    for (let i = 0; i < 80 && !done && !problems.length; i++) {
        const s = JSON.parse(await p.eval(`JSON.stringify(${STATE})`) || 'null');
        if (!s) { await wait(1200); continue; }
        const sig = JSON.stringify([s.cnt, s.text, s.under, s.assume]);
        same = sig === last ? same + 1 : 0; last = sig;
        if (s.cnt === 'DONE') { done = true; break; }
        if (same >= 5) { problems.push(`案内どおりに押しても進まない: ${JSON.stringify(s)}`); break; }
        let act;
        if (s.assume) { act = '仮定 ' + s.assume; await p.eval(`document.querySelector('#pmDock [data-pm=assume]').click()`); await wait(4500); }
        else if (s.ring) { act = (await p.eval(PRESS)) + ' ' + JSON.stringify(s.under); await wait(1100); }
        else if (s.where) { act = 'どこ？'; await p.eval(`document.querySelector('#pmDock [data-pm=where]').click()`); await wait(900); }
        else { act = '(待つ)'; await wait(900); }
        trail.push(`${s.cnt} ${s.title} | ${s.text.slice(0, 40)} | ${act}`);
    }
    if (!done && !problems.length) problems.push('80 手で終わらなかった');
    // 当日に進めたとき、ほかのメンバーの凸が入っている (ボスは倒し切らない = レベルは進めない) / 自分は 1 凸・予約は実行済み・締め凸に返事済み
    const world = JSON.parse(await p.eval(`JSON.stringify((() => { const T = window.PAD_PRACTICE.db.tables, me = 9101;
        return { others: T.attacks.filter(a => a.player_id !== me).length, mine: T.attacks.filter(a => a.player_id === me).length, level: T.seasons[0].current_level,
            dead: T.bosses.filter(b => !(b.remaining_hp_raw > 0)).length, resv: T.plan_reservations.filter(r => r.player_id === me).map(r => r.status).sort(),
            finish: T.finish_requests.filter(r => r.player_id === me).map(r => r.status), plans: T.published_plans.length, pushes: window.PAD_PRACTICE.db.outbox.length,
            conf: T.availability_confirmations.some(r => r.player_id === me), fire: T.player_damages.some(d => d.player_id === me && d.attribute === 'fire' && d.characters.length === 5) }; })())`));
    if (!(world.others >= 10)) problems.push(`当日に進めても、ほかのメンバーの凸が入っていない (${world.others} 件)`);
    if (world.level !== 1 || world.dead) problems.push(`練習の世界がレベルを進めた / ボスを倒し切った: ${JSON.stringify(world)}`);
    if (world.mine !== 1 || !world.resv.includes('fulfilled') || !world.finish.every(s => s !== 'pending') || !world.finish.length) problems.push(`自分の凸・予約・締め凸の返事が入っていない: ${JSON.stringify(world)}`);
    // 練習中は端末の状態に触れない: Service Worker を登録しない・通知の許可を求めない
    const device = JSON.parse(await p.eval(`(async () => JSON.stringify({ sw: ('serviceWorker' in navigator) ? (await navigator.serviceWorker.getRegistrations()).length : 0,
        perm: ('Notification' in window) ? Notification.permission : 'none' }))()`));
    if (device.sw !== 0 || !['default', 'none'].includes(device.perm)) problems.push(`練習中に端末の通知・Service Worker に触れた: ${JSON.stringify(device)}`);
    if (!world.conf || !world.fire || !(world.plans >= 1) || !(world.pushes >= 1)) problems.push(`時間の確認・模擬 (5人)・配信・通知の見本 のどれかが欠けている: ${JSON.stringify(world)}`);
    if (p.errors.length) problems.push(`画面でエラー: ${p.errors.slice(0, 4).join(' / ').slice(0, 600)}`);
    const real = p.net.filter(n => /supabase\.co/.test(n.url));
    const writes = real.filter(n => !['GET', 'OPTIONS'].includes(n.method));
    if (writes.length) problems.push(`本物の Supabase へ書き込みが出た: ${writes.map(n => n.method + ' ' + n.url.slice(0, 90)).join(' / ')}`);
    const other = real.filter(n => !/\/rest\/v1\/nikke_characters\?select=\*$/.test(n.url));
    if (other.length) problems.push(`キャラ表以外を本物から読んだ: ${other.map(n => n.method + ' ' + n.url.slice(0, 90)).join(' / ')}`);
    // やめる → 本番に戻る (ここから先は本物へ読みに行かせない)
    await p.S('Network.setBlockedURLs', { urls: ['*supabase.co*', '*esm.sh*', '*jsdelivr.net/npm/@supabase*'] });
    const before = p.net.length;
    await p.eval(`document.querySelector('#pmDock [data-pm=quit]').click()`).catch(() => { });
    await wait(3500);
    const after = JSON.parse(await p.eval(`JSON.stringify({ practice: !!window.PAD_PRACTICE, attr: document.documentElement.getAttribute('data-practice'), search: location.search,
        keys: Object.keys(sessionStorage).filter(k => k.indexOf('shirisuko_practice_v1') === 0 || k.indexOf('pm::') === 0), me: localStorage.getItem('shirisuPad.currentPlayer'),
        lsKeys: Object.keys(localStorage).sort() })`));
    if (after.practice || after.attr || /practice=/.test(after.search) || after.keys.length) problems.push(`やめても練習が残っている: ${JSON.stringify(after)}`);
    if (JSON.parse(after.me || '{}').id !== 24) problems.push(`本番の名乗りが変わった: ${after.me}`);
    if (after.lsKeys.some(k => !['shirisuPad.currentPlayer', 'shirisuPad.tourCompleted'].includes(k) && !/^shirisu/.test(k))) problems.push(`本番の記憶に見慣れない鍵: ${after.lsKeys}`);
    if (!p.dialogs.some(d => /練習をやめて、本番の画面に戻りますか/.test(d))) problems.push('やめる前に確かめていない');
    void before;
    await p.close();
    console.log(problems.length ? `  ❌ ${label}\n     ${problems.join('\n     ')}\n     --- ここまでの手順\n     ${trail.slice(-8).join('\n     ')}` : `  ✅ ${label} (${trail.length} 手で最後まで)`);
    return problems.length === 0;
}

let ok = true;
try {
    ok = await run('スマホ幅 (390×844): 案内の枠だけを押してメンバー編が最後まで進む / エラー 0 / 本物への書き込み 0 / やめると本番に戻る', { width: 390, height: 844, mobile: true }) && ok;
    if (process.env.PC) ok = await run('PC 幅 (1280×800): 同上', { width: 1280, height: 800, mobile: false }) && ok;
} catch (e) { ok = false; console.log('  ❌ 実行できませんでした: ' + (e && e.stack || e)); }
cleanup();
console.log(ok ? '\nOK' : '\nNG');
process.exit(ok ? 0 : 1);
