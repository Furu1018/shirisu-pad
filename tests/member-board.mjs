// ============================================================================
// 👥 メンバー状況ボード (_mbPaint) の実行テスト
//   node tests/member-board.mjs
// ----------------------------------------------------------------------------
// index.html から _mbPaint の本体を切り出し、DOM と依存をスタブして**実際に描画を実行**する。
// 判定ロジック (js/domain/memberStatus.js) は run-tests.mjs で検証済みなので、ここは
// 「行が組み立てられる」「名前がエスケープされる」「ボタンの出し分け」「undefined が混ざらない」
// といった実行経路だけを見る (plan-hp-modal.mjs と同じ方式・波括弧対応で終端を決める)。
// index.html 側のシグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import '../js/domain/mockLevels.js';     // globalThis.mockLevelsDomain (charKey の委譲先 — 本番と同じ読み込み順)
import '../js/domain/memberStatus.js';   // globalThis.memberStatusDomain
import '../js/domain/raidBlocks.js';     // globalThis.raidBlocksDomain (行の時間のタイル)
import '../js/domain/availability.js';   // globalThis.availabilityDomain (タイルの下の時刻)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extract(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker.trim()} を index.html から切り出せませんでした (目印が変わった?)`); process.exit(2); }
    let depth = 0, end = -1, inStr = null, prev = '';
    for (let k = html.indexOf('{', i); k < html.length; k++) {
        const ch = html[k];
        if (inStr) {
            if (ch === inStr && prev !== '\\') inStr = null;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            inStr = ch;
        } else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
        prev = ch;
    }
    if (end < 0) { console.error(`NG: ${marker.trim()} の終端を判定できませんでした`); process.exit(2); }
    return html.slice(i, end);
}

// ---- 依存スタブ (index.html 側の実装に合わせる) ----
const els = {};
const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} } });
globalThis._homeSimple = () => false;   // 従来の画面 (代理凸のボタンが出る側)
globalThis._finishAskOn = () => true;   // 🏁 段階 2.5: 本番は締め凸の依頼を読まない (練習だけ)。ここは従来の表示 (締め凸 未返答) を見るので true
globalThis.document = { getElementById: (id) => el(id) };
globalThis.escapeHtml = (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.DC_ATTR_COLORS = { fire: '#FF3D44', water: '#2E8BFF', electric: '#9B4DFF', iron: '#FF8A2B', wind: '#18C26B' };
globalThis.window = globalThis;
globalThis._mb = { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, loading: false };

const _mbPaint = eval(`(${extract('        function _mbPaint(').trim()})`);

const dom = globalThis.memberStatusDomain;
const P = (o) => ({ id: 1, name: 'A', damagesByAttr: {}, attacks: [], syncLevel: 0, syncLevelEstimated: true, availableSlots: [], flexTime: false, notifyAllHours: false, strong_attributes: [], ...o });
const players = [
    P({ id: 1, name: '<script>x</script>', damagesByAttr: { fire: 1 }, strong_attributes: ['fire'] }),
    P({ id: 2, name: '完了さん', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, availableSlots: ['h21', 'h22'], avatar_url: 'https://x/y.png' }),
    P({ id: 3, name: '当日残凸', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 610, syncLevelEstimated: false, flexTime: true, attacks: [{ level: 1, boss_number: 1 }] }),
    // 3属性 (被りなし) = 必要範囲を満たす → 前日は「完了」扱い (5属性必須に戻ると未完になりテストが落ちる)
    P({ id: 4, name: '三属性', damagesByAttr: { fire: 1, water: 1, wind: 1 }, teamsByAttr: { fire: ['a'], water: ['b'], wind: ['c'] }, syncLevel: 590, syncLevelEstimated: false, availableSlots: ['h20'], attacks: [{ level: 1 }, { level: 2 }, { level: 3 }] }),
];
// availConfirmations = 今期の戦闘可能時間を確認済み (37)。無いと全員「今期未確認」で要対応になる
const extras = { pushPlayerIds: [2, 3, 4], slvThisSeasonIds: [2, 3, 4], finishRequests: [{ player_id: 3, status: 'pending' }], proxyEvents: [{ player_id: 3 }],
    availConfirmations: [1, 2, 3, 4, 9].map(id => ({ player_id: id, confirmed_at: '2026-09-06T00:00:00Z', unavailable: false, slot_count: null })) };

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}
console.log('member-board (_mbPaint):');

test('📱 端末の状態 (2026-10-08): 最後に開いた端末が拒否 → 🔔⚠ (購読あり) / 🔕 の title に拒否を添える / 端末が分からなければ従来どおり・「未着」と言わない', () => {
    _mb.filter = 'all'; _mb.sort = 'why';
    const devs = [{ device_id: 'd2', player_id: 2, push_permission: 'denied', last_seen_at: '2026-10-07T01:02:03Z', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', app_build: 'abcdef0123' },
        { device_id: 'd1', player_id: 1, push_permission: 'denied', last_seen_at: '2026-10-06T00:00:00Z', ua: 'Mozilla/5.0 (Linux; Android 14)', app_build: null },
        { device_id: 'd4', player_id: 4, push_permission: 'granted', last_seen_at: '2026-10-05T00:00:00Z', ua: 'Mozilla/5.0 (Windows NT 10.0)', app_build: 'abc' }];
    _mb.rows = dom.buildRows({ players, extras: { ...extras, memberDevices: devs }, phase: 'pre' });
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(/title="最後に開いた端末では通知が「拒否」です[^"]*iPhone 10\/07 · 版 abcdef0"[^>]*>🔔⚠</.test(out), `購読ありで端末が拒否の人に 🔔⚠ が出ていない: ${(out.match(/<span class="dc-mb-c[^>]*>🔔[^<]*</g) || []).join(' | ')}`);
    assert.ok(/title="通知の購読がありません — 何も届きません \(最後に開いた端末では通知が拒否されています\)[^"]*Android 10\/06"[^>]*>🔕</.test(out), '購読なし + 端末が拒否の title が無い');
    assert.ok(/title="購読の登録あり \(届くかは未検証。疎通確認はまだ\) \/ 最後に開いた端末: PC 10\/05 · 版 abc"[^>]*>🔔</.test(out), '登録ありの title が変わっている / 端末が添えられていない');
    assert.ok(!/未着/.test(out), '「未着」と断定している');
    assert.ok(!/undefined|NaN|\[object/.test(out), `描画に undefined/NaN が混ざっている: ${out.slice(0, 200)}`);
    _mb.rows = dom.buildRows({ players, extras: { ...extras, memberDevices: null }, phase: 'pre' });
    _mbPaint('pre');
    const plain = el('opsMbRows').innerHTML;
    assert.ok(/title="購読の登録あり \(届くかは未検証。疎通確認はまだ\)"[^>]*>🔔</.test(plain) && !/🔔⚠/.test(plain), '端末が分からないのに ⚠ を出している / title に余計な端末');
});


test('前日・未完のみ: 未完の行だけ描画され、名前はエスケープ、Push未購読の催促は disabled', () => {
    _mb.filter = 'todo'; _mb.sort = 'why';
    _mb.rows = dom.buildRows({ players, extras, phase: 'pre' });
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(!out.includes('<script>'), '名前が生のまま出ている');
    assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'), 'エスケープ済みの名前が出ていない');
    assert.ok(!out.includes('完了さん'), '完了の人が「未完のみ」に出ている');
    // 押せない催促はボタンにしない — 理由の札 (スマホでは title が見えない: 2026-10-29 ボタンの監査)
    assert.ok(!/handleOpsMemberNudge\(1\)/.test(out) && out.includes('🔕 通知なし'), 'Push未購読の人に押せない催促ボタンを出している / 理由の札が無い');
    assert.ok(!out.includes('handleOpsMemberProxy'), '前日に代理凸ボタンが出ている');
    assert.ok(!/undefined|NaN|\[object/.test(out), `描画に undefined/NaN が混ざっている: ${out.slice(0, 200)}`);
    assert.ok(el('opsMbSummary').innerHTML.includes('模擬 3属性 (被りなし)'), '前日の集計が出ていない');
    assert.ok(el('opsMbSummary').innerHTML.includes('5属性 '), '5属性の加点表示が無い');
    assert.equal(el('opsMbFilterTodo').textContent, '未完のみ (1)', '3属性(被りなし)の人は完了扱い');
    assert.equal(el('opsMbFilterAll').textContent, '全員 (4)');
    assert.ok(!out.includes('三属性'), '3属性で完了の人が「未完のみ」に出ている');
});

test('前日・全員: 完了の行は ✓ で出る / アバター画像は src がエスケープされる', () => {
    _mb.filter = 'all';
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(out.includes('完了さん'));
    assert.ok(out.includes('src="https://x/y.png"'));
    assert.ok(out.includes('⏳隙間型'), '隙間型の表示が無い');
    assert.ok(out.includes('class="dc-mb-blks"'), '時間のタイルが無い');
});

test('当日: 凸 L1 表示・代理バッジ・締め凸未返答・代理凸ボタン (凸3未満のみ)', () => {
    _mb.filter = 'todo';
    _mb.rows = dom.buildRows({ players, extras, phase: 'day' });
    _mbPaint('day');
    const out = el('opsMbRows').innerHTML;
    assert.ok(out.includes('<i class="d">L1</i>'), '凸の Lv が出ていない');
    assert.ok(out.includes('代理'), '代理バッジが無い');
    assert.ok(out.includes('締め凸 未返答'));
    assert.ok(out.includes('handleOpsMemberProxy(3)'), '当日の代理凸ボタンが無い');
    assert.ok(out.includes('handleOpsMemberProxy(2)'), '当日は凸0/3の人も要対応 (代理凸ボタンあり)');
    // 3凸完了の人には代理凸ボタンを出さない
    _mb.rows = dom.buildRows({ players: [P({ id: 9, name: '三凸', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, availableSlots: ['h21'], attacks: [{ level: 1 }, { level: 2 }, { level: 3 }] })], extras: { ...extras, pushPlayerIds: [9], slvThisSeasonIds: [9] }, phase: 'day' });
    _mb.filter = 'all';
    _mbPaint('day');
    const out2 = el('opsMbRows').innerHTML;
    assert.ok(!out2.includes('handleOpsMemberProxy(9)'), '3凸完了の人に代理凸ボタンが出ている');
    assert.ok(out2.includes('<i class="d">L3</i>'));
    _mb.filter = 'todo';
    _mb.rows = dom.buildRows({ players, extras, phase: 'day' });
    _mbPaint('day');
    assert.ok(el('opsMbSummary').innerHTML.includes('3凸 完了'), '当日の集計が出ていない');
    assert.ok(!/undefined|NaN/.test(out));
});

// 👥 行の時間はブロックのタイル (2026-10-31 ふるり「ホームは 5 時スタートなのに 24 時スタートで見づらい。24 時間分の点をやめて A や B のブロックに」)
const paintOne = (slots, phase = 'pre', over = {}) => {
    _mb.filter = 'all';
    _mb.rows = dom.buildRows({ players: [P({ id: 9, name: '時間さん', availableSlots: slots, ...over })], extras, phase });
    _mbPaint(phase);
    return el('opsMbRows').innerHTML;
};
const tiles = (out) => [...out.matchAll(/<i(?: class="([^"]*)")? title="([^"]*)">([^<]*)<\/i>/g)].map(m => ({ cls: m[1] || '', title: m[2], letter: m[3] }));
const tzOf = (out) => /<div class="dc-mb-tz">([^<]*)<\/div>/.exec(out)?.[1];

test('★ 行の時間: A から順 (5 時始まり) のタイル / 出られる = 紫・出られない = 無地 / 下の時刻は間が空いても分けて出す', () => {
    const out = paintOne(['h05', 'h06', 'h07', 'h08', 'h13', 'h14', 'h15', 'h16']);
    const t = tiles(out);
    assert.deepEqual(t.map(x => x.letter), ['A', 'B', 'C', 'D', 'E', 'F'], `5 時始まりの A から順でない: ${t.map(x => x.letter).join('')}`);
    assert.deepEqual(t.map(x => x.cls), ['on', '', 'on', '', '', ''], '出られるブロックの印が違う');
    assert.equal(t[0].title, 'A 朝 5〜9時', 'タイルの title がブロックの言い方でない');
    assert.equal(tzOf(out), '5〜9時・13〜17時', '間の空いた時間が「5-17時」のようにつながっている');
    assert.ok(out.includes('style="--mb-n:6;"') && out.includes('aria-label="A 朝・C 午後"'), 'タイルの数 / 読み上げの文が違う');
    assert.ok(!/undefined|NaN|\[object/.test(out), `描画に undefined/NaN が混ざっている: ${out.slice(0, 200)}`);
});
test('★ 行の時間: 1 時間刻みの古い登録はブロックの一部 (薄い紫) / 夜をまたぐ時間は 5 時始まりで読む', () => {
    const part = paintOne(['h21', 'h22']);
    const t = tiles(part);
    assert.deepEqual(t.map(x => x.cls), ['', '', '', '', 'part', ''], '一部のブロックの印が違う');
    assert.equal(t[4].title, 'E 夜 21〜翌1時 (一部 2/4 時間)', '一部の title が違う');
    assert.equal(tzOf(part), '21〜23時');
    // 0 時始まりの読み方だと「0-24時」になっていた人
    const night = paintOne(['h23', 'h00', 'h01']);
    assert.equal(tzOf(night), '23〜翌2時', `夜をまたぐ時間が 0 時始まりで読まれている: ${tzOf(night)}`);
    assert.deepEqual(tiles(night).map(x => x.cls), ['', '', '', '', 'part', 'part']);
});
test('★ 行の時間: シーズンの区切りのとおりのタイル (数・名前は escape)', () => {
    _mb.season = { metadata: { blocks: [{ name: '<b>', from: 5, to: 12 }, { name: '', from: 13, to: 4 }] } };
    try {
        const out = paintOne(['h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12']);
        const t = tiles(out);
        assert.deepEqual(t.map(x => [x.letter, x.cls]), [['A', 'on'], ['B', '']], 'シーズンのブロックの数でない');
        assert.ok(out.includes('style="--mb-n:2;"'), 'タイルの列の数がブロックの数でない');
        assert.ok(t[0].title.includes('&lt;b&gt;') && !/(title|aria-label)="[^"]*<b>/.test(out), 'ブロックの名前が escape されていない');
    } finally { _mb.season = null; }
});
test('★ 行の時間: 当日はいまのブロックに赤枠 (時計で決める)・前日は出さない / 凡例も同じブロック', () => {
    const RealDate = Date;
    globalThis.Date = class extends RealDate { getHours() { return 18; } };   // 18 時 = D (17〜21時)
    try {
        const day = paintOne(['h05', 'h17'], 'day');
        assert.deepEqual(tiles(day).map(x => x.cls), ['part', '', '', 'part now', '', ''], 'いまのブロックに赤枠が付いていない');
        assert.ok(el('opsMbLegend').innerHTML.includes('赤枠 = いまのブロック (D 夕方 17〜21時)'), '当日の凡例にいまのブロックが無い');
        const pre = paintOne(['h17'], 'pre');
        assert.ok(!tiles(pre).some(x => /now/.test(x.cls)), '前日に赤枠が出ている');
        assert.ok(el('opsMbLegend').innerHTML.includes('左が 5 時始まり') && !el('opsMbLegend').innerHTML.includes('0〜23時'), '凡例が古い (0 時始まり)');
    } finally { globalThis.Date = RealDate; }
});
test('★ 行の時間: 時間が未登録・今回は難しい の人はタイルを出さない / 24 個の点に戻さない', () => {
    const none = paintOne([]);
    assert.ok(none.includes('時間帯 未登録') && !none.includes('dc-mb-blks'), '未登録の人にタイルを出している');
    _mb.rows = dom.buildRows({ players: [P({ id: 9, name: '難しいさん', availableSlots: [] })], extras: { ...extras, availConfirmations: [{ player_id: 9, confirmed_at: '2026-09-06T00:00:00Z', unavailable: true, slot_count: 0 }] }, phase: 'pre' });
    _mbPaint('pre');
    const hard = el('opsMbRows').innerHTML;
    assert.ok(hard.includes('✋ 今回は難しい') && !hard.includes('dc-mb-blks') && !hard.includes('時間帯 未登録'), '今回は難しい の札が無い / タイルを出している');
    assert.ok(!html.includes('dc-mb-strip') && !/for \(let i = 0; i < 24; i\+\+\) cells \+= `<i class=/.test(html), '24 個の点が残っている');
});

test('行が0件のときは案内文だけ', () => {
    _mb.rows = dom.buildRows({ players: [players[1]], extras, phase: 'pre' });
    _mb.filter = 'todo';
    _mbPaint('pre');
    assert.ok(el('opsMbRows').innerHTML.includes('要対応のメンバーはいません'));
});

// ---- 非同期の世代制御 (renderOpsMemberStatus) ----
// 「シーズンあり → 取得待ち中にシーズン無し / 別シーズンへ切替」で古い応答が盤面を復活させないこと
globalThis._opsMode = true;
// opsStore スタブ: get()/load() を分け、世代 (generation/isCurrentGeneration/invalidate) も本物と同じ契約で持つ
let storeData = null, loadData = null, loadCalls = 0, storeGen = 0;
globalThis.opsStore = {
    get: () => storeData,
    load: async () => { loadCalls++; storeGen++; storeData = loadData; return loadData; },
    generation: () => storeGen,
    isCurrentGeneration: (g) => g === storeGen,
    invalidate: () => { storeGen++; storeData = null; },
};
let pendingResolvers = [];
globalThis.supabaseLoadMemberStatusExtras = () => new Promise(res => pendingResolvers.push(res));
const _mbCurrentPhase = eval(`(${extract('        function _mbCurrentPhase(').trim()})`);
const _mbRebuild = eval(`(${extract('        function _mbRebuild(').trim()})`);
globalThis._mbCurrentPhase = _mbCurrentPhase; globalThis._mbRebuild = _mbRebuild; globalThis._mbPaint = _mbPaint;
const renderOpsMemberStatus = eval(`(${extract('        async function renderOpsMemberStatus(').trim()})`);

async function testAsync(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}
await testAsync('世代制御: 取得待ち中に「シーズン無し」へ遷移したら、古い応答は盤面を復活させない', async () => {
    Object.assign(_mb, { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snapA = { season: { id: 26, hard_date: '2026-08-01' }, players };
    const pA = renderOpsMemberStatus(snapA);            // 取得開始 (待機)
    assert.equal(pendingResolvers.length, 1);
    await renderOpsMemberStatus({ season: null, players: [] });   // シーズン無しへ
    assert.ok(el('opsMbRows').innerHTML.includes('アクティブシーズンがありません'));
    pendingResolvers.shift()(extras);                    // 古い応答が遅れて到着
    await pA;
    assert.ok(el('opsMbRows').innerHTML.includes('アクティブシーズンがありません'), '古い応答で旧盤面が復活している');
    assert.equal(_mb.rows.length, 0);
    assert.equal(_mb.season, null);
});
await testAsync('世代制御: 別シーズンへの切替中に届いた前シーズンの応答は捨て、新シーズンの応答だけ採用', async () => {
    Object.assign(_mb, { phase: 'day', filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, gen: 0 });
    const pOld = renderOpsMemberStatus({ season: { id: 26, hard_date: '2026-08-01' }, players });
    const pNew = renderOpsMemberStatus({ season: { id: 30, hard_date: '2026-09-05' }, players: [players[1]] });
    assert.equal(pendingResolvers.length, 2);
    const [resOld, resNew] = pendingResolvers.splice(0, 2);
    resNew(extras); await pNew;
    assert.equal(_mb.season.id, 30);
    assert.equal(_mb.rows.length, 1, '新シーズンの players で組み立てられている');
    resOld(extras); await pOld;
    assert.equal(_mb.season.id, 30, '古い応答で前シーズンに戻っている');
    assert.equal(_mb.rows.length, 1);
});
await testAsync('snapshot 無し (invalidate 直後) は opsStore.load() を待ってから描く — null を「シーズン無し」と誤認しない', async () => {
    Object.assign(_mb, { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, gen: 0 });
    storeData = null;                                              // invalidate 直後: get() は null
    loadData = { season: { id: 30, hard_date: '2026-09-05' }, players };
    loadCalls = 0;
    const p = renderOpsMemberStatus(null, true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(loadCalls, 1, 'opsStore.load() を1回呼ぶ');
    assert.equal(pendingResolvers.length, 1, 'load() 後に extras を取りに行く');
    pendingResolvers.shift()(extras); await p;
    assert.equal(_mb.season.id, 30);
    assert.ok(!el('opsMbRows').innerHTML.includes('アクティブシーズンがありません'));
});
await testAsync('extras 待機中に opsStore.invalidate() (凸登録等) が走ったら、その応答は採用しない', async () => {
    Object.assign(_mb, { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snap = { season: { id: 30, hard_date: '2026-09-05' }, players };
    storeData = snap;
    const p = renderOpsMemberStatus(snap);
    assert.equal(pendingResolvers.length, 1);
    opsStore.invalidate();                                         // 盤面が書き換わった
    pendingResolvers.shift()(extras); await p;
    assert.equal(_mb.rows.length, 0, '古い盤面の応答で行が組み立てられている');
    assert.equal(_mb.season, null);
});
// toggleOpsMode 本体を切り出して実行 (OFF 側で _mb.gen を進める実装そのものを検証する)
globalThis._applyOpsMode = () => {};
// 運営モードは名乗っている人ごとに覚える (2026-09-10)。ここでは記憶そのものは対象外なので黙らせる
globalThis._rememberOpsMode = () => {};
globalThis.showNotification = () => {};
globalThis._applyOpsCardStates = () => {};      // 戦況タブの折りたたみ (toggleOpsMode が呼ぶ。ここでは対象外)
globalThis._renderOpsCockpitSoon = () => {};
globalThis.showNotification = () => {};
globalThis._invalidateTabRenderCache = () => {};
globalThis.renderOpsMemberStatus = renderOpsMemberStatus;
// ★ 後始末は _afterOpsModeChanged に切り出されている (toggle と身元切替で同じ道を通すため)。
//   OFF 側で _mb.gen を進めるのはそちら側なので、両方を取り込む
globalThis._afterOpsModeChanged = eval(`(${extract('        function _afterOpsModeChanged(').trim()})`);
const toggleOpsMode = eval(`(${extract('        function toggleOpsMode(').trim()})`);
await testAsync('extras 待機中に toggleOpsMode() で運営OFF になったら、隠れた盤面を更新しない (ON に戻すときは世代を進めない)', async () => {
    Object.assign(_mb, { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snap = { season: { id: 30, hard_date: '2026-09-05' }, players };
    storeData = snap;
    globalThis._opsMode = true;
    const p = renderOpsMemberStatus(snap);
    const genBefore = _mb.gen;
    toggleOpsMode();                                               // ON → OFF
    assert.equal(globalThis._opsMode, false);
    assert.equal(_mb.gen, genBefore + 1, 'OFF で世代が進んでいない');
    pendingResolvers.shift()(extras); await p;
    assert.equal(_mb.rows.length, 0, 'OFF 中に届いた応答で盤面が更新されている');
    const genOff = _mb.gen;
    toggleOpsMode();                                               // OFF → ON (tab-ops 非アクティブなので再取得は走らない)
    assert.equal(globalThis._opsMode, true);
    assert.equal(_mb.gen, genOff, 'ON に戻すときに世代を進めてはいけない');
});
await testAsync('extras が失敗しても、待機中に invalidate されていたらエラー表示すら出さない', async () => {
    Object.assign(_mb, { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snap = { season: { id: 30, hard_date: '2026-09-05' }, players };
    storeData = snap;
    el('opsMbRows').innerHTML = 'KEEP';
    const origExtras = globalThis.supabaseLoadMemberStatusExtras;
    let rejecter = null;
    globalThis.supabaseLoadMemberStatusExtras = () => new Promise((_, rej) => { rejecter = rej; });
    const p = renderOpsMemberStatus(snap);
    opsStore.invalidate();
    rejecter(new Error('boom')); await p;
    globalThis.supabaseLoadMemberStatusExtras = origExtras;
    assert.ok(!el('opsMbRows').innerHTML.includes('読み込みエラー'), '古い失敗応答でエラーが描画されている');
});
await testAsync('opsStore.load() が失敗したら「取得に失敗」を出し、既存の行は消さない (シーズン無し扱いにしない)', async () => {
    Object.assign(_mb, { phase: null, filter: 'todo', sort: 'why', rows: [{ id: 1 }], players, extras, season: { id: 30 }, gen: 0 });
    storeData = null;
    const origLoad = opsStore.load;
    opsStore.load = async () => { throw new Error('network down'); };
    await renderOpsMemberStatus(null, true);
    opsStore.load = origLoad;
    assert.ok(el('opsMbRows').innerHTML.includes('取得に失敗'), '失敗表示が無い');
    assert.ok(!el('opsMbRows').innerHTML.includes('アクティブシーズンがありません'));
    assert.equal(_mb.rows.length, 1, '既存の行が消されている');
});

// ---- 全体監査 2026-09-14 #4: 一部の取得に失敗しても「全員未登録」を描かず、「?」と見出しの警告を出す ----
await testAsync('extras の一部が null (取得失敗) でも描画は壊れず、該当欄は「?」・見出しに「取得できませんでした」', async () => {
    Object.assign(_mb, { phase: 'pre', filter: 'all', sort: 'name', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snap = { season: { id: 30, hard_date: '2026-09-05', current_level: 1 }, players };
    storeData = snap;
    const origExtras = globalThis.supabaseLoadMemberStatusExtras;
    globalThis.supabaseLoadMemberStatusExtras = async () => ({ pushPlayerIds: null, slvThisSeasonIds: null, finishRequests: null, proxyEvents: [], availConfirmations: [] });
    await renderOpsMemberStatus(snap, true);
    globalThis.supabaseLoadMemberStatusExtras = origExtras;
    const rows = el('opsMbRows').innerHTML;
    assert.ok(rows.includes('SLv ?'), 'SLv が分からないのに「SLv —」(未登録) を描いている');
    assert.ok(rows.includes('🔔?'), 'Push が分からないのに 🔕 (未購読) を描いている');
    assert.ok(!rows.includes('🔕'), '「未購読」の印が出ている');
    assert.ok(!rows.includes('SLv —'), '「SLv —」(未登録) が出ている');
    assert.ok(!rows.includes('undefined') && !rows.includes('NaN'));
    assert.ok(el('opsMbUpdated').textContent.includes('取得できませんでした'), '見出しに警告が無い');
    assert.ok(/Push・SLv・締め凸/.test(el('opsMbUpdated').textContent), '失敗した項目名が並んでいない');
    assert.ok(el('opsMbSummary').innerHTML.includes('取得失敗'), '集計に「取得失敗」が無い (0/4 と出ると全員未登録に見える)');
    // 当日も同じ (締め凸 ?)
    _mb.phase = 'day'; _mbRebuild();
    assert.ok(el('opsMbRows').innerHTML.includes('締め凸 ?'), '当日の締め凸の欄が「?」でない');
});
await testAsync('extras が全部そろっていれば従来どおり (未購読は 🔕・見出しに警告なし)', async () => {
    Object.assign(_mb, { phase: 'pre', filter: 'all', sort: 'name', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snap = { season: { id: 30, hard_date: '2026-09-05', current_level: 1 }, players };
    storeData = snap;
    const origExtras = globalThis.supabaseLoadMemberStatusExtras;
    globalThis.supabaseLoadMemberStatusExtras = async () => ({ pushPlayerIds: [2], slvThisSeasonIds: [2, 3, 4], finishRequests: [], proxyEvents: [], availConfirmations: [] });
    await renderOpsMemberStatus(snap, true);
    globalThis.supabaseLoadMemberStatusExtras = origExtras;
    assert.ok(el('opsMbRows').innerHTML.includes('🔕'), '本当に未購読の人に 🔕 が出ない');
    assert.ok(!el('opsMbRows').innerHTML.includes('🔔?'));
    assert.ok(!el('opsMbUpdated').textContent.includes('取得できませんでした'));
});

// 🔔 通知の疎通確認 (2026-10-07): 届いた = 🔔✓ / 送ったがまだ = 🔔 未確認 / 送る前 = 🔔 のまま / 購読なし = 🔕 (未確認とは言わない)
await testAsync('疎通確認: 通知のセルに 届いた・未確認 が出る / 集計に「通知 届いた」/ 送る前はこれまでどおり', async () => {
    Object.assign(_mb, { phase: 'pre', filter: 'all', sort: 'name', rows: [], players: null, extras: null, season: null, gen: 0 });
    const snap = { season: { id: 30, hard_date: '2026-09-05', current_level: 1 }, players };
    storeData = snap;
    const origExtras = globalThis.supabaseLoadMemberStatusExtras;
    const base = { pushPlayerIds: [2, 3], slvThisSeasonIds: [2, 3, 4], finishRequests: [], proxyEvents: [], availConfirmations: [] };
    globalThis.supabaseLoadMemberStatusExtras = async () => ({ ...base, pushCheck: { sentAt: '2026-09-03T03:00:00Z', confirmed: [{ player_id: 2, at: '2026-09-03T03:05:00Z' }] } });
    await renderOpsMemberStatus(snap, true);
    let rows = el('opsMbRows').innerHTML;
    assert.equal((rows.match(/🔔✓/g) || []).length, 1, '届いた人に ✓ が出ない');
    assert.equal((rows.match(/🔔 未確認/g) || []).length, 1, '送ったがまだの人が「未確認」にならない (購読なしの人まで数えていないか)');
    assert.ok(rows.includes('🔕'), '購読なしの人が 🔕 でない');
    assert.ok(el('opsMbSummary').innerHTML.includes('通知 届いた'), '集計に疎通確認が出ない');
    // 送る前: 印は増えない・集計にも出さない (0/n と出すと「誰にも届いていない」に見える)
    globalThis.supabaseLoadMemberStatusExtras = async () => ({ ...base, pushCheck: { sentAt: null, confirmed: [] } });
    await renderOpsMemberStatus(snap, true);
    rows = el('opsMbRows').innerHTML;
    assert.ok(!rows.includes('🔔✓') && !rows.includes('🔔 未確認') && !rows.includes('通知 未確認'), '送る前から 届いた・未確認 を出している');
    assert.ok(!el('opsMbSummary').innerHTML.includes('通知 届いた'));
    globalThis.supabaseLoadMemberStatusExtras = origExtras;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
