// 今の強さ (×1) で方針を入れると残る凸が増える理由: 実行できなかった凸の内訳 / ボス5 が Lv3 で倒れたか / 計画の時点で割り当てなし
// 実行: node tests/bench-blockflow/boss5-why.mjs   (集中の型・40 通り)
import * as m from './base.mjs';
const B5W = m.BOSSES.find(b => b.boss_number === 5).weakness;
const EVE = m.BLOCKS.findIndex(b => b.name === '夕方');
const N = Number(process.env.BENCH_N || 40);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 10; };
for (const policy of [false, true]) {
  const why = { dead: 0, char: 0, spent: 0 }; let b5dead = 0, lv = 0, noPlan = 0;
  for (let s = 1; s <= N; s++) {
    const rnd = m.rng(s * 7919);
    const avail = m.MEMBERS.map(() => m.CONC[Math.floor(rnd() * m.CONC.length)]());
    const w = m.newWorld(avail);
    const firstBlock = avail.map(sl => Math.min(...sl.map(k => m.blockOf(m.idxOf(k)))));
    const lastBlock = avail.map(sl => Math.max(...sl.map(k => m.blockOf(m.idxOf(k)))));
    w.players.forEach((p, i) => {
      if (!policy || lastBlock[i] < EVE) return;
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
      const list = m.flatten(plan).filter(a => a.hourIdx >= bk.from && a.hourIdx < bk.to).sort((x, y) => x.hourIdx - y.hourIdx || x.level - y.level);
      for (const a of list) {
        const p = w.players.find(x => x.id === a.memberId);
        if (p.attacks.length >= 3) { why.spent++; continue; }
        if (a.team.some(c => p.used.has(c))) { why.char++; continue; }
        if (w.level < 4) { const b = w.bosses[a.bossNumber - 1]; if (b.rem <= 1e-9) { why.dead++; continue; } }
        m.execute(w, [a], a.hourIdx, a.hourIdx + 1);
      }
    });
    if (w.level === 3 && w.bosses[4].rem <= 1e-9) b5dead++;
    lv += w.level;
    noPlan += w.players.reduce((t, p) => t + (3 - p.attacks.length), 0);
  }
  console.log(`${policy ? '方針あり' : '今のまま'}: 残った凸 ${(noPlan / N).toFixed(1)} / 実行できなかった計画 (倒れたボス ${(why.dead / N).toFixed(1)} · キャラ被り ${(why.char / N).toFixed(1)}) / Lv3 でボス5 が倒れた盤面 ${b5dead}/${N} / 到達 Lv ${(lv / N).toFixed(2)}`);
}
