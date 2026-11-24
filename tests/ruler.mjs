// ============================================================================
// 📏 物差しの検査 (全体の見直し 段階 2・2026-11-16〜) — 本物のブラウザで、揃え終わったタブに「物差しから外れた部品」が 0 個なのを確かめる
//   node tests/ruler.mjs            揃え終わったタブ (下の DONE) を全部
//   TABS=raid node tests/ruler.mjs  まだ揃えていないタブの外れを一覧で見る (落ちない・下調べ用)。運営タブの中の小タブは TABS=ops/メンバー,ops/組む,ops/戦況
// 場面は「練習の編:幅」。3 つ目に動作を足せる (+ でつなぐ): ':piece' = 🧱 組む のピース置き場の札 (置けるもの) を 1 つ押してから見る (押したときだけ出る 🧭 ガイド・置ける行の印を検査に入れる)
//   ':open' = 畳まれているカードを全部開く / ':finish' = ⚔️ ボス状況の「締め凸検索」を押す / ':intake' = 📥 結果の取り込みで人を選んで「✏️ 手で入力」(下書きを出す)
//   ':details' / ':maint' / ':prep' / ':end' = 👑 マスター (下の DONE) / ':board' = 📅 レイド予定表の決定の盤と模擬の表が見えていることを確かめる (押さない)
//   ':mine' / ':nomine' / ':ack' / ':acked' = 📅 の場面ごとの状態 (★ あなたの凸 / あなたの凸なし / ✅ 確認しました / ✅ 確認済み) が見えていることを確かめる
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
    // 🧱 組む (2026-11-17): 前日は「このブロックのみ」の段が開いている (PC 幅の見出しは 1 行 = hit40 が効く) / 当日は盤に駒・置いた札・やり直す。:piece = ピースを押して 🧭 ガイドを出した所
    'ops/組む': ['ops-eve:390', 'ops-eve:1366', 'ops-day:390', 'ops-day:1366', 'ops-eve:390:piece', 'ops-day:390:piece', 'ops-day:1366:piece'],
    'ops/メンバー': ['ops-eve:390', 'ops-day:390', 'ops-day:1366'],   // 運営タブの小タブ (段階のバー・ヒーロー・👥 メンバー状況・📸 模擬の取り込み・一斉通知・Discord 用の文面)
    // ⚔️ 戦況 (2026-11-17): 当日は 締め凸検索・結果の取り込み が畳まれて出る → 開かない場面 1 つ (畳んだ見出し) + :open (全部開く)。前日は空の文。
    //   :finish = ボスの「締め凸検索」を押した所 (候補・🏁・プラン・📋 コピー) / :intake = 取り込みの下書き (ボス・ダメージ・Lv・やめる / 登録する)
    //   320px = 📥 の行のボタンが折り返して上下に並ぶ幅 (2026-11-20 Codex 監査: 「凸していない」が「📥 取り込む」の真下に来て押せる範囲が重なっていた → 行の row-gap)
    'ops/戦況': ['ops-eve:390:open', 'ops-day:390', 'ops-day:390:open', 'ops-day:320:open', 'ops-day:1366:open', 'ops-day:390:open+finish', 'ops-day:1366:open+finish', 'ops-day:390:open+intake', 'ops-day:1366:open+intake'],
    // 👑 マスター (2026-11-20): 練習の運営役を master にして開く (runScene)。前日 = ブロックの設定を編集できる / 当日 = 決定があるので読み取り専用。:details = 名簿の読み取りの開閉を開く /
    //   :maint = その他 › メンテナンス の 最近のアクティビティ・キャラマスタ を開く / :prep・:end = 段階を手で切り替えて シーズン作成・🧪 リハーサル / シーズン終了・リセット のボタンを出す
    'ops/マスター': ['ops-eve:390', 'ops-eve:390:details', 'ops-eve:320:details', 'ops-day:390', 'ops-day:1366', 'ops-eve:1366:maint+details', 'ops-day:390:maint', 'ops-day:390:prep', 'ops-day:390:end'],
    // 📅 レイド予定表 (2026-11-21): メンバーの前日 = まだ配信されていません + みんなの模擬 / 途中の課題 (報告) = 決定 (夕方・夜) の盤・★ あなたの凸 /
    //   当日の運営役 = ✅ 確認しました のボタン・完了 / 未完了 の札。:board = 決定の盤と模擬の表が見えていること (決定が無くなると盤が出ず、測らずに通る)。1366px = 模擬の表の名前の列 (全体の tbody td が PC 幅だけ 13px)
    //   場面ごとの状態も求める (2026-11-21 Codex 監査: 盤と他人の札が残れば、状態の分岐だけ消えても通っていた): :mine = ★ あなたの凸の箱 / :nomine = 「あなたの凸はありません」/ :ack = ✅ 確認しました のボタン / :acked = ✅ 確認済み
    raid: ['member:390', 'member&start=report:390:board+mine+acked', 'member&start=report:1366:board+mine+acked', 'ops-day:390:board+ack+nomine', 'ops-day:320:board+ack+nomine', 'ops-day:1366:board+ack+nomine'],
    // 分析 1 回目 (2026-11-24): 📊 実績 = 順位表・グラフの切り替え・結果まとめ (押すと出る)・NIKKE編成 (開くと出る・キャラの顔 315 枚) / ⚡ ふるり値 = 順位表・属性別・モード /
    //   🧪 シミュレータ = プレイヤーを選んで目標 SLv → 予測と順位表・逆引き (目標ダメージ → SLv) / ふるり値試算 (属性・ダメージ → 算出と順位表)。分析の画面は 'slv-ranking/<画面>' (セグメントのボタンで開く)
    //   汎用の動作 click= / pick= / type= / need= (選択子に : と + は使えない)。need= で、押した・選んだ結果が出ていることを確かめる (出ないまま外れ 0 で通さない)
    //   押した結果は押す前から見えている部品で確かめない (2026-11-24 Codex 監査): グラフの切り替え = 属性のトグルが消える (gone=) / ふるり値の属性・モード = 押したボタンが選ばれた (.active)
    ranking: ['member:390', 'member:1366', 'member:320', 'member:390:click=#statsToggleInline+need=#statsGrid .stat-card', 'member:390:click=#rankChartModeBtnSlv+gone=#chartAttributeToggle',
        'member:390:click=[onclick="toggleCharactersSection()"]+need=#teamCompositionsContainer .card'],
    'slv-ranking/fururi': ['member:390', 'member:1366', 'member:320', 'member:390:click=[data-fururi-boss="H.S.T.A."]+need=[data-fururi-boss="H.S.T.A."].active+need=#fururiRankingBody tr',
        'member:390:click=#fururiModeBtnMean+need=#fururiModeBtnMean.active+need=#fururiRankingBody tr'],
    'slv-ranking/sim': ['member:390:pick=#simPlayerSelect+type=#simTargetSlv=700+need=#simResult+need=#simTableBody tr', 'member:1366:pick=#simPlayerSelect+type=#simTargetSlv=700+need=#simResult+need=#simTableBody tr',
        'member:390:pick=#simPlayerSelect+type=#simTargetDmgB=40+need=#simReverseResult span',
        'member:320:click=.sim-mode-btn[data-sim-mode="fururi"]+pick=#fsimPlayerSelect+click=[data-fsim-attr="FIRE"]+type=#fsimDamage=30+need=#fsimResult+need=#fsimTableBody tr+fit=.fsim-attr-vs'],
    // 分析 2 回目 (2026-11-24): 🛡 全体分析 = 進捗の帯・散布図 (SVG の中は見ない)・ヒートマップ (表) / ⚔ ランキング (押すと出る) / 帯の凸を押した詳細 (編成・✕ = hit40)。
    //   🌏 GB比較 = メンバー% (1 人 1 行の一覧 = data-dense) / 編成 (属性のチップ・人気 / 強い) / 最適3凸 (凸ごとの属性のチップ・SLv の欄・結果)
    //   320px の ⚔ ランキング・帯の凸の詳細・GB の編成 も見る (2026-11-24 Codex 監査: 狭い幅の状態が見張られていなかった)
    'slv-ranking/review': ['member:390', 'member:1366', 'member:320', 'member:390:click=#rrAptBarsBtn+need=.rr-bar', 'member:390:click=.rr-sl+need=.rr-det',
        'member:320:click=#rrAptBarsBtn+need=.rr-bar', 'member:320:click=.rr-sl+need=.rr-det'],
    'slv-ranking/gb': ['member:390', 'member:1366', 'member:320', `member:390:click=[onclick="_setGbView('comps')"]+need=#gbCompareCard [onclick^="_setGbMode"]`,
        `member:320:click=[onclick="_setGbView('comps')"]+need=#gbCompareCard [onclick^="_setGbMode"]`,
        `member:390:click=[onclick="_setGbView('best')"]+need=#gbCompareCard [onclick^="_setGbPick"]`, `member:320:click=[onclick="_setGbView('best')"]+need=#gbCompareCard [onclick^="_setGbPick"]`],
    // 分析 3 回目 = 🧬 育成 (2026-11-24): 練習のシーズンに育成の行を入れて、この回の凸がいちばん多い人を名乗ってから開く (runScene の sub === 'growth')。当日の編 = 凸の記録がある (使った編成は凸の記録から作る)。
    //   相手 (ユニオン全体 / growth-them = 凸した人) × 見方 (使った編成 / キャラ別)・1 体ずつくらべる・全項目・取り込みの内訳。顔のマスと編成のアイコンの列は data-dense (盤の駒と同じ「縦に伸ばさない所」)
    'slv-ranking/growth': ['ops-day:390:need=.gv-pt', 'ops-day:320:need=.gv-pt', 'ops-day:1366:need=.gv-pt', 'ops-day:390:click=.gv-pt .gc-more+need=.gv-rk',
        `ops-day:390:growth-them+click=[onclick="handleGrowthAnaBase('them')"]+need=.gv-pt`, 'ops-day:390:growth-them+click=.gv-pt .gc-more+click=.gc-char .gc-more+need=.gc-tbl',
        `ops-day:390:click=[onclick="handleGrowthAnaView('char')"]+click=.gv-tile+need=.gv-rk`, `ops-day:320:click=[onclick="handleGrowthAnaView('char')"]+click=.gv-tile+need=.gv-rk`,
        `ops-day:1366:growth-them+click=[onclick="handleGrowthAnaView('char')"]+click=.gv-tile+need=.gc-char`, 'ops-day:390:click=.gc-more+need=.gc-mrow'],
};
const ONLY = (process.env.TABS || '').split(',').filter(Boolean);
// TABS=ops/戦況 SCENES=ops-day:390:open,ops-day:1366 で、そのタブの場面を差し替えて下調べできる (落ちない・一覧だけ・ALL=1 で外れを全部出す)。SCENES は TABS といっしょに使う
const SCENES = (process.env.SCENES || '').split(',').filter(Boolean);
if (SCENES.length && !ONLY.length) { console.error('NG: SCENES は TABS といっしょに指定してください (例: TABS=ops/戦況 SCENES=ops-day:320:open)'); process.exit(2); }
const PLAN = ONLY.length ? Object.fromEntries(ONLY.map(t => [t, SCENES.length ? SCENES : DONE[t] || ['member:390', 'ops-eve:390', 'ops-day:390', 'ops-day:1366']])) : DONE;
const STRICT = (!ONLY.length || ONLY.every(t => DONE[t])) && !SCENES.length;

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
    //   ★ ただし ⚔️ ✓ 凸の記録の押す札 (button.db-tag) は高さだけ例外にしない = 40px (2026-11-17・当日いちばん押す・押し間違えると別の人に ✓)。札の中の文字は dense のまま (📅 の札は読むだけの span)
    //   1 人 1 行の一覧で、ほかの印が無いものは data-dense を付ける (👑 マスター の 通知状況・育成の識別子・選んだ人。付け先は run-tests が一覧で固定 = 外れを黙らせるために足さない)
    const dense = (e) => !!e.closest('table, .dc-mb-row, [class*="table"], .obr, .obpc, .db-tag, [data-dense]');
    const ownText = (e) => [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim());
    const snapF = (px) => px < 11.3 ? 11 : px < 12.8 ? 12 : px < 15 ? 14 : px < 17.5 ? 16 : px < 24 ? 20 : px;
    const where = (e) => { let n = e; while (n && n !== document.body) { if (n.id) return '#' + n.id; n = n.parentElement; } return ''; };
    const sig = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
    const out = [];
    for (const e of els) {
        const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // 図 (SVG) の中は見ない: 文字の大きさは viewBox の縮尺で決まる (👑 🧱 ブロックの設定の時計は viewBox 360 を 190〜300px に縮めて描く = 指定の 13px は実際には 7〜11px)。図の外のラベル (figcaption) は見る
        if (e.closest('svg')) continue;
        const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue;
        const txt = (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 18);
        if (ownText(e)) { const px = parseFloat(cs.fontSize); let t = snapF(px); if (dense(e) && px < 11) t = px < 9.75 ? 9 : 10; if (Math.abs(t - px) > 0.01) out.push(['文字', px + '→' + t, where(e), sig(e), txt]); }
        const r = parseFloat(cs.borderTopLeftRadius); const short = Math.min(b.height, b.width);
        if (r > 0 && r < short / 2 - 0.5) { const t = short < 24 ? 4 : r <= 10.5 ? 8 : r <= 18 ? 14 : 22; if (t !== r) out.push(['角丸', r + '→' + t, where(e), sig(e), Math.round(b.width) + 'x' + Math.round(b.height) + ' ' + txt]); }
        if (e.matches('button, [role="button"], a.btn, select, input[type="text"], input[type="number"]') && (!dense(e) || e.matches('button.db-tag')) && !e.classList.contains('hit40') && b.height >= 24 && b.height < 40 && b.width >= 24) out.push(['高さ', Math.round(b.height) + '→40', where(e), sig(e), txt]);
        // hit40 (見た目を変えずに押せる範囲を広げる) は、class があるだけで通さない。2 つとも満たすこと:
        //   ① 押せる範囲 (::before) の高さが 40px 以上 (数字)  ② その範囲の点が、実際にこのボタンに当たる (::before が無い・消えている・pointer-events が無い・親で切れている・別の部品に覆われている、を拾う)。
        //   ② はボタンを画面の真ん中に寄せ (すぐ動かす — なめらかなスクロールの途中を測らない)、左・中・右 × 上 19.5px・真ん中・下 19.5px の 9 点で elementFromPoint を見る。押したあとの動き (disabled など) までは見ない
        //   さらに ③ 広げた範囲が、すぐ上下の別の押せる部品を取っていないか (下の ③)
        if (e.classList.contains('hit40')) {
            const hb = parseFloat(getComputedStyle(e, '::before').height);
            e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            const q = e.getBoundingClientRect(); const cy = q.top + q.height / 2;
            const hitAt = (x, dy) => { const g = document.elementFromPoint(x, cy + dy); return !!g && (g === e || e.contains(g)); };
            const xs = [q.left + 2, q.left + q.width / 2, q.right - 2]; const miss = [];
            for (const x of xs) for (const dy of [-19.5, 0, 19.5]) if (!hitAt(x, dy)) miss.push(Math.round(x - q.left) + ',' + dy);
            if (!(hb >= 39.5) || miss.length) out.push(['高さ', 'hit40 の押せる範囲 ' + (Number.isFinite(hb) ? Math.round(hb * 10) / 10 : '?') + 'px→40 (当たらない点 ' + (miss.join(' ') || 'なし') + ')', where(e), sig(e), txt]);
            // ③ 広げた範囲が、すぐ上下の別の押せる部品を取らない (2026-11-17 見直し: 「自動で反映する」のチェックの範囲が、カードの見出し (押すと畳む) の下 5px を取っていた)。
            //   見た目の外の帯 (上下に (範囲 − 高さ) / 2) の点で、いちばん上がこの部品なのに、その下に別の押せる部品 (button・a・summary・label・入力・onclick・cursor: pointer) があれば外れ。祖先と子は数えない
            const ext = Number.isFinite(hb) ? (hb - q.height) / 2 : 0; const steal = new Set();
            if (ext > 1) for (const x of xs) for (const y of [q.top - 1, q.top - ext / 2, q.top - ext + 1, q.bottom + 1, q.bottom + ext / 2, q.bottom + ext - 1]) {
                const st = document.elementsFromPoint(x, y); if (!st.length || !(st[0] === e || e.contains(st[0]))) continue;
                const vic = st.find(n => n !== e && !e.contains(n) && !n.contains(e) && (n.matches('button, a[href], summary, label, input, select, textarea, [onclick], [role="button"]') || getComputedStyle(n).cursor === 'pointer'));
                if (vic) steal.add(where(vic) + ' ' + sig(vic));
            }
            //   左右も同じ (2026-11-20: 既定の hit40 は左右に 4px 広げる。⚔️ 📥 の行のボタンは 6px の間で並ぶので、広げると隣のボタンの端を取る — 行では left/right 0 にしてある)
            const bs = getComputedStyle(e, '::before'); const exL = -parseFloat(bs.left), exR = -parseFloat(bs.right);
            for (const [ex, side] of [[exL, -1], [exR, 1]]) if (ex > 0.5) for (const y of [cy - q.height / 4, cy, cy + q.height / 4]) for (const d of [0.5, ex / 2, ex - 0.5]) {
                const x = side < 0 ? q.left - d : q.right + d;
                const st = document.elementsFromPoint(x, y); if (!st.length || !(st[0] === e || e.contains(st[0]))) continue;
                const vic = st.find(n => n !== e && !e.contains(n) && !n.contains(e) && (n.matches('button, a[href], summary, label, input, select, textarea, [onclick], [role="button"]') || getComputedStyle(n).cursor === 'pointer'));
                if (vic) steal.add(where(vic) + ' ' + sig(vic));
            }
            if (steal.size) out.push(['高さ', 'hit40 の押せる範囲がほかの押せる部品にかかる (' + [...steal].join(' / ') + ')', where(e), sig(e), txt]);
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
// 場面を 1 つ開いて検査する。返すのは { v: 外れの一覧 (検査できなければ null), label, openFail: タブを開けなかった・検査が動かなかった }
const runScene = async (tab, scene) => {
        const [scenario, w, act] = scene.split(':'); const W = Number(w), H = W > 700 ? 800 : 844;
        const [tabId, sub] = tab.split('/');   // 'ops/組む' = 運営タブの中の小タブ (名前の一部で指す)
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const S = (method, params) => send(method, params, sessionId);
        const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
        await S('Page.enable'); await S('Runtime.enable');
        await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
        await S('Page.navigate', { url: `${ORIGIN}/index.html?practice=${scenario}` });
        // 読み込みは時計でなく状態で待つ: 練習の案内の帯が「練習中」になってから (当日の編は開始の盤面を作って読み込み直す・途中の課題から入ると手前を済ませて読み込み直す — その前のページで通さない)。
        //   運営の編は、役割を読み終わって運営モードになってから (なる前に運営タブを開くとホームへ回される)。重い Chrome で偽の NG が出ていた (2026-11-17 見直し)
        const READY = `!!(window.PAD_PRACTICE && document.getElementById('pmDock') && document.readyState === 'complete' && typeof switchTab === 'function' && /練習中/.test(document.querySelector('#pmDock .pm-band .t')?.textContent || '')${scenario.startsWith('ops') ? " && document.body.classList.contains('ops-mode')" : ''})`;
        let ready = false;
        for (let i = 0; i < 80 && !ready; i++) { await wait(500); try { ready = await ev(READY); } catch (_) { /* 読み込み直しの最中 */ } }
        await wait(2500);
        let v = null, openFail = false, label = `${tab} — ${scenario} ${W}px${act ? ' (' + act + ')' : ''}`;
        try {
            // 練習の案内 (上の帯・枠) と使い方ツアーは検査の対象でない (本番の画面に無い / 別の画面)
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '#pmDock, #pmRing, #tourOverlay { display: none !important; }'; document.head.appendChild(st); return 1; })()`);
            // 👑 マスター の小タブは、練習の運営役 (運営担当 = ops) には出ない → 偽のサーバの運営役を master にして役割を読み直す (本番の 46 と同じ入り方。練習の DB の 1 行だけ)
            let promoted = true;
            if (sub === 'マスター') promoted = await ev(`(async () => { const P = window.PAD_PRACTICE; const row = P && P.db && P.db.tables.players.find(x => String(x.id) === String(P.ops && P.ops.id)); if (!row) return false; row.ops_role = 'master'; await _syncOpsRole(); if (!document.body.classList.contains('ops-mode')) toggleOpsMode(); return document.body.classList.contains('ops-master') && document.body.classList.contains('ops-mode'); })()`);   // master は 🛠 の記憶で運営⇄メンバー (練習の端末は記憶が空 = メンバーになる) → 運営の画面にする
            let active = promoted ? await ev(`(() => { switchTab(${JSON.stringify(tabId)}); return document.querySelector('.tab-content.active')?.id || null; })()`) : 'マスターにできない';
            // 🧬 育成 (2026-11-24): 練習の偽のサーバは育成の表が空 = 「まだ育成データがありません」しか出ない → 練習のシーズンの凸と模擬に出てくるキャラで、
            //   取り込みの本物の保存の関数 (supabaseSaveMemberGrowth / Status) で育成の行を入れてから開く (練習の DB だけ・本番に触れない・数字は名前から決まる = 乱数なし)
            if (sub === 'growth' && active === 'tab-' + tabId) {
                const seeded = await ev(`(async () => {
                    const P = window.PAD_PRACTICE; const t = P && P.db && P.db.tables; if (!t) return '練習の DB が無い';
                    const season = (t.seasons || []).find(s => s.is_active) || (t.seasons || [])[0]; if (!season) return 'シーズンが無い';
                    const chars = new Map();
                    const add = (pid, list) => { if (!Array.isArray(list)) return; const s = chars.get(String(pid)) || new Set(); list.filter(Boolean).forEach(c => s.add(String(c))); chars.set(String(pid), s); };
                    (t.attacks || []).filter(a => String(a.season_id) === String(season.id)).forEach(a => add(a.player_id, a.characters));
                    (t.player_damages || []).forEach(d => add(d.player_id, d.characters));
                    if (!chars.size) return '凸にも模擬にもキャラが無い';
                    for (const [pid, set] of chars) {
                        const rows = [...set].map(c => { const h = [...(pid + c)].reduce((x, ch) => (x * 31 + ch.charCodeAt(0)) % 9973, 7);
                            return { character_name: c, grade: 3, core: 1 + h % 7, lv: 360 + h % 80, skill1_lv: 10 - h % 3, skill2_lv: 10 - h % 4, ulti_skill_lv: 10 - h % 2, combat: 80000 + h * 13, harmony_cube_lv: 1 + h % 15,
                                overload: { 有利コード: 5 + h % 25, 攻撃力: 4 + h % 18, 最大装弾数: h % 12 } }; });
                        await window.supabaseSaveMemberGrowth(season.id, Number(pid), rows);
                        await window.supabaseSaveMemberGrowthStatus(season.id, Number(pid), { status: 'ok', characterCount: rows.length });
                    }
                    // 「使った編成」は凸の記録から作る — 練習の運営役は凸していないので、編成のカードが出ない → この回の凸がいちばん多い人を名乗る (同じ数なら id の小さい人)
                    const cnt = new Map();
                    (t.attacks || []).filter(a => String(a.season_id) === String(season.id) && Array.isArray(a.characters) && a.characters.length).forEach(a => cnt.set(String(a.player_id), (cnt.get(String(a.player_id)) || 0) + 1));
                    const top = [...cnt.entries()].sort((x, y) => y[1] - x[1] || Number(x[0]) - Number(y[0]))[0];
                    const mp = top && (t.players || []).find(p => String(p.id) === top[0]);
                    if (!mp) return 'この回に凸した人がいない';
                    setCurrentIdentity({ id: mp.id, name: mp.name });
                    return chars.size;
                })()`);
                if (!(seeded > 0)) active = '育成の行を入れられない (' + seeded + ')';
            }
            if (sub && active === 'tab-' + tabId && tabId === 'slv-ranking') {
                // 分析の画面 ('slv-ranking/review' = 🛡 全体分析・fururi・growth・sim・gb): 上のセグメントのボタンを押す (メンバーが押すのと同じ)。押したあと、その画面の部品が見えていること
                //   ★ 先に別の画面へ切り替えて、目当ての画面が隠れたのを確かめてから押す (ふるり値は最初から出ている画面 — そのままだとボタンが壊れていても通る: 2026-11-24 Codex 監査)
                const view = JSON.stringify(JSON.stringify(sub));
                const shownNow = `[...document.querySelectorAll('#tab-slv-ranking [data-slv-view=' + ${view} + ']')].some(e => !e.hidden && e.getClientRects().length > 0)`;
                await ev(`_setSlvView(${JSON.stringify(sub === 'sim' ? 'fururi' : 'sim')})`);
                const hidden = !(await ev(shownNow));
                const hit = hidden && await ev(`(() => { const b = document.querySelector('#tab-slv-ranking .ana-seg button[data-view=' + ${view} + ']'); if (!b) return false; b.click(); return true; })()`);
                const shown = hit && await ev(shownNow);
                if (!shown) active = '分析の画面「' + sub + '」を開けない';
            } else if (sub && active === 'tab-' + tabId) {
                // 小タブは、タブの中身が出てから押す (運営タブは盤面を読んでから小タブを描く)
                let hit = false;
                for (let i = 0; i < 20 && !hit; i++) { await wait(500); hit = await ev(`(() => { const b = [...document.querySelectorAll('#opsSubTabs button')].find(x => x.textContent.includes(${JSON.stringify(sub)})); if (!b) return false; b.click(); return true; })()`); }
                if (!hit) active = '小タブ「' + sub + '」が無い';
            }
            // ★ 中身が落ち着くまで待つ (Codex 監査 fc127f8): タブの中の部品の数と文字の量が 3 回続けて同じになるまで (最長 20 秒)。非同期の描画の途中 (読み込み中・空) を検査して通さない
            //   「同じ」は 部品の数 + 文字の中身 (長さでなく中身 — 同じ長さの別の文に差し替わったのを見逃さない) + タブの高さ + 押せない・隠した・選んだ部品の数。早く揃っても 5 秒は見る (遅れて来る描画: 配信・通知・更新履歴)。
            //   ★ これは「描き終わったか」の目安で、証明ではない (5 秒より後に来る描画・見た目だけの変化は拾えない)。練習モードは端末の中の偽のサーバで動くので、通信待ちは無い
            const SHAPE = `(() => { const t = document.querySelector('.tab-content.active'); if (!t) return ''; const s = t.innerText || ''; let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return t.id + ':' + t.querySelectorAll('*').length + ':' + h + ':' + t.scrollHeight + ':' + t.querySelectorAll('[disabled], [hidden], [aria-pressed="true"]').length; })()`;
            let same = 0, last = '';
            const settle = async () => { same = 0; last = ''; const t0 = Date.now(); for (let i = 0; i < 28 && (same < 3 || Date.now() - t0 < 5000); i++) { await wait(700); const now = await ev(SHAPE); same = (now && now === last) ? same + 1 : 0; last = now; } };
            await settle();
            // 動作: ピースを押す (置けるピース = 赤くない・使っていない札)。押せなければ「押せない」と出して検査しない (黙って押す前の画面を見ない)。
            //   タブを開けていないときは押さない (開けなかった本当の理由を「ピースが無い」で上書きしない)。押したあとはピースとガイドが「見えている」か (DOM にあるだけでは通さない — 隠れたガイドは CHECK が飛ばすので、測らずに外れ 0 になる)
            //   動作は + でつなげる (例 open+finish)。前から順に行い、1 つでも失敗したら残りはしない
            for (const a of (act || '').split('+').filter(Boolean)) {
                if (active !== 'tab-' + tabId) break;
                if (a === 'piece') {
                    const pressed = await ev(`(() => { const b = document.querySelector('#opsBuild .obt:not(.off):not(.ng)'); if (!b) return false; b.click(); return true; })()`);
                    if (!pressed) { active = 'ピースが無い (押せない)'; }
                    else { await settle(); if (!(await ev(`(() => { const vis = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden'; return vis(document.querySelector('#opsBuild .obt.sel')) && vis(document.querySelector('#obGuide .obg-h')); })()`))) active = '押したのにピースが選ばれない / ガイドが見えない'; }
                } else if (a === 'open') {
                    // 畳まれているカードを全部開く (見出しを押す = 運営が開くのと同じ)。開いたあとに畳まれたカードが残っていれば失敗
                    const n = await ev(`(() => { const hs = [...document.querySelectorAll('.tab-content.active .ops-card.ops-closed > .ops-card-head')].filter(h => h.getClientRects().length); hs.forEach(h => h.click()); return hs.length; })()`);
                    await settle();
                    if (await ev(`[...document.querySelectorAll('.tab-content.active .ops-card.ops-closed')].some(c => c.getClientRects().length)`)) active = 'カードが開かない (' + n + ' 枚押した)';
                } else if (a === 'finish') {
                    // ⚔️ ボス状況カードの「締め凸検索」を押す → 締め凸検索のカードに候補・🏁 いま打つか待つか・📋 コピー が出る (締め凸検索のカードは open で先に開いておく)
                    const pressed = await ev(`(() => { const b = document.querySelector('#opsBossSummary .js-finish:not([disabled])'); if (!b) return false; b.click(); return true; })()`);
                    if (!pressed) active = '締め凸検索を押せない';
                    else { await settle(); if (!(await ev(`(() => { const l = document.getElementById('opsFinishList'); return !!l && l.getClientRects().length > 0 && !/^\\s*ボス状況カードから/.test(l.textContent) && l.querySelectorAll('button').length > 0; })()`))) active = '押したのに締め凸検索の結果が出ない'; }
                } else if (a === 'intake') {
                    // 📥 結果の取り込み: 誰の凸か (いちばん上の人) を選んで「✏️ 手で入力」→ 下書き (ボス・ダメージ・Lv・編成・残 HP・登録する) が出る
                    const ok = await ev(`(() => { const s = document.getElementById('opsResultPlayer'); const o = s && [...s.options].find(x => x.value); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); const b = document.querySelector('#opsSecAttackCheck button[onclick="_opsResultManual()"]'); if (!b) return false; b.click(); return true; })()`);
                    if (!ok) active = '取り込みの人・手で入力を押せない';
                    else { await settle(); if (!(await ev(`(() => { const d = document.getElementById('opsResultDraft'); return !!d && d.getClientRects().length > 0 && d.querySelectorAll('button, input, select').length > 0; })()`))) active = '押したのに取り込みの下書きが出ない'; }
                } else if (a === 'prep' || a === 'end') {
                    // 運営の段階を手で切り替える (運営が段階の上書きを選ぶのと同じ関数)。👑 シーズン制御の 作成 (準備) / 終了・リセット (終了) のボタンは段階で出し分ける
                    const called = await ev(`(() => { if (typeof handleOpsStageOverride !== 'function') return false; handleOpsStageOverride(${JSON.stringify(a)}); return true; })()`);
                    await settle();
                    // 段階を変えると、開く小タブが段階の既定 (準備 = 👥 メンバー) に戻る → 小タブを押し直す
                    if (called && sub) { await ev(`(() => { const b = [...document.querySelectorAll('#opsSubTabs button')].find(x => x.textContent.includes(${JSON.stringify(sub)})); if (b) b.click(); return !!b; })()`); await settle(); }
                    const ok = called && await ev(`[...document.querySelectorAll('#tab-ops button[data-stage~="${a}"]')].some(e => e.getClientRects().length)`);   // ボタンが見えていること (説明文だけ残ったのを通さない)
                    if (!ok) active = '段階を「' + a + '」にできない';
                } else if (a === 'maint') {
                    // 👑 マスター › その他 › メンテナンス の、見出しを押して開くカード 2 枚 (最近のアクティビティ・キャラマスタ) を、見出しを押して開く
                    await ev(`(() => { for (const [id, fn] of [['settingsActivityBody', 'toggleSettingsActivity'], ['settingsMasterBody', 'toggleSettingsMaster']]) { const b = document.getElementById(id); const h = document.querySelector('#tab-ops [onclick="' + fn + '()"]'); if (b && h && getComputedStyle(b).display === 'none') h.click(); } return 1; })()`);
                    await settle();
                    if (!(await ev(`['settingsActivityBody', 'settingsMasterBody'].every(id => { const b = document.getElementById(id); return !!b && b.getClientRects().length > 0; })`))) active = 'アクティビティ・キャラマスタが開かない';
                } else if (a === 'details') {
                    // 畳んである開閉 (details) を全部開く (👑 マスター の 名簿の読み取り・メンテナンスなど)。開いたあとに見えている閉じた details が残れば失敗
                    const n = await ev(`(() => { let n = 0; for (let k = 0; k < 5; k++) { const ds = [...document.querySelectorAll('.tab-content.active details:not([open])')].filter(d => d.getClientRects().length); if (!ds.length) break; ds.forEach(d => { d.open = true; }); n += ds.length; } return n; })()`);   // 中の details は親を開くと見えるので、なくなるまで (5 段まで)
                    await settle();
                    if (n === 0) active = '開く details が無い';
                    else if (await ev(`[...document.querySelectorAll('.tab-content.active details:not([open])')].some(d => d.getClientRects().length)`)) active = 'details が開かない (' + n + ' 個開いた)';
                } else if (a === 'board') {
                    // 📅 レイド予定表: 決定の状態の行・盤 (ブロックのボタン・ボスの行・名前の札)・みんなの模擬の表 が見えていること (DOM にあるだけでは通さない — 隠れた部品は CHECK が飛ばすので、測らずに外れ 0 になる)
                    const ok = await ev(`(() => { const vis = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden'; return ['#raidStatusBody .rt-state', '#raidTimetableBody .obb', '#raidTimetableBody .obr', '#raidTimetableBody .db-tag', '#raidMocksBody table'].every(q => vis(document.querySelector(q))); })()`);
                    if (!ok) active = '決定の盤・模擬の表が見えない';
                } else if (a === 'mine' || a === 'nomine' || a === 'ack' || a === 'acked') {
                    // 📅 の場面ごとの状態 (その分岐だけが消えたら落ちる): 部品が見えていること (文は中身も見る)
                    const want = { mine: ['#raidTimetableBody .db-mine', '★ あなたの凸: '], nomine: ['#raidTimetableBody .rt-note', '決まったブロックに、あなたの凸はありません'], ack: ['#raidStatusBody .rt-ack', '✅ 確認しました'], acked: ['#raidStatusBody .rt-acked', '✅ 確認済み'] }[a];
                    const ok = await ev(`(() => { const vis = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden'; return [...document.querySelectorAll(${JSON.stringify(want[0])})].some(e => vis(e) && e.textContent.includes(${JSON.stringify(want[1])})); })()`);
                    if (!ok) active = '「' + want[1] + '」が見えない';
                } else if (a === 'growth-them') {
                    // 🧬 育成: くらべる相手に、この回に凸した人 (名乗っている人の次に凸が多い人) を選ぶ (相手えらびのボタンを押す)。凸の無い相手だと「その人が使った編成」が空になる
                    const ok = await ev(`(() => { const t = window.PAD_PRACTICE.db.tables; const me = String(getCurrentIdentity()?.id ?? ''); const sid = String(_gv.seasonId);
                        const cnt = new Map(); (t.attacks || []).filter(x => String(x.season_id) === sid && Array.isArray(x.characters) && x.characters.length && String(x.player_id) !== me).forEach(x => cnt.set(String(x.player_id), (cnt.get(String(x.player_id)) || 0) + 1));
                        const top = [...cnt.entries()].sort((x, y) => y[1] - x[1] || Number(x[0]) - Number(y[0]))[0]; if (!top) return false;
                        const b = document.querySelector('.gv-who button[onclick="handleGrowthAnaWho(' + Number(top[0]) + ')"]'); if (!b) return false; b.click(); return true; })()`);
                    if (!ok) { active = 'くらべる相手 (凸した人) を選べない'; break; }
                    await settle();
                } else if (a.startsWith('click=')) {
                    // 汎用 (2026-11-21 分析から): 見えている最初の部品を押す (結果まとめ・グラフの切り替え・開閉・モードなど)。選択子に ':' と '+' は使えない (場面の区切り)
                    const q = a.slice(6);
                    const ok = await ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(q)})].find(x => x.getClientRects().length > 0); if (!e) return false; e.click(); return true; })()`);
                    if (!ok) { active = '「' + q + '」を押せない'; break; }
                    await settle();
                } else if (a.startsWith('pick=')) {
                    // 汎用: select の最初の空でない選択肢を選んで change を送る (シミュレータのプレイヤーなど)
                    const q = a.slice(5);
                    const ok = await ev(`(() => { const s = document.querySelector(${JSON.stringify(q)}); const o = s && [...s.options].find(x => x.value); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                    if (!ok) { active = '「' + q + '」で選べない'; break; }
                    await settle();
                } else if (a.startsWith('type=')) {
                    // 汎用: 入力欄に値を入れて input を送る。type=#fsimDamage=30 (最後の = の後ろが値)
                    const k = a.lastIndexOf('='); const q = a.slice(5, k), val = a.slice(k + 1);
                    const ok = k > 5 && await ev(`(() => { const e = document.querySelector(${JSON.stringify(q)}); if (!e) return false; e.value = ${JSON.stringify(val)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                    if (!ok) { active = '「' + q + '」に入れられない'; break; }
                    await settle();
                } else if (a.startsWith('need=')) {
                    // 汎用: その部品が見えていること (押した・選んだ結果が出たか。出ないまま外れ 0 で通さない)
                    const q = a.slice(5);
                    const ok = await ev(`[...document.querySelectorAll(${JSON.stringify(q)})].some(e => e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden')`);
                    if (!ok) { active = '「' + q + '」が見えない'; break; }
                } else if (a.startsWith('gone=')) {
                    // 汎用: その部品が見えていないこと (押した結果、消えるはずの部品 — 例: グラフを SLv×ダメージ にすると属性のトグルが消える)
                    const q = a.slice(5);
                    const shown = await ev(`[...document.querySelectorAll(${JSON.stringify(q)})].some(e => e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0)`);
                    if (shown) { active = '「' + q + '」が消えない'; break; }
                } else if (a.startsWith('fit=')) {
                    // 汎用: その部品が親の中に収まっていること (中身の幅が親の中身の幅を超えない = 隣にはみ出さない。物差しの検査では拾えない並び崩れ — 2026-11-24 Codex 監査: 320px の ⚔ の行)
                    const q = a.slice(4);
                    const bad = await ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(q)})].filter(e => e.getClientRects().length > 0); if (!els.length) return '見えない'; for (const e of els) { const p = e.parentElement; const cs = getComputedStyle(p); const inner = p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); if (e.scrollWidth > inner + 0.5) return (e.textContent || '').trim().slice(0, 12) + ' が ' + Math.round(e.scrollWidth - inner) + 'px はみ出す'; } return ''; })()`);
                    if (bad) { active = '「' + q + '」' + bad; break; }
                } else { active = '知らない動作: ' + a; break; }
            }
            const body = await ev(`(() => { const t = document.querySelector('.tab-content.active'); const vis = t ? [...t.querySelectorAll('*')].filter(e => e.getClientRects().length && [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) : []; return { n: vis.length, loading: vis.filter(e => /^(読み込み中|Loading)/.test(e.textContent.trim())).length }; })()`);
            if (active !== 'tab-' + tabId || !last.startsWith('tab-' + tabId + ':')) { label += ` (開けない → ${active} / 検査のとき ${last.split(':')[0]})`; openFail = active === null || /^tab-/.test(active); }
            else if (same < 3) label += ' (20 秒待っても中身が落ち着かない)';
            else if (body.n < 20 || body.loading) label += ` (中身が出ていない: 文字のある部品 ${body.n} 個・読み込み中 ${body.loading} 個)`;
            else v = await ev(CHECK);
        } catch (e) { label += ' (検査が動かない: ' + String(e.message || e).slice(0, 120) + ')'; openFail = true; }
        await send('Target.closeTarget', { targetId });
        return { v, label, openFail };
};
for (const [tab, scenes] of Object.entries(PLAN)) {
    for (const scene of scenes) {
        let r = await runScene(tab, scene);
        // タブを開けなかった (別のタブへ回された)・検査が動かなかったときだけ、1 回だけ開き直す (重い端末で練習の読み込み直しと競ることがある)。本物の回帰なら 2 回とも落ちる
        if (r.openFail) { console.log(`  ↻ ${r.label} — 開き直す`); r = await runScene(tab, scene); }
        const { v, label } = r;
        checked++;
        if (v && v.length === 0) { console.log(`  ✅ ${label}: 外れ 0`); continue; }
        if (!v) { console.log(`  ${STRICT ? '❌' : '・'} ${label}`); if (STRICT) failed++; continue; }
        if (STRICT) failed++;
        console.log(`  ${STRICT ? '❌' : '・'} ${label}: 外れ ${v.length} 個 (文字 ${v.filter(x => x[0] === '文字').length}・角丸 ${v.filter(x => x[0] === '角丸').length}・高さ ${v.filter(x => x[0] === '高さ').length})`);
        const grp = new Map(); for (const x of v) { const k = x.slice(0, 4).join(' | '); const g = grp.get(k) || { n: 0, ex: x[4] }; g.n++; grp.set(k, g); }
        for (const [k, g] of [...grp.entries()].sort((p, q) => q[1].n - p[1].n).slice(0, STRICT ? 12 : process.env.ALL ? 1e9 : 60)) console.log('       ' + String(g.n).padStart(3) + '  ' + k + '  「' + g.ex + '」');
    }
}
ws.close();
if (errors.length) { failed++; console.log('  ❌ 画面でエラー: ' + [...new Set(errors)].slice(0, 3).map(e => String(e).slice(0, 200)).join(' / ')); }
console.log(failed ? `\nNG: ${failed} 件 (物差しは docs/段階2_物差し_2026-11-14.md)` : `\nOK: ${checked} 場面`);
cleanup();
process.exit(failed ? 1 : 0);
