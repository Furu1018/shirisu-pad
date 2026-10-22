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
    const page = { errors: [], net: [], dialogs: [], navs: [] };   // navs: 画面の読み込み直し (いつ・どこへ) — 失敗の切り分け用
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.ng(new Error(m.error.message)) : w.ok(m.result); return; }
        if (m.method === 'Runtime.exceptionThrown') page.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
        if (m.method === 'Network.requestWillBeSent') page.net.push({ method: m.params.request.method, url: m.params.request.url });
        if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) page.navs.push(`${new Date().toISOString().slice(11, 23)} → ${m.params.frame.url.replace(/^https?:\/\/[^/]+/, '')}`);
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
    text: d.querySelector('.pm-in p')?.innerText || '', assume: d.querySelector('[data-pm=assume]')?.innerText || null, where: !!d.querySelector('[data-pm=where]'), ring: shown, under, tag,
    toast: (() => { const n = document.getElementById('notification'); if (!n) return null; const r = n.getBoundingClientRect(); return { text: n.textContent, shown: n.classList.contains('show'), top: r.top, dockBottom: d.getBoundingClientRect().bottom }; })() };
})()`;
// 案内の枠の真ん中にあるものを押す (入力欄なら、案内の文が言う数字を入れる)。枠は pointer-events:none なので、拾うのは本物の画面の要素
const PRESS = (value) => `(() => { const r = document.getElementById('pmRing').getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!el) return 'none';
  if (el.tagName === 'INPUT') { el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return '入力'; }
  (el.closest('button,[onclick],a,label') || el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return '押す'; })()`;
// ★ 読み込みは時計でなく状態で待つ (この機では 6〜10 秒ぶれる・読み込み直しの最中は eval が落ちる): 練習の DB と案内が揃うまで最大 ms
const settle = async (p, ms, extra = 'true') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        let ok = false;
        try { ok = await p.eval(`!!(window.PAD_PRACTICE && window.PAD_PRACTICE.db && document.querySelector('#pmDock .pm-cnt, #pmDock .pm-done') && (${extra}))`); } catch (_) { ok = false; }
        if (ok) return true;
        await wait(500);
    }
    return false;
};
// 案内の文の「〜を 40 にします」「(例: 33.1)」から入れる数字を読む
// 案内のボタン (仮定 / どこ？ / 戻る) を押す。状態を読んでから押すまでに描き直されて消えていたら false (押さずに次の状態を読む)
const tap = (p, sel) => p.eval(`(() => { const b = document.querySelector(${JSON.stringify('#pmDock ' + sel)}); if (!b) return false; b.click(); return true; })()`);
const valueOf = (text) => (String(text || '').match(/(\d+(?:\.\d+)?)\s*(?:にします|と入れ)|例: (\d+(?:\.\d+)?)/) || []).slice(1).find(Boolean) || '33.1';

// メンバー編の課題 (2026-10-22 の作り直し: js/practice/guide.js の STEPS.member と同じ並び)
const MEMBER_KEYS = ['avail', 'wait', 'ack', 'report'];
async function run(label, size, scenario = 'member', startAt = '') {
    const problems = [], trail = [];
    const p = await openPage(size);
    // 本番の名乗りを置いておく (練習が書き換えないことを最後に見る)
    await p.goto(`${ORIGIN}/__blank`, 500);
    await p.eval(`localStorage.setItem('shirisuPad.currentPlayer', JSON.stringify({ id: 24, name: '本物の人' })); localStorage.setItem('shirisuPad.tourCompleted', '1');`);
    await p.goto(`${ORIGIN}/index.html?practice=${scenario}${startAt ? '&start=' + startAt : ''}`, 1500);
    const idx0 = MEMBER_KEYS.indexOf(startAt) + 1;
    if (!await settle(p, 45000, startAt ? `(document.querySelector('#pmDock .pm-cnt') || {}).innerText === '課題 ${idx0}/${MEMBER_KEYS.length}'` : 'true')) problems.push('45 秒待っても練習が起動しない (DB と案内が揃わない)');
    if (startAt) {   // 途中の課題から: 手前が済んだ状態で、その課題から始まっている
        const at = JSON.parse(await p.eval(`JSON.stringify({ cnt: document.querySelector('#pmDock .pm-cnt')?.innerText || '-', title: document.querySelector('#pmDock .pm-top b')?.innerText || '' })`));
        const idx = MEMBER_KEYS.indexOf(startAt) + 1;
        if (at.cnt !== `課題 ${idx}/${MEMBER_KEYS.length}`) problems.push(`「${startAt}」から始まっていない: ${JSON.stringify(at)}`);
    }
    const expectMe = scenario.startsWith('ops') ? 9102 : 9101;
    const boot = JSON.parse(await p.eval(`JSON.stringify({ practice: !!window.PAD_PRACTICE, players: window.PAD_PRACTICE?.db?.tables?.players?.length || 0,
        me: (typeof getCurrentIdentity === 'function' ? getCurrentIdentity() : null), dock: !!document.getElementById('pmDock'), scenario: window.PAD_PRACTICE?.scenario })`));
    if (!boot.practice || boot.players !== 31 || boot.me?.id !== expectMe || !boot.dock || boot.scenario !== scenario) problems.push(`練習モードで起動していない: ${JSON.stringify(boot)}`);
    let last = '', same = 0, done = false, lastToast = null;   // lastToast: 手順の途中で見えたアプリの知らせ (3 秒で消えるので、最後に確かめる前に消えていることがある)
    for (let i = 0; i < 80 && !done && !problems.length; i++) {
        const s = JSON.parse(await p.eval(`JSON.stringify(${STATE})`) || 'null');
        if (!s) { await wait(1200); continue; }
        if (s.toast && s.toast.shown) lastToast = s.toast;
        const sig = JSON.stringify([s.cnt, s.text, s.under, s.assume]);
        same = sig === last ? same + 1 : 0; last = sig;
        if (s.cnt === 'DONE') { done = true; break; }
        if (same >= 5) { problems.push(`案内どおりに押しても進まない: ${JSON.stringify(s)}`); break; }
        let act;
        if (s.assume) { act = '仮定 ' + s.assume; await wait((await tap(p, '[data-pm=assume]')) ? 4500 : 600); }
        else if (s.ring) { act = (await p.eval(PRESS(valueOf(s.text)))) + ' ' + JSON.stringify(s.under); await wait(scenario.startsWith('ops') ? 2500 : 1100); }
        else if (s.where) { act = 'どこ？'; await tap(p, '[data-pm=where]'); await wait(900); }
        else { act = '(待つ)'; await wait(900); }
        trail.push(`${s.cnt} ${s.title} | ${s.text.slice(0, 40)} | ${act}`);
    }
    if (!done && !problems.length) problems.push('80 手で終わらなかった');
    if (done) await settle(p, 15000);   // おしまいの直後に読み込み直しが走っていても、落ち着いてから確かめる (走ったかは下の記録で見える)
    try {   // ★ 終わったあとの確認で画面が読み込み直し中だと eval が落ちる — 例外も problems に入れて、手順と読み込み直しの記録を出す
    // アプリの知らせ (トースト) は案内の裏に隠れない: 最後の返事のあとに出る「了承を運営に伝えました」が、案内の下に見えている
    const toastNow = JSON.parse(await p.eval(`JSON.stringify((() => { const n = document.getElementById('notification'), d = document.getElementById('pmDock');
        const r = n.getBoundingClientRect(); return { text: n.textContent, shown: n.classList.contains('show'), top: r.top, dockBottom: d.getBoundingClientRect().bottom }; })())`));
    const toast = toastNow.shown ? toastNow : (lastToast || toastNow);   // いま消えていても、手順の途中で見えていればそれで判定 (負荷で 3 秒を過ぎることがある)
    if (done && scenario !== 'ops-day' && !(toast.shown && toast.top >= toast.dockBottom - 1)) problems.push(`アプリの知らせが案内の裏に隠れている: ${JSON.stringify(toast)}`);
    // ↩ 1つ前に戻る: おしまいから戻ると、課題 5 の最初 (締め凸のお願いが来る前・時計は当日) に戻る。そこからまた最後まで行ける
    if (scenario === 'member') {
        // 出られる時間と凸数 (夜 2) を伝えた → 運営が「夜」のぶんを配信 (本人の凸数が上限) → 確認した → 運営が自分の凸を登録した (レベルは進めない)
        const world = JSON.parse(await p.eval(`JSON.stringify((() => { const T = window.PAD_PRACTICE.db.tables, me = 9101;
            const pub = T.published_plans.slice().sort((a, b) => b.id - a.id)[0];
            const conf = T.availability_confirmations.find(r => r.player_id === me);
            return { mine: T.attacks.filter(a => a.player_id === me).length, level: T.seasons[0].current_level, dead: T.bosses.filter(b => !(b.remaining_hp_raw > 0)).length,
                counts: conf ? conf.block_counts : null, scope: pub && pub.plan.blockScope ? pub.plan.blockScope.name : null, acked: T.plan_acks.some(a => a.player_id === me && pub && a.plan_id === pub.id),
                pushes: window.PAD_PRACTICE.db.outbox.length, lite: !(T.seasons[0].metadata || {}).member_input,
                byOps: T.attacks.filter(a => a.player_id === me).every(a => true) }; })())`));
        if (JSON.stringify(world.counts) !== '{"21-23":2}') problems.push(`凸数 (夜 2) を伝えていない: ${JSON.stringify(world)}`);
        if (world.scope !== '夜' || !world.acked) problems.push(`夜のぶんの配信・確認 のどちらかが欠けている: ${JSON.stringify(world)}`);
        if (world.mine !== 1 || world.level !== 1 || world.dead) problems.push(`運営が自分の凸を 1 つ登録した形になっていない / レベルを進めた: ${JSON.stringify(world)}`);
        if (!world.lite) problems.push(`練習のシーズンが本番の既定 (メンバーの入力は最低限) になっていない: ${JSON.stringify(world)}`);
    } else if (scenario === 'ops-eve') {
        const w = JSON.parse(await p.eval(`JSON.stringify((() => { const T = window.PAD_PRACTICE.db.tables;
            const pub = T.published_plans.slice().sort((a, b) => b.id - a.id)[0];
            return { nudged: T.push_notifications_log.filter(r => /登録のお願い/.test(r.title)).length, pinned: T.plan_reservations.filter(r => r.status === 'pinned').length,
                approved: T.plan_reservations.filter(r => r.status === 'approved').length, requested: T.plan_reservations.filter(r => r.status === 'requested').length,
                plans: T.published_plans.length, resvInPlan: pub ? Number(pub.plan.reservationCount) : -1, by: pub ? pub.published_by_name : null, level: T.seasons[0].current_level,
                scope: pub && pub.plan.blockScope ? pub.plan.blockScope.name : null }; })())`));
        if (!(w.nudged >= 1) || !(w.pinned >= 1) || w.approved !== 1 || w.requested !== 0 || !(w.plans >= 1) || !(w.resvInPlan >= 1) || w.by !== '運営役 (練習)' || w.scope !== '朝') problems.push(`運営編・前日の結果が欠けている: ${JSON.stringify(w)}`);
    } else if (scenario === 'ops-day') {
        // 夕方のブロックの頭: HP を直した (B1 = 40B) → 凸報告を 1 件 ✓ → 🧱 夕方を組んで配信 → 締凸検索で探してコピー (依頼・打診はしない)
        const w = JSON.parse(await p.eval(`JSON.stringify((() => { const T = window.PAD_PRACTICE.db.tables; const titles = T.push_notifications_log.map(r => r.title || '');
            const pub = T.published_plans.slice().sort((a, b) => b.id - a.id)[0];
            return { plans: T.published_plans.length, others: T.attacks.filter(a => a.player_id !== 9102).length, hpSavedAt: T.bosses.find(b => b.boss_number === 1)?.updated_at,
                setupAt: sessionStorage.getItem('shirisuko_practice_v1:ops-day:setupAt'), confirmed: T.attacks.filter(a => a.confirmed_at).length,
                scope: pub && pub.plan.blockScope ? pub.plan.blockScope.name : null, copied: sessionStorage.getItem('shirisuko_practice_v1:ops-day:copied'),
                finish: T.finish_requests.length, offers: titles.filter(t => /締め凸/.test(t)).length, level: T.seasons[0].current_level }; })())`));
        if (!(w.plans >= 2) || !(w.others >= 10)) problems.push(`当日の盤面 (朝からの配信と 18 時までの凸) ができていない: ${JSON.stringify(w)}`);
        if (!(w.setupAt && w.hpSavedAt && w.hpSavedAt > w.setupAt)) problems.push(`B1 の HP を保存していない: ${JSON.stringify(w)}`);
        if (!(w.confirmed >= 1) || w.scope !== '夕方' || w.copied !== '1') problems.push(`結果の取り込み・夕方のぶんの配信・締凸検索のコピー のどれかが欠けている: ${JSON.stringify(w)}`);
        if (w.finish !== 0 || w.offers !== 0) problems.push(`締め凸を PAD から頼んだ (探すだけのはず): ${JSON.stringify(w)}`);
    }
    if (done && scenario === 'member' && !startAt) {
        if (!await tap(p, '[data-pm=back]')) problems.push('おしまいに「↩ 1つ前に戻る」が無い');   // confirm は「はい」
        await wait(1500); await settle(p, 45000);   // 戻るは読み込み直し
        const back = JSON.parse(await p.eval(`JSON.stringify((() => { const T = window.PAD_PRACTICE.db.tables; const d = document.getElementById('pmDock');
            return { cnt: d.querySelector('.pm-cnt')?.innerText || '-', assume: d.querySelector('[data-pm=assume]')?.innerText || null, finish: T.finish_requests.length,
                mine: T.attacks.filter(a => a.player_id === 9101).length, hard: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) === window.PAD_PRACTICE.hardDate }; })())`));
        if (back.cnt !== `課題 ${MEMBER_KEYS.length}/${MEMBER_KEYS.length}` || !/登録したことにする/.test(back.assume || '') || back.mine !== 0 || !back.hard) problems.push(`1つ前に戻れていない: ${JSON.stringify(back)}`);
        else {
            let again = false;
            for (let i = 0; i < 12 && !again; i++) {
                const s = JSON.parse(await p.eval(`JSON.stringify(${STATE})`) || 'null');
                if (!s) { await wait(1000); continue; }
                if (s.cnt === 'DONE') { again = true; break; }
                if (s.assume) { await wait((await tap(p, '[data-pm=assume]')) ? 4000 : 600); }
                else if (s.ring) { await p.eval(PRESS(valueOf(s.text))); await wait(1200); }
                else if (s.where) { await tap(p, '[data-pm=where]'); await wait(900); }
                else await wait(900);
            }
            if (!again) problems.push('戻ったあと、もう一度最後まで行けない');
        }
    }
    // 練習中は端末の状態に触れない: Service Worker を登録しない・通知の許可を求めない
    const device = JSON.parse(await p.eval(`(async () => JSON.stringify({ sw: ('serviceWorker' in navigator) ? (await navigator.serviceWorker.getRegistrations()).length : 0,
        perm: ('Notification' in window) ? Notification.permission : 'none' }))()`));
    if (device.sw !== 0 || !['default', 'none'].includes(device.perm)) problems.push(`練習中に端末の通知・Service Worker に触れた: ${JSON.stringify(device)}`);
    if (p.errors.length) problems.push(`画面でエラー: ${p.errors.slice(0, 4).join(' / ').slice(0, 600)}`);
    const real = p.net.filter(n => /supabase\.co/.test(n.url));
    const writes = real.filter(n => !['GET', 'OPTIONS'].includes(n.method));
    if (writes.length) problems.push(`本物の Supabase へ書き込みが出た: ${writes.map(n => n.method + ' ' + n.url.slice(0, 90)).join(' / ')}`);
    const other = real.filter(n => !/\/rest\/v1\/nikke_characters\?select=\*$/.test(n.url));
    if (other.length) problems.push(`キャラ表以外を本物から読んだ: ${other.map(n => n.method + ' ' + n.url.slice(0, 90)).join(' / ')}`);
    // やめる → 本番に戻る (ここから先は本物へ読みに行かせない)
    await p.S('Network.setBlockedURLs', { urls: ['*supabase.co*', '*esm.sh*', '*jsdelivr.net/npm/@supabase*'] });
    const before = p.net.length;
    await tap(p, '[data-pm=quit]').catch(() => { });
    // 本番へ戻る読み込みも状態で待つ (読み込み中に eval すると「navigated」で落ちる)
    for (let t0 = Date.now(); Date.now() - t0 < 45000;) {
        let back = false;
        try { back = await p.eval(`!/practice=/.test(location.search) && document.readyState === 'complete' && !!document.getElementById('notification')`); } catch (_) { back = false; }
        if (back) break;
        await wait(500);
    }
    const after = JSON.parse(await p.eval(`JSON.stringify({ practice: !!window.PAD_PRACTICE, attr: document.documentElement.getAttribute('data-practice'), search: location.search,
        keys: Object.keys(sessionStorage).filter(k => k.indexOf('shirisuko_practice_v1') === 0 || k.indexOf('pm::') === 0), me: localStorage.getItem('shirisuPad.currentPlayer'),
        lsKeys: Object.keys(localStorage).sort() })`));
    if (after.practice || after.attr || /practice=/.test(after.search) || after.keys.length) problems.push(`やめても練習が残っている: ${JSON.stringify(after)}`);
    if (JSON.parse(after.me || '{}').id !== 24) problems.push(`本番の名乗りが変わった: ${after.me}`);
    if (after.lsKeys.some(k => !['shirisuPad.currentPlayer', 'shirisuPad.tourCompleted'].includes(k) && !/^shirisu/.test(k))) problems.push(`本番の記憶に見慣れない鍵: ${after.lsKeys}`);
    if (!p.dialogs.some(d => /練習をやめて、本番の画面に戻りますか/.test(d))) problems.push('やめる前に確かめていない');
    void before;
    } catch (e) { problems.push(`確認の途中で例外: ${String(e && e.message || e).slice(0, 200)}`); }
    await p.close();
    console.log(problems.length ? `  ❌ ${label}\n     ${problems.join('\n     ')}\n     --- ここまでの手順\n     ${trail.slice(-8).join('\n     ')}\n     --- 読み込み直し\n     ${p.navs.slice(-6).join('\n     ')}` : `  ✅ ${label} (${trail.length} 手で最後まで)`);
    return problems.length === 0;
}

const ONLY = process.env.ONLY || '';   // ONLY=ops-day のように 1 本だけ流す (作っている最中に)
let ok = true;
try {
    const want = (sc, at = '') => !ONLY || ONLY === sc + (at ? ':' + at : '');
    if (want('member')) ok = await run('スマホ幅 (390×844): 案内の枠だけを押してメンバー編が最後まで進む / エラー 0 / 本物への書き込み 0 / やめると本番に戻る', { width: 390, height: 844, mobile: true }, 'member') && ok;
    if (want('ops-eve')) ok = await run('スマホ幅: 運営編・前日 (催促 → 🧱 朝を組む → 📌 → 予約の承認 → 朝のぶんを配信) が最後まで進む', { width: 390, height: 844, mobile: true }, 'ops-eve') && ok;
    if (want('ops-day')) ok = await run('スマホ幅: 運営編・当日 (⚔️ HP → ⚔️ 結果の取り込み → 🧱 夕方を組む → 配信 → 締凸検索で探してコピー) が最後まで進む', { width: 390, height: 844, mobile: true }, 'ops-day') && ok;
    if (want('member', 'report')) ok = await run('スマホ幅: ツアーから「凸したら Discord へ」に入る (手前の課題は済んだ状態) → 最後まで', { width: 390, height: 844, mobile: true }, 'member', 'report') && ok;
    if (want('member', 'ack')) ok = await run('スマホ幅: 「「いつ・どの PT で凸するか」を確かめる」から入る (配信まで済んだ状態) → 最後まで', { width: 390, height: 844, mobile: true }, 'member', 'ack') && ok;
    if (process.env.PC && want('member')) ok = await run('PC 幅 (1280×800): メンバー編', { width: 1280, height: 800, mobile: false }, 'member') && ok;
    if (process.env.PC && want('ops-eve')) ok = await run('PC 幅 (1280×800): 運営編・前日', { width: 1280, height: 800, mobile: false }, 'ops-eve') && ok;
    if (process.env.PC && want('ops-day')) ok = await run('PC 幅 (1280×800): 運営編・当日', { width: 1280, height: 800, mobile: false }, 'ops-day') && ok;
} catch (e) { ok = false; console.log('  ❌ 実行できませんでした: ' + (e && e.stack || e)); }
cleanup();
console.log(ok ? '\nOK' : '\nNG');
process.exit(ok ? 0 : 1);
