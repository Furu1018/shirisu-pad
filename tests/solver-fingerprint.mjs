// ============================================================================
// ソルバーの出力指紋 (リファクタで挙動が1ビットも変わっていないことの確認)
//   node tests/solver-fingerprint.mjs            → 指紋を出す
//   node tests/solver-fingerprint.mjs <file>     → その指紋ファイルと突き合わせる
// ----------------------------------------------------------------------------
// bench-crossboss は「改善件数」を測るので実行に数分かかり、リファクタの前後で
// 同じ解が出ているかを短時間で確かめる用途には向かない。ここは seed 固定の盤面を解いて
// **プラン全体を安定 JSON にしてハッシュする**だけ。差が出たら必ず挙動が変わっている。
//
// 使い方 (L1 のような大きなリファクタの前後で):
//   node tests/solver-fingerprint.mjs > /tmp/before.txt
//   ...リファクタ...
//   node tests/solver-fingerprint.mjs /tmp/before.txt   → OK か、最初に壊れた seed を出す
// ============================================================================
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (p) => {
    const ctx = { window: {}, globalThis: null, console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx);
    return ctx.computeOptimalPlanCore || ctx.window.computeOptimalPlanCore;
};
const compute = load(process.env.FP_SOLVER || path.join(HERE, '..', 'js', 'optimal-plan.js'));

const ATTRS = ['fire', 'water', 'electric', 'iron', 'wind'];
const HOURS = ['h05', 'h09', 'h13', 'h17', 'h21'];
const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
const TIERS = ['lord', 'lord', 'tyrant', 'lord', 'tyrant'];
const HP = {
    1: { lord: 30, tyrant: 45 },
    2: { lord: 90, tyrant: 135 },
    3: { lord: 200, tyrant: 300 },
};

// bench-crossboss と同じ決定的乱数 (mulberry32 相当)。盤面の作り方は簡略だが、
// **同じ seed なら誰が回しても同じ盤面**であることだけが要件
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function board(seed) {
    const r = rng(seed);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const bosses = TIERS.map((tier, i) => {
        const attribute = ATTRS[i % 5];
        return {
            boss_number: i + 1, boss_code: `T${i + 1}`, name: `ボス${i + 1}`,
            attribute, weakness: COUNTER[attribute], tier,
            total_hp_raw: HP[1][tier] * 1e9,
            remaining_hp_raw: Math.max(1, HP[1][tier] * (0.3 + r() * 0.7)) * 1e9,
        };
    });
    const n = 24 + Math.floor(r() * 9);
    const players = [];
    for (let i = 0; i < n; i++) {
        const loadoutsByAttr = {};
        const nAttr = 2 + Math.floor(r() * 4);
        const attrs = [...ATTRS].sort(() => r() - 0.5).slice(0, nAttr);
        attrs.forEach((a, ai) => {
            const list = [];
            const slots = r() < 0.3 ? 2 : 1;
            for (let s = 1; s <= slots; s++) {
                const dmg = 8 + r() * 55;
                // キャラは属性ごとに固有 + まれに共有 (被り判定を働かせる)
                const team = [0, 1, 2, 3, 4].map(k => (k === 0 && r() < 0.25) ? `共有${i}_${k}` : `C${i}_${ai}_${s}_${k}`);
                list.push({ dmgB: Math.round(dmg * 10) / 10, team, slot: s, level: null, levels: null });
            }
            loadoutsByAttr[a] = list;
        });
        const damagesByAttr = {};
        for (const [k, list] of Object.entries(loadoutsByAttr)) damagesByAttr[k] = Math.max(...list.map(x => x.dmgB));
        const slots = [];
        const nh = 1 + Math.floor(r() * 4);
        for (let h = 0; h < nh; h++) slots.push(pick(HOURS));
        players.push({
            id: i + 1, name: `P${i + 1}`, attackCount: r() < 0.15 ? 1 : 0,
            syncLevel: 400 + Math.floor(r() * 300), syncLevelEstimated: false,
            damagesByAttr, teamsByAttr: {}, loadoutsByAttr, attacks: [],
            availableSlots: [...new Set(slots)],
            flexTime: r() < 0.15, notifyAllHours: false,
            strong_attributes: r() < 0.3 ? [pick(ATTRS)] : [],
        });
    }
    return {
        season: { id: 1, current_level: 1, hard_date: '2026-09-05' },
        bosses, players, currentSlot: 'h05', timeAware: true, onlyAvailableNow: false,
    };
}

// ハッシュ対象は「割当そのもの」に絞る。
// ★ プラン全体を丸ごとハッシュすると、テレメトリ項目 (stability など) を1つ足しただけで
//   全盤面が落ちて「挙動が変わった」と誤読する。見たいのは
//   **誰がどのレベルのどのボスを、いつ、どの編成で、いくら削るか** が変わっていないこと
function projection(plan) {
    return {
        startLevel: plan.startLevel,
        fullyClearedThrough: plan.fullyClearedThrough,
        frontierLevel: plan.frontierLevel,
        lv4Open: plan.lv4Open,
        totalAttacks: plan.totalAttacks,
        totalCreditedB: plan.totalCreditedB,
        totalWaste: plan.totalWaste,
        unusedAttacks: plan.unusedAttacks,
        levels: (plan.levels || []).map(lv => ({
            level: lv.level, infinite: !!lv.infinite, levelCleared: !!lv.levelCleared,
            openHourLabel: lv.openHourLabel ?? null, clearHourLabel: lv.clearHourLabel ?? null,
            bosses: (lv.bosses || []).map(b => ({
                bossNumber: b.bossNumber, cleared: !!b.cleared,
                remainingHpB: b.remainingHpB, creditedB: b.creditedB ?? null, absorbedB: b.absorbedB ?? null,
                attacks: (b.attacks || []).map(a => [
                    a.memberId, a.loadoutSlot, a.dmgB, a.usedB, a.overflowB,
                    a.hourLabel ?? null, !!a.flex, !!a.timeMismatch, !!a.reserved,
                ]),
            })),
        })),
    };
}

// プランを安定 JSON にする。オブジェクトのキー順に依存しないよう並べ替える
function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
        return out;
    }
    if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;   // 浮動小数の揺れを丸める
    return v;
}

const N = Number(process.env.FP_N || 120);
const lines = [];
for (let seed = 1; seed <= N; seed++) {
    let h;
    try {
        const plan = compute(board(seed));
        h = crypto.createHash('sha1').update(JSON.stringify(stable(projection(plan)))).digest('hex').slice(0, 16);
    } catch (e) {
        h = `ERROR:${e && e.message ? e.message.slice(0, 60) : e}`;
    }
    lines.push(`${seed} ${h}`);
}
const text = lines.join('\n');

// ★ 引数なしでも**必ず基準と突き合わせる** (Codex指摘 2026-09-07)。
//   以前は引数なしだとハッシュを出して成功終了していたので、
//   「previousPlan なしの割当が全盤面で変わっても、手で基準を渡さなければ気づけない」状態だった。
//   基準は L1 導入前 (112d110) のソルバーで取ったもの。
//   ⚠ ソルバーの選択ロジックを意図的に変えたときだけ、理由をコミットに書いて更新すること:
//     node tests/solver-fingerprint.mjs --update
const BASELINE = path.join(HERE, 'solver-fingerprint.baseline.txt');
if (process.argv[2] === '--update') {
    fs.writeFileSync(BASELINE, text + '\n');
    console.log(`基準を更新した (${lines.length} 盤面) — 変更の理由をコミットメッセージに残すこと`);
    process.exit(0);
}
if (process.argv[2] === '--print') { console.log(text); process.exit(0); }
const cmpFile = process.argv[2] || BASELINE;
if (!fs.existsSync(cmpFile)) {
    console.error(`基準ファイルが無い: ${cmpFile}`);
    console.error('意図した変更なら --update で作り直すこと');
    process.exit(1);
}
const before = fs.readFileSync(cmpFile, 'utf8').trim().split('\n').map(s => s.trim()).filter(Boolean);
const after = text.split('\n');
if (before.length !== after.length) {
    console.error(`件数が違う: before=${before.length} after=${after.length}`);
    process.exit(1);
}
const diffs = [];
for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) diffs.push(`  seed ${i + 1}: ${before[i]} → ${after[i]}`);
if (diffs.length === 0) {
    console.log(`OK: ${after.length} 盤面すべてで出力が一致 (挙動は変わっていない)`);
    process.exit(0);
}
console.error(`❌ ${diffs.length}/${after.length} 盤面で出力が変わった`);
console.error(diffs.slice(0, 10).join('\n'));
process.exit(1);
