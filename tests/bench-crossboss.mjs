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
// supabaseQuickCreateTestSeason のティア配分):
//   - 弱点(=持っていくPT属性) は fire→water / water→electric / iron→wind /
//     electric→iron / wind→fire
//   - ティアは B1,B2,B4 = lord / B3,B5 = tyrant
//   - 人数は NIKKE のユニオン上限に合わせて最大30人
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
    const bosses = order.map((attr, k) => {
        const totalB = 20 + pick(41);                  // 20〜60B
        return {
            boss_number: k + 1, boss_code: `T${k + 1}`, name: `テストボス${k + 1}`,
            attribute: attr, weakness: COUNTER[attr], tier: TIERS[k],
            total_hp_raw: totalB * 1e9,
            remaining_hp_raw: Math.round(totalB * (0.3 + rnd() * 0.7)) * 1e9,   // 残HP <= 総HP
        };
    });
    const n = 6 + pick(25);                            // 6〜30人 (ユニオン上限)
    const players = [];
    for (let p = 0; p < n; p++) {
        const dmg = {}, teams = {};
        // 出せるのは弱点PT属性 = COUNTER の値側。2〜5属性ぶん模擬を出している想定
        const pool = shuffled(Object.values(COUNTER)).slice(0, 2 + pick(4));
        pool.forEach(a => {
            dmg[a] = Math.round((4 + rnd() * 24) * 2) / 2;
            teams[a] = ['B1共有', 'B2共有', `${a}A`, `${a}B`, `${a}C`];
        });
        const done = pick(4);                          // 0〜3凸済み
        players.push({
            id: `p${p}`, name: `M${p}`, syncLevel: 300 + pick(400), attackCount: done,
            damagesByAttr: dmg, teamsByAttr: teams,
            attacks: Array.from({ length: done }, () => ({ boss_number: 1 + pick(5), characters: [] })),
            availableSlots: rnd() < 0.4 ? HOURS.filter(() => rnd() < 0.6) : [],
            strong_attributes: rnd() < 0.3 ? pool.slice(0, 2) : [],
        });
    }
    return {
        season: { current_level: 1 + pick(3) }, bosses, players,
        currentSlot: HOURS[pick(5)], timeAware: rnd() < 0.7,
    };
}

const N = 2000;
let up = 0, down = 0, same = 0, sum = 0, lvUp = 0, lvDown = 0, errors = 0;
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
console.log(`改善 ${up} / 悪化 ${down} / 同一 ${same}   合計 ${sum >= 0 ? '+' : ''}${sum.toFixed(1)}B`);
console.log(`踏破Lv 上昇 ${lvUp} / 低下 ${lvDown}`);
console.log(`実行時間 中央値 ${q(0.5)}ms / p95 ${q(0.95)}ms / p99 ${q(0.99)}ms / 最大 ${times[times.length - 1].toFixed(1)}ms`);

// 基準解 (crossBoss:false) 比較のときだけ非悪化を強制する。
// 旧実装との比較は「探索の当たり方の差」なので勝ち負けが出て当然 = 落とさない
const failed = errors > 0 || done !== N || (!OTHER && (down > 0 || lvDown > 0));
if (failed) {
    console.error('❌ ' + (errors > 0 || done !== N ? '全盤面を解けていない' : '基準解より悪い盤面がある'));
    process.exit(1);
}
console.log('✅ 全盤面で基準解を下回らない');
