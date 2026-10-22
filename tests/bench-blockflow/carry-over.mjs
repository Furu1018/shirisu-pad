// 実験 (2026-10-22): 朝が混んでいて、A = 朝だけ / B = 朝+夕方。B の 3 凸目の凸先が朝の時点で無い (そのボスは倒れている) とき、
//   朝のブロックで組むと B の 3 凸目はどうなるか → 朝の凸を実行したあと、夕方のブロックで組むと回ってくるか。
//   本物のソルバー + 本物のブロック定義 + 第44回の実データ (30 人)。流れは本番のブロック制 (そのブロックに出られる人だけで組み、そのブロックの凸だけ実行)
// 実行: node tests/bench-blockflow/carry-over.mjs
import * as m from './base.mjs';

const B5 = m.BOSSES.find(b => b.boss_number === 5);
const hk = (h) => `h${String(h).padStart(2, '0')}`;
const range = (a, b) => { const out = []; let h = a; for (;;) { out.push(hk(h)); if (h === b) break; h = (h + 1) % 24; } return out; };
const MORNING = range(5, 8), EVENING = range(18, 20), NIGHT = range(21, 23), AFTERNOON = range(12, 17);
const blockName = (idx) => m.BLOCKS[m.blockOf(idx)]?.name || '?';
const hourOf = (idx) => { const h = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4][idx]; return h <= 4 ? `翌${h}時` : `${h}時`; };

// B さん = ボス5 の弱点 (wind) を含めて 3 属性以上の模擬を持つ人 (最初に見つかった人)
const bIdx = m.MEMBERS.findIndex(p => p.loadouts[B5.weakness] && Object.keys(p.loadouts).length >= 3);
const B = m.MEMBERS[bIdx];
console.log(`B さん = ${B.name} (模擬: ${Object.entries(B.loadouts).map(([k, v]) => `${k} ${v.map(x => x.dmgB + 'B').join('/')}`).join(', ')})`);
console.log(`ボス: ${m.BOSSES.map(b => `B${b.boss_number}=${b.weakness}`).join(' ')} / ★ B5 (${B5.weakness}) は朝の時点で倒れている`);

function scenario(label, availOf) {
    const avail = m.MEMBERS.map((p, i) => availOf(i));
    const w = m.newWorld(avail);
    w.bosses[4].rem = 0;   // B5 は倒れている (B の wind の凸先が朝には無い)
    const morningIdx = m.BLOCKS.findIndex(b => b.name === '朝'), eveIdx = m.BLOCKS.findIndex(b => b.name === '夕方');
    const nMorning = avail.filter(sl => sl.some(k => m.blockOf(m.idxOf(k)) === morningIdx)).length;
    console.log(`\n=== ${label} (朝に出られる人 ${nMorning} 人)`);
    const runBlock = (k) => {
        const bk = m.BLOCKS[k];
        const inBlock = (p) => p.slots.some(h => m.blockOf(m.idxOf(h)) === k);
        const plan = m.REAL.compute(m.input(w, bk.from, inBlock, {}));
        const all = m.flatten(plan);
        const mine = all.filter(a => a.memberId === B.id).sort((x, y) => x.hourIdx - y.hourIdx);
        const lv2 = (plan.levels || []).find(l => l.level === 2);
        const un = (plan.unassigned || []).find(u => String(u.memberId) === String(B.id));
        console.log(`  🧱 ${bk.name} で組む: 踏破見込み Lv${plan.fullyClearedThrough || 0} / Lv2 の開放見込み ${lv2 && lv2.openHourIdx != null ? hourOf(lv2.openHourIdx) : '—'} / 配信される凸 ${all.filter(a => a.hourIdx >= bk.from && a.hourIdx < bk.to).length}`);
        console.log(`     B さんの計画: ${mine.map(a => `${hourOf(a.hourIdx)}(${blockName(a.hourIdx)}) Lv${a.level} B${a.bossNumber}`).join(' / ') || 'なし'}${un ? `  ※ 残り凸を使わなかった理由: ${un.reason}` : ''}`);
        m.execute(w, all, bk.from, bk.to);
        const me = w.players[bIdx];
        console.log(`     → ${bk.name} を実行: B さんの済み ${me.attacks.length} 凸 (残り ${3 - me.attacks.length}) / ユニオンは Lv${w.level}`);
    };
    runBlock(morningIdx);
    // 午前〜午後は朝の人と同じ扱いで素通り (このシナリオでは誰も出ない) → 夕方
    runBlock(eveIdx);
}

// ① 朝が混む: 朝だけの人 12 人 (A さんたち) + 朝と夕方の人 4 人 (B を含む) + 残りは午後/夕方/夜
scenario('① 朝が混む', (i) => {
    if (i === bIdx) return [...MORNING, ...EVENING];
    const r = i % 10;
    if (r <= 3) return MORNING;                                   // 朝だけ (12 人)
    if (r === 4) return [...MORNING, ...EVENING];                 // 朝+夕方
    if (r <= 6) return AFTERNOON;
    if (r <= 8) return EVENING;
    return NIGHT;
});
// ② 朝が少ない: 朝だけの人 4 人 + B。朝だけでは Lv1 を踏破できない
scenario('② 朝が少ない', (i) => {
    if (i === bIdx) return [...MORNING, ...EVENING];
    const r = i % 10;
    if (r === 0) return MORNING;                                  // 朝だけ (3 人)
    if (r <= 4) return AFTERNOON;
    if (r <= 7) return EVENING;
    return NIGHT;
});
