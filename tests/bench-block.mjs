// ============================================================================
// ブロック制の代償を測る — 第44回 (data/2026-09.json・30人・90凸) の実データで
//   node bench-block.mjs            (既定 100 通りの時間帯)
//   BENCH_N=300 node bench-block.mjs
// ----------------------------------------------------------------------------
// 比べるもの (credited = ゲームに入る与ダメ。有限ボスは min(dmg, 残HP)・Lv4 は全額):
//   A  前日に全員の模擬がそろい、朝5時に1日ぶんを1回だけ組んで、そのとおりに実行
//   B  ブロック制 (朝/午前/昼/午後/夕方/夜/深夜)。ブロックの頭に残りの1日を組み直し、そのブロックの凸だけ実行。模擬は全員ぶん最初からある
//   C  B + 模擬は「自分が最初に出られるブロックの前」に届く (それまでその人は盤面にいない)
//   D  B + 模擬は「自分が出られるブロックのどれか (ランダム) の前」に届く (ぎりぎりまで出さない人)
//   E  B + 戦闘可能時間を1時間刻みでなくブロック単位で聞く (ブロックに1時間でも出られれば丸ごと出られると申告・実際は本当の時間に動く)
//   F  C + E (ふるり案そのもの: ブロックで聞いて、ブロックの前に模擬を出す)
// 模擬 = 実際に出した凸のダメージ (締め凸 12 件は本人の非締め凸の最大で代用)。
// 時間帯は実データに無いので 練習モードの型 + 「いつでも」を混ぜて乱数で振る (seed ごとに変える)。
// ============================================================================
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { window: {}, globalThis: null, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'optimal-plan.js'), 'utf8'), ctx);
const compute = ctx.computeOptimalPlanCore || ctx.window.computeOptimalPlanCore;

const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
const hourKey = (h) => `h${String(h).padStart(2, '0')}`;
const KEYS = HOUR_ORDER.map(hourKey);
const HP = {
    1: { lord: 99.8562792, tyrant: 150.8418136 },
    2: { lord: 149.7844188, tyrant: 226.2627204 },
    3: { lord: 292.44529575, tyrant: 349.2309015 },
};
// 第44回のボス (ROADMAP: レイタンス電撃L / トゥームストーン灼熱L / モダニア風圧H / リビルドビッグトルソー水冷L / アニヒリオ鉄甲H)
const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
const BOSSES = [
    { boss_number: 1, boss_code: 'Z.E.U.S.', name: 'レイタンス', attribute: 'electric', tier: 'lord' },
    { boss_number: 2, boss_code: 'H.S.T.A.', name: 'トゥームストーン', attribute: 'fire', tier: 'lord' },
    { boss_number: 3, boss_code: 'A.N.M.I.', name: 'モダニア', attribute: 'wind', tier: 'tyrant' },
    { boss_number: 4, boss_code: 'P.S.I.D.', name: 'リビルドビッグトルソー', attribute: 'water', tier: 'lord' },
    { boss_number: 5, boss_code: 'D.M.T.R.', name: 'アニヒリオ', attribute: 'iron', tier: 'tyrant' },
].map(b => ({ ...b, weakness: COUNTER[b.attribute] }));
const bossByCode = new Map(BOSSES.map(b => [b.boss_code, b]));

// ブロック (5時始まりの番号): 朝 5-8 / 午前 9-11 / 昼 12-14 / 午後 15-17 / 夕方 18-20 / 夜 21-23 / 深夜 0-4
const BLOCKS = [
    { name: '朝', from: 0, to: 4 }, { name: '午前', from: 4, to: 7 }, { name: '昼', from: 7, to: 10 },
    { name: '午後', from: 10, to: 13 }, { name: '夕方', from: 13, to: 16 }, { name: '夜', from: 16, to: 19 }, { name: '深夜', from: 19, to: 24 },
];
const blockOf = (idx) => BLOCKS.findIndex(b => idx >= b.from && idx < b.to);

// ---- 実データ → メンバー (模擬 = 実際の凸) ----------------------------------
const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'data', '2026-09.json'), 'utf8'));
let killSubst = 0;
const MEMBERS_REAL = raw.players.map((p, i) => {
    const nonKill = p.attacks.filter(a => !a.isKill).map(a => a.damage / 1e9);
    const loadouts = {};
    for (const a of p.attacks) {
        const b = bossByCode.get(a.bossCode);
        if (!b) continue;
        let dmgB = a.damage / 1e9;
        if (a.isKill) { if (nonKill.length) { dmgB = Math.max(...nonKill); killSubst++; } }
        dmgB = Math.round(dmgB * (Number(process.env.SCALE) || 1) * 100) / 100;
        const lo = { dmgB, team: a.characters.slice(), slot: 1 };
        (loadouts[b.weakness] ||= []).push(lo);
    }
    for (const k of Object.keys(loadouts)) loadouts[k].forEach((lo, j) => { lo.slot = j + 1; });
    return { id: `p${i}`, name: p.player, syncLevel: p.syncLevel, loadouts };
});

// ---- 合成盤面 (tests/bench-stability.mjs と同じ規則・前日の状態: Lv1・凸なし・30人) ----
function synthMembers(seed) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (n) => Math.floor(rnd() * n);
    const shuffled = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = pick(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const P_SHARE2 = 0.12, P_SHARE1 = 0.05, P_SLOT2 = 0.3;
    const out = [];
    for (let p = 0; p < 30; p++) {
        const loadouts = {};
        const pool = shuffled(Object.values(COUNTER)).slice(0, rnd() < 0.9 ? 5 : 4);
        const team1 = {}, nextSlot = {};
        pool.forEach(a => { team1[a] = [1, 2, 3, 4, 5].map(k => `${p}_${a}_${k}`); nextSlot[a] = 0; });
        for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
            const a = pool[i], b = pool[j], r = rnd();
            const cnt = r < P_SHARE2 ? 2 : r < P_SHARE2 + P_SHARE1 ? 1 : 0;
            for (let k = 0; k < cnt; k++) {
                if (nextSlot[a] >= 5 || nextSlot[b] >= 5) break;
                const shared = `${p}_共有_${a}-${b}_${k}`;
                team1[a][nextSlot[a]++] = shared; team1[b][nextSlot[b]++] = shared;
            }
        }
        pool.forEach(a => {
            const base = Math.round((4 + rnd() * 24) * 2) / 2 * (Number(process.env.SCALE) || 1);
            const los = [{ dmgB: base, team: team1[a], slot: 1 }];
            if (rnd() < P_SLOT2) los.push({ dmgB: Math.round((base * (0.7 + rnd() * 0.25)) * 2) / 2, team: [1, 2, 3, 4, 5].map(k => `${p}_${a}_alt${k}`), slot: 2 });
            loadouts[a] = los;
        });
        out.push({ id: `p${p}`, name: `M${p}`, syncLevel: 300 + pick(400), loadouts });
    }
    return out;
}
let MEMBERS_SYNTH = null;

// ---- 時間帯 (乱数) -----------------------------------------------------------
const range = (a, b) => { const out = []; let h = a; for (;;) { out.push(hourKey(h)); if (h === b) break; h = (h + 1) % 24; } return out; };
const PATTERNS = [
    () => null,                       // いつでも (時間不明)
    () => null,
    () => null,
    () => range(19, 0), () => range(20, 1), () => range(21, 2), () => range(18, 23), () => range(22, 3),
    () => range(5, 9), () => range(12, 17), () => range(9, 23), () => range(7, 12),
    () => [...range(5, 8), ...range(21, 1)], () => [...range(12, 13), ...range(20, 0)], () => range(0, 4),
];
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
function drawAvail(rnd) {
    return (MEMBERS_SYNTH || MEMBERS_REAL).map(() => PATTERNS[Math.floor(rnd() * PATTERNS.length)]());
}
const idxOf = (key) => KEYS.indexOf(key);
const coarsen = (slots) => {   // ブロック単位で申告: 1時間でも出られるブロックは丸ごと
    if (!slots) return null;
    const bs = new Set(slots.map(k => blockOf(idxOf(k))));
    return KEYS.filter((k, i) => bs.has(blockOf(i)));
};

// ---- 世界 (盤面) --------------------------------------------------------------
function newWorld(avail, declared) {
    const MEMBERS = MEMBERS_SYNTH || MEMBERS_REAL;
    return {
        level: 1,
        bosses: BOSSES.map(b => ({ ...b, rem: HP[1][b.tier] })),
        players: MEMBERS.map((m, i) => ({ ...m, attacks: [], used: new Set(), trueSlots: avail[i], declaredSlots: declared[i] })),
        credited: 0, lost: { dead: 0, char: 0, spent: 0, lv4boss: 0 }, levelMismatch: 0, shifted: 0, done: 0,
    };
}
function solverInput(w, nowIdx, visible) {
    return {
        season: { current_level: w.level },
        bosses: w.bosses.map(b => ({
            boss_number: b.boss_number, boss_code: b.boss_code, name: b.name, attribute: b.attribute, weakness: b.weakness, tier: b.tier,
            total_hp_raw: (w.level <= 3 ? HP[w.level][b.tier] : 1e6) * 1e9,
            remaining_hp_raw: (w.level <= 3 ? b.rem : (b.boss_number === 5 ? 1e6 : 0)) * 1e9,
        })),
        players: w.players.filter((p, i) => visible(p, i)).map(p => ({
            id: p.id, name: p.name, syncLevel: p.syncLevel, attackCount: p.attacks.length,
            attacks: p.attacks.map(a => ({ boss_number: a.boss_number, characters: a.characters })),
            loadoutsByAttr: Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, v.map(lo => ({ ...lo, team: lo.team.slice() }))])),
            damagesByAttr: Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, Math.max(...v.map(x => x.dmgB))])),
            teamsByAttr: Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, v[0].team.slice()])),
            availableSlots: p.declaredSlots || [],
        })),
        currentSlot: KEYS[nowIdx], timeAware: true, timeStrict: !!process.env.STRICT,
    };
}
const flatten = (plan) => (plan && plan.levels || []).flatMap(lv => (lv.bosses || []).flatMap(b => (b.attacks || []).map(a => ({
    memberId: a.memberId, bossNumber: b.bossNumber, level: lv.level, dmgB: a.dmgB, team: a.team || [], hourIdx: a.hourIdx ?? 0, flex: !!a.flex,
}))));
// 実際に動く時刻: 計画の時刻に本当に出られなければ、その人が本当に出られる次の時刻 (無ければ最後の時刻 = 早めに動く)。
// いつでもの人は計画どおり。ブロック制では、ブロックの外へずれた凸は実行せず次のブロックで組み直す (execute の範囲で落ちる)
function actualHour(w, a) {
    const p = w.players.find(x => x.id === a.memberId);
    if (!p.trueSlots) return a.hourIdx;
    const tr = p.trueSlots.map(idxOf).sort((x, y) => x - y);
    if (tr.includes(a.hourIdx)) return a.hourIdx;
    const next = tr.find(i => i > a.hourIdx);
    return next != null ? next : tr[tr.length - 1];
}
function execute(w, attacks, from, to) {
    const list = attacks.map(a => ({ a: { ...a, at: actualHour(w, a) }, at: actualHour(w, a) })).filter(x => x.at >= from && x.at < to)
        .sort((x, y) => x.at - y.at || x.a.level - y.a.level);
    for (const { a } of list) {
        const p = w.players.find(x => x.id === a.memberId);
        if (p.attacks.length >= 3) { w.lost.spent++; continue; }
        if (a.team.some(c => p.used.has(c))) { w.lost.char++; continue; }
        if (a.level !== w.level) w.levelMismatch++;
        if (a.at !== a.hourIdx) w.shifted++;
        if (w.level >= 4) {
            if (a.bossNumber !== 5) { w.lost.lv4boss++; continue; }
            w.credited += a.dmgB;
        } else {
            const b = w.bosses[a.bossNumber - 1];
            if (b.rem <= 1e-9) { w.lost.dead++; continue; }
            const used = Math.min(a.dmgB, b.rem);
            b.rem -= used; w.credited += used;
            if (w.bosses.every(x => x.rem <= 1e-9)) {
                w.level++;
                if (w.level <= 3) w.bosses.forEach(x => { x.rem = HP[w.level][x.tier]; });
            }
        }
        p.attacks.push({ boss_number: a.bossNumber, characters: a.team.slice() });
        a.team.forEach(c => p.used.add(c));
        w.done++;
    }
}

// ---- シナリオ ----------------------------------------------------------------
function runWholeDay(w) {
    const plan = compute(solverInput(w, 0, () => true));
    execute(w, flatten(plan), 0, 24);
    return { w, planCredited: plan ? plan.totalCreditedB : 0, unused: plan ? (plan.unusedAttacks || 0) : 0 };
}
function runBlocks(w, visibleAtBlock, localOnly) {
    let unused = 0;
    BLOCKS.forEach((bk, k) => {
        const inBlock = (p) => !p.trueSlots || p.trueSlots.some(h => blockOf(idxOf(h)) === k);
        const plan = compute(solverInput(w, bk.from, (p, i) => visibleAtBlock(i) <= k && (!localOnly || inBlock(p))));
        execute(w, flatten(plan), bk.from, bk.to);
        if (k === BLOCKS.length - 1 && plan) unused = plan.unusedAttacks || 0;
    });
    return { w, unused };
}
const firstBlockOf = (slots) => slots ? Math.min(...slots.map(k => blockOf(idxOf(k)))) : 0;

const N = Number(process.env.BENCH_N || 100);
const res = { A: [], B: [], C: [], D: [], E: [], F: [], H: [] };
const lvl = { A: [], B: [], C: [], D: [], E: [], F: [], H: [] };
const lost = { A: [], B: [], C: [], D: [], E: [], F: [], H: [] };
const first = {};
const diag = { A: [], B: [], C: [], D: [], E: [], F: [], H: [] };
for (let s = 1; s <= N; s++) {
    const rnd = rng(s * 7919);
    if (process.env.BOARD === 'synth') MEMBERS_SYNTH = synthMembers(s * 104729);
    const avail = drawAvail(rnd);
    const coarse = avail.map(coarsen);
    const lateBlock = avail.map(sl => {   // D: 出られるブロックのどれかの前 (いつでもの人は7つのどれか)
        const bs = sl ? [...new Set(sl.map(k => blockOf(idxOf(k))))].sort((a, b) => a - b) : BLOCKS.map((_, i) => i);
        return bs[Math.floor(rnd() * bs.length)];
    });
    const runs = {
        A: () => runWholeDay(newWorld(avail, avail)),
        B: () => runBlocks(newWorld(avail, avail), () => 0),
        C: () => runBlocks(newWorld(avail, avail), (i) => firstBlockOf(avail[i])),
        D: () => runBlocks(newWorld(avail, avail), (i) => lateBlock[i]),
        E: () => runBlocks(newWorld(avail, coarse), () => 0),
        F: () => runBlocks(newWorld(avail, coarse), (i) => firstBlockOf(avail[i])),
        H: () => runBlocks(newWorld(avail, avail), (i) => firstBlockOf(avail[i]), true),
    };
    for (const k of Object.keys(runs)) {
        const r = runs[k]();
        res[k].push(r.w.credited); lvl[k].push(r.w.level); lost[k].push(r.w.done);
        diag[k].push({ mm: r.w.levelMismatch, sh: r.w.shifted, dead: r.w.lost.dead, char: r.w.lost.char, unused: r.unused });
        if (s === 1) first[k] = r;
    }
    if (s === 1 && process.env.VERBOSE) {
        // 盤面 1 の A (1日ぶんを1回) を読む: レベルごとの開放→踏破と、未使用の理由
        const plan = compute(solverInput(newWorld(avail, avail), 0, () => true));
        for (const lv of plan.levels) {
            const n = lv.bosses.reduce((t, b) => t + b.attacks.length, 0);
            const bottleneck = lv.bosses.flatMap(b => b.attacks.filter(a => a.isBottleneck).map(a => `${a.memberName} ${a.dmgB}B→B${b.bossNumber}`));
            console.log(`  Lv${lv.level} ${lv.openHourLabel ?? '-'}開始 → ${lv.levelCleared ? `${lv.clearHourLabel} 踏破` : (lv.infinite ? '無限' : '踏破できず')} · ${n}凸` + (bottleneck.length ? ` · 律速: ${bottleneck.join(' / ')}` : ''));
        }
        console.log(`  未使用 ${plan.unusedAttacks}凸: ` + (plan.unusedSummary || []).map(u => `${u.label} ${u.attacks} (${u.members.map(m => `${m.name}×${m.remaining}`).join(' ')})`).join(' / '));
        console.log(`  時間帯: ` + plan.levels.flatMap(lv => lv.bosses.flatMap(b => b.attacks)).length + '凸を配置 / credited ' + plan.totalCreditedB.toFixed(1) + 'B');
    }
}
const ceilingOf = () => (MEMBERS_SYNTH || MEMBERS_REAL).reduce((t, m) => t + Object.values(m.loadouts).flat().sort((a, b) => b.dmgB - a.dmgB).slice(0, 3).reduce((x, lo) => x + lo.dmgB, 0), 0);
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
console.log(process.env.BOARD === 'synth' ? `合成盤面 (30人・前日の状態) ${N} 通り / 倍率 ${process.env.SCALE || 1} / 時間厳守=${!!process.env.STRICT}` : `第44回の実データ: 30人・90凸・締め凸の代用 ${killSubst} 件・実績 2981B / 倍率 ${process.env.SCALE || 1} / 時間帯 ${N} 通り / 時間厳守=${!!process.env.STRICT}`);
console.log(`天井 (全員の上位3編成の合計・最後の盤面) = ${ceilingOf().toFixed(0)}B  ※ 合成盤面は盤面ごとに違う`);
console.log('scen  credited平均  中央値   p10    p90   | Aとの差(平均)  | Lv4到達 | 実行凸 | Lv違い ずれ 死体 被り 未使用');
for (const k of Object.keys(res)) {
    const dA = res[k].map((v, i) => v - res.A[i]);
    console.log(`${k}     ${mean(res[k]).toFixed(0).padStart(6)}B   ${q(res[k], 0.5).toFixed(0).padStart(5)}  ${q(res[k], 0.1).toFixed(0).padStart(5)}  ${q(res[k], 0.9).toFixed(0).padStart(5)}  | ${mean(dA).toFixed(0).padStart(5)}B (${(100 * mean(dA) / mean(res.A)).toFixed(1).padStart(5)}%) | ${String(lvl[k].filter(l => l >= 4).length).padStart(3)}/${N} | ${mean(lost[k]).toFixed(1)} | ${['mm','sh','dead','char','unused'].map(f => mean(diag[k].map(d => d[f])).toFixed(1).padStart(4)).join(' ')}`);
}
