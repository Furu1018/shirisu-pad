// ============================================================================
// 本人のホーム「あなたの3凸」(3枠) の実行テスト
//   node tests/home-slots.mjs
// ----------------------------------------------------------------------------
// index.html から _homeSlotsNow / _homeSlotCardHtml / _heroPlanStripHtml / _planMineHtml を
// 切り出し、依存をスタブして**実際に実行**する。枠の組み立ては js/domain/reservations.js
// (homeSlots) の本物を使う。
//
// なぜ要るか: テンプレートリテラルの中の未定義参照は実行しないと出ない (2026-09-07 の本番障害:
// 模擬タブの提出カードが1枚も出なかった)。ホームの3枠は 2026-09-08 に大きく描き直したので、
// 「予約で固定 / 配信の割当 / 空き枠 (理由つき)」の3種類がそれぞれ描けることを実際に走らせて見る。
//
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import '../js/domain/reservations.js';   // globalThis.reservationsDomain (本物の homeSlots を使う)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const rv = globalThis.reservationsDomain;

// 波括弧の対応で終端を決める。★ 引数のデフォルト値を本体と誤認しないよう `)` を先に探す
function cut(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} を切り出せません (目印が変わった?)`); process.exit(2); }
    let paren = 0, bodyStart = -1;
    for (let k = html.indexOf('(', i); k < html.length; k++) {
        if (html[k] === '(') paren++;
        else if (html[k] === ')') { paren--; if (!paren) { bodyStart = html.indexOf('{', k); break; } }
    }
    let d = 0, inStr = null, prev = '';
    for (let k = bodyStart; k < html.length; k++) {
        const ch = html[k];
        if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; }
        else if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '{') d++;
        else if (ch === '}') { d--; if (!d) return html.slice(i, k + 1); }
        prev = ch;
    }
    console.error(`NG: ${marker} の終端を判定できません`); process.exit(2);
}

const SRC = [
    '        function _homeSlotsNow(identity)',
    '        function _homeSlotsKey(h)',
    '        function _homeStaleBannerHtml(h, onHero)',
    '        function _homeSlotCardHtml(slot, i, hero)',
    '        function _homeGotoResvCard()',
    '        function _heroPlanStripHtml(identity, hero)',
    '        function _planMineHtml(plan, viewerId, doneCounts, liveLevel)',
].map(cut).join('\n');

const ATTRS = [
    { key: 'fire', name: '灼熱' }, { key: 'water', name: '水冷' }, { key: 'electric', name: '電撃' },
    { key: 'iron', name: '鉄甲' }, { key: 'wind', name: '風圧' },
];
const BOSSES = [
    { boss_number: 1, name: 'ボス1', attribute: 'water', weakness: 'fire', remaining_hp_raw: 1e11 },
    { boss_number: 3, name: 'ボス3', attribute: 'electric', weakness: 'water', remaining_hp_raw: 1e11 },
];
const plan = (attacks, unassigned = []) => ({
    startLevel: 2,
    levels: [{ level: 2, bosses: [{ bossNumber: 3, name: 'ボス3', attribute: 'electric', weakness: 'water',
        attacks: attacks.map(a => ({ memberId: 7, loadoutSlot: 1, hourIdx: 8, hourLabel: '13時', team: ['a', 'b', 'c', 'd', 'e'], dmgB: 30, ...a })) }] }],
    unassigned,
});
const resv = (o = {}) => ({
    id: o.id ?? 1, season_id: 1, player_id: 7, raid_level: null, boss_number: o.boss ?? 3,
    time_mode: o.flex ? 'flex' : 'fixed', time_slot: o.flex ? null : (o.slot ?? 'h21'),
    loadout_slot: o.lo ?? 1, characters_snapshot: ['a', 'b', 'c', 'd', 'e'], expected_damage_b: 30,
    status: o.status ?? 'approved', approved_at: 'x', approved_by: '運営A',
});

function run({ pub = null, rows = [], today = null } = {}) {
    const env = {
        window: { reservationsDomain: rv },
        document: { getElementById: () => null },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        DC_ATTR_COLORS: Object.fromEntries(ATTRS.map(a => [a.key, '#123456'])),
        DC_ATTR_ICONS: Object.fromEntries(ATTRS.map(a => [a.key, `${a.key}.png`])),
        PT_ATTRS: ATTRS, SLOT_JP: { 1: '①', 2: '②' },
        resolveNikkeChar: (n) => ({ canonical: n, iconPath: 'i.png' }),
        renderTeamSnippet: (team) => `<i class="team">${team.join(',')}</i>`,
        _seasonBossesForResv: () => BOSSES,
        _planRowResvHtml: () => '<span class="claim">引き受ける</span>',
        openMyResvRequest: () => { }, renderMyNextAction: () => { },
        _myPubState: pub ? { plan: pub, viewerId: 7, doneCounts: new Map(), todayAttacks: today ?? 0 } : null,
        _myResvRows: rows,
        _myTodayAttacksCache: today == null ? null : Array.from({ length: today }).map(() => ({})),
        _heroPlanKey: '',
    };
    const keys = Object.keys(env);
    const fns = new Function(...keys, `${SRC}\nreturn { strip: _heroPlanStripHtml, mine: _planMineHtml, card: _homeSlotCardHtml, now: _homeSlotsNow };`)(...keys.map(k => env[k]));
    return fns;
}

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}

console.log('ホームの3枠 (あなたの3凸):\n');

await test('★ 予約で固定 + 配信の割当 + 空き枠 (理由つき) の3枚が実際に描ける', () => {
    const t = run({
        pub: plan([{ reservationId: 1, hourIdx: 16, hourLabel: '21時' }, { loadoutSlot: 2, hourIdx: 4, hourLabel: '9時', team: ['f', 'g', 'h', 'i', 'j'] }],
                  [{ memberId: 7, reason: 'char_conflict' }]),
        rows: [resv({ id: 1 })],
    });
    const out = t.strip({ id: 7 }, true);
    assert.equal((out.match(/dc-plan-card/g) || []).length, 3, `3枚出ていない: ${out.slice(0, 300)}`);
    assert.ok(/dc-plan-card fixed/.test(out), '予約で固定のカードが無い');
    assert.ok(/🔒 予約</.test(out), '錠前が無い');
    assert.ok(/21時/.test(out), '予約の時刻が出ていない');
    assert.ok(/dc-plan-card empty/.test(out), '空き枠が無い');
    assert.ok(out.includes('ほかの凸とキャラが被って、使える編成が残っていません'), '空き枠の理由 (日本語) が無い');
    assert.ok(/openMyResvRequest\(\)/.test(out), '空き枠から申請できない');
    assert.ok(/on-hero/.test(out), '黒ヒーロー用の見た目になっていない');
    assert.ok(!/運営が組み直し中/.test(out), '配信が予約を知っているのに組み直し中と出ている');
    assert.ok(!/undefined|NaN/.test(out), `未定義参照が混ざっている: ${out.match(/.{40}(undefined|NaN).{40}/)?.[0]}`);
});

await test('★ 配信が予約を知らない → 「運営が組み直し中」の帯 + 予約は「組み直し待ち」', () => {
    const t = run({ pub: plan([{ loadoutSlot: 1 }]), rows: [resv({ id: 9, lo: 2 })] });
    const out = t.strip({ id: 7 }, false);
    assert.ok(/運営が組み直し中です/.test(out), '帯が無い');
    assert.ok(/組み直し待ち/.test(out), '配信に入っていない予約を区別していない');
    assert.ok(!/on-hero/.test(out));
});

await test('配信が無くても、予約が読めていれば3枠を出す (空きは「運営の算出待ち」)', () => {
    const t = run({ pub: null, rows: [] });
    const out = t.strip({ id: 7 }, true);
    assert.equal((out.match(/dc-plan-card empty/g) || []).length, 3);
    assert.ok(out.includes('運営の算出待ちです'));
});

await test('39未適用 (予約が読めない) で配信も無ければ何も出さない (従来どおり)', () => {
    const t = run({ pub: null, rows: null });
    assert.equal(t.strip({ id: 7 }, true), '');
});

await test('プラン外の実凸は枠を消費して「報告済み」になる', () => {
    const t = run({ pub: plan([{}]), rows: [], today: 2 });
    const out = t.strip({ id: 7 }, false);
    assert.equal((out.match(/dc-plan-card done/g) || []).length, 2, `報告済みの枠が2つ出ていない: ${out.slice(0, 200)}`);
});

await test('★ 「わたしの凸」一覧も同じ3枠 (予約の行に取り消し希望 / 配信の行に引き受ける / 空き枠に申請)', () => {
    const t = run({
        pub: plan([{ reservationId: 1, hourIdx: 16, hourLabel: '21時' }, { loadoutSlot: 2, team: ['f', 'g', 'h', 'i', 'j'] }], [{ memberId: 7, reason: 'time' }]),
        rows: [resv({ id: 1 })],
    });
    const out = t.mine(t.now({ id: 7 }) && plan([{ reservationId: 1, hourIdx: 16, hourLabel: '21時' }, { loadoutSlot: 2, team: ['f', 'g', 'h', 'i', 'j'] }], [{ memberId: 7, reason: 'time' }]), 7, new Map(), 2);
    assert.ok(out.includes('🔒 予約で固定'), '予約の行が無い');
    assert.ok(/handleRequestCancelReservation\(1\)/.test(out), '取り消し希望のボタンが無い');
    assert.ok(out.includes('運営Aが承認'), '承認者が出ていない');
    assert.ok(/class="claim"/.test(out), '配信の行に引き受けるが無い');
    assert.ok(out.includes('戦闘可能時間に合う枠がありません'), '空き枠の理由が無い');
    assert.ok(/openMyResvRequest\(\)/.test(out), '空き枠から申請できない');
    assert.ok(/報告する ▶/.test(out), '現在レベルの配信の行に報告ボタンが無い');
    assert.ok(!/undefined|NaN/.test(out), `未定義参照が混ざっている: ${out.match(/.{40}(undefined|NaN).{40}/)?.[0]}`);
});

await test('★ 置けていない予約 (配信の unmetReservations) は「組み直し待ち」でなく ⚠ 置けていません + 理由', () => {
    const p = plan([{ loadoutSlot: 2, team: ['f', 'g', 'h', 'i', 'j'] }]);
    p.unmetReservations = [{ reservationId: 1, memberId: 7, level: 2, bossNumber: 3, loadoutSlot: 1, reason: 'conflict' }];
    const t = run({ pub: p, rows: [resv({ id: 1 })] });
    const out = t.strip({ id: 7 }, false);
    assert.ok(/⚠ 置けていません/.test(out), '置けていない表示が無い');
    assert.ok(/ほかの凸とキャラが被るため置けません/.test(out), '理由 (日本語) が無い');
    assert.ok(!/組み直し待ち/.test(out) && !/運営が組み直し中/.test(out), '置けないのを組み直し待ちと言っている');
    assert.ok(/dc-plan-card fixed unmet/.test(out));
    const mine = t.mine(p, 7, new Map(), 2);
    assert.ok(/⚠ 置けていません — ほかの凸とキャラが被るため置けません/.test(mine), '一覧に理由が無い');
});

await test('取り消し希望中の予約は固定のまま、印だけ変わる', () => {
    const t = run({ pub: null, rows: [resv({ id: 5, status: 'cancel_requested' })] });
    const out = t.strip({ id: 7 }, false);
    assert.ok(/取り消し希望中/.test(out));
    assert.ok(/dc-plan-card fixed pending/.test(out));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
