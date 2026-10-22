// 実験 (2026-10-22): 「朝と夕方」のように離れた複数のブロックに出られる人の 3 凸は、どう割り当てられるか。
//   本物のソルバー (js/optimal-plan.js) と本物のブロック定義 (js/domain/raidBlocks.js)、第44回の実データ (30 人・実際の凸のダメージ) で解く。
//   画面の computeOptimalPlan と同じ渡し方: ブロックのときは onlyAvailableNow + availableAtSlots (ブロックの時間) + currentSlot = ブロックの頭
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 実行: node tests/bench-blockflow/multi-block.mjs
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ctx = { window: {}, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'optimal-plan.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'domain', 'raidBlocks.js'), 'utf8'), ctx);
const compute = ctx.computeOptimalPlanCore || ctx.window.computeOptimalPlanCore;
const RB = ctx.raidBlocksDomain || ctx.window.raidBlocksDomain;
const BLOCKS = RB.normalize(null).blocks;   // 既定 7 つ (朝 5-8 / 午前 9-11 / 昼 12-14 / 午後 15-17 / 夕方 18-20 / 夜 21-23 / 深夜 0-4)
const blockName = (hourIdx) => { const b = BLOCKS.find(b => hourIdx >= b.fromIdx && hourIdx <= b.toIdx); return b ? b.name : '?'; };
const blk = (name) => BLOCKS.find(b => b.name === name);

const hk = (h) => `h${String(h).padStart(2, '0')}`;
const range = (a, b) => { const out = []; let h = a; for (;;) { out.push(hk(h)); if (h === b) break; h = (h + 1) % 24; } return out; };

const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
const BOSSES = [
    { boss_number: 1, boss_code: 'Z.E.U.S.', name: 'B1', attribute: 'electric', tier: 'lord' },
    { boss_number: 2, boss_code: 'H.S.T.A.', name: 'B2', attribute: 'fire', tier: 'lord' },
    { boss_number: 3, boss_code: 'A.N.M.I.', name: 'B3', attribute: 'wind', tier: 'tyrant' },
    { boss_number: 4, boss_code: 'P.S.I.D.', name: 'B4', attribute: 'water', tier: 'lord' },
    { boss_number: 5, boss_code: 'D.M.T.R.', name: 'B5', attribute: 'iron', tier: 'tyrant' },
].map(b => ({ ...b, weakness: COUNTER[b.attribute] }));
const HP1 = { lord: 99.8562792, tyrant: 150.8418136 };
const bossByCode = new Map(BOSSES.map(b => [b.boss_code, b]));

// 第44回の実データ → 模擬 (締め凸は本人の非締め凸の最大で代用 = ベンチと同じ)
const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'data', '2026-09.json'), 'utf8'));
const MEMBERS = raw.players.map((p, i) => {
    const nonKill = p.attacks.filter(a => !a.isKill).map(a => a.damage / 1e9);
    const loadouts = {};
    for (const a of p.attacks) {
        const b = bossByCode.get(a.bossCode);
        if (!b) continue;
        let dmgB = a.damage / 1e9;
        if (a.isKill && nonKill.length) dmgB = Math.max(...nonKill);
        (loadouts[b.weakness] ||= []).push({ dmgB: Math.round(dmgB * 100) / 100, team: a.characters.slice(), slot: 1 });
    }
    for (const k of Object.keys(loadouts)) loadouts[k].forEach((lo, j) => { lo.slot = j + 1; });
    return { id: i + 1, name: `M${i + 1}`, syncLevel: p.syncLevel, loadouts };
});

// 時間帯 (決め打ち・乱数なし)。★ 「朝+夕方」の人を 4 人 (M4 / M11 / M18 / M25)
const SPLIT = new Set([4, 11, 18, 25]);
const PATTERNS = [range(5, 8), range(9, 14), range(18, 23), range(21, 2), range(12, 17), range(19, 0), null];
const availOf = (id) => SPLIT.has(id) ? [...range(5, 8), ...range(18, 20)] : PATTERNS[(id - 1) % PATTERNS.length];

const players = (doneById = new Map()) => MEMBERS.map(m => ({
    id: m.id, name: m.name, syncLevel: m.syncLevel,
    attackCount: (doneById.get(m.id) || []).length,
    attacks: (doneById.get(m.id) || []).map(a => ({ boss_number: a.bossNumber, characters: a.team })),
    loadoutsByAttr: Object.fromEntries(Object.entries(m.loadouts).map(([k, v]) => [k, v.map(lo => ({ ...lo, team: lo.team.slice() }))])),
    damagesByAttr: Object.fromEntries(Object.entries(m.loadouts).map(([k, v]) => [k, Math.max(...v.map(x => x.dmgB))])),
    teamsByAttr: Object.fromEntries(Object.entries(m.loadouts).map(([k, v]) => [k, v[0].team.slice()])),
    availableSlots: availOf(m.id) || [], flexTime: false, notifyAllHours: false, strong_attributes: [],
}));
const bosses = () => BOSSES.map(b => ({ ...b, total_hp_raw: HP1[b.tier] * 1e9, remaining_hp_raw: HP1[b.tier] * 1e9 }));

const flat = (plan) => (plan?.levels || []).flatMap(lv => (lv.bosses || []).flatMap(b => (b.attacks || []).map(a => ({
    memberId: a.memberId, level: lv.level, bossNumber: b.bossNumber, hourIdx: a.hourIdx, hourLabel: a.hourLabel, flex: !!a.flex, dmgB: a.dmgB, team: a.team || [], reservationId: a.reservationId ?? null,
}))));
const show = (title, plan, scope = null) => {
    const all = flat(plan);
    const inScope = scope ? all.filter(a => a.hourIdx >= scope.fromIdx && a.hourIdx <= scope.toIdx) : all;
    console.log(`\n=== ${title}`);
    console.log(`  全体: 割当 ${all.length} 凸 / 踏破 Lv${plan.fullyClearedThrough || 0}${scope ? ` / 配信される範囲 (${scope.name}) ${inScope.length} 凸` : ''}`);
    for (const id of SPLIT) {
        const mine = all.filter(a => String(a.memberId) === String(id)).sort((x, y) => x.hourIdx - y.hourIdx);
        const desc = mine.map(a => `${a.hourLabel || a.hourIdx}(${blockName(a.hourIdx)}) Lv${a.level}B${a.bossNumber}${a.reservationId ? '🔒' : ''}`).join(' / ') || 'なし';
        const pub = scope ? mine.filter(a => a.hourIdx >= scope.fromIdx && a.hourIdx <= scope.toIdx).length : null;
        console.log(`  M${id} (朝+夕方): ${desc}${scope ? `  → メンバーに見えるのは ${pub} 凸` : ''}`);
    }
    if ((plan.unmetReservations || []).length) console.log(`  置けなかった予約: ${JSON.stringify(plan.unmetReservations.map(u => ({ id: u.reservationId, reason: u.reason })))}`);
    return all;
};

const asBlock = (b, extra = {}) => ({ season: { id: 1, current_level: 1, hard_date: '2026-10-10' }, bosses: bosses(), players: players(),
    currentSlot: hk(b.from), onlyAvailableNow: true, availableAtSlots: b.slots, availableAtLabel: b.label, timeAware: true, timeStrict: true, crossBoss: true, ...extra });

console.log(`ブロック: ${BLOCKS.map(b => `${b.name} ${b.label}`).join(' / ')}`);
console.log(`朝+夕方の人: ${[...SPLIT].map(id => `M${id}`).join(' ')}  (時間 = 5〜8時 と 18〜20時)`);

// ① 全員・朝5時から・1 日ぶん (従来の算出)
show('① 全員・朝5時から・1日ぶん (時間厳守)', compute({ season: { id: 1, current_level: 1 }, bosses: bosses(), players: players(),
    currentSlot: 'h05', onlyAvailableNow: false, timeAware: true, timeStrict: true, crossBoss: true }));

// ② 🧱 朝 のブロックで組む (画面の「🧱 ブロックの人 › 朝」+ 時間厳守 = 既定)
const morning = blk('朝');
const pM = compute(asBlock(morning));
const allM = show('② 🧱 朝 で組む (時間厳守・既定)', pM, morning);

// ③ 同じく「与ダメ優先」(時間厳守 OFF)
show('③ 🧱 朝 で組む (与ダメ優先)', compute(asBlock(morning, { timeStrict: false })), morning);

// ④ 朝の凸を配信どおりに実行したあと、🧱 夕方 で組む (朝のぶんは済んだ凸として渡す)
const doneById = new Map();
for (const a of allM.filter(a => a.hourIdx >= morning.fromIdx && a.hourIdx <= morning.toIdx)) {
    if (!doneById.has(a.memberId)) doneById.set(a.memberId, []);
    doneById.get(a.memberId).push(a);
}
const evening = blk('夕方');
const left = (id) => 3 - (doneById.get(id) || []).length;
console.log(`\n(朝のぶんを実行したことにする: 朝+夕方の人の残り凸 = ${[...SPLIT].map(id => `M${id} ${left(id)}`).join(' / ')})`);

// ⑤ 予約を 2 つ (夕方 18時) 入れた場合 — M4 が「朝に 1 凸・夕方に 2 凸」を希望して、運営が承認した
const m4 = MEMBERS.find(m => m.id === 4);
const attrs = Object.keys(m4.loadouts);
const resv = attrs.slice(0, 2).map((attr, i) => {
    const boss = BOSSES.find(b => b.weakness === attr);
    return { reservationId: 900 + i, memberId: 4, level: null, bossNumber: boss.boss_number, loadoutSlot: 1, flex: false, timeSlot: 'h18',
        team: m4.loadouts[attr][0].team.slice(), expectedB: m4.loadouts[attr][0].dmgB };
});
console.log(`\n(M4 の予約: ${resv.map(r => `18時 B${r.bossNumber}`).join(' / ')} — M4 が持っている属性: ${attrs.join(', ')})`);
show('⑤ 🧱 朝 で組む + M4 の夕方の予約 2 つ (承認済み)', compute(asBlock(morning, { reservations: resv })), morning);
