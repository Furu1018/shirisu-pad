// 🧱 ブロック制の流れを第44回の実データで回す土台 (2026-10-22 職場PC の実験を移したもの)
//   流れは tests/bench-block.mjs の H (本番のブロック制): 各ブロックの頭に「そのブロックに出られる人」だけで残りの 1 日を組み、
//   そのブロックの凸だけ実行する。模擬は自分が最初に出られるブロックの前に届く。時間厳守 (既定)。
//   盤面は data/2026-09.json (30 人・実際の凸のダメージ。締め凸は本人の非締め凸の最大で代用)。SCALE=1.3 で全員のダメージを倍率で。
//   時間帯の型は 2 通り: SPREAD (散らばり = bench-block と同じ型・時間未登録は無し) / CONC (集中 = 夜 21〜23時 に寄る)。
//   使い方は同じフォルダの README.md
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (file) => {
    const ctx = { window: {}, console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'domain', 'raidBlocks.js'), 'utf8'), ctx);
    return { compute: ctx.computeOptimalPlanCore || ctx.window.computeOptimalPlanCore, RB: ctx.raidBlocksDomain || ctx.window.raidBlocksDomain };
};
const REAL = load(path.join(REPO, 'js', 'optimal-plan.js'));

const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
const hk = (h) => `h${String(h).padStart(2, '0')}`;
const KEYS = HOUR_ORDER.map(hk);
const idxOf = (key) => KEYS.indexOf(key);
const HP = { 1: { lord: 99.8562792, tyrant: 150.8418136 }, 2: { lord: 149.7844188, tyrant: 226.2627204 }, 3: { lord: 292.44529575, tyrant: 349.2309015 } };
const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
const BOSSES = [
    { boss_number: 1, boss_code: 'Z.E.U.S.', name: 'B1', attribute: 'electric', tier: 'lord' },
    { boss_number: 2, boss_code: 'H.S.T.A.', name: 'B2', attribute: 'fire', tier: 'lord' },
    { boss_number: 3, boss_code: 'A.N.M.I.', name: 'B3', attribute: 'wind', tier: 'tyrant' },
    { boss_number: 4, boss_code: 'P.S.I.D.', name: 'B4', attribute: 'water', tier: 'lord' },
    { boss_number: 5, boss_code: 'D.M.T.R.', name: 'B5', attribute: 'iron', tier: 'tyrant' },
].map(b => ({ ...b, weakness: COUNTER[b.attribute] }));
const bossByCode = new Map(BOSSES.map(b => [b.boss_code, b]));
const BLK = REAL.RB.normalize(null).blocks;   // 既定 7 つ
const BLOCKS = BLK.map(b => ({ name: b.name, from: b.fromIdx, to: b.toIdx + 1 }));
const blockOf = (idx) => BLOCKS.findIndex(b => idx >= b.from && idx < b.to);

const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'data', '2026-09.json'), 'utf8'));
const MEMBERS = raw.players.map((p, i) => {
    const nonKill = p.attacks.filter(a => !a.isKill).map(a => a.damage / 1e9);
    const loadouts = {};
    for (const a of p.attacks) {
        const b = bossByCode.get(a.bossCode);
        if (!b) continue;
        let dmgB = a.damage / 1e9;
        if (a.isKill && nonKill.length) dmgB = Math.max(...nonKill);
        (loadouts[b.weakness] ||= []).push({ dmgB: Math.round(dmgB * (Number(process.env.SCALE) || 1) * 100) / 100, team: a.characters.slice(), slot: 1 });
    }
    for (const k of Object.keys(loadouts)) loadouts[k].forEach((lo, j) => { lo.slot = j + 1; });
    return { id: `p${i}`, name: p.player, syncLevel: p.syncLevel, loadouts };
});

const range = (a, b) => { const out = []; let h = a; for (;;) { out.push(hk(h)); if (h === b) break; h = (h + 1) % 24; } return out; };
// 散らばり: tests/bench-block.mjs と同じ型 (★ 時間未登録 = いつでも は、隙間型の撤廃を見越して外した)
const SPREAD = [
    () => range(19, 0), () => range(20, 1), () => range(21, 2), () => range(18, 23), () => range(22, 3),
    () => range(5, 9), () => range(12, 17), () => range(9, 23), () => range(7, 12),
    () => [...range(5, 8), ...range(21, 1)], () => [...range(12, 13), ...range(20, 0)], () => range(0, 4),
];
// 集中: 夜 (21〜23時) に寄せる。夜だけの人が半分、夜 + 別の時間帯 (朝 / 昼 / 夕方〜) の人が 4 割、そのほか 1 割
const CONC = [
    () => range(21, 23), () => range(21, 23), () => range(21, 23), () => range(21, 23), () => range(20, 23),
    () => [...range(5, 8), ...range(21, 23)], () => [...range(12, 14), ...range(21, 23)], () => range(18, 23), () => range(15, 23),
    () => range(12, 17),
];
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

function newWorld(avail) {
    return { level: 1, bosses: BOSSES.map(b => ({ ...b, rem: HP[1][b.tier] })),
        players: MEMBERS.map((m, i) => ({ ...m, attacks: [], used: new Set(), slots: avail[i] })), credited: 0, done: 0 };
}
function input(w, nowIdx, visible, extra) {
    return {
        season: { current_level: w.level },
        bosses: w.bosses.map(b => ({ boss_number: b.boss_number, boss_code: b.boss_code, name: b.name, attribute: b.attribute, weakness: b.weakness, tier: b.tier,
            total_hp_raw: (w.level <= 3 ? HP[w.level][b.tier] : 1e6) * 1e9, remaining_hp_raw: (w.level <= 3 ? b.rem : (b.boss_number === 5 ? 1e6 : 0)) * 1e9 })),
        players: w.players.filter(visible).map(p => ({
            id: p.id, name: p.name, syncLevel: p.syncLevel, attackCount: p.attacks.length,
            attacks: p.attacks.map(a => ({ boss_number: a.boss_number, characters: a.characters })),
            loadoutsByAttr: Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, v.map(lo => ({ ...lo, team: lo.team.slice() }))])),
            damagesByAttr: Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, Math.max(...v.map(x => x.dmgB))])),
            teamsByAttr: Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, v[0].team.slice()])),
            availableSlots: p.slots,
        })),
        currentSlot: KEYS[nowIdx], timeAware: true, timeStrict: true, ...extra,
    };
}
const flatten = (plan) => (plan && plan.levels || []).flatMap(lv => (lv.bosses || []).flatMap(b => (b.attacks || []).map(a => ({
    memberId: a.memberId, bossNumber: b.bossNumber, level: lv.level, dmgB: a.dmgB, team: a.team || [], hourIdx: a.hourIdx ?? 0 }))));
function execute(w, attacks, from, to) {
    const list = attacks.filter(a => a.hourIdx >= from && a.hourIdx < to).sort((x, y) => x.hourIdx - y.hourIdx || x.level - y.level);
    for (const a of list) {
        const p = w.players.find(x => x.id === a.memberId);
        if (p.attacks.length >= 3 || a.team.some(c => p.used.has(c))) continue;
        if (w.level >= 4) { if (a.bossNumber !== 5) continue; w.credited += a.dmgB; }
        else {
            const b = w.bosses[a.bossNumber - 1];
            if (b.rem <= 1e-9) continue;
            const used = Math.min(a.dmgB, b.rem);
            b.rem -= used; w.credited += used;
            if (w.bosses.every(x => x.rem <= 1e-9)) { w.level++; if (w.level <= 3) w.bosses.forEach(x => { x.rem = HP[w.level][x.tier]; }); }
        }
        p.attacks.push({ boss_number: a.bossNumber, characters: a.team.slice() });
        a.team.forEach(c => p.used.add(c));
        w.done++;
    }
}
// 本番のブロック制 (bench-block の H)。extra はソルバーへの追加の入力 (段階 2b の blockCaps などを試すとき)
function runBlocks(avail, extra = {}) {
    const w = newWorld(avail);
    const firstBlock = avail.map(sl => Math.min(...sl.map(k => blockOf(idxOf(k)))));
    BLOCKS.forEach((bk, k) => {
        const inBlock = (p) => p.slots.some(h => blockOf(idxOf(h)) === k);
        const vis = (p) => firstBlock[w.players.indexOf(p)] <= k && (process.env.LOCAL === "0" || inBlock(p));
        if (!w.players.some(vis)) return;
        const plan = REAL.compute(input(w, bk.from, vis, typeof extra === 'function' ? extra(w, k) : extra));
        execute(w, flatten(plan), bk.from, bk.to);
    });
    return w;
}

export { MEMBERS, BOSSES, BLOCKS, HP, REAL, newWorld, input, flatten, execute, runBlocks, blockOf, idxOf, KEYS, rng, CONC, SPREAD, range };
