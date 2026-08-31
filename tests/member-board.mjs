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
const extras = { pushPlayerIds: [2, 3, 4], slvThisSeasonIds: [2, 3, 4], finishRequests: [{ player_id: 3, status: 'pending' }], proxyEvents: [{ player_id: 3 }] };

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}
console.log('member-board (_mbPaint):');

test('前日・未完のみ: 未完の行だけ描画され、名前はエスケープ、Push未購読の催促は disabled', () => {
    _mb.filter = 'todo'; _mb.sort = 'why';
    _mb.rows = dom.buildRows({ players, extras, phase: 'pre' });
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(!out.includes('<script>'), '名前が生のまま出ている');
    assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'), 'エスケープ済みの名前が出ていない');
    assert.ok(!out.includes('完了さん'), '完了の人が「未完のみ」に出ている');
    assert.ok(/handleOpsMemberNudge\(1\)[^>]*disabled/.test(out), 'Push未購読の催促ボタンが disabled になっていない');
    assert.ok(!out.includes('handleOpsMemberProxy'), '前日に代理凸ボタンが出ている');
    assert.ok(!/undefined|NaN|\[object/.test(out), `描画に undefined/NaN が混ざっている: ${out.slice(0, 200)}`);
    assert.ok(el('opsMbSummary').innerHTML.includes('模擬 3属性 (被りなし)'), '前日の集計が出ていない');
    assert.ok(el('opsMbSummary').innerHTML.includes('5属性 '), '5属性の加点表示が無い');
    assert.equal(el('opsMbFilterTodo').textContent, '未完のみ (1)', '3属性(被りなし)の人は完了扱い');
    assert.equal(el('opsMbFilterAll').textContent, '全員 (4)');
    assert.ok(!out.includes('三属性'), '3属性で完了の人が「未完のみ」に出ている');
    assert.equal(el('opsMbPhasePre').attrs['aria-pressed'], 'true');
});

test('前日・全員: 完了の行は ✓ で出る / アバター画像は src がエスケープされる', () => {
    _mb.filter = 'all';
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(out.includes('完了さん'));
    assert.ok(out.includes('src="https://x/y.png"'));
    assert.ok(out.includes('⏳隙間型'), '隙間型の表示が無い');
    assert.ok(out.includes('dc-mb-strip'), '時間帯バーが無い');
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
    assert.equal(el('opsMbPhaseDay').attrs['aria-pressed'], 'true');
    assert.ok(!/undefined|NaN/.test(out));
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
globalThis._applyOpsCardStates = () => {};      // 戦況タブの折りたたみ (toggleOpsMode が呼ぶ。ここでは対象外)
globalThis._renderOpsCockpitSoon = () => {};
globalThis.showNotification = () => {};
globalThis._invalidateTabRenderCache = () => {};
globalThis.renderOpsMemberStatus = renderOpsMemberStatus;
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
