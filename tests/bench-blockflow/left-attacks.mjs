// 残った凸の内訳: その人がボス 5 (Lv4 で唯一残るボス) の弱点の編成を持っているか / Lv4 が開いた時刻
// 実行: node tests/bench-blockflow/left-attacks.mjs   (SCALE=1.3 で強さを変える)
import * as m from './base.mjs';
const B5W = m.BOSSES.find(b => b.boss_number === 5).weakness;
const N = Number(process.env.BENCH_N || 40);
for (const [label, PAT] of [['集中', m.CONC], ['散らばり', m.SPREAD]]) {
  let leftHas = 0, leftNo = 0, lv4Block = [];
  for (let s = 1; s <= N; s++) {
    const rnd = m.rng(s * 7919);
    const avail = m.MEMBERS.map(() => PAT[Math.floor(rnd() * PAT.length)]());
    const w = m.newWorld(avail);
    const firstBlock = avail.map(sl => Math.min(...sl.map(k => m.blockOf(m.idxOf(k)))));
    let lv4At = null;
    m.BLOCKS.forEach((bk, k) => {
      const inBlock = (p) => p.slots.some(h => m.blockOf(m.idxOf(h)) === k);
      const vis = (p) => firstBlock[w.players.indexOf(p)] <= k && inBlock(p);
      if (!w.players.some(vis)) return;
      const plan = m.REAL.compute(m.input(w, bk.from, vis, {}));
      m.execute(w, m.flatten(plan), bk.from, bk.to);
      if (lv4At == null && w.level >= 4) lv4At = bk.name;
    });
    lv4Block.push(lv4At || '開かない');
    w.players.forEach(p => { const left = 3 - p.attacks.length; if (left > 0) { if ((p.loadouts[B5W] || []).length) leftHas += left; else leftNo += left; } });
  }
  const cnt = {}; lv4Block.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  console.log(`${label} ×${process.env.SCALE || 1}: 残った凸 (1 盤面あたり) — ボス5 の弱点 (${B5W}) の編成なし ${(leftNo / N).toFixed(1)} / あり ${(leftHas / N).toFixed(1)} · Lv4 が開いたブロック ${JSON.stringify(cnt)}`);
}
