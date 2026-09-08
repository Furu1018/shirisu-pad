// ============================================================================
// 模擬タブの提出カード (renderMyDamagePanels) の実行テスト
//   node tests/mock-panels.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
//
// なぜ要るか (2026-09-07 本番障害):
//   測定ボスレベルを廃止したとき (8a5265f) に `lvTitle` の定義だけ消え、
//   テンプレート内の参照が残った。カード生成の map の中で ReferenceError になるため
//   **5枚とも1枚も描かれない**。単体テスト 333件は1つも落ちなかった —
//   「実行しないと出ない」典型で、plan-hp-modal.mjs と同じ理由でこのテストがある。
//
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

const SRC = cut('        async function renderMyDamagePanels(');

const ATTRS = [
    { key: 'fire', name: '灼熱', icon: 'a.png' }, { key: 'water', name: '水冷', icon: 'b.png' },
    { key: 'electric', name: '電撃', icon: 'c.png' }, { key: 'iron', name: '鉄甲', icon: 'd.png' },
    { key: 'wind', name: '風圧', icon: 'e.png' },
];

function run({ damages = [], picks = new Map(), excluded = false, resv = [], bosses = [] } = {}) {
    let boxHtml = '';
    const box = { set innerHTML(v) { boxHtml = v; }, get innerHTML() { return boxHtml; }, style: {} };
    const env = {
        document: { getElementById: (id) => id === 'mypageDmgPanels' ? box : { style: {}, textContent: '' } },
        window: {
            supabaseLoadPlayerDamages: async () => damages,
            supabaseLoadMyReservations: async () => resv,
            reservationsDomain: { isActive: (r) => ['requested', 'approved', 'cancel_requested'].includes(r.status) },
            mockExclusionDomain: { isExcluded: () => excluded, exclusionLabel: () => '運営が除外 (理由)' },
        },
        getNikkeCharsCache: async () => [],
        ensureActiveSeasonLoaded: async () => ({ season: { id: 1, current_level: 1 }, bosses }),
        PT_ATTRS: ATTRS, MY_TEAM_SLOTS: [1, 2], SLOT_JP: { 1: '①', 2: '②' },
        _myDmgPanelSlots: {}, _myPlanPicks: picks,
        mockDamageOf: (r) => Number(r?.damage_b) || 0,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        fuzzyResolveCharacter: (n) => n,
        resolveNikkeChar: (n) => ({ canonical: n, iconPath: 'i.png' }),
        _pkVars: () => '', DC_ATTR_COLORS: Object.fromEntries(ATTRS.map(a => [a.key, '#123456'])),
        _orderAttrsByBosses: () => ATTRS.map((a, i) => ({ ...a, bossNumber: i + 1 })),
        renderMyFururiRadar: () => { }, renderMypageStrongAttrsBadge: () => { }, _renderMockDupLegend: () => { },
    };
    const keys = Object.keys(env);
    const render = new Function(...keys, `${SRC}\nreturn renderMyDamagePanels;`)(...keys.map(k => env[k]));
    return { render, box: () => boxHtml };
}

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}

console.log('模擬タブの提出カード:\n');

await test('★ 提出が1件でも5属性ぶんのカードを描く (未提出は「—」)', async () => {
    // ★ 2026-09-07 の本番障害はここ: テンプレート内の未定義参照で map ごと落ち、1枚も出なかった
    const t = run({ damages: [{ attribute: 'fire', slot: 1, damage_b: 50, characters: ['a', 'b', 'c', 'd', 'e'] }] });
    await t.render({ id: 1, name: 'me' });
    const n = (t.box().match(/dc-dmg-panel/g) || []).length;
    assert.equal(n, 5, `カードが ${n} 枚しか出ていない`);
    assert.ok(/50/.test(t.box()), '提出した値が出ていない');
    assert.ok(/dc-dmg-value empty/.test(t.box()), '未提出の枠が「—」になっていない');
});

await test('提出ゼロでも5枚出る (最初に開いた人の画面が空にならない)', async () => {
    const t = run({ damages: [] });
    await t.render({ id: 1, name: 'me' });
    assert.equal((t.box().match(/dc-dmg-panel/g) || []).length, 5);
});

await test('1属性2編成は「重なり」と ①⇄② の巡回バッジが出る', async () => {
    const t = run({ damages: [
        { attribute: 'fire', slot: 1, damage_b: 50, characters: ['a', 'b', 'c', 'd', 'e'] },
        { attribute: 'fire', slot: 2, damage_b: 40, characters: ['f', 'g', 'h', 'i', 'j'] },
    ] });
    await t.render({ id: 1, name: 'me' });
    assert.ok(/dc-dmg-panel stacked/.test(t.box()), '重なり表示になっていない');
    assert.ok(/dc-dmg-slotbadge/.test(t.box()), '巡回バッジが無い');
});

await test('運営除外 (35) の印が出る', async () => {
    const t = run({ damages: [{ attribute: 'fire', slot: 1, damage_b: 50, characters: [] }], excluded: true });
    await t.render({ id: 1, name: 'me' });
    assert.ok(/運営除外/.test(t.box()), '除外の印が出ていない');
});

await test('配信プランで採用された編成は光る枠になる', async () => {
    const t = run({
        damages: [{ attribute: 'fire', slot: 1, damage_b: 50, characters: ['a'] }],
        picks: new Map([['fire', new Set([1])]]),
    });
    await t.render({ id: 1, name: 'me' });
    assert.ok(/planpick/.test(t.box()), '採用マークが出ていない');
});

await test('プレイヤー未選択なら案内だけ出す', async () => {
    const t = run({});
    await t.render(null);
    assert.ok(/プレイヤーを選択すると表示されます/.test(t.box()));
    assert.equal((t.box().match(/dc-dmg-panel/g) || []).length, 0);
});

await test('★ 予約中の編成に「🔒 予約済み / 承認待ち」の印が出る (実機FB 2026-09-08: 予約したカードを誤って消さないように)', async () => {
    const bosses = [{ boss_number: 1, weakness: 'fire' }, { boss_number: 2, weakness: 'water' }];
    const t = run({
        damages: [
            { attribute: 'fire', slot: 1, damage_b: 50, characters: ['a', 'b', 'c', 'd', 'e'] },
            { attribute: 'water', slot: 1, damage_b: 40, characters: ['f', 'g', 'h', 'i', 'j'] },
        ],
        bosses,
        resv: [
            { id: 1, boss_number: 1, loadout_slot: 1, status: 'approved' },
            { id: 2, boss_number: 2, loadout_slot: 1, status: 'requested' },
            { id: 3, boss_number: 2, loadout_slot: 2, status: 'released' },   // 終わった予約は印にしない
        ],
    });
    await t.render({ id: 1, name: 'me' });
    const out = t.box();
    assert.ok(/dc-dmg-resv approved"[^>]*>🔒 予約済み/.test(out), '予約済みの印が無い');
    assert.ok(/dc-dmg-resv requested"[^>]*>🔒 承認待ち/.test(out), '承認待ちの印が無い');
    assert.equal((out.match(/dc-dmg-resv /g) || []).length, 2, '終わった予約にも印が出ている');
});

await test('予約が読めない (39未適用 / シーズン無し) でもカードは描ける', async () => {
    const t = run({ damages: [{ attribute: 'fire', slot: 1, damage_b: 50, characters: [] }], bosses: [], resv: null });
    await t.render({ id: 1, name: 'me' });
    assert.equal((t.box().match(/dc-dmg-panel/g) || []).length, 5);
    assert.ok(!/dc-dmg-resv/.test(t.box()));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
