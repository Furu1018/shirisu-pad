// ふるりの方針 (2026-10-22): 遅い時間に凸できる人 (最初に出られるブロックが夕方以降) はボス5 の弱点の模擬を 2 編成出す。
//   朝・昼の人は今のまま (できる範囲で出して Lv1〜3 の消化)。残る凸がどれだけ減るかを、本番のブロック制の流れで測る。
//   2 編成目は「キャラが被らない別の編成」として足す (ダメージは 1 編成目の 0.85 倍。持っていない人は他の属性の中央値の 0.9 / 0.8 倍)
// 実行: node tests/bench-blockflow/boss5-two-teams.mjs   (BENCH_N=40 / SCALE=1.3 で強さを変える)
import * as m from './base.mjs';
const B5W = m.BOSSES.find(b => b.boss_number === 5).weakness;
const EVE = m.BLOCKS.findIndex(b => b.name === '夕方');
const N = Number(process.env.BENCH_N || 40);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 10; };
function run(PAT, policy) {
  const out = { left: 0, leftLate: 0, leftEarly: 0, cred: 0, late: 0 };
  for (let s = 1; s <= N; s++) {
    const rnd = m.rng(s * 7919);
    const avail = m.MEMBERS.map(() => PAT[Math.floor(rnd() * PAT.length)]());
    const w = m.newWorld(avail);
    const firstBlock = avail.map(sl => Math.min(...sl.map(k => m.blockOf(m.idxOf(k)))));
    const lastBlock = avail.map(sl => Math.max(...sl.map(k => m.blockOf(m.idxOf(k)))));
    const isLate = (i) => lastBlock[i] >= EVE;   // 夕方以降にも出られる人
    w.players.forEach((p, i) => {
      if (!policy || !isLate(i)) return;
      const lo = Object.fromEntries(Object.entries(p.loadouts).map(([k, v]) => [k, v.map(x => ({ ...x, team: x.team.slice() }))]));
      const others = Object.entries(lo).filter(([k]) => k !== B5W).flatMap(([, v]) => v.map(x => x.dmgB));
      const have = lo[B5W] || [];
      const mk = (dmgB, n) => ({ dmgB: Math.round(dmgB * 100) / 100, team: [1, 2, 3, 4, 5].map(k => `${p.id}_b5_${n}_${k}`), slot: n });
      if (have.length === 0) lo[B5W] = [mk(median(others) * 0.9, 1), mk(median(others) * 0.8, 2)];
      else if (have.length === 1) lo[B5W] = [have[0], mk(have[0].dmgB * 0.85, 2)];
      p.loadouts = lo;
    });
    m.BLOCKS.forEach((bk, k) => {
      const inBlock = (p) => p.slots.some(h => m.blockOf(m.idxOf(h)) === k);
      const vis = (p) => firstBlock[w.players.indexOf(p)] <= k && inBlock(p);
      if (!w.players.some(vis)) return;
      const plan = m.REAL.compute(m.input(w, bk.from, vis, {}));
      m.execute(w, m.flatten(plan), bk.from, bk.to);
    });
    w.players.forEach((p, i) => { const l = 3 - p.attacks.length; out.left += l; if (isLate(i)) { out.leftLate += l; } else out.leftEarly += l; });
    out.late += w.players.filter((_, i) => isLate(i)).length;
    out.cred += w.credited;
  }
  for (const k of Object.keys(out)) out[k] /= N;
  return out;
}
const f = (x) => x.toFixed(1).padStart(5);
for (const [label, PAT] of [['集中 (夜に寄る)', m.CONC], ['散らばり', m.SPREAD]]) {
  const a = run(PAT, false), b = run(PAT, true);
  console.log(`${label} ×${process.env.SCALE || 1} (夕方以降に出られる人 ${a.late.toFixed(1)} 人): 残った凸 ${f(a.left)} → ${f(b.left)}  [遅い人 ${f(a.leftLate)} → ${f(b.leftLate)} / 朝・昼だけの人 ${f(a.leftEarly)} → ${f(b.leftEarly)}]  与ダメ ${a.cred.toFixed(0)}B → ${b.cred.toFixed(0)}B`);
}
