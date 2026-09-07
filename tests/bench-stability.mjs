// ============================================================================
// L1 安定化ベンチ — 「振り回しがどれだけ減ったか」と「その代償」を数える
//   node tests/bench-stability.mjs          (既定 150 盤面)
//   BENCH_N=400 node tests/bench-stability.mjs
// ----------------------------------------------------------------------------
// bench-crossboss.mjs は「ボス横断分岐が総与ダメを改善するか」を測るもので、
// 悪化0・踏破Lv低下0 が規約。L1 はそれとは目的が違う —
// **わざと最大 max(5%, 30B) の改善を捨てて、前回の約束を守る**。
// 同じ物差しでは評価できないので別系統にする (Codex 設計レビュー 2026-09-07)。
//
// 測るもの:
//   ① 同一盤面不変性  盤面が1つも変わっていなければ、前回の指示は1つも消えたり変わったりしない (必須)
//   ② 変化盤面の churn 盤面を1箇所だけ動かしたとき、前回から割当が変わる人数。
//                      安定化ありとなしで比べる (これが「振り回しがどれだけ減ったか」)
//   ③ 代償            安定化のために捨てた総与ダメ (通常解 − 安定解) の分布
//   ④ 安全性          約束を守った (applied) 盤面で、踏破Lvが下がっていないこと・
//                      時刻を確約できない凸が増えていないこと (どちらも必須・0件でなければ失敗)
//   ⑤ 採否の内訳      kept / clearLevel / timeRisk / creditedGain の件数
//
// 盤面生成は bench-crossboss.mjs と同じ規則にそろえてある (本番の実測分布で較正済み)。
// ★ 別の簡略データで測ると、キャラ被り・2編成目・時間帯が評価されず数字が良く出すぎる。
//
// ── 同一盤面不変性をどう成立させているか (2026-09-07 の経緯) ──────────────────
// 約束を先に置くと、貪欲の途中状態が「約束なしで解いたとき」と食い違う。
// 貪欲は ボスを埋める → オーバーキル圧縮で凸を外す (= その人の枠とキャラが戻る) → 次のボス、
// と進むので、圧縮で戻った枠が次のボスの選択を変える。約束は圧縮後の結果なので、
// 置いた時点ではその「戻り」が起きず、以降の選択がずれる。温存パス (Lv4) も同じ理由でずれる。
// このため素朴に実装すると、**盤面が1つも動いていないのに約束が壊れる**盤面が 4.5% あった。
//
// 効かなかった対策 (入れていない):
//   ・後のレベルの約束ぶんの枠を予約する → 壊れた人数が 163 → 188 に**悪化** (待つ間に出せる凸を失う)
//   ・約束を「そのボスを埋める直前」に置く (貪欲と同じ順序) → 166 とほぼ変わらず
//
// 効いた対策: **採否の判定に「どちらが約束を多く守れたか」を入れた** (`countStickyKept`)。
// 拘束解が通常解より守れていないなら拘束解を採る意味がないので通常解へ倒す。
// 盤面が動いていないとき通常解は前回そのもの = 全部守れているので、必ず通常解が選ばれる。
// これで 4.5% → 0% になった。
// ============================================================================
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = { window: {}, globalThis: null, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'js', 'optimal-plan.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'js', 'domain', 'planDiff.js'), 'utf8'), ctx);
const compute = ctx.computeOptimalPlanCore || ctx.window.computeOptimalPlanCore;
const planDiff = ctx.planDiffDomain || ctx.window.planDiffDomain;

// ---- 盤面生成 (bench-crossboss.mjs と同じ規則) -------------------------------
const ATTRS = ['fire', 'water', 'electric', 'iron', 'wind'];
const HOURS = ['h05', 'h09', 'h13', 'h17', 'h21'];
const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
const TIERS = ['lord', 'lord', 'tyrant', 'lord', 'tyrant'];
const HP = {
    1: { lord: 29.9568837600, tyrant: 44.9353256400 },
    2: { lord: 99.8562792000, tyrant: 149.7844188000 },
    3: { lord: 199.7125584000, tyrant: 299.5688376000 },
};
const P_SHARE2 = 0.12, P_SHARE1 = 0.05, P_SLOT2 = 0.3;

function board(seed) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (n) => Math.floor(rnd() * n);
    const shuffled = (arr) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) { const j = pick(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    };
    const order = shuffled(ATTRS);
    const level = 1 + pick(3);
    const bosses = order.map((attr, k) => {
        const totalB = HP[level][TIERS[k]];
        return {
            boss_number: k + 1, boss_code: `T${k + 1}`, name: `テストボス${k + 1}`,
            attribute: attr, weakness: COUNTER[attr], tier: TIERS[k],
            total_hp_raw: totalB * 1e9,
            remaining_hp_raw: totalB * (0.15 + rnd() * 0.85) * 1e9,
        };
    });
    const n = 6 + pick(25);
    const players = [];
    for (let p = 0; p < n; p++) {
        const dmg = {}, teams = {}, loadouts = {};
        const pool = shuffled(Object.values(COUNTER)).slice(0, rnd() < 0.9 ? 5 : 4);
        const team1 = {}, nextSlot = {};
        pool.forEach(a => { team1[a] = [1, 2, 3, 4, 5].map(k => `${p}_${a}_${k}`); nextSlot[a] = 0; });
        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < pool.length; j++) {
                const a = pool[i], b = pool[j];
                const r = rnd();
                const cnt = r < P_SHARE2 ? 2 : r < P_SHARE2 + P_SHARE1 ? 1 : 0;
                for (let k = 0; k < cnt; k++) {
                    if (nextSlot[a] >= 5 || nextSlot[b] >= 5) break;
                    const shared = `${p}_共有_${a}-${b}_${k}`;
                    team1[a][nextSlot[a]++] = shared;
                    team1[b][nextSlot[b]++] = shared;
                }
            }
        }
        pool.forEach(a => {
            const base = Math.round((4 + rnd() * 24) * 2) / 2;
            const los = [{ dmgB: base, team: team1[a], slot: 1 }];
            if (rnd() < P_SLOT2) {
                los.push({
                    dmgB: Math.round((base * (0.7 + rnd() * 0.25)) * 2) / 2,
                    team: [1, 2, 3, 4, 5].map(k => `${p}_${a}_alt${k}`), slot: 2,
                });
            }
            dmg[a] = base; teams[a] = los[0].team; loadouts[a] = los;
        });
        const bossOfAttr = new Map(bosses.map(b => [b.weakness, b.boss_number]));
        const done = pick(4);
        const attacks = [];
        for (let k = 0; k < done && k < pool.length; k++) {
            const a = pool[k];
            attacks.push({ boss_number: bossOfAttr.get(a), characters: [...loadouts[a][0].team] });
        }
        players.push({
            id: `p${p}`, name: `M${p}`, syncLevel: 300 + pick(400), attackCount: attacks.length,
            damagesByAttr: dmg, teamsByAttr: teams, loadoutsByAttr: loadouts, attacks,
            availableSlots: rnd() < 0.4 ? HOURS.filter(() => rnd() < 0.6) : [],
            strong_attributes: rnd() < 0.3 ? pool.slice(0, 2) : [],
        });
    }
    return { season: { current_level: level }, bosses, players, currentSlot: HOURS[pick(5)], timeAware: rnd() < 0.7 };
}

// ---- 盤面を1箇所だけ動かす (当日に実際に起きること) --------------------------
// ★ 「配信したあとに何が起きて再算出になるか」を再現する。第44回の実ログでは
//   凸報告 58 / 時間帯の変更 147 / 模擬提出 295 / HP更新 が動いていた
const PERTURB = {
    hp: (inp) => {   // 誰かが凸してボスのHPが減った (運営がHPを更新した)
        const b = inp.bosses.find(x => x.remaining_hp_raw > 0);
        if (b) b.remaining_hp_raw = Math.max(1e9, b.remaining_hp_raw * 0.6);
        return 'HP減';
    },
    attack: (inp, base) => {   // プランどおりに1人が凸を済ませた
        const rows = planDiff.rowsByPlayer(base);
        for (const [id, list] of rows) {
            const p = inp.players.find(x => String(x.id) === String(id));
            if (!p || p.attackCount >= 3 || !list.length) continue;
            const r = list[0];
            p.attacks = [...(p.attacks || []), { boss_number: r.bossNumber, characters: r.team || [] }];
            p.attackCount = p.attacks.length;
            return '実凸';
        }
        return '実凸(対象なし)';
    },
    avail: (inp) => {   // 誰かが戦闘可能時間を変えた
        const p = inp.players.find(x => (x.availableSlots || []).length > 0);
        if (p) p.availableSlots = [HOURS[HOURS.length - 1]];
        return '時間帯';
    },
    loadout: (inp) => {   // 誰かが模擬を出し直した (ダメージが少し変わる)
        const p = inp.players.find(x => Object.keys(x.loadoutsByAttr || {}).length > 0);
        if (p) {
            const a = Object.keys(p.loadoutsByAttr)[0];
            p.loadoutsByAttr[a][0].dmgB = Math.round(p.loadoutsByAttr[a][0].dmgB * 1.15 * 2) / 2;
            p.damagesByAttr[a] = Math.max(...p.loadoutsByAttr[a].map(x => x.dmgB));
        }
        return '模擬再提出';
    },
};
const PERTURB_KEYS = Object.keys(PERTURB);

// ---- 物差し ------------------------------------------------------------------
const creditedOf = (plan) => Number(plan.totalCreditedB) || 0;
const riskOf = (plan) => (plan.levels || []).flatMap(lv => (lv.bosses || []).flatMap(b => b.attacks || []))
    .reduce((t, a) => t + (a.timeMismatch ? 2 : 0) + (a.flex ? 1 : 0), 0);
const churn = (prev, next) => planDiff.diffPlans(prev, next).changed.length;

// ★ 「約束が壊れた人数」— 前回の割当が**1つでも消えた/変わった**人だけを数える。
//   凸が増えるのは振り回しではない (前の指示はそのまま有効で、上乗せされただけ) ので分けて数える。
//   これが L1 の本命の指標。churn は追加も含むので、そのままだと安定化を過小評価する
function promiseStats(prev, next) {
    const P = planDiff.rowsByPlayer(prev), Nx = planDiff.rowsByPlayer(next);
    const key = (r) => `${planDiff.coreKey(r)}|${planDiff.timeKey(r)}|${planDiff.teamKey(r)}`;
    let broken = 0, added = 0;
    P.forEach((prevRows, id) => {
        const pool = (Nx.get(id) || []).map(key);
        let ok = true;
        for (const r of prevRows) {
            const i = pool.indexOf(key(r));
            if (i < 0) { ok = false; break; }
            pool.splice(i, 1);   // 同じ行は1回しか使わない (多重集合の包含判定)
        }
        if (!ok) broken++;
        else if (pool.length > 0) added++;
    });
    return { broken, added };
}
const pct = (arr, q) => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
};
const fmt = (v, d = 1) => Number(v).toFixed(d);

// ---- 実行 --------------------------------------------------------------------
const N = Number(process.env.BENCH_N || 150);
// 同一盤面で約束が壊れてよい割合。**0 が正**。
// 予算という形にしてあるのは、将来ソルバーを触ったときに「何%まで許すか」の議論を
// コードの上でできるようにするため。上げるときは上の経緯を読んでからにすること
const IDENTITY_BUDGET = 0;
let errors = 0;
let identityBroken = 0;              // ① 同一盤面なのに**約束が壊れた** (必須0)
let identityAdded = 0;               // ① 同一盤面で凸が上乗せされただけ (害はない・参考値)
let clearLevelDrops = 0;             // ④ 約束を守った結果、踏破Lvが下がった (必須0)
let riskIncreases = 0;               // ④ 約束を守った結果、確約できない凸が増えた (必須0)
const reasons = {};
const churnStickyAll = [], churnNormalAll = [], costAll = [];
const byPerturb = {};

for (let i = 1; i <= N; i++) {
    const seed = i * 7919;
    let base;
    try {
        base = compute(structuredClone(board(seed)));
    } catch (e) { errors++; console.error(`  例外 (base) seed ${seed}: ${e && e.message}`); continue; }

    // ① 同一盤面不変性: 盤面が変わっていないなら、前回の約束は1つも壊れてはいけない。
    //    (凸が上乗せされるのは可 — 前の指示は有効なままで、空いていた枠が埋まっただけ)
    try {
        const again = compute({ ...structuredClone(board(seed)), previousPlan: base });
        const s = promiseStats(base, again);
        if (s.broken > 0) {
            identityBroken++;
            if (identityBroken <= 3) console.error(`  ⚠ 同一盤面で ${s.broken} 人の約束が壊れた (seed ${seed})`);
        }
        if (s.added > 0) identityAdded++;
    } catch (e) { errors++; console.error(`  例外 (同一) seed ${seed}: ${e && e.message}`); }

    // ②〜⑤ 盤面を1箇所だけ動かす (seed ごとに種類を回す)
    const key = PERTURB_KEYS[i % PERTURB_KEYS.length];
    const inp2 = structuredClone(board(seed));
    let label;
    try { label = PERTURB[key](inp2, base); } catch { label = key; }
    let normal, sticky;
    try {
        normal = compute(structuredClone(inp2));
        sticky = compute({ ...structuredClone(inp2), previousPlan: base });
    } catch (e) { errors++; console.error(`  例外 (${key}) seed ${seed}: ${e && e.message}`); continue; }

    const st = sticky.stability || { applied: false, reason: 'none' };
    reasons[st.reason] = (reasons[st.reason] || 0) + 1;

    const cN = promiseStats(base, normal).broken, cS = promiseStats(base, sticky).broken;
    const cost = creditedOf(normal) - creditedOf(sticky);
    churnNormalAll.push(cN); churnStickyAll.push(cS); costAll.push(cost);
    if (!byPerturb[label]) byPerturb[label] = { n: 0, cN: 0, cS: 0, cost: 0, kept: 0 };
    const g = byPerturb[label];
    g.n++; g.cN += cN; g.cS += cS; g.cost += cost; if (st.applied) g.kept++;

    // ④ 安全性: 約束を守った盤面で踏破が下がる/時間リスクが増えるのは設計違反
    if (st.applied) {
        if (sticky.fullyClearedThrough < normal.fullyClearedThrough) {
            clearLevelDrops++;
            if (clearLevelDrops <= 3) {
                console.error(`  ❌ 約束を守って踏破Lvが下がった (seed ${seed} / ${label}): `
                    + `${sticky.fullyClearedThrough} < ${normal.fullyClearedThrough}`);
            }
        }
        if (riskOf(sticky) > riskOf(normal)) {
            riskIncreases++;
            if (riskIncreases <= 3) {
                console.error(`  ❌ 約束を守って確約できない凸が増えた (seed ${seed} / ${label}): `
                    + `${riskOf(sticky)} > ${riskOf(normal)}`);
            }
        }
    }
}

// ---- 結果 --------------------------------------------------------------------
const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
console.log(`\n盤面 ${N} 件 (例外 ${errors} 件)`);
const identityRate = N > 0 ? identityBroken / N : 0;
const identityOk = identityRate <= IDENTITY_BUDGET;
console.log(`\n① 同一盤面不変性: 約束が壊れた盤面 ${identityBroken}/${N} (${fmt(identityRate * 100, 1)}%) `
    + `${identityOk ? '✅' : '❌'} 予算 ${fmt(IDENTITY_BUDGET * 100, 0)}%`);
console.log(`   (前回と同じ盤面で組み直しても、前回の指示が1つも消えたり変わったりしないこと)`);
console.log(`   ★ 成立の経緯と、効かなかった対策はこのファイルの冒頭を参照`);
console.log(`   参考: 凸が上乗せされただけの盤面 ${identityAdded} 件 (前の指示は有効なままなので害はない)`);

console.log(`\n② 振り回し (前回の約束が壊れた人数)`);
console.log(`   安定化なし  平均 ${fmt(avg(churnNormalAll), 2)} / 中央 ${pct(churnNormalAll, 0.5)} / p95 ${pct(churnNormalAll, 0.95)} / 最大 ${Math.max(0, ...churnNormalAll)}`);
console.log(`   安定化あり  平均 ${fmt(avg(churnStickyAll), 2)} / 中央 ${pct(churnStickyAll, 0.5)} / p95 ${pct(churnStickyAll, 0.95)} / 最大 ${Math.max(0, ...churnStickyAll)}`);
const before = sum(churnNormalAll), after = sum(churnStickyAll);
console.log(`   のべ ${before} 人 → ${after} 人 (${before > 0 ? fmt((1 - after / before) * 100) : '0.0'}% 減)`);

console.log(`\n③ 代償 (安定化のために捨てた与ダメ: 通常解 − 安定解)`);
console.log(`   平均 ${fmt(avg(costAll), 2)}B / 中央 ${fmt(pct(costAll, 0.5), 1)}B / p95 ${fmt(pct(costAll, 0.95), 1)}B / 最大 ${fmt(Math.max(0, ...costAll), 1)}B`);

console.log(`\n④ 安全性 (約束を守った盤面で)`);
console.log(`   踏破Lv低下 ${clearLevelDrops} 件 ${clearLevelDrops === 0 ? '✅' : '❌'} / 時間リスク増 ${riskIncreases} 件 ${riskIncreases === 0 ? '✅' : '❌'}`);

console.log(`\n⑤ 採否の内訳`);
const REASON_JP = { kept: '約束を守った', clearLevel: '踏破が上がるので組み直し', timeRisk: '時間リスク増で組み直し', lessKept: '拘束解の方が約束を壊すので組み直し', creditedGain: '与ダメ改善で組み直し', error: '拘束解で例外', none: '判定なし' };
Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`   ${String(REASON_JP[k] || k).padEnd(22, '　')} ${v} 件`));

console.log(`\n⑥ 盤面の動き別`);
Object.entries(byPerturb).sort().forEach(([k, g]) => {
    const line = `   ${k.padEnd(12, '　')} n=${String(g.n).padStart(3)}  振り回し ${fmt(g.cN / g.n, 2)} → ${fmt(g.cS / g.n, 2)} 人`
        + `  代償 ${fmt(g.cost / g.n, 2)}B  守った ${g.kept}/${g.n}`;
    console.log(line);
});

const failed = errors > 0 || !identityOk || clearLevelDrops > 0 || riskIncreases > 0;
console.log(failed ? '\n❌ 規約違反あり' : '\n✅ 同一盤面で動かない / 踏破を下げない / 時間リスクを増やさない');
process.exit(failed ? 1 : 0);
