// ============================================================================
// ボス横断分岐 (フェーズ2) の効果測定
//   node tests/bench-crossboss.mjs             現行 vs crossBoss:false (採用可否の判定に使う)
//   node tests/bench-crossboss.mjs <旧実装.js>  現行 vs 指定実装
//                                              (例: git show <sha>:js/optimal-plan.js > /tmp/old.js)
//
// 乱数盤面は自前LCG + Fisher-Yates で生成する。**Array#sort に乱数比較関数を渡さないこと** —
// 比較関数の契約 (一貫した順序) を破るとソート実装依存で乱数の消費順が変わり、
// 「seed 固定なら誰が実行しても同じ盤面」が成立しなくなる。
//
// 盤面は本番の前提に合わせてある (js/supabase-client.js の SEASON_WEAKNESS_BY_ATTR と
// supabaseQuickCreateTestSeason のティア配分、js/optimal-plan.js の HARD_LEVEL_HP_B):
//   - 弱点(=持っていくPT属性) は fire→water / water→electric / iron→wind /
//     electric→iron / wind→fire
//   - ティアは B1,B2,B4 = lord / B3,B5 = tyrant
//   - 総HPは本番のレベル別定数 (Lv1 lord 99.9B / tyrant 150.8B …)
//   - 人数は NIKKE のユニオン上限に合わせて最大30人
//   - **loadoutsByAttr を渡す** (1属性2編成 + キャラ名)。damagesByAttr だけだと
//     slot/ord・同属性2凸・キャラ被りが一切評価されず、フェーズ1〜2の本題が抜ける
//
// キャラ被りの強さは **本番 player_damages の実測分布** に合わせてある
// (2026-08-03 時点・46人227編成を集計):
//   - 1人あたり編成数 平均4.9 (ほぼ全員が5属性提出)
//   - 1人が使う総キャラ種類数 平均21.8 / 25枠 → 被りは「たまに起きる」程度
//   - 編成ペアの共通キャラ数 平均0.30 (0が83% / 1が5% / 2が12%)
// ※ここを盛る (全員が少数の汎用キャラを使い回す設定にする) と、
//   全員が1日1凸しかできない退化盤面になり測定値が意味を失う
//
// **悪化0・踏破Lv低下0 が採用条件** (分岐は基準解を下回ってはいけない)。
// 実行時間は端末・負荷に依存するので、完全一致ではなく桁の目安として見ること。
// ============================================================================
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (p) => {
    const g = {};
    const c = { console, Math, JSON, Date, Set, Map, WeakMap, WeakSet, Array, Object, Number, String, globalThis: g };
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(p, 'utf8'), c);
    return g.computeOptimalPlanCore;
};
const F = load(path.join(HERE, '..', 'js', 'optimal-plan.js'));
const OTHER = process.argv[2] ? load(process.argv[2]) : null;
const baselineOf = (inp) => (OTHER
    ? OTHER(structuredClone(inp))
    : F({ ...structuredClone(inp), crossBoss: false }));

const ATTRS = ['fire', 'water', 'electric', 'iron', 'wind'];
const HOURS = ['h05', 'h09', 'h13', 'h17', 'h21'];
const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
const TIERS = ['lord', 'lord', 'tyrant', 'lord', 'tyrant'];   // B1,2,4=lord / B3,5=tyrant
const HP = {   // js/optimal-plan.js の HARD_LEVEL_HP_B と一致させること
    1: { lord: 99.8562792, tyrant: 150.8418136 },
    2: { lord: 149.7844188, tyrant: 226.2627204 },
    3: { lord: 292.44529575, tyrant: 349.2309015 },
};
// 実測の共通キャラ数分布 (0:83% / 1:5% / 2:12%) を属性ペアごとに再現する確率
const P_SHARE2 = 0.12, P_SHARE1 = 0.05;
// 同属性2編成 (slot=2) の提出率。**実測は 0%** (誰もまだ2編成目を出していない) だが、
// 0 にすると slot/ord の探索が一切評価されないため、フェーズ3で目指す状態を想定して 30% にしてある。
// 「本番の現状」ではなく「本番で目指す状態」を測っている点に注意
const P_SLOT2 = 0.3;
// レベル別測定 (31_player_damages_levels) を持つ編成の割合。想定運用:
// 高レベルで測り直した値が levels{'0':旧値, L:新値} の形で追記される。
// 0 にするとレベル解決 (resolveAtLevel) が一度も評価されないため 25% にしてある
const P_LEVELED = 0.25;

function board(seed) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (n) => Math.floor(rnd() * n);
    const shuffled = (arr) => {                       // Fisher-Yates (乱数の消費順が実装に依存しない)
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) { const j = pick(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    };
    // 5属性がボス1〜5に毎シーズン別の順で割り当たる
    const order = shuffled(ATTRS);
    const level = 1 + pick(3);
    const bosses = order.map((attr, k) => {
        const totalB = HP[level][TIERS[k]];            // 本番のレベル別HP
        return {
            boss_number: k + 1, boss_code: `T${k + 1}`, name: `テストボス${k + 1}`,
            attribute: attr, weakness: COUNTER[attr], tier: TIERS[k],
            total_hp_raw: totalB * 1e9,
            remaining_hp_raw: totalB * (0.15 + rnd() * 0.85) * 1e9,   // 残HP <= 総HP
        };
    });
    const n = 6 + pick(25);                            // 6〜30人 (ユニオン上限)
    const players = [];
    for (let p = 0; p < n; p++) {
        const dmg = {}, teams = {}, loadouts = {};
        // 実測ではほぼ全員が5属性提出 (平均4.9編成)
        const pool = shuffled(Object.values(COUNTER)).slice(0, rnd() < 0.9 ? 5 : 4);
        // まず属性ごとに完全に独立した編成を作る (この時点で共通キャラ0)
        const team1 = {}, nextSlot = {};
        pool.forEach(a => {
            team1[a] = [1, 2, 3, 4, 5].map(k => `${p}_${a}_${k}`);
            nextSlot[a] = 0;
        });
        // 実測分布に合わせて属性ペア単位で共通キャラを注入する。
        // **「片方の編成のキャラを他方へコピーする」方式は使わない** — 同じキャラが
        // 3編成以上へファンアウトし、ペアが独立でなくなる。実測では
        // 「1人の中で3編成以上に登場するキャラ」は 0件 (被りは必ず2編成のみ)。
        // そこでペア専用の新キャラを作り、その2編成の空き枠にだけ入れる
        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < pool.length; j++) {
                const a = pool[i], b = pool[j];
                const r = rnd();
                const n = r < P_SHARE2 ? 2 : r < P_SHARE2 + P_SHARE1 ? 1 : 0;
                for (let k = 0; k < n; k++) {
                    if (nextSlot[a] >= 5 || nextSlot[b] >= 5) break;   // 枠切れ
                    const shared = `${p}_共有_${a}-${b}_${k}`;
                    team1[a][nextSlot[a]++] = shared;
                    team1[b][nextSlot[b]++] = shared;
                }
            }
        }
        pool.forEach(a => {
            const base = Math.round((4 + rnd() * 24) * 2) / 2;
            const lo1 = { dmgB: base, team: team1[a], slot: 1 };
            // レベル別測定: 一部の編成は「未指定の旧値 + 高レベルで測り直した低めの値」を持つ
            // (levels のミラー不変条件: dmgB = 最大値)
            if (rnd() < P_LEVELED) {
                const lv = 2 + Math.floor(rnd() * 3);               // 2〜4
                const lower = Math.round((base * (0.75 + rnd() * 0.2)) * 2) / 2;
                lo1.levels = { '0': base, [String(lv)]: lower };
                lo1.level = null;
            }
            const los = [lo1];
            // 同属性2編成目。**slot1 と1人も被らせないこと** — 1人でも共有すると
            // 2編成目は必ずキャラ被りで除外され、slot/ord が一度も評価されない
            if (rnd() < P_SLOT2) {
                los.push({
                    dmgB: Math.round((base * (0.7 + rnd() * 0.25)) * 2) / 2,
                    team: [1, 2, 3, 4, 5].map(k => `${p}_${a}_alt${k}`), slot: 2,
                });
            }
            dmg[a] = base;
            teams[a] = los[0].team;
            loadouts[a] = los;
        });
        // 凸済みは「実際に出した編成」を持たせる (キャラ消費が正しく効くか評価するため)。
        // **boss_number はその属性が弱点のボスにすること** — ソルバーは boss_number から
        // 消費した属性を逆引きするので、ランダムだと別属性の上位編成を誤って消費する
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
    return {
        season: { current_level: level }, bosses, players,
        currentSlot: HOURS[pick(5)], timeAware: rnd() < 0.7,
    };
}

const N = 2000;
let up = 0, down = 0, same = 0, sum = 0, lvUp = 0, lvDown = 0, errors = 0;
let nPlayers = 0, nRemain = 0, nAssigned = 0, nSlot2 = 0, nSlot2Used = 0;
let nLoadouts = 0;
const pairShare = [0, 0, 0, 0, 0, 0];   // 編成ペアの共通キャラ数の分布 (実測との照合用)
const charMult = [0, 0, 0, 0, 0, 0];    // 1人の中で1キャラが何編成に登場するか (実測は3以上が0件)
const times = [];
for (let i = 1; i <= N; i++) {
    const seed = i * 7919;
    const inp = board(seed);
    let on, off;
    // 例外は黙って飛ばさない: 落ちる盤面があること自体が回帰なので数えて最後に落とす
    try {
        const t0 = process.hrtime.bigint();
        on = F(structuredClone(inp));
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        off = baselineOf(inp);
    } catch (e) {
        errors++;
        console.error(`  例外 seed ${seed}: ${e && e.message}`);
        continue;
    }
    // 盤面が退化していないかの内訳 (割当率が極端に低い = 被りで全員が凸できない盤面)
    nPlayers += inp.players.length;
    nRemain += inp.players.reduce((t, p) => t + Math.max(0, 3 - p.attackCount), 0);
    nSlot2 += inp.players.reduce((t, p) =>
        t + Object.values(p.loadoutsByAttr).filter(l => l.length > 1).length, 0);
    inp.players.forEach(p => {
        const t1 = Object.values(p.loadoutsByAttr).map(l => l[0].team);
        nLoadouts += t1.length;
        for (let i = 0; i < t1.length; i++) {
            for (let j = i + 1; j < t1.length; j++) {
                pairShare[new Set(t1[i].filter(c => t1[j].includes(c))).size]++;
            }
        }
        const mult = new Map();
        t1.forEach(t => new Set(t).forEach(c => mult.set(c, (mult.get(c) || 0) + 1)));
        mult.forEach(v => { charMult[Math.min(v, 5)]++; });
    });
    on.levels.forEach(l => l.bosses.forEach(b => b.attacks.forEach(x => {
        nAssigned++;
        if (x.loadoutSlot === 2) nSlot2Used++;
    })));
    if (on.fullyClearedThrough > off.fullyClearedThrough) lvUp++;
    if (on.fullyClearedThrough < off.fullyClearedThrough) { lvDown++; console.log(`  踏破低下 seed ${seed}`); }
    const d = on.totalCreditedB - off.totalCreditedB;
    sum += d;
    if (d > 1e-6) up++;
    else if (d < -1e-6) { down++; console.log(`  悪化 seed ${seed}: ${d.toFixed(2)}B`); }
    else same++;
}
times.sort((a, b) => a - b);
const q = (p) => times[Math.floor(times.length * p)].toFixed(1);
const done = up + down + same;
console.log(`盤面 ${done}/${N} 件 (例外 ${errors} 件)`);
let calibrationOff = null;
{   // 生成された盤面が実測分布どおりかを毎回照合する (「較正済み」を口約束にしない)
    const tot = pairShare.reduce((a, b) => a + b, 0);
    const avg = pairShare.reduce((a, b, i) => a + b * i, 0) / tot;
    const pct = (i) => (100 * pairShare[i] / tot).toFixed(1);
    console.log(`盤面の被り分布: 編成ペアの共通キャラ数 平均 ${avg.toFixed(2)} `
        + `(0:${pct(0)}% 1:${pct(1)}% 2:${pct(2)}%)  1人あたり編成数 ${(nLoadouts / nPlayers).toFixed(2)}`);
    const mt = charMult.reduce((a, b) => a + b, 0);
    const m3 = charMult.slice(3).reduce((a, b) => a + b, 0);
    console.log(`              1キャラが登場する編成数 1:${(100 * charMult[1] / mt).toFixed(1)}% `
        + `2:${(100 * charMult[2] / mt).toFixed(1)}% 3以上:${(100 * m3 / mt).toFixed(2)}%`);
    console.log(`  ↑ 本番 player_damages の実測値: 平均 0.30 (0:83% 1:5% 2:12%) / 編成数 4.9`);
    console.log(`                                  1キャラの登場編成数 1:86.6% 2:13.4% 3以上:0%`);
    // 出力するだけだと生成器を変えたときに見落とす。許容範囲を外れたら落とす
    const share2 = 100 * pairShare[2] / tot, mult3 = 100 * m3 / mt;
    const loadoutsPer = nLoadouts / nPlayers;
    if (Math.abs(avg - 0.30) > 0.05) calibrationOff = `ペア共通キャラ数 平均 ${avg.toFixed(2)} (実測 0.30 ±0.05)`;
    else if (Math.abs(share2 - 12) > 3) calibrationOff = `2共有 ${share2.toFixed(1)}% (実測 12% ±3)`;
    else if (mult3 > 0.5) calibrationOff = `3編成以上に出るキャラ ${mult3.toFixed(2)}% (実測 0%)`;
    else if (Math.abs(loadoutsPer - 4.9) > 0.2) calibrationOff = `1人あたり編成数 ${loadoutsPer.toFixed(2)} (実測 4.9 ±0.2)`;
}
console.log(`平均 人数 ${(nPlayers / N).toFixed(1)} / 残凸 ${(nRemain / N).toFixed(1)} / `
    + `割当 ${(nAssigned / N).toFixed(1)} (${(100 * nAssigned / nRemain).toFixed(0)}%)   `
    + `2編成目 保有 ${(nSlot2 / N).toFixed(1)} → 採用 ${(nSlot2Used / N).toFixed(1)}`);
console.log(`改善 ${up} / 悪化 ${down} / 同一 ${same}   合計 ${sum >= 0 ? '+' : ''}${sum.toFixed(1)}B`);
console.log(`踏破Lv 上昇 ${lvUp} / 低下 ${lvDown}`);
console.log(`実行時間 中央値 ${q(0.5)}ms / p95 ${q(0.95)}ms / p99 ${q(0.99)}ms / 最大 ${times[times.length - 1].toFixed(1)}ms`);

// 基準解 (crossBoss:false) 比較のときだけ非悪化を強制する。
// 旧実装との比較は「探索の当たり方の差」なので勝ち負けが出て当然 = 落とさない
if (calibrationOff) {
    console.error(`❌ 盤面が実測分布から外れている: ${calibrationOff}`);
    console.error('   このまま測っても数字の意味が変わる。盤面生成を直すか、実測を取り直して基準を更新すること');
    process.exit(1);
}
const failed = errors > 0 || done !== N || (!OTHER && (down > 0 || lvDown > 0));
if (failed) {
    console.error('❌ ' + (errors > 0 || done !== N ? '全盤面を解けていない' : '基準解より悪い盤面がある'));
    process.exit(1);
}
console.log('✅ 全盤面で基準解を下回らない');
