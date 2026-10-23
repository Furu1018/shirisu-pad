// 🧱 ブロックで組むと、そのブロックの人だけでは Lv を削り切れず「踏破できないレベル」(吸収モード = 撃破を狙わずオーバーキル最小) に
//   落ちやすい。本当は後ろのブロックの人が続きを削るので、ブロックの中では撃破を狙ったほうが 1 日の与ダメ・踏破が伸びるのでは?
//   を本番のブロック制の流れで測る (2026-10-23 の全体監査・観点 A)。
//   比べるのは 従来 (吸収モード) / frontierKill (撃破狙いのまま) の 2 つ。各ブロックの頭に「そのブロックの人」で組んで、そのブロックの凸だけ実行。
// 実行: node tests/bench-blockflow/frontier-kill.mjs   (BENCH_N=40 / SCALE=1.3 で強さを変える)
import * as m from './base.mjs';
const N = Number(process.env.BENCH_N || 40);
const SCALE = Number(process.env.SCALE || 1);
function run(PAT, extra) {
    const out = { cred: 0, left: 0, lv: 0, lv4: 0 };
    for (let s = 1; s <= N; s++) {
        const rnd = m.rng(s * 7919);
        const avail = m.MEMBERS.map(() => PAT[Math.floor(rnd() * PAT.length)]());
        const w = m.newWorld(avail);
        // ★ newWorld は MEMBERS を浅くコピーするので loadouts は共有 — 書き換えずに新しい表を作る (boss5-two-teams と同じ)
        if (SCALE !== 1) w.players.forEach(p => { p.loadouts = Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, v.map(lo => ({ ...lo, dmgB: Math.round(lo.dmgB * SCALE * 100) / 100, team: lo.team.slice() }))])); });
        const firstBlock = avail.map(sl => Math.min(...sl.map(k => m.blockOf(m.idxOf(k)))));
        m.BLOCKS.forEach((bk, k) => {
            const inBlock = (p) => p.slots.some(h => m.blockOf(m.idxOf(h)) === k);
            const vis = (p) => firstBlock[w.players.indexOf(p)] <= k && inBlock(p);
            if (!w.players.some(vis)) return;
            const plan = m.REAL.compute(m.input(w, bk.from, vis, extra));
            m.execute(w, m.flatten(plan), bk.from, bk.to);
        });
        out.cred += w.credited;
        out.left += w.players.reduce((t, p) => t + (3 - p.attacks.length), 0);
        out.lv += w.level;
        if (w.level >= 4) out.lv4++;
    }
    for (const k of Object.keys(out)) out[k] /= N;
    return out;
}
const f = (x) => x.toFixed(1).padStart(7);
for (const [label, PAT] of [['集中 (夜に寄る)', m.CONC], ['散らばり', m.SPREAD]]) {
    const a = run(PAT, { secondB5Lv4Only: true, excludeTimeUnknown: true });
    const b = run(PAT, { secondB5Lv4Only: true, excludeTimeUnknown: true, frontierKill: true });
    console.log(`${label} ×${SCALE} (${N} 盤面の平均): 与ダメ ${f(a.cred)}B → ${f(b.cred)}B  / 残った凸 ${f(a.left)} → ${f(b.left)}  / 日の終わりの Lv ${a.lv.toFixed(2)} → ${b.lv.toFixed(2)}  / Lv4 が開いた盤面 ${(a.lv4 * 100).toFixed(0)}% → ${(b.lv4 * 100).toFixed(0)}%`);
}
