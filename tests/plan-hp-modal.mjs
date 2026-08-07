// ============================================================================
// 🎯どれくらい削れる? モーダル (openPlanHpModal) の実行テスト
//   node tests/plan-hp-modal.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// UIテストが無いこのリポジトリで、この関数だけは実行経路のバグが出やすいため:
//   - 2026-08-08: const の TDZ で「想定ダメージ>0 のカードをタップすると
//     ReferenceError」という致命バグが入り、単体テスト129件では検出できなかった
//   - 残HP未記録・total=0 の不整合・Lv4 の分岐は実データで踏みやすい
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i = html.indexOf('        async function openPlanHpModal(');
const j = html.indexOf('        // ヒーローの主CTA:');
if (i < 0 || j < 0 || j <= i) {
    console.error('NG: openPlanHpModal を index.html から切り出せませんでした (目印が変わった?)');
    process.exit(2);
}
const src = html.slice(i, j);
// ---- 依存スタブ (index.html 側の実装に合わせる) ----
let bodyHtml = '';
const bodyEl = { set innerHTML(v) { bodyHtml = v; }, get innerHTML() { return bodyHtml; } };
const modalEl = { classList: { add() {}, remove() {} } };
globalThis.document = { getElementById: (id) => (id === 'planHpModal' ? modalEl : id === 'planHpBody' ? bodyEl : null) };
globalThis._planHpSeq = 0;
globalThis.escapeHtml = (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.ATTR_VISUAL = {
    fire: { color: '#FF3D44', dark: '#D02830', name: '灼熱', icon: 'a.png' },
    water: { color: '#2E8BFF', dark: '#1E78F0', name: '水冷', icon: 'b.png' },
    electric: { color: '#9B4DFF', dark: '#7C3AED', name: '電撃', icon: 'c.png' },
    iron: { color: '#FF8A2B', dark: '#E0701F', name: '鉄甲', icon: 'd.png' },
    wind: { color: '#18C26B', dark: '#0EA055', name: '風圧', icon: 'e.png' },
};
globalThis.weaknessPtOf = (b) => b.weakness;
globalThis.opsStore = { patchBosses() {} };
globalThis.seasonStore = { patchBosses() {} };
// ★ index.html の isLv4LiveBoard と同じ契約 (B1〜B5 が全員そろっていることの確認を含む)
globalThis.isLv4LiveBoard = (season, bosses) => {
    if (!season || Number(season.current_level) < 3) return false;
    const list = bosses || [];
    const nums = new Set(list.map(x => Number(x.boss_number)));
    if (![1, 2, 3, 4, 5].every(n => nums.has(n))) return false;
    return list.every(x => {
        const total = Number(x.total_hp_raw) || 0;
        const rem = Number(x.remaining_hp_raw) || 0;
        return total > 0 ? (rem / total) * 100 <= 0.01 : rem <= 0;
    });
};
globalThis.getNikkeCharsCache = async () => [];
globalThis._renderMatchupCharAvatar = (n) => `<img alt="${n}">`;

let MOCK_ROWS = [], BOSSES = [], SEASON = { id: 26, current_level: 2 };
globalThis._myPlanRows = () => MOCK_ROWS;
globalThis.window = { supabaseLoadActiveSeasonWithBosses: async () => ({ season: SEASON, bosses: BOSSES }) };
globalThis._myPubState = { plan: {}, viewerId: 'me', doneCounts: new Map(), seasonId: 26 };

const openPlanHpModal = eval(`(${src.trim()})`);

const B = (n, attr, weak, totB, remB) => ({
    boss_number: n, attribute: attr, weakness: weak, name: `B${n}`, boss_code: `T${n}`,
    total_hp_raw: totB * 1e9, remaining_hp_raw: remB * 1e9,
});
const FULL = (b5tot, b5rem) => [
    B(1, 'fire', 'water', 100, 0), B(2, 'water', 'electric', 100, 0),
    B(3, 'electric', 'iron', 100, 0), B(4, 'iron', 'wind', 100, 0),
    B(5, 'wind', 'fire', b5tot, b5rem),
];

// [名前, ボス配列, current_level, ボス番号, Lv, 想定ダメージ, 期待する判定, 期待するバー表記]
const cases = [
    ['通常 (残34.2/150.8, 18.4B)', [B(1, 'fire', 'water', 150.8, 34.2)], 2, 1, 18.4, /残HPの 54% を削る見込み/, '54% 削減'],
    ['撃破見込み (残10, 18.4B)', [B(1, 'fire', 'water', 150.8, 10)], 2, 1, 18.4, /この凸で撃破できる見込み/, '100% 削減'],
    ['残HP未記録 (total=0,rem=0)', [B(1, 'fire', 'water', 0, 0)], 2, 1, 18.4, /試算できません/, null],
    ['total=0 だが rem>0 の不整合', [B(1, 'fire', 'water', 0, 5)], 2, 1, 18.4, /試算できません/, null],
    ['Lv4 (B1-4撃破・B5は0/0)', FULL(0, 0), 3, 5, 25.0, /HP無限/, '全額が加算'],
    ['HPを一度も記録していない盤面', [B(1, 'fire', 'water', 0, 0), B(2, 'water', 'electric', 0, 0),
        B(3, 'electric', 'iron', 0, 0), B(4, 'iron', 'wind', 0, 0), B(5, 'wind', 'fire', 0, 0)],
        3, 5, 25.0, /試算できません/, null],
    ['B1-4は未撃破・B5だけ0/0', [B(1, 'fire', 'water', 100, 50), B(2, 'water', 'electric', 100, 50),
        B(3, 'electric', 'iron', 100, 50), B(4, 'iron', 'wind', 100, 50), B(5, 'wind', 'fire', 0, 0)],
        3, 5, 25.0, /試算できません/, null],
    // 本番DBでは「5体とも記録済み」か「5体とも未記録」しか無く、混在は0件 (2026-08-08 実測)。
    // 万一混在したら「HP無限・全額入る」と誤って言うより「試算できません」に倒す
    ['混在 (B3だけ総HP未記録) は安全側に倒す', [B(1, 'fire', 'water', 100, 0), B(2, 'water', 'electric', 100, 0),
        B(3, 'electric', 'iron', 0, 0), B(4, 'iron', 'wind', 100, 0), B(5, 'wind', 'fire', 0, 0)],
        3, 5, 25.0, /試算できません/, null],
    ['B1〜B4 が1体足りない盤面', [B(1, 'fire', 'water', 100, 0), B(2, 'water', 'electric', 100, 0),
        B(3, 'electric', 'iron', 100, 0), B(5, 'wind', 'fire', 0, 0)],
        3, 5, 25.0, /試算できません/, null],
    ['想定ダメージ0', [B(1, 'fire', 'water', 150.8, 34.2)], 2, 1, 0, /残HPの 0% を削る見込み/, null],
];

let pass = 0, fail = 0;
for (const [name, bs, cl, bn, dmg, expectVerdict, expectBar] of cases) {
    BOSSES = bs;
    SEASON = { id: 26, current_level: cl };
    MOCK_ROWS = [{ bossNumber: bn, dmgB: dmg, level: cl, team: ['A', 'B', 'C', 'D', 'E'], loadoutSlot: 1, hourLabel: '07時', flex: false }];
    bodyHtml = '';
    const problems = [];
    try {
        await openPlanHpModal(bn, cl, dmg, 0);
    } catch (e) {
        problems.push(`${e.constructor.name}: ${e.message}`);
    }
    if (problems.length === 0) {
        if (!expectVerdict.test(bodyHtml)) problems.push(`判定が期待と違う (期待: ${expectVerdict})`);
        const bar = (bodyHtml.match(/(全額が加算|\d+% 削減)/) || [null])[0];
        if (expectBar === null && bar !== null) problems.push(`バーが出てはいけないのに「${bar}」`);
        if (expectBar !== null && bar !== expectBar) problems.push(`バーが「${bar}」(期待: ${expectBar})`);
        if (/undefined|NaN|\[object Object\]/.test(bodyHtml)) problems.push('出力に undefined / NaN が混ざっている');
    }
    if (problems.length === 0) { console.log(`  ✅ ${name}`); pass++; }
    else { console.error(`  ❌ ${name}`); problems.forEach(x => console.error(`     ${x}`)); fail++; }
}

// ---- 防御分岐 (早期リターン) ----
// 取得失敗・シーズン切替・ボス欠損・プラン行の不一致で、
// 黙って壊れず「案内を出して止まる」ことを固定する
const guards = [
    ['盤面の取得に失敗', async () => {
        globalThis.window = { supabaseLoadActiveSeasonWithBosses: async () => { throw new Error('network down'); } };
    }, /最新の残HPを取得できませんでした/],
    ['配信後にシーズンが切り替わった', async () => {
        SEASON = { id: 99, current_level: 2 };
        globalThis.window = { supabaseLoadActiveSeasonWithBosses: async () => ({ season: SEASON, bosses: BOSSES }) };
    }, /シーズンが切り替わりました/],
    ['対象ボスが盤面にいない', async () => {
        BOSSES = [B(2, 'water', 'electric', 100, 50)];
        SEASON = { id: 26, current_level: 2 };
        globalThis.window = { supabaseLoadActiveSeasonWithBosses: async () => ({ season: SEASON, bosses: BOSSES }) };
    }, /このボスの情報が見つかりませんでした/],
    ['プラン行が一致しない (配信が更新された)', async () => {
        BOSSES = [B(1, 'fire', 'water', 150.8, 34.2)];
        SEASON = { id: 26, current_level: 2 };
        globalThis.window = { supabaseLoadActiveSeasonWithBosses: async () => ({ season: SEASON, bosses: BOSSES }) };
        MOCK_ROWS = [{ bossNumber: 1, dmgB: 99.9, level: 2, team: ['A'], loadoutSlot: 1, hourLabel: '07時' }];
    }, /プランが更新されました/],
];
for (const [name, setup, expect] of guards) {
    BOSSES = [B(1, 'fire', 'water', 150.8, 34.2)];
    SEASON = { id: 26, current_level: 2 };
    MOCK_ROWS = [{ bossNumber: 1, dmgB: 18.4, level: 2, team: ['A', 'B', 'C', 'D', 'E'], loadoutSlot: 1, hourLabel: '07時' }];
    globalThis.window = { supabaseLoadActiveSeasonWithBosses: async () => ({ season: SEASON, bosses: BOSSES }) };
    await setup();
    bodyHtml = '';
    try {
        await openPlanHpModal(1, 2, 18.4, 0);
        if (expect.test(bodyHtml)) { console.log(`  ✅ ${name}`); pass++; }
        else { console.error(`  ❌ ${name}\n     案内が出ていない (期待: ${expect})`); fail++; }
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++;
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
