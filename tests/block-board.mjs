// ============================================================================
// 🧱 ブロック盤 (段階 6) の実行テスト
//   node tests/block-board.mjs
// ----------------------------------------------------------------------------
// index.html から 盤の描画 (_planBlockBoardHtml)・候補を押す (_opsBoardCandPlace)・手順の帯 (_renderOpsBlockSteps / _opsBlockStepGo)・
// メンバーの「🧱 盤」(_myPlanBoardHtml) を切り出し、依存をスタブして**実際に走らせる**。判定は js/domain/planBoard.js の本物。
// テンプレートの中の未定義参照は実行しないと出ないので、運営の盤とメンバーの盤の両方を描いて undefined / NaN が無いことも見る。
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import '../js/domain/planBoard.js';      // globalThis.planBoardDomain
import '../js/domain/opsLayout.js';      // globalThis.opsLayoutDomain (HP の鮮度)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
function cutFn(marker) {
    const i = html.indexOf(marker);
    if (i < 0 || html.indexOf(marker, i + 1) >= 0) { console.error(`NG: ${marker} を 1 か所に特定できません`); process.exit(2); }
    const j = html.indexOf('\n        }\n', i);
    return html.slice(i, j + 10);
}
function cutConst(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} が見つかりません`); process.exit(2); }
    return html.slice(i, html.indexOf(';\n', i) + 1);
}
const SRC = [
    html.includes('        let _opsBoardCands = [];') ? 'let _opsBoardCands = [];' : (console.error('NG: _opsBoardCands が見つかりません'), process.exit(2)),
    cutConst('        const _BB_FILL = {'),
    cutFn('        function _planBlockBoardHtml(plan, opts = {}) {'),
    cutFn('        function _opsBoardCandPlace(ri, k) {'),
    cutFn('        function _renderOpsBlockSteps() {'),
    cutFn('        function _opsBlockStepGo(key) {'),
    cutFn('        function _myPlanBoardHtml(plan, viewerId) {'),
].join('\n');

const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
const hourLabel = (idx) => { const h = HOUR_ORDER[idx]; return (h >= 0 && h <= 4) ? `翌${h}時` : `${h}時`; };
const BOSSES = [{ boss_number: 3, attribute: 'wind', weakness: 'fire', updated_at: null }, { boss_number: 4, attribute: 'electric', weakness: 'iron', updated_at: null }];
const PLAN = {
    seasonId: 45, startLevel: 2, currentSlot: 'h18',
    blockScope: { idx: 4, name: '夕方', label: '夕方 18〜20時', from: 18, to: 20 },
    levels: [{ level: 2, bosses: [
        { bossNumber: 3, name: 'アネモイ', attribute: 'wind', weakness: 'fire', targetHpB: 60, attacks: [
            { memberId: 7, memberName: 'あお', dmgB: 30, hourIdx: 14, hourLabel: '19時', loadoutSlot: 1 },
            { memberId: 8, memberName: 'きい', dmgB: 35, hourIdx: 13, hourLabel: '18時', loadoutSlot: 1, pinned: true, fromReservation: true, reservationId: 51 }] },
        { bossNumber: 4, name: 'ゼウス', attribute: 'electric', weakness: 'iron', targetHpB: 50, attacks: [
            { memberId: 9, memberName: 'あか', dmgB: 20, hourIdx: 15, hourLabel: '20時', loadoutSlot: 2, fromReservation: true, reservationId: 52 }] }] }],
};
const PLAYERS = [
    { id: 7, name: 'あお', attackCount: 0, availableSlots: ['h18', 'h19'], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 30 }] } },
    { id: 8, name: 'きい', attackCount: 0, availableSlots: ['h18'], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 35 }] } },
    { id: 9, name: 'あか', attackCount: 0, availableSlots: ['h20'], loadoutsByAttr: { iron: [{ slot: 2, dmgB: 20 }] } },
    { id: 11, name: 'ひ', attackCount: 0, availableSlots: ['h19', 'h20'], loadoutsByAttr: { iron: [{ slot: 1, dmgB: 34, team: [] }] } },
];

function makeEnv({ opsMode = true, sel = null, lastPlan = PLAN, pub = null, missing = 2, hpAt = null, nowIdx = 13, countsSeason = 45 } = {}) {
    const calls = [];
    const els = new Map();
    const el = (id) => { if (!els.has(id)) els.set(id, { id, innerHTML: '', style: {}, scrollIntoView() { calls.push(['scroll', id]); } }); return els.get(id); };
    const snap = { season: { id: 45 }, players: PLAYERS, bosses: BOSSES.map(b => ({ ...b, updated_at: hpAt })) };
    const env = {
        window: { planBoardDomain: globalThis.planBoardDomain, opsLayoutDomain: globalThis.opsLayoutDomain, reservationsDomain: null },
        document: { getElementById: el },
        requestAnimationFrame: (f) => f(),
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        HOUR_ORDER, PT_ATTRS: [{ key: 'fire', name: '灼熱' }, { key: 'iron', name: '鉄甲' }], DC_ATTR_COLORS: { wind: '#18C26B', electric: '#9B4DFF' },
        _planNowIdx: () => nowIdx, _planHourHeadLabel: hourLabel, _hhmm: () => '18:05',
        opsStore: { get: () => snap },
        _resv: { rows: [] },
        _opsMode: opsMode, _opsPlanSel: sel, _opsPlanFocus: null, _opsPlanDragOk: () => true,
        _opsPlanPlace: (b, h) => { calls.push(['place', b, h]); },
        _opsLastPlan: lastPlan, _opsPublishedPlan: pub,
        _atkCheck: { counts: missing == null ? null : { seasonId: countsSeason, missing } },
        _opsPlanBlock: () => ({ name: '夕方', label: '夕方 18〜20時', from: 18, to: 20 }),
        _opsStageAct: (k) => calls.push(['stage', k]), _opsJump: (id) => calls.push(['jump', id]),
        calls, el,
    };
    const keys = Object.keys(env).filter(k => !['calls', 'el', '_opsPlanSel'].includes(k));
    // _opsPlanSel / _opsPlanFocus は書き換えられるので let で持つ
    const fns = new Function(...keys, 'initialSel', `let _opsPlanSel = initialSel;\n${SRC}\nreturn { _planBlockBoardHtml, _opsBoardCandPlace, _renderOpsBlockSteps, _opsBlockStepGo, _myPlanBoardHtml, sel: () => _opsPlanSel, cands: () => _opsBoardCands };`)(...keys.map(k => env[k]), sel);
    return Object.assign(env, fns);
}

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
console.log('🧱 ブロック盤:\n');

await test('★ 運営の盤: ボスの行・枠・ピース (時間割と同じ札・🔒 はつかめない)・あと ◯B・時刻のマス・候補 が実際に描ける', () => {
    const t = makeEnv();
    const out = t._planBlockBoardHtml(PLAN, { ops: true });
    assert.ok(!/undefined|NaN/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN).{40}/)?.[0]}`);
    assert.equal((out.match(/class="bb-row/g) || []).length, 2);
    assert.ok(/撃破 ✓ 19時 · 余り 5\.0B/.test(out), 'B3 の撃破 (時刻の順に足して届いた 19時) / 余りが無い');
    assert.ok(/あと 30\.0B/.test(out), 'B4 のあと ◯B が無い');
    assert.ok(/data-member="8" data-slot="1" data-attr="fire" data-resv="51" data-pinned="1" data-promise="0" draggable="true"/.test(out), '📌 のピースの札が違う (つかめるはず)');
    assert.ok(/data-member="9" data-slot="2" data-attr="iron" data-resv="52" data-pinned="0" data-promise="1" draggable="false"/.test(out), '🔒 のピースをつかめる');
    assert.ok(/data-boss="4" data-h="13"/.test(out) && /data-boss="4" data-h="15"/.test(out) && !/data-h="12"/.test(out), '時刻のマスがブロック (いまより後) でない');
    assert.ok(/onclick="_opsBoardCandPlace\(1, 0\)"/.test(out) && /ひ 鉄甲 34\.0B · 19時/.test(out) && /撃破 ✓ · 余り 4\.0B · 残凸 3/.test(out), 'B4 の候補が無い / 中身が違う');
    assert.ok(!/onclick="[^"]*ひ/.test(out), '名前を onclick に埋めている');
    // いまが 19 時なら 18 時のマスは出さない (過ぎた時刻に置かない)
    const later = makeEnv({ nowIdx: 14 })._planBlockBoardHtml(PLAN, { ops: true });
    assert.ok(!/data-h="13"/.test(later) && /data-boss="4" data-h="14"/.test(later), 'いまより前の時刻をマスにした');
    assert.ok(/var\(--attr-fire-solid\)/.test(out) && /var\(--attr-iron-ink\)/.test(out), 'ピースの色がトークンでない');
});

await test('★ 候補を押す = その模擬ピースを選んで、その時刻に置く (置く関数は時間割と同じ)', () => {
    const t = makeEnv();
    t._planBlockBoardHtml(PLAN, { ops: true });
    t._opsBoardCandPlace(1, 0);
    assert.deepEqual(t.sel(), { kind: 'piece', memberId: 11, loadoutSlot: 1, attr: 'iron', reservationId: null, pinned: false });
    assert.deepEqual(t.calls.find(c => c[0] === 'place'), ['place', 4, 14]);
    t._opsBoardCandPlace(5, 0);   // 無い候補
    assert.equal(t.calls.filter(c => c[0] === 'place').length, 1);
});

await test('選んだ駒が置けるマスに印 (属性と出られる時間)', () => {
    const t = makeEnv({ sel: { kind: 'piece', memberId: 11, loadoutSlot: 1, attr: 'iron' } });
    const out = t._planBlockBoardHtml(PLAN, { ops: true });
    assert.ok(/class="bb-cell can" data-boss="4" data-h="14" data-can="1"/.test(out), '置けるマスに印が無い');
    assert.ok(/class="bb-cell" data-boss="4" data-h="13" data-can="0"/.test(out), '出られない時間に印を付けた');
    assert.ok(/class="bb-cell" data-boss="3" data-h="14" data-can="0"/.test(out), '属性の違うボスに印を付けた');
});

await test('★ メンバーの盤: 読み取り専用 (札・時刻のマス・候補なし) / あなたの凸に印 / 説明', () => {
    const t = makeEnv({ opsMode: false });
    const out = t._myPlanBoardHtml(PLAN, 7);
    assert.ok(!/undefined|NaN/.test(out));
    assert.ok(/夕方 18〜20時 に出られる人の模擬を/.test(out), '説明が無い');
    assert.ok(!/data-member=|data-boss=|_opsBoardCandPlace/.test(out), 'メンバーの盤に操作の札がある');
    assert.ok(/bb-piece bb-auto mine/.test(out), 'あなたの凸に印が無い');
});

await test('★ 手順の帯: いまの手順を光らせ、未解決の「あと ◯B」と最終配信を出す / 押すとその作業へ', () => {
    const t = makeEnv({ missing: 2, pub: { season_id: 45, published_at: 'x', published_by_name: 'ふるり', plan: { blockScope: { name: '昼', from: 12, to: 14 } } } });
    t._renderOpsBlockSteps();
    const out = t.el('opsBlockSteps').innerHTML;
    assert.ok(!/undefined|NaN/.test(out));
    assert.ok(/夕方 18〜20時 の手順/.test(out) && /未解決: B4 あと 30\.0B/.test(out) && /最終配信 18:05 · ふるり \(昼\)/.test(out), '見出しが違う');
    assert.ok(/class="bs-step cur" onclick="_opsBlockStepGo\('hp'\)"/.test(out), 'HP が古い (不明) のに HP を光らせていない');
    assert.ok(/class="bs-step done" onclick="_opsBlockStepGo\('build'\)"/.test(out), 'このブロックで組んだのに済にしていない');
    assert.ok(/結果がまだ 2 凸/.test(out));
    assert.ok(/class="bs-step" onclick="_opsBlockStepGo\('publish'\)"/.test(out), '別のブロック (昼) の配信で、夕方の配信を済にした');
    const other = makeEnv({ missing: 0, countsSeason: 44 });
    other._renderOpsBlockSteps();
    assert.ok(/class="bs-step" onclick="_opsBlockStepGo\('result'\)"/.test(other.el('opsBlockSteps').innerHTML) && /⚔️ 戦況の結果の取り込み/.test(other.el('opsBlockSteps').innerHTML), '別シーズンの結果の数で済にした');
    const fresh = makeEnv({ missing: 0, hpAt: new Date().toISOString(), pub: { season_id: 45, plan: { blockScope: { name: '夕方', from: 18, to: 20 } } } });
    fresh._renderOpsBlockSteps();
    assert.ok(/class="bs-step done" onclick="_opsBlockStepGo\('publish'\)"/.test(fresh.el('opsBlockSteps').innerHTML), 'このブロックを配信したのに済にしていない');
    // 押す
    t._opsBlockStepGo('hp'); t._opsBlockStepGo('result'); t._opsBlockStepGo('publish');
    assert.deepEqual(t.calls.filter(c => c[0] !== 'scroll'), [['stage', 'hp'], ['jump', 'opsSecAttackCheck'], ['jump', 'opsSecPlan']]);
    // 運営でない・シーズンが無い → 出さない
    const off = makeEnv({ opsMode: false });
    off._renderOpsBlockSteps();
    assert.equal(off.el('opsBlockSteps').style.display, 'none');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
