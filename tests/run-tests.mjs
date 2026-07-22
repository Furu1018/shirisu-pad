// ============================================================================
// 最適凸プラン ソルバー 単体テスト
//   node tests/run-tests.mjs
// ============================================================================
import assert from 'node:assert/strict';
import '../js/optimal-plan.js';        // globalThis.computeOptimalPlanCore を定義する
import '../js/domain/attributes.js';   // globalThis.weaknessPtOf 等 (リアーキ ステップ1)
import '../js/domain/fururi.js';       // globalThis.fururiDomain (リアーキ ステップ2)
import '../js/domain/ocr.js';          // globalThis.ocrDomain (リアーキ ステップ2)
import '../js/domain/finish.js';       // globalThis.finishDomain (リアーキ ステップ2)
import '../js/domain/format.js';       // globalThis.formatDomain (リアーキ ステップ2)
import '../js/state/opsStore.js';      // globalThis.opsStore (リアーキ ステップ3)
import '../js/state/seasonStore.js';   // globalThis.seasonStore (リアーキ ステップ3宿題)

const compute = globalThis.computeOptimalPlanCore;
const { normalizeAttrKey, weaknessPtOf, bossAttributeOf, ATTR_KEYS, fururiDomain, ocrDomain, finishDomain, formatDomain } = globalThis;

// ---- テストデータ ヘルパー -------------------------------------------------
const B = 1e9;   // 1B = 10億

function boss(num, weakness, opts = {}) {
    return {
        boss_number: num,
        boss_code: `TEST${num}`,
        name: `テストボス${num}`,
        attribute: opts.attribute || 'iron',
        weakness,
        tier: opts.tier || 'lord',
        total_hp_raw: (opts.totalB ?? 150) * B,
        remaining_hp_raw: (opts.remainingB ?? opts.totalB ?? 150) * B,
    };
}

function player(name, damagesByAttr, opts = {}) {
    return {
        id: opts.id ?? name,
        name,
        attackCount: opts.attackCount ?? 0,
        syncLevel: opts.slv ?? 500,
        syncLevelEstimated: !!opts.slvEstimated,
        damagesByAttr,
        teamsByAttr: opts.teamsByAttr || {},
        attacks: opts.attacks || [],
        availableSlots: opts.availableSlots || [],
        flexTime: !!opts.flexTime,
        strong_attributes: opts.strong || [],
    };
}

function makeInput(bosses, players, opts = {}) {
    return {
        season: { current_level: opts.currentLevel ?? 1 },
        bosses,
        players,
        currentSlot: opts.currentSlot ?? 'h21',
        onlyAvailableNow: !!opts.onlyAvailableNow,
    };
}

// ---- テストランナー --------------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message}`);
    }
}

console.log('computeOptimalPlanCore:');

// ---- 基本動作 ---------------------------------------------------------------
test('残HPを1凸で削りきれると撃破想定になり、オーバーキルが計上される', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('A', { fire: 12 })],
    ));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, true);
    assert.equal(b1.attacks.length, 1);
    assert.equal(b1.attacks[0].memberName, 'A');
    assert.ok(Math.abs(b1.attacks[0].overflowB - 2) < 1e-6, `overkill=2B のはず: ${b1.attacks[0].overflowB}`);
    assert.ok(Math.abs(plan.totalWaste - 2) < 1e-6);
});

test('火力不足だとそのレベルで停止し、以降のレベルは計画しない', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 100 })],
        [player('A', { fire: 10 })],
    ));
    assert.equal(plan.levels.length, 1);
    assert.equal(plan.levels[0].levelCleared, false);
    assert.equal(plan.fullyClearedThrough, 0);
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, false);
    assert.ok(Math.abs(b1.remainingHpB - 90) < 1e-6);
});

test('Lv1〜3 を通しで攻略できると fullyClearedThrough=3', () => {
    // Lv1 残5B / Lv2 lord=149.78B / Lv3 lord=292.45B。各レベル1人が一撃で処理。
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 5 })],
        [
            player('P1', { fire: 300 }, { slv: 400 }),
            player('P2', { fire: 300 }, { slv: 500 }),
            player('P3', { fire: 400 }, { slv: 600 }),
        ],
    ));
    assert.equal(plan.fullyClearedThrough, 3);
    assert.equal(plan.levels.length, 3);
    assert.equal(plan.totalAttacks, 3);
    assert.equal(plan.unusedAttacks, 9 - 3);
});

// ---- SLv 割当ポリシー --------------------------------------------------------
test('低レベル帯には低SLvメンバーを優先割当 (高SLvは後半に温存)', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [
            player('高SLv', { fire: 11 }, { slv: 700 }),
            player('低SLv', { fire: 11 }, { slv: 100 }),
        ],
    ));
    assert.equal(plan.levels[0].bosses[0].attacks[0].memberName, '低SLv');
});

// ---- 属性・凸の制約 ----------------------------------------------------------
test('同じ属性は同一メンバーが2回使えない (avail から削除される)', () => {
    // ボス2体とも fire 弱点。Aしか居ないので2体目は候補なしで止まる。
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'fire', { remainingB: 10 })],
        [player('A', { fire: 15 })],
    ));
    const [b1, b2] = plan.levels[0].bosses;
    assert.equal(b1.cleared, true);
    assert.equal(b2.cleared, false);
    assert.equal(b2.attacks.length, 0);
});

test('既に凸したボスの弱点属性は候補から除外される', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('A', { fire: 15, water: 20 }, {
            attackCount: 1,
            attacks: [{ boss_number: 1 }],   // B1(fire弱点) に凸済み
        })],
    ));
    assert.equal(plan.levels[0].bosses[0].attacks.length, 0, 'fire は使用済みのはず');
});

test('キャラ衝突: 同一キャラを含む編成は2属性目でスキップされる', () => {
    // A は fire/water 両方に「ニヒリスター」入り編成を登録。
    // fire で使ったら water では選ばれない (Bが代わりに選ばれる)。
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'water', { remainingB: 10 })],
        [
            player('A', { fire: 100, water: 100 }, {
                slv: 100,
                teamsByAttr: { fire: ['ニヒリスター', 'モダニア'], water: ['ニヒリスター', 'ドロシー'] },
            }),
            player('B', { water: 11 }, { slv: 500 }),
        ],
    ));
    const [b1, b2] = plan.levels[0].bosses;
    assert.equal(b1.attacks[0].memberName, 'A');
    assert.equal(b2.attacks[0].memberName, 'B', 'A はキャラ衝突で除外されるはず');
});

// ---- モード・集計 ------------------------------------------------------------
test('onlyAvailableNow: 現スロットに居ないメンバーは対象外', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [
            player('不在', { fire: 15 }, { availableSlots: ['h09'] }),
            player('在席', { fire: 12 }, { availableSlots: ['h21'] }),
        ],
        { onlyAvailableNow: true, currentSlot: 'h21' },
    ));
    assert.equal(plan.candidateCount, 1);
    assert.equal(plan.levels[0].bosses[0].attacks[0].memberName, '在席');
});

test('current_level=2 開始時は Lv2 の残HPが目標になる', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 50, totalB: 149.7844188 })],
        [player('A', { fire: 60 })],
        { currentLevel: 2 },
    ));
    assert.equal(plan.startLevel, 2);
    assert.equal(plan.levels[0].level, 2);
    assert.ok(Math.abs(plan.levels[0].bosses[0].targetHpB - 50) < 1e-6, '開始レベルは remaining_hp_raw が目標');
});

test('membersNoData: 属性ダメージ未登録のメンバーが列挙される', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [
            player('登録済', { fire: 15 }),
            player('未登録', {}),
            player('ゼロのみ', { fire: 0 }),
        ],
    ));
    assert.deepEqual(plan.membersNoData.sort(), ['ゼロのみ', '未登録']);
});

test('3凸済みメンバーは候補に含まれない', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('打ち止め', { fire: 15 }, { attackCount: 3 })],
    ));
    assert.equal(plan.candidateCount, 0);
    assert.equal(plan.levels[0].bosses[0].attacks.length, 0);
});

// ---- 得意属性の必須消化 ----------------------------------------------------------
test('得意属性のボスが全滅済みでも他ボスに出せる (予約ロックアウト回帰)', () => {
    // NOB: 得意3属性 (fire/water/electric) のボスは全て撃破済み。
    // wind のボスだけ生存していて wind ダメージも提出済み → wind に出せるべき。
    // 旧実装は 自由枠 = 3 - 必須3 = 0 で wind をスキップし、一切使われなかった。
    const plan = compute(makeInput(
        [
            boss(1, 'fire', { remainingB: 0, totalB: 100 }),
            boss(2, 'water', { remainingB: 0, totalB: 100 }),
            boss(3, 'electric', { remainingB: 0, totalB: 100 }),
            boss(4, 'wind', { remainingB: 10 }),
        ],
        [player('NOB', { fire: 20, water: 20, electric: 20, wind: 15 }, {
            strong: ['fire', 'water', 'electric'],
        })],
    ));
    const b4 = plan.levels[0].bosses.find(b => b.bossNumber === 4);
    assert.equal(b4.cleared, true, 'wind ボスに割当てられるはず');
    assert.equal(b4.attacks[0].memberName, 'NOB');
});

test('得意属性のボスが生きている間は枠が予約される (必須消化の本来動作)', () => {
    // 得意 fire のボスが生存 → 残凸1のとき water には出さず fire に温存する
    const plan = compute(makeInput(
        [boss(1, 'water', { remainingB: 10 }), boss(2, 'fire', { remainingB: 10 })],
        [player('A', { fire: 15, water: 15 }, {
            strong: ['fire'],
            attackCount: 2,               // 残凸1
            attacks: [{ boss_number: 99 }, { boss_number: 98 }],   // 属性未消費扱いのダミー
        })],
    ));
    const water = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    const fire = plan.levels[0].bosses.find(b => b.bossNumber === 2);
    assert.equal(water.attacks.length, 0, '残り1凸は必須の fire に温存されるはず');
    assert.equal(fire.attacks[0]?.memberName, 'A');
});

test('必須属性のボスがレベル途中で他メンバーに撃破されたら予約を解放して他ボスに出せる (Codex監査 #4)', () => {
    // A: 得意 fire (必須) + water も出せる、残凸1。fire は大幅オーバーキル(火力過剰)。
    // B: fire を低オーバーキルで撃破 → A より fire に適する。
    // 期待: B が fire を撃破 → A の必須 fire は満たせなくなるので予約を解放し、A は water に出る。
    // 修正前は A の lockedNow が握られたまま水ボスで除外され、A の1凸が丸ごと未使用だった。
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'water', { remainingB: 10 })],
        [
            player('A', { fire: 100, water: 15 }, {
                strong: ['fire'], attackCount: 2,               // 残凸1
                attacks: [{ boss_number: 98 }, { boss_number: 99 }],
            }),
            player('B', { fire: 11 }),
        ],
    ));
    const fire = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    const water = plan.levels[0].bosses.find(b => b.bossNumber === 2);
    assert.equal(fire.attacks[0]?.memberName, 'B', 'fire は低オーバーキルの B が撃破するはず');
    assert.equal(water.cleared, true, 'A の予約が解放され water も撃破されるはず');
    assert.equal(water.attacks[0]?.memberName, 'A', 'A が余った1凸を water に使うはず');
});

// ---- 時間考慮モード (timeAware) ------------------------------------------------
console.log('\ntimeAware:');

const timeInput = (bosses, players, opts = {}) => ({ ...makeInput(bosses, players, opts), timeAware: true });

test('時間外(ミスマッチ)割当は MISMATCH_PENALTY で正規時間の人より後回しになる (Codex監査 #6)', () => {
    // X: 火力はやや上(オーバーキル小)だが凸可能時間が過去(h05)のみ → 現在h21ではミスマッチ。
    // Y: オーバーキルはやや大きいが h21 に正規で凸できる。
    // MISMATCH_PENALTY が効いていれば、多少の火力差より「時間を確約できる Y」が優先される。
    // 括弧バグがあると X の罰が FLEX 分(0.4)だけになり X が選ばれてしまう。
    // Lv2 を対象にする (levelPos=0.5 → 2人の SLv 順位ペナルティが両者 0.5 で相殺され、
    // 時間ミスマッチ罰だけが勝敗を分ける状態を作る)。
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [
            player('X時間外', { fire: 11 }, { availableSlots: ['h05'] }),
            player('Y正規', { fire: 12 }, { availableSlots: ['h21'] }),
        ],
        { currentSlot: 'h21', currentLevel: 2 },
    ));
    const atk = plan.levels[0].bosses[0].attacks[0];
    assert.equal(atk.memberName, 'Y正規', '時間を確約できる Y が優先されるはず');
    assert.equal(atk.timeMismatch, false);
});

test('凸は「そのレベルが開いてから最も早い凸可能時間帯」に割り当てられる', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('夜の人', { fire: 12 }, { availableSlots: ['h21', 'h22'] })],
        { currentSlot: 'h14' },
    ));
    const atk = plan.levels[0].bosses[0].attacks[0];
    assert.equal(atk.hourLabel, '21時');
    assert.equal(plan.levels[0].clearHourLabel, '21時');
});

test('レベル依存: 時間外の人も ⏳ミスマッチとして組み込まれる (除外しない)', () => {
    // Lv1 は21時の人しか時間内に凸できない。「朝だけの人」(h09) は
    // 14時時点で希望時間を過ぎているが、除外せずベストエフォートで組み込む。
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 5 })],
        [
            player('夜の人', { fire: 10 }, { availableSlots: ['h21'] }),
            player('朝だけの人', { fire: 300 }, { availableSlots: ['h09'] }),
            player('深夜の人', { fire: 300 }, { availableSlots: ['h23'] }),
        ],
        { currentSlot: 'h14' },
    ));
    assert.equal(plan.levels[0].levelCleared, true);
    // 朝だけの人がどこかのレベルで使われた場合、必ず ⏳ミスマッチ扱いで
    // 時刻ラベルなし・律速にならない
    const all = plan.levels.flatMap(lv => lv.bosses.flatMap(b => b.attacks));
    const asa = all.filter(a => a.memberName === '朝だけの人');
    assert.ok(asa.length > 0, '朝だけの人も計画に組み込まれるはず');
    for (const a of asa) {
        assert.equal(a.timeMismatch, true);
        assert.equal(a.flex, true);
        assert.equal(a.hourLabel, null);
        assert.equal(a.isBottleneck, false);
        assert.equal(a.nearestHourLabel, '9時');
    }
});

test('律速マーク: レベルのクリア時刻を決める凸に isBottleneck が付く', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 20 })],
        [
            player('早い人', { fire: 15 }, { availableSlots: ['h15'] }),
            player('遅い人', { fire: 15 }, { availableSlots: ['h23'] }),
        ],
        { currentSlot: 'h14' },
    ));
    const atks = plan.levels[0].bosses[0].attacks;
    const slow = atks.find(a => a.memberName === '遅い人');
    const fast = atks.find(a => a.memberName === '早い人');
    assert.equal(slow.isBottleneck, true);
    assert.equal(fast.isBottleneck, false);
});

test('時間が合わない人も最寄り扱いで必ず組み込まれる (⏳ミスマッチ)', () => {
    // 現在22時。凸可能が「過ぎた時間」しかない人でも、除外せず組み込む
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('もう寝た人', { fire: 100 }, { availableSlots: ['h09', 'h10'] })],
        { currentSlot: 'h22' },
    ));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, true, '時間外でもベストエフォートで削り切る想定になる');
    const atk = b1.attacks[0];
    assert.equal(atk.memberName, 'もう寝た人');
    assert.equal(atk.timeMismatch, true);
    assert.equal(atk.nearestHourLabel, '10時');
    assert.equal(b1.timeConstrained, false);
});

test('凸可能時間 未登録のメンバーは「いつでも可」+ timeUnknown フラグ', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('未登録さん', { fire: 12 })],
        { currentSlot: 'h14' },
    ));
    const atk = plan.levels[0].bosses[0].attacks[0];
    assert.equal(atk.hourLabel, '14時', '開いた時間帯に即割当');
    assert.equal(atk.timeUnknown, true);
    assert.deepEqual(plan.membersTimeUnknown, ['未登録さん']);
});

test('翌0-4時は「翌N時」ラベルになり、リセットまでの残り時間が出る', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('深夜組', { fire: 12 }, { availableSlots: ['h02'] })],
        { currentSlot: 'h23' },
    ));
    assert.equal(plan.levels[0].bosses[0].attacks[0].hourLabel, '翌2時');
    assert.equal(plan.hoursUntilReset, 6);  // 23,0,1,2,3,4 の6枠
});

test('⏳隙間時間型: 時刻を割り当てず (hourLabel=null, flex=true)、律速にもならない', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 20 })],
        [
            player('隙間さん', { fire: 15 }, { flexTime: true }),
            player('夜の人', { fire: 15 }, { availableSlots: ['h23'] }),
        ],
        { currentSlot: 'h14' },
    ));
    const atks = plan.levels[0].bosses[0].attacks;
    const flex = atks.find(a => a.memberName === '隙間さん');
    const timed = atks.find(a => a.memberName === '夜の人');
    assert.equal(flex.flex, true);
    assert.equal(flex.hourLabel, null, '隙間凸に時刻ラベルを付けない');
    assert.equal(flex.isBottleneck, false, '隙間凸は律速にしない');
    assert.equal(timed.isBottleneck, true, '時刻の読める凸が律速になる');
    assert.equal(plan.levels[0].bosses[0].hasFlex, true);
    assert.deepEqual(plan.membersFlex, ['隙間さん']);
});

test('⏳隙間時間型は「時間未登録」の注意対象に含めない', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('隙間さん', { fire: 12 }, { flexTime: true })],
        { currentSlot: 'h14' },
    ));
    assert.deepEqual(plan.membersTimeUnknown, []);
    assert.equal(plan.levels[0].bosses[0].attacks[0].timeUnknown, false);
});

test('⏳隙間凸だけで削るボスのクリア時刻は開放時刻扱い (hasFlex で目安と分かる)', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('隙間さん', { fire: 12 }, { flexTime: true })],
        { currentSlot: 'h14' },
    ));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, true);
    assert.equal(b1.clearHourLabel, '14時');
    assert.equal(plan.levels[0].hasFlex, true);
});

test('ハイブリッド隙間型: 登録時間内は通常の時刻付き割当 (確約=律速にもなる)', () => {
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('ハイブリッドさん', { fire: 12 }, { flexTime: true, availableSlots: ['h21'] })],
        { currentSlot: 'h14' },
    ));
    const atk = plan.levels[0].bosses[0].attacks[0];
    assert.equal(atk.flex, false, '登録時間内は隙間扱いにしない');
    assert.equal(atk.hourLabel, '21時');
    assert.equal(atk.isBottleneck, true, '確約した時刻はレベルの律速になり得る');
});

test('ハイブリッド隙間型: 登録時間外のレベルは ⏳隙間フォールバック (時間切れにならない)', () => {
    // Lv1 を21時の人がクリア → Lv2 開放は21時。ハイブリッドさんの登録は h15 のみ (過ぎている)
    // → 時間切れ除外ではなく ⏳隙間として割当てられる
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 5 })],
        [
            player('夜の人', { fire: 10 }, { availableSlots: ['h21'] }),
            player('ハイブリッドさん', { fire: 300 }, { flexTime: true, availableSlots: ['h15'] }),
        ],
        { currentSlot: 'h14' },
    ));
    const lv2 = plan.levels[1];
    const atk = lv2.bosses[0].attacks.find(a => a.memberName === 'ハイブリッドさん');
    assert.ok(atk, 'Lv2 に割当てられるはず');
    assert.equal(atk.flex, true, '登録時間外なので隙間扱い');
    assert.equal(atk.hourLabel, null);
    assert.equal(atk.isBottleneck, false);
    assert.equal(lv2.bosses[0].timeConstrained, false);
});

test('ハイブリッド隙間型: 登録時間があるうちは確約割当を優先 (隙間フォールバックしない)', () => {
    // Lv1 が h14 開放でハイブリッドさんの登録は h21 → 「今すぐ隙間で」ではなく
    // 確約できる 21時 に時刻付きで割当てられる (保守的で共有しやすいプランになる)
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('ハイブリッドさん', { fire: 12 }, { flexTime: true, availableSlots: ['h21'] })],
        { currentSlot: 'h14' },
    ));
    const atk = plan.levels[0].bosses[0].attacks[0];
    assert.equal(atk.flex, false);
    assert.equal(atk.hourLabel, '21時');
});

test('timeAware=false では従来と同じ出力 (時間フィールドは null)', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('A', { fire: 12 }, { availableSlots: ['h21'] })],
    ));
    assert.equal(plan.timeAware, false);
    assert.equal(plan.levels[0].bosses[0].attacks[0].hourIdx, null);
    assert.equal(plan.levels[0].clearHourLabel, null);
});

// ---- 得意属性の必須選出 -------------------------------------------------------
console.log('\nstrongAttrs:');

test('得意属性2つ: その2属性は必ず消化、自由枠は1つだけ', () => {
    const bs = [
        boss(1, 'fire', { remainingB: 5 }), boss(2, 'water', { remainingB: 5 }),
        boss(3, 'electric', { remainingB: 5 }), boss(4, 'iron', { remainingB: 5 }),
        boss(5, 'wind', { remainingB: 5 }),
    ];
    const plan = compute(makeInput(bs, [
        player('A', { fire: 10, water: 10, electric: 10, iron: 10, wind: 10 }, { strong: ['electric', 'wind'] }),
    ]));
    const attrs = plan.levels[0].bosses.flatMap(b => b.attacks.map(() => b.weakness));
    assert.equal(attrs.length, 3, `3凸のはず: ${attrs}`);
    assert.ok(attrs.includes('electric') && attrs.includes('wind'), `得意2属性を含むはず: ${attrs}`);
});

test('得意属性4つ: その4属性の中からのみ選出 (5属性目には出さない)', () => {
    const bs = [
        boss(1, 'wind', { remainingB: 5 }), boss(2, 'fire', { remainingB: 5 }),
        boss(3, 'water', { remainingB: 5 }), boss(4, 'electric', { remainingB: 5 }),
    ];
    const plan = compute(makeInput(bs, [
        player('A', { fire: 10, water: 10, electric: 10, iron: 10, wind: 10 }, { strong: ['fire', 'water', 'electric', 'iron'] }),
    ]));
    assert.equal(plan.levels[0].bosses[0].attacks.length, 0, 'wind ボスには出ないはず');
    const attrs = plan.levels[0].bosses.flatMap(b => b.attacks.map(() => b.weakness)).sort();
    assert.deepEqual(attrs, ['electric', 'fire', 'water']);
});

test('得意属性でもダメージ未提出なら強制しない (提出済みの得意属性のみ必須)', () => {
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 5 }), boss(2, 'electric', { remainingB: 5 })],
        [player('A', { fire: 10, electric: 10 }, { strong: ['electric', 'wind'] })],
    ));
    const attrs = plan.levels[0].bosses.flatMap(b => b.attacks.map(() => b.weakness)).sort();
    assert.deepEqual(attrs, ['electric', 'fire'], 'wind 未提出でも fire は自由枠で選出されるはず');
});

test('得意属性なし: 従来どおり制約なく選出される', () => {
    const bs = [
        boss(1, 'fire', { remainingB: 5 }), boss(2, 'water', { remainingB: 5 }),
        boss(3, 'electric', { remainingB: 5 }),
    ];
    const plan = compute(makeInput(bs, [
        player('A', { fire: 10, water: 10, electric: 10 }),
    ]));
    const attrs = plan.levels[0].bosses.flatMap(b => b.attacks.map(() => b.weakness)).sort();
    assert.deepEqual(attrs, ['electric', 'fire', 'water']);
});

// ---- 1属性2編成 (dual loadout) ------------------------------------------------
console.log('\ndualLoadout:');

test('1属性2編成: 別編成なら同じ属性に2回凸できる', () => {
    const p = player('A', { fire: 10 });
    p.loadoutsByAttr = { fire: [
        { dmgB: 10, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 8, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 15 })], [p]));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, true);
    assert.equal(b1.attacks.length, 2, `2凸のはず: ${b1.attacks.length}`);
    assert.equal(b1.attacks[0].dmgB, 10);
    assert.equal(b1.attacks[1].dmgB, 8);
    assert.equal(b1.attacks[1].loadoutSlot, 2);
});

test('2編成目がキャラ被りなら同属性2凸はしない', () => {
    const p = player('A', { fire: 10 });
    p.loadoutsByAttr = { fire: [
        { dmgB: 10, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 8, team: ['a', 'x', 'y', 'z', 'w'], slot: 2 },   // 'a' が被る
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 15 })], [p]));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, false);
    assert.equal(b1.attacks.length, 1, '被り編成は2凸目に使えないはず');
});

test('既に1凸済みの属性は上位ロードアウトから消費済み扱い', () => {
    const p = player('A', { fire: 10 }, {
        attackCount: 1,
        attacks: [{ boss_number: 1 }],   // boss1 (fire) に1凸済み
    });
    p.loadoutsByAttr = { fire: [
        { dmgB: 10, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 8, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 7 })], [p]));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, true);
    assert.equal(b1.attacks.length, 1);
    assert.equal(b1.attacks[0].dmgB, 8, '残っているのは2編成目 (8B) のはず');
});

test('凸済みの得意属性は再強制しない (編成②が残っていても満足済み扱い)', () => {
    // fire に1凸済み。fire の編成②が残っていても mandatory は water だけになり、
    // 残り1枠は自由に electric へ使えるはず (旧バグ: fire 再強制で electric が選出不能)
    const p = player('A', { fire: 10, water: 9, electric: 8 }, {
        attackCount: 1,
        attacks: [{ boss_number: 1 }],   // boss1 (fire) に凸済み
        strong: ['fire', 'water'],
    });
    p.loadoutsByAttr = {
        fire: [
            { dmgB: 10, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
            { dmgB: 7, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
        ],
        water: [{ dmgB: 9, team: [], slot: 1 }],
        electric: [{ dmgB: 8, team: [], slot: 1 }],
    };
    // fire ボスは既に撃破済み (残HP 0)。ボスリストには居るので凸履歴→属性の逆引きは可能
    const bs = [
        boss(1, 'fire', { remainingB: 0 }),
        boss(2, 'water', { remainingB: 5 }),
        boss(3, 'electric', { remainingB: 5 }),
    ];
    const plan = compute(makeInput(bs, [p]));
    const attrs = plan.levels[0].bosses.flatMap(b => b.attacks.map(() => b.weakness)).sort();
    assert.deepEqual(attrs, ['electric', 'water'], `water(必須)+electric(自由枠) のはず: ${attrs}`);
});

// ---- Lv4: ボス5・HP無限 (Lv3踏破で即日開放) ----------------------------------
console.log('\nlv4:');

// 5属性フルセット (tier 配置は supabase-client.js の ['lord','lord','tyrant','lord','tyrant'] 準拠)
const fiveBosses = (opts = {}) => [
    boss(1, 'fire', { tier: 'lord', remainingB: opts.b1 ?? 5 }),
    boss(2, 'water', { tier: 'lord', remainingB: opts.b2 ?? 5 }),
    boss(3, 'electric', { tier: 'tyrant', remainingB: opts.b3 ?? 5 }),
    boss(4, 'iron', { tier: 'lord', remainingB: opts.b4 ?? 5 }),
    boss(5, 'wind', { tier: 'tyrant', remainingB: opts.b5 ?? 5 }),
];
// Lv3 開始 (current_level=3) にすると標準HP定数に依存せず踏破シナリオを組める
const lv3Input = (bosses, players, opts = {}) => makeInput(bosses, players, { currentLevel: 3, ...opts });

test('Lv3踏破で Lv4 (ボス5・無限) が末尾に追加され、余剰凸が全額計上で割当てられる', () => {
    const plan = compute(lv3Input(fiveBosses(), [
        player('P1', { fire: 10, water: 10, wind: 10 }),
        player('P2', { electric: 10, iron: 10, wind: 10 }),
    ]));
    assert.equal(plan.fullyClearedThrough, 3);
    assert.equal(plan.lv4Open, true);
    assert.equal(plan.lv4Weakness, 'wind');
    const lv4 = plan.levels[plan.levels.length - 1];
    assert.equal(lv4.level, 4);
    assert.equal(lv4.infinite, true);
    assert.equal(lv4.bosses.length, 1);
    const b5 = lv4.bosses[0];
    assert.equal(b5.bossNumber, 5);
    assert.equal(b5.infinite, true);
    // P1: fire+water+wind消化はLv3で3凸使い切り or wind温存なし (PhaseAは素直に割当)。
    // 5ボス撃破に5凸 → 残り1凸が wind ならボス5へ。割当詳細ではなく全額計上則を検証する
    for (const a of b5.attacks) {
        assert.equal(a.usedB, a.dmgB, 'ボス5への凸は全額計上');
        assert.equal(a.overflowB, 0, 'ボス5にオーバーキルは存在しない');
    }
    // credited 検算: 有限ボスは残HPぶん (5B×5)、ボス5は全額
    const finiteUsed = 25;
    assert.ok(Math.abs(plan.totalCreditedB - (finiteUsed + plan.lv4CreditedB)) < 1e-6);
});

test('Lv4-live 盤面 (Lv3全滅済み) では即ボス5へ割当てられる', () => {
    const plan = compute(lv3Input(fiveBosses({ b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 }), [
        player('P1', { wind: 20 }),
        player('P2', { wind: 15 }),
    ]));
    assert.equal(plan.lv4Open, true);
    const b5 = plan.levels[plan.levels.length - 1].bosses[0];
    assert.equal(b5.attacks.length, 2, '2人とも wind 1編成ずつ');
    assert.equal(plan.lv4CreditedB, 35);
    assert.equal(plan.totalCreditedB, 35);
    assert.equal(plan.totalWaste, 0);
});

test('wind 2編成の人はボス5に2凸できる (dmg降順・全額計上)', () => {
    const p = player('A', { wind: 20 });
    p.loadoutsByAttr = { wind: [
        { dmgB: 20, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 15, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
    ] };
    const plan = compute(lv3Input(fiveBosses({ b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 }), [p]));
    const b5 = plan.levels[plan.levels.length - 1].bosses[0];
    assert.equal(b5.attacks.length, 2, '別編成なら同属性2凸');
    assert.equal(b5.attacks[0].dmgB, 20);
    assert.equal(b5.attacks[1].dmgB, 15);
    assert.equal(b5.attacks[1].loadoutSlot, 2);
    assert.equal(plan.lv4CreditedB, 35);
});

test('wind 2編成でもキャラ被りならボス5への2凸目は不可', () => {
    const p = player('A', { wind: 20 });
    p.loadoutsByAttr = { wind: [
        { dmgB: 20, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 15, team: ['a', 'x', 'y', 'z', 'w'], slot: 2 },   // 'a' 被り
    ] };
    const plan = compute(lv3Input(fiveBosses({ b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 }), [p]));
    const b5 = plan.levels[plan.levels.length - 1].bosses[0];
    assert.equal(b5.attacks.length, 1);
    // 診断: 残凸はあるが被りで出せない
    const detail = plan.unusedDetail.find(d => d.name === 'A');
    assert.ok(detail && /キャラ被り/.test(detail.reason), `被り理由のはず: ${detail?.reason}`);
});

test('boss_number=5 が入力に無ければ Lv4 は追加されない', () => {
    const plan = compute(lv3Input(
        [boss(1, 'fire', { remainingB: 5 })],
        [player('P1', { fire: 10, wind: 10 })],
    ));
    assert.equal(plan.lv4Open, false);
    assert.ok(plan.levels.every(lv => !lv.infinite));
    assert.equal(plan.lv4CreditedB, 0);
});

test('踏破できない場合は Lv4 を計画しない', () => {
    const plan = compute(lv3Input(fiveBosses({ b5: 500 }), [
        player('P1', { wind: 10 }),
    ]));
    assert.equal(plan.fullyClearedThrough, 2);
    assert.equal(plan.lv4Open, false);
    assert.ok(plan.levels.every(lv => !lv.infinite));
});

test('プランのJSON往復で Infinity/NaN が混入しない (📤配信のJSONB保存対策)', () => {
    const plan = compute(lv3Input(fiveBosses(), [
        player('P1', { fire: 10, water: 10, electric: 10 }),
        player('P2', { iron: 10, wind: 10 }),
    ]));
    assert.equal(plan.lv4Open, true);
    const walk = (v, path) => {
        if (typeof v === 'number') assert.ok(Number.isFinite(v), `非有限数値: ${path} = ${v}`);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
    };
    walk(plan, 'plan');
    // JSON 往復でも同一 (undefined 脱落以外の変質なし)
    const rt = JSON.parse(JSON.stringify(plan));
    assert.equal(rt.levels[rt.levels.length - 1].bosses[0].infinite, true);
});

test('timeAware: ボス5への凸は Lv3 クリア想定時刻以降に割当てられる', () => {
    const plan = compute(timeInput(fiveBosses(), [
        // 踏破役: 夜しか出られない → Lv3 クリアは h22
        player('夜の人', { fire: 10, water: 10, electric: 10 }, { availableSlots: ['h22'] }),
        player('夜の人2', { iron: 10, wind: 10 }, { availableSlots: ['h22'] }),
        // ボス5要員: 全時間帯OK — だが開放は h22 以降
        player('いつでも', { wind: 30 }, { availableSlots: ['h21', 'h22', 'h23'] }),
    ], { currentLevel: 3, currentSlot: 'h21' }));
    assert.equal(plan.lv4Open, true);
    const lv4 = plan.levels[plan.levels.length - 1];
    const clearIdx = plan.levels.find(lv => lv.level === 3).clearHourIdx;
    assert.equal(lv4.openHourIdx, clearIdx, 'Lv4 開放 = Lv3 クリア想定時刻');
    for (const a of lv4.bosses[0].attacks) {
        if (!a.flex) assert.ok(a.hourIdx >= clearIdx, `ボス5の凸は開放時刻以降のはず: ${a.hourIdx} >= ${clearIdx}`);
    }
});

test('wind 未提出の人の余剰凸は「弱点属性が未提出」と診断される', () => {
    const plan = compute(lv3Input(fiveBosses(), [
        player('踏破役', { fire: 10, water: 10, electric: 10 }),
        player('鉄だけ', { iron: 10 }),
        player('風あり', { wind: 10 }),
    ]));
    assert.equal(plan.lv4Open, true);
    const detail = plan.unusedDetail.find(d => d.name === '鉄だけ');
    assert.ok(detail, '鉄だけ は凸が余るはず');
    assert.ok(/未提出|残っていない/.test(detail.reason), `ボス5系の理由のはず: ${detail.reason}`);
});

// ---- Lv4 温存 (probe + 機会費用の2パス) ---------------------------------------
console.log('\nlv4Reserve:');

test('大火力の wind 凸は有限ボスに使わずボス5へ温存される', () => {
    // Lv3 boss5 残30B。probe は SLv 相性で大火力(25B)を有限ボス5に使うが、
    // 温存パスなら小火力2人(16B×2)で踏破して 25B をボス5(無限)へ回せる (+9B)
    const plan = compute(lv3Input(fiveBosses({ b5: 30 }), [
        player('小火力1', { wind: 16 }, { slv: 400 }),
        player('小火力2', { wind: 16 }, { slv: 401 }),
        player('火担当', { fire: 5 }, { slv: 450 }),
        player('水担当', { water: 5 }, { slv: 460 }),
        player('電担当', { electric: 5 }, { slv: 470 }),
        player('鉄担当', { iron: 5 }, { slv: 480 }),
        player('大火力', { wind: 25 }, { slv: 800 }),   // slv最高 = Lv3帯でSLvペナルティ0
    ]));
    assert.equal(plan.lv4Open, true);
    assert.equal(plan.fullyClearedThrough, 3, '温存しても踏破は崩れない');
    const finiteB5 = plan.levels.find(lv => lv.level === 3).bosses.find(b => b.bossNumber === 5);
    assert.ok(!finiteB5.attacks.some(a => a.memberName === '大火力'),
        `大火力は有限ボス5に使われないはず: ${finiteB5.attacks.map(a => a.memberName)}`);
    const lv4 = plan.levels[plan.levels.length - 1].bosses[0];
    const big = lv4.attacks.find(a => a.memberName === '大火力');
    assert.ok(big, '大火力はボス5(無限)に割当てられるはず');
    assert.equal(big.reserved, true, 'probe から移動した凸には温存マーク');
    assert.equal(plan.reservePassUsed, true);
    assert.ok(Math.abs(plan.reserveGainB - 9) < 1e-6, `温存で+9Bのはず: ${plan.reserveGainB}`);
    assert.ok(plan.totalCreditedB > plan.baselineCreditedB);
});

test('Lv4開放時刻より前にしか出られない大火力は温存されない (踏破に使う)', () => {
    const plan = compute(timeInput(fiveBosses({ b5: 30 }), [
        player('小火力1', { wind: 16 }, { slv: 400, availableSlots: ['h22', 'h23'] }),
        player('小火力2', { wind: 16 }, { slv: 401, availableSlots: ['h22', 'h23'] }),
        player('火担当', { fire: 5 }, { slv: 450, availableSlots: ['h22'] }),
        player('水担当', { water: 5 }, { slv: 460, availableSlots: ['h22'] }),
        player('電担当', { electric: 5 }, { slv: 470, availableSlots: ['h22'] }),
        player('鉄担当', { iron: 5 }, { slv: 480, availableSlots: ['h22'] }),
        // h21 しか出られない → Lv3クリア想定 (h22) 以降に確約枠がない → 温存対象外
        player('大火力', { wind: 25 }, { slv: 800, availableSlots: ['h21'] }),
    ], { currentLevel: 3, currentSlot: 'h21' }));
    assert.equal(plan.lv4Open, true);
    const finiteB5 = plan.levels.find(lv => lv.level === 3).bosses.find(b => b.bossNumber === 5);
    assert.ok(finiteB5.attacks.some(a => a.memberName === '大火力'),
        '時間的に温存できない大火力は従来どおり有限ボスへ');
    assert.equal(plan.reservePassUsed, false, '温存で credited が増えないので probe を採用');
});

test('スロット逼迫: wind2編成持ちの2つ目の他属性凸は機会費用がかかり、他の人に譲る', () => {
    const m = player('二刀流', { wind: 20, fire: 10, water: 10 }, { slv: 800 });
    m.loadoutsByAttr = {
        wind: [
            { dmgB: 20, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
            { dmgB: 18, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
        ],
        fire: [{ dmgB: 10, team: ['k', 'l', 'm', 'n', 'o'], slot: 1 }],
        water: [{ dmgB: 10, team: ['p', 'q', 'r', 's', 't'], slot: 1 }],
    };
    const plan = compute(lv3Input(fiveBosses({ b1: 10, b2: 10 }), [
        m,
        player('水番', { water: 12 }, { slv: 500 }),
        player('風小', { wind: 6 }, { slv: 400 }),
        player('電担当', { electric: 5 }, { slv: 450 }),
        player('鉄担当', { iron: 5 }, { slv: 460 }),
    ]));
    assert.equal(plan.lv4Open, true);
    assert.equal(plan.reservePassUsed, true, '温存パスが採用されるはず');
    const lv3 = plan.levels.find(lv => lv.level === 3);
    const fireAtk = lv3.bosses.find(b => b.weakness === 'fire').attacks;
    const waterAtk = lv3.bosses.find(b => b.weakness === 'water').attacks;
    // 1回目の他属性凸 (fire) はコスト0なので二刀流が出す
    assert.ok(fireAtk.some(a => a.memberName === '二刀流'), 'fire は二刀流 (スロット残2でもwind2編成入る)');
    // 2回目 (water) は wind 2凸目の枠を失うコスト18 > 水番のオーバーキル2 → 水番に譲る
    assert.ok(waterAtk.every(a => a.memberName !== '二刀流'), `water は水番のはず: ${waterAtk.map(a => a.memberName)}`);
    const lv4 = plan.levels[plan.levels.length - 1].bosses[0];
    const mine = lv4.attacks.filter(a => a.memberName === '二刀流');
    assert.equal(mine.length, 2, `二刀流は wind 2編成ともボス5へ: ${lv4.attacks.map(a => a.memberName)}`);
    assert.deepEqual(mine.map(a => a.dmgB), [20, 18]);
});

test('残HPの小さい有限ボスには2編成目(低火力)を回し、1編成目をボス5へ温存する', () => {
    const m = player('二編成', { wind: 20 }, { slv: 500 });
    m.loadoutsByAttr = { wind: [
        { dmgB: 20, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 6, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
    ] };
    const plan = compute(lv3Input(fiveBosses({ b5: 6 }), [
        m,
        player('火担当', { fire: 5 }), player('水担当', { water: 5 }),
        player('電担当', { electric: 5 }), player('鉄担当', { iron: 5 }),
    ]));
    assert.equal(plan.lv4Open, true);
    const finiteB5 = plan.levels.find(lv => lv.level === 3).bosses.find(b => b.bossNumber === 5);
    assert.equal(finiteB5.attacks.length, 1);
    assert.equal(finiteB5.attacks[0].dmgB, 6, '有限ボスにはオーバーキルの小さい2編成目');
    assert.equal(finiteB5.attacks[0].loadoutSlot, 2);
    const lv4 = plan.levels[plan.levels.length - 1].bosses[0];
    assert.deepEqual(lv4.attacks.filter(a => a.memberName === '二編成').map(a => a.dmgB), [20],
        '1編成目(20B)はボス5(無限)へ');
});

test('得意属性が wind の人は Lv4 (ボス5) への割当で必須消化を満たす', () => {
    const plan = compute(lv3Input(fiveBosses({ b1: 10 }), [
        player('風得意', { wind: 20, fire: 10 }, { slv: 500, strong: ['wind'] }),
        player('風小', { wind: 6 }, { slv: 400 }),
        player('水担当', { water: 5 }), player('電担当', { electric: 5 }), player('鉄担当', { iron: 5 }),
    ]));
    assert.equal(plan.lv4Open, true);
    const lv4 = plan.levels[plan.levels.length - 1].bosses[0];
    assert.ok(lv4.attacks.some(a => a.memberName === '風得意'), '得意属性はボス5で消化 (全額計上で本人にも最良)');
    const lv3 = plan.levels.find(lv => lv.level === 3);
    assert.ok(lv3.bosses.find(b => b.weakness === 'fire').attacks.some(a => a.memberName === '風得意'),
        '必須枠の予約で fire への自由凸がブロックされない');
    // 温存が絡んでも必須未消化の警告対象にならない
    const detail = plan.unusedDetail.find(d => d.name === '風得意');
    assert.ok(!detail || !/必須枠を温存中/.test(detail.reason));
});

test('reserveGainB は常に0以上 (悪化するなら probe に倒す)', () => {
    // 温存の余地がないケース (wind 1人だけ) でも壊れない
    const plan = compute(lv3Input(fiveBosses(), [
        player('唯一風', { wind: 10 }, { slv: 500 }),
        player('他全部', { fire: 10, water: 10, electric: 10, iron: 10 }, { slv: 600 }),
    ]));
    assert.ok(plan.reserveGainB >= 0);
    assert.ok(plan.totalCreditedB >= plan.baselineCreditedB - 1e-9);
});

test('温存で Lv3 クリアが遅れて開放時刻に出られなくなる人は、引き直しで温存対象から外れる', () => {
    // probe は大火力(h22のみ)がボス5(残25B)を1撃で締めて T3=h22。
    // 温存パス1回目は T3=h22 前提で大火力を温存するが、小火力(h23のみ)で締め直すと
    // クリアが h23 にずれ、大火力は h23 以降に出られない → T3 を h23 に引き上げて引き直し、
    // 大火力は結局踏破に使う (= probe と同じ) に収束する
    const plan = compute(timeInput(fiveBosses({ b5: 25 }), [
        player('小火力1', { wind: 16 }, { slv: 400, availableSlots: ['h23'] }),
        player('小火力2', { wind: 16 }, { slv: 401, availableSlots: ['h23'] }),
        player('火担当', { fire: 5 }, { slv: 450, availableSlots: ['h22'] }),
        player('水担当', { water: 5 }, { slv: 460, availableSlots: ['h22'] }),
        player('電担当', { electric: 5 }, { slv: 470, availableSlots: ['h22'] }),
        player('鉄担当', { iron: 5 }, { slv: 480, availableSlots: ['h22'] }),
        player('大火力', { wind: 25 }, { slv: 800, availableSlots: ['h22'] }),
    ], { currentLevel: 3, currentSlot: 'h21' }));
    assert.equal(plan.lv4Open, true);
    assert.equal(plan.reservePassUsed, false, '幻の温存は採用しない');
    const finiteB5 = plan.levels.find(lv => lv.level === 3).bosses.find(b => b.bossNumber === 5);
    assert.ok(finiteB5.attacks.some(a => a.memberName === '大火力'), '大火力は踏破に使う');
    const lv4 = plan.levels[plan.levels.length - 1].bosses[0];
    assert.ok(!lv4.attacks.some(a => a.reserved), '温存マークなし');
    assert.ok(!lv4.attacks.some(a => a.memberName === '大火力'), '出られない時間の幻凸をボス5に計上しない');
});

test('温存マークは編成単位: 元からボス5行きだった2編成目には付かない', () => {
    // probe: 大火力の編成① (25B) が有限ボス5を締め、編成② (22B) はボス5(無限)へ。
    // 温存パス: 小火力2人で締め直し、編成①②とも無限へ。🔒 は probe から移動した①だけ
    const big = player('大火力', { wind: 25 }, { slv: 800 });
    big.loadoutsByAttr = { wind: [
        { dmgB: 25, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 22, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
    ] };
    const plan = compute(lv3Input(fiveBosses({ b5: 30 }), [
        player('小火力1', { wind: 16 }, { slv: 400 }),
        player('小火力2', { wind: 16 }, { slv: 401 }),
        player('火担当', { fire: 5 }, { slv: 450 }),
        player('水担当', { water: 5 }, { slv: 460 }),
        player('電担当', { electric: 5 }, { slv: 470 }),
        player('鉄担当', { iron: 5 }, { slv: 480 }),
        big,
    ]));
    assert.equal(plan.reservePassUsed, true);
    const lv4 = plan.levels[plan.levels.length - 1].bosses[0];
    const mine = lv4.attacks.filter(a => a.memberName === '大火力');
    assert.equal(mine.length, 2, `編成①②ともボス5へ: ${lv4.attacks.map(a => `${a.memberName}#${a.loadoutSlot}`)}`);
    const s1 = mine.find(a => a.loadoutSlot === 1);
    const s2 = mine.find(a => a.loadoutSlot === 2);
    assert.equal(s1.reserved, true, '編成① (probe では有限ボス行き) に 🔒');
    assert.ok(!s2.reserved, '編成② (元からボス5行き) には付かない');
});

// ---- フロンティア吸収 (踏破できないレベルの与ダメ最大化) ----------------------
console.log('\nfrontier:');

test('踏破できないレベルでは残スロットをオーバーキル最小の配り方にする (ボス順に縛られない)', () => {
    // 残1凸の人が fire(残5B) と water(残50B) を持つ。ボス順の逐次投入だと fire に
    // 出してオーバーキル5B (credited 5) だが、吸収割当なら water へ出して credited 10
    const plan = compute(lv3Input([
        boss(1, 'fire', { remainingB: 5 }),
        boss(2, 'water', { remainingB: 50 }),
        boss(3, 'electric', { remainingB: 0 }),
        boss(4, 'iron', { remainingB: 0 }),
        boss(5, 'wind', { tier: 'tyrant', remainingB: 0 }),
    ], [
        player('残り1凸', { fire: 10, water: 10 }, { attackCount: 2, attacks: [{ boss_number: 3 }, { boss_number: 4 }] }),
    ]));
    assert.equal(plan.fullyClearedThrough, 2, 'Lv3 は踏破できない');
    assert.equal(plan.frontierLevel, 3);
    const lv3 = plan.levels.find(lv => lv.level === 3);
    const fire = lv3.bosses.find(b => b.weakness === 'fire');
    const water = lv3.bosses.find(b => b.weakness === 'water');
    assert.equal(fire.attacks.length, 0, 'オーバーキルになる fire には出さない');
    assert.equal(water.attacks.length, 1, '全額入る water に出す');
    assert.equal(plan.totalWaste, 0);
    assert.ok(Math.abs(plan.totalCreditedB - 10) < 1e-6, `credited=10 のはず: ${plan.totalCreditedB}`);
    assert.ok(Math.abs(water.absorbedB - 10) < 1e-6);
    assert.equal(fire.cleared, false, '無理に倒さない');
});

test('フロンティアの手前のレベルは従来どおり撃破する', () => {
    // Lv1 は残5B×5 で踏破可能、Lv2 は標準HP (149B/226B) で踏破不能 → Lv2 が吸収レベル。
    // P火 は fire 2編成なので Lv1 で1つ使っても Lv2 に出せる凸が残る
    const pf = player('P火', { fire: 10 });
    pf.loadoutsByAttr = { fire: [
        { dmgB: 10, team: ['a', 'b', 'c', 'd', 'e'], slot: 1 },
        { dmgB: 9, team: ['f', 'g', 'h', 'i', 'j'], slot: 2 },
    ] };
    const plan = compute(makeInput(fiveBosses(), [
        pf, player('P水', { water: 10 }),
        player('P電', { electric: 10 }), player('P鉄', { iron: 10 }),
        player('P風', { wind: 10 }),
    ]));
    assert.equal(plan.fullyClearedThrough, 1);
    assert.equal(plan.frontierLevel, 2);
    const lv1 = plan.levels.find(lv => lv.level === 1);
    assert.ok(lv1.levelCleared, 'Lv1 は撃破想定');
    assert.ok(lv1.bosses.every(b => b.cleared));
    // Lv1 の fire ボス (残5B) にはオーバーキルの小さい2編成目 (9B) が使われる
    const lv1Fire = lv1.bosses.find(b => b.weakness === 'fire');
    assert.equal(lv1Fire.attacks[0].dmgB, 9);
    const lv2 = plan.levels.find(lv => lv.level === 2);
    assert.ok(!lv2.levelCleared);
    // 吸収モード: 残った fire 1編成目 (10B) は Lv2 の fire ボスへ全額入る
    const lv2Attacks = lv2.bosses.flatMap(b => b.attacks);
    assert.ok(lv2Attacks.length > 0, 'フロンティアでも凸は計画される');
    assert.ok(lv2Attacks.every(a => a.overflowB === 0), 'プールが大きいのでオーバーキルなし');
    assert.ok(lv2.bosses.every(b => b.absorbedB != null), '吸収量が出力される');
});

// ---- ドメイン: 属性変換 (js/domain/attributes.js — リアーキ ステップ1) --------
console.log('\ndomain/attributes:');

test('normalizeAttrKey: 大文字・空白・未知値を正規化する', () => {
    assert.equal(normalizeAttrKey('WATER'), 'water');       // 比較タブ系の大文字ドメイン境界
    assert.equal(normalizeAttrKey(' Fire '), 'fire');
    assert.equal(normalizeAttrKey('fire'), 'fire');
    assert.equal(normalizeAttrKey('FIRE PT'), null);        // 未知の表記は素通しせず null
    assert.equal(normalizeAttrKey(''), null);
    assert.equal(normalizeAttrKey(null), null);
    assert.equal(normalizeAttrKey(undefined), null);
    assert.equal(normalizeAttrKey(42), null);
});

test('相性写像はゲーム仕様と一致し、往復で元に戻る', () => {
    // ゲーム仕様: 風ボス→火PT / 火ボス→水PT / 水ボス→電PT / 電ボス→鉄PT / 鉄ボス→風PT
    const expect = { wind: 'fire', fire: 'water', water: 'electric', electric: 'iron', iron: 'wind' };
    for (const [bossAttr, pt] of Object.entries(expect)) {
        assert.equal(weaknessPtOf({ attribute: bossAttr }), pt, `${bossAttr}ボスの弱点`);
        // 逆写像: weakness から ボス属性を戻せる (往復一致 = 写像が全単射)
        assert.equal(bossAttributeOf({ weakness: pt }), bossAttr, `${pt}PTが刺さるボス`);
    }
    assert.equal(ATTR_KEYS.length, 5);
});

test('weaknessPtOf: DB保存済みの weakness を最優先し、相性の再計算はしない', () => {
    // weakness と attribute が矛盾する行 (手入力事故など) では weakness が勝つ —
    // 相性表による上書きをしないことが「画面からの逆算追放」の意味
    assert.equal(weaknessPtOf({ attribute: 'fire', weakness: 'wind' }), 'wind');
    // 大文字で入っていても正規化される
    assert.equal(weaknessPtOf({ weakness: 'WIND' }), 'wind');
});

test('weaknessPtOf: weakness の無い旧データ行は attribute から導出、両方無ければ null', () => {
    assert.equal(weaknessPtOf({ attribute: 'wind' }), 'fire');
    assert.equal(weaknessPtOf({ attribute: 'wind', weakness: null }), 'fire');
    assert.equal(weaknessPtOf({}), null);
    assert.equal(weaknessPtOf(null), null);
    assert.equal(weaknessPtOf(undefined), null);
    assert.equal(weaknessPtOf({ attribute: '謎属性' }), null);
});

test('bossAttributeOf: attribute 優先・weakness から逆算・両方無ければ null', () => {
    assert.equal(bossAttributeOf({ attribute: 'iron', weakness: 'fire' }), 'iron');
    assert.equal(bossAttributeOf({ weakness: 'electric' }), 'water');
    assert.equal(bossAttributeOf({}), null);
    assert.equal(bossAttributeOf(null), null);
});

// ---- ドメイン: ふるり値計算 (js/domain/fururi.js — リアーキ ステップ2) --------
console.log('\ndomain/fururi:');

// 共通フィクスチャ: SLv500 を基準に 600=1.2倍 / 700=1.4倍
const RATIO = { '500': 1.0, '600': 1.2, '700': 1.4 };
const fpl = (name, slv, totalDamage, attacks) => ({ player: name, syncLevel: slv, damage: totalDamage, attacks });

test('buildFururiBaseMaps: classic は基準者の bossCode別max、模擬スコアは実凸より優先', () => {
    const maps = fururiDomain.buildFururiBaseMaps({
        players: [
            fpl('ふるり', 500, 30, [
                { bossCode: 'A', damage: 10 }, { bossCode: 'A', damage: 12 },   // max=12
                { bossCode: 'B', damage: 8 },
            ]),
        ],
        basePlayerName: 'ふるり',
        simulationScores: { B: 9, C: 7, D: 0 },   // B=差し替え / C=未凸補完 / D=0は無効
        slvRatioTable: RATIO,
    });
    assert.equal(maps.classic.A.damage, 12, '同bossCodeはmax採用');
    assert.equal(maps.classic.B.damage, 9, '模擬スコアが実凸(8)を差し替える');
    assert.equal(maps.classic.C.damage, 7, '未凸属性は模擬で補完');
    assert.equal(maps.classic.D, undefined, '0以下の模擬値は無視');
    // mean: (12+9+7)/3 が全コード共通
    const meanVal = (12 + 9 + 7) / 3;
    for (const code of ['A', 'B', 'C']) assert.ok(Math.abs(maps.mean[code].damage - meanVal) < 1e-9);
});

test('buildFururiBaseMaps: 基準者が居ない/SLv無しなら全マップ null', () => {
    const noBase = fururiDomain.buildFururiBaseMaps({
        players: [fpl('別人', 600, 10, [])], basePlayerName: 'ふるり', slvRatioTable: RATIO,
    });
    assert.equal(noBase.classic, null);
    assert.equal(noBase.mean, null);
    assert.equal(noBase.median, null);
    const slvZero = fururiDomain.buildFururiBaseMaps({
        players: [fpl('ふるり', 0, 10, [{ bossCode: 'A', damage: 5 }])], basePlayerName: 'ふるり', slvRatioTable: RATIO,
    });
    assert.equal(slvZero.classic, null, 'SLv 0 の基準者は不採用');
});

test('buildFururiBaseMaps: 上位N平均は SLv正規化し、同一人物は最大1件、データ無し属性は classic へフォールバック', () => {
    const maps = fururiDomain.buildFururiBaseMaps({
        players: [
            fpl('ふるり', 500, 30, [{ bossCode: 'A', damage: 10 }, { bossCode: 'X', damage: 5 }]),
            // SLv700 (1.4倍) の 14 は 基準SLv換算で 14*1.0/1.4 = 10
            fpl('強い人', 700, 30, [{ bossCode: 'A', damage: 14 }, { bossCode: 'A', damage: 7 }]),   // 同人物は max のみ
            fpl('弱い人', 600, 30, [{ bossCode: 'A', damage: 6 }]),                                   // 6/1.2 = 5
        ],
        basePlayerName: 'ふるり', slvRatioTable: RATIO, topN: 2,
    });
    // A の上位2名 (正規化後): ふるり10, 強い人10 → 平均10 (弱い人5 は topN=2 で切られる)
    assert.ok(Math.abs(maps.median.A.damage - 10) < 1e-9, `上位2名平均=10 のはず: ${maps.median.A.damage}`);
    assert.equal(maps.median.A.sampleSize, 2);
    // X は基準者しか凸していない → その1名で平均
    assert.ok(Math.abs(maps.median.X.damage - 5) < 1e-9);
});

test('calcFururiScore: SLv換算込みの全体ふるり値 (基準者と同等火力なら1.0)', () => {
    const basePlayer = fpl('ふるり', 500, 30, []);
    const args = { basePlayer, maps: { classic: {}, mean: null, median: null }, slvRatioTable: RATIO };
    // SLv600 の人が基準合計30の1.2倍=36 を出せば 1.0
    assert.ok(Math.abs(fururiDomain.calcFururiScore({ ...args, playerDamage: 36, playerSLv: 600, mode: 'classic' }) - 1.0) < 1e-9);
    // 半分しか出なければ 0.5
    assert.ok(Math.abs(fururiDomain.calcFururiScore({ ...args, playerDamage: 18, playerSLv: 600, mode: 'classic' }) - 0.5) < 1e-9);
    // 計算不能条件は null (テーブル未ロード / SLv不明 / テーブルに無いSLv)
    assert.equal(fururiDomain.calcFururiScore({ ...args, playerDamage: 36, playerSLv: 600, slvRatioTable: null }), null);
    assert.equal(fururiDomain.calcFururiScore({ ...args, playerDamage: 36, playerSLv: 0 }), null);
    assert.equal(fururiDomain.calcFururiScore({ ...args, playerDamage: 36, playerSLv: 999 }), null);
});

test('calcPerAttackFururi: 凸単位のふるり値と mode 別基準の切替', () => {
    const maps = {
        classic: { A: { damage: 10, slv: 500 } },
        mean: { A: { damage: 20, slv: 500 } },
        median: null,   // median 未構築時は classic に落ちる
    };
    const args = { playerSLv: 600, bossCode: 'A', maps, slvRatioTable: RATIO };
    // classic: 基準10×1.2=12 に対し 12 → 1.0
    assert.ok(Math.abs(fururiDomain.calcPerAttackFururi({ ...args, damage: 12, mode: 'classic' }) - 1.0) < 1e-9);
    // mean: 基準20×1.2=24 に対し 12 → 0.5
    assert.ok(Math.abs(fururiDomain.calcPerAttackFururi({ ...args, damage: 12, mode: 'mean' }) - 0.5) < 1e-9);
    // median 未構築 → classic フォールバックで 1.0
    assert.ok(Math.abs(fururiDomain.calcPerAttackFururi({ ...args, damage: 12, mode: 'median' }) - 1.0) < 1e-9);
    // 基準マップに無い bossCode は null
    assert.equal(fururiDomain.calcPerAttackFururi({ ...args, damage: 12, bossCode: 'Z' }), null);
});

test('fururiBaseTotalsByMode: mean=平均×3 / median=5属性平均×3 / classic=基準者の合計', () => {
    const basePlayer = fpl('ふるり', 500, 33, []);
    const maps = {
        classic: {},
        mean: { A: { damage: 10 }, B: { damage: 10 } },
        median: { A: { damage: 8 }, B: { damage: 12 } },
    };
    assert.equal(fururiDomain.fururiBaseTotalsByMode({ basePlayer, mode: 'mean', maps }), 30);
    assert.equal(fururiDomain.fururiBaseTotalsByMode({ basePlayer, mode: 'median', maps }), 30);   // (8+12)*3/2
    assert.equal(fururiDomain.fururiBaseTotalsByMode({ basePlayer, mode: 'classic', maps }), 33);
    // マップ未構築のモードは classic (基準者合計) に落ちる
    assert.equal(fururiDomain.fururiBaseTotalsByMode({ basePlayer, mode: 'mean', maps: { classic: {}, mean: null, median: null } }), 33);
});

// ---- ドメイン: OCR後処理 (js/domain/ocr.js — リアーキ ステップ2) --------------
console.log('\ndomain/ocr:');

test('normNameForMatch: NFKC・全角コロン・空白・バーストレベル接頭辞を正規化', () => {
    assert.equal(ocrDomain.normNameForMatch('アニス：スター'), 'アニス:スター');
    assert.equal(ocrDomain.normNameForMatch(' ラピ  '), 'ラピ');
    assert.equal(ocrDomain.normNameForMatch('MAXアニス'), 'アニス', '画面のバーストLv表記 MAX を剥がす');
    assert.equal(ocrDomain.normNameForMatch('Ⅲラピ'), 'ラピ', 'ローマ数字接頭辞も剥がす');
    assert.equal(ocrDomain.normNameForMatch('マクスウェル'), 'マクスウェル', 'かな直前以外は剥がさない');
    assert.equal(ocrDomain.normNameForMatch(null), '');
});

test('simBetween: OCR誤読パターン別の段階スコア', () => {
    assert.equal(ocrDomain.simBetween('アニス：スター', 'アニス:スター'), 1, '正規化後の完全一致');
    assert.equal(ocrDomain.simBetween('アニス', 'アニス:スター'), 0.92, '見切れ (接頭辞関係)');
    assert.equal(ocrDomain.simBetween('レッドフード', 'ラピ:レッドフード'), 0.92, '部分文字列');
    // 1文字違いの Levenshtein: 距離1/長さ3 → 1 - 1/3
    assert.ok(Math.abs(ocrDomain.simBetween('カカカ', 'カカタ') - (1 - 1 / 3)) < 1e-9);
    assert.equal(ocrDomain.simBetween('', 'ラピ'), 0);
});

test('fuzzyResolveCharacter: 完全一致(エイリアス含む)優先 → ファジィ → raw 温存', () => {
    const master = [{ canonical_name: 'ラピ:レッドフード' }, { canonical_name: 'アニス:スター' }];
    const byName = new Map([
        ['ラピ:レッドフード', master[0]], ['赤ずきん', master[0]],   // エイリアス
        ['アニス:スター', master[1]],
    ]);
    const args = { master, exactByName: byName };
    assert.equal(ocrDomain.fuzzyResolveCharacter({ ...args, rawName: '赤ずきん' }), 'ラピ:レッドフード', 'エイリアス完全一致');
    assert.equal(ocrDomain.fuzzyResolveCharacter({ ...args, rawName: 'ラピレッドフード' }), 'ラピ:レッドフード', 'コロン欠落もファジィで解決');
    assert.equal(ocrDomain.fuzzyResolveCharacter({ ...args, rawName: 'まったく別の何か' }), 'まったく別の何か', '閾値未満は raw のまま');
    assert.equal(ocrDomain.fuzzyResolveCharacter({ ...args, rawName: 'ラピ' }), 'ラピ', '3文字未満は誤マッチ防止で raw (正規化後2文字)');
    assert.equal(ocrDomain.fuzzyResolveCharacter({ master: [], rawName: 'ラピ' }), 'ラピ', 'マスタ空は raw');
    assert.equal(ocrDomain.fuzzyResolveCharacter({ ...args, rawName: '' }), null);
});

test('mergeOcrAttackResults: 5枚揃い優先・和集合の順序保持・最初の有効値採用', () => {
    // 5枚揃いが無い → 和集合 (順序保持・重複除去・5件まで)
    const union = ocrDomain.mergeOcrAttackResults([
        { characters: ['A', 'B'], bossName: '', totalDamage: null },
        null,
        { characters: ['B', 'C', 'D'], bossName: 'ゼウス', totalDamage: 123 },
        { characters: ['E', 'F'] },
    ]);
    assert.deepEqual(union.characters, ['A', 'B', 'C', 'D', 'E'], '順序保持・重複除去・5件まで');
    assert.equal(union.bossName, 'ゼウス', "空文字は飛ばして最初の有効値");
    assert.equal(union.totalDamage, 123);
    // 5枚揃いがある → その画像を丸ごと優先
    const five = ocrDomain.mergeOcrAttackResults([
        { characters: ['X'] },
        { characters: ['P', 'Q', 'R', 'S', 'T', 'U'] },
    ]);
    assert.deepEqual(five.characters, ['P', 'Q', 'R', 'S', 'T'], '5枚揃い画像を優先し5件に切る');
    // 全部空
    const empty = ocrDomain.mergeOcrAttackResults([]);
    assert.equal(empty.characters, null);
    assert.equal(empty.bossName, null);
});

test('detectBossCode: 完全一致 → 空白分割OCR → トライグラムファジィの3段', () => {
    assert.equal(ocrDomain.detectBossCode('ゼウスが出現', {}), 'Z.E.U.S.', '静的キーワード辞書');
    assert.equal(ocrDomain.detectBossCode('ス トーム ブリ ンガー', {}), 'Z.E.U.S.', 'OCRの空白分割に耐える');
    // 動的データ由来 (ローマ数字接頭辞 + ASCII を除去して照合)
    assert.equal(ocrDomain.detectBossCode('クラーケンEX戦', {
        dynamicBossNames: [{ code: 'D.M.T.R.', name: 'IIIクラーケンEX' }],
    }), 'D.M.T.R.');
    // nameJP からのカタカナ抽出
    assert.equal(ocrDomain.detectBossCode('本日の相手はヘスティア', {
        nameJpByCode: { 'H.S.T.A.': '灼熱ヘスティア' },
    }), 'H.S.T.A.');
    // トライグラム: 1文字化けても引き当てる
    assert.equal(ocrDomain.detectBossCode('ストーAブリンガー', {}), 'Z.E.U.S.', '1文字誤認識をファジィ救済');
    assert.equal(ocrDomain.detectBossCode('無関係なテキスト', {}), null);
    assert.equal(ocrDomain.detectBossCode('', {}), null);
});

// ---- ドメイン: 締め凸候補の選別 (js/domain/finish.js — リアーキ ステップ2) -----
console.log('\ndomain/finish:');

test('computeFinishPlans: 1凸で足りるなら tight は1凸、同一プランは safe に重複させない', () => {
    const r = finishDomain.computeFinishPlans([{ name: 'A', dmg: 10 }], 8);
    assert.equal(r.cannotKill, false);
    assert.equal(r.tight.shots, 1);
    assert.ok(Math.abs(r.tight.overkill - 2) < 1e-9);
    assert.equal(r.safe, null, 'tight と同一の組合せは safe として出さない');
});

test('computeFinishPlans: tight=オーバーキル最小 / safe=10%余裕の中で凸数最少→OK最小', () => {
    const A = { name: 'A', dmg: 10.5 }, B = { name: 'B', dmg: 6 }, C = { name: 'C', dmg: 5 };
    const r = finishDomain.computeFinishPlans([A, B, C], 10);
    assert.deepEqual(r.tight.members.map(m => m.name), ['A'], 'ギリギリはオーバーキル0.5のA単騎');
    assert.deepEqual(r.safe.members.map(m => m.name), ['B', 'C'], '余裕(=残HP10%以上)ではB+C (over 1.0)');
});

test('computeFinishPlans: 1/2凸で届かない時だけ3凸を探索、3人でも届かなければ cannotKill', () => {
    const three = finishDomain.computeFinishPlans(
        [{ name: 'A', dmg: 4 }, { name: 'B', dmg: 4 }, { name: 'C', dmg: 4 }], 10);
    assert.equal(three.tight.shots, 3);
    assert.ok(Math.abs(three.tight.overkill - 2) < 1e-9);
    const cant = finishDomain.computeFinishPlans([{ name: 'A', dmg: 3 }, { name: 'B', dmg: 3 }], 10);
    assert.equal(cant.cannotKill, true);
    assert.equal(cant.tight, null);
    // 残HP 0 以下は「締め不要」であって cannotKill ではない
    const dead = finishDomain.computeFinishPlans([{ name: 'A', dmg: 3 }], 0);
    assert.equal(dead.cannotKill, false);
    assert.equal(dead.tight, null);
});

test('buildFinishLeaderTimeline: 現在時から24時間走査・時間帯フィルタ・リーダー変化点', () => {
    const A = { name: 'A', dmg: 10, availableSlots: ['h22', 'h00'] };
    const B = { name: 'B', dmg: 20, availableSlots: ['h23'] };
    const noSlot = { name: 'C', dmg: 99, availableSlots: [] };   // 未設定=未参加で除外
    const { rows, leaderChanges } = finishDomain.buildFinishLeaderTimeline({
        candidates: [A, B, noSlot], curHour: 22,
    });
    assert.equal(rows[0].hour, 22, '現在時が先頭');
    assert.equal(rows[1].hour, 23);
    assert.equal(rows[2].hour, 0, '日付をまたいで一周する');
    assert.equal(rows[0].best.name, 'A');
    assert.equal(rows[1].best.name, 'B');
    assert.equal(rows[2].best.name, 'A');
    assert.equal(rows[3].best, null, '誰も居ない時間帯は null');
    assert.equal(leaderChanges, 3, 'A→B→A で3回変化 (時間未設定のCは現れない)');
    assert.ok(rows[0].isLeaderChange && rows[1].isLeaderChange && rows[2].isLeaderChange);
});

// ---- ドメイン: ダメージ整形 (js/domain/format.js — リアーキ ステップ2) ---------
console.log('\ndomain/format:');

test('rawToB / formatDamageRaw / trimZeroB', () => {
    assert.equal(formatDomain.rawToB(1e9), 1);
    assert.equal(formatDomain.rawToB('2000000000'), 2);
    assert.equal(formatDomain.rawToB(null), 0);
    assert.equal(formatDomain.rawToB('abc'), 0);
    assert.equal(formatDomain.formatDamageRaw(1234567890), '1.23B');
    assert.equal(formatDomain.formatDamageRaw(-1.5e9), '-1.50B', '負値は符号つき (旧 formatDamage 互換)');
    assert.equal(formatDomain.formatDamageRaw(null), '-');
    assert.equal(formatDomain.formatDamageRaw(NaN), '-');
    assert.equal(formatDomain.trimZeroB(22.5), '22.5');
    assert.equal(formatDomain.trimZeroB(5), '5');
    assert.equal(formatDomain.trimZeroB(5.25), '5.25');
    assert.equal(formatDomain.trimZeroB(0), '0');
    assert.equal(formatDomain.trimZeroB(null), '');
});

// ---- 状態ストア: opsStore (js/state/opsStore.js — リアーキ ステップ3) ----------
console.log('\nstate/opsStore:');

// 非同期テスト用の小さなランナー (既存 test() は同期専用のため)
async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message}`);
    }
}

const opsStore = globalThis.opsStore;
await testAsync('load/get/invalidate: 基本契約 (未ロードは null・invalidate 後も null)', async () => {
    let calls = 0;
    opsStore.configure({ load: async () => { calls++; return { season: { id: 1 }, bosses: [], players: [] }; } });
    opsStore.invalidate();
    assert.equal(opsStore.get(), null, '未ロードは null (例外を投げない)');
    const d = await opsStore.load();
    assert.equal(d.season.id, 1);
    assert.equal(opsStore.get(), d);
    opsStore.invalidate();
    assert.equal(opsStore.get(), null);
    assert.equal(calls, 1);
});

await testAsync('isStale: 60秒TTL 相当の判定 (未ロード=常に古い / 部分patchでは若返らない)', async () => {
    opsStore.configure({ load: async () => ({ season: { id: 7 }, bosses: [{ n: 1 }], players: [] }) });
    opsStore.invalidate();
    assert.equal(opsStore.isStale(60_000), true, '未ロードは stale');
    await opsStore.load();
    const now = Date.now();
    assert.equal(opsStore.isStale(60_000, now + 1_000), false, 'ロード直後は fresh');
    assert.equal(opsStore.isStale(60_000, now + 61_000), true, '60秒超で stale');
    // 不変条件4: patchBosses は全量ロード時刻を進めない → stale 判定は変わらない
    assert.equal(opsStore.patchBosses(7, [{ n: 2 }]), true);
    assert.equal(opsStore.get().bosses[0].n, 2, 'bosses は差し替わる');
    assert.equal(opsStore.isStale(60_000, now + 61_000), true, 'patch してもプランTTLは古いまま');
});

await testAsync('patchBosses: シーズン不一致・未ロードでは何もしない', async () => {
    opsStore.configure({ load: async () => ({ season: { id: 7 }, bosses: [{ n: 1 }], players: [] }) });
    opsStore.invalidate();
    assert.equal(opsStore.patchBosses(7, [{ n: 9 }]), false, '未ロード時は false');
    await opsStore.load();
    assert.equal(opsStore.patchBosses(8, [{ n: 9 }]), false, '別シーズンは差し替えない');
    assert.equal(opsStore.get().bosses[0].n, 1, '中身は不変');
});

await testAsync('patchPlayer: 該当者のみ部分更新・未ロード/不在は false', async () => {
    opsStore.configure({ load: async () => ({ season: { id: 1 }, bosses: [], players: [{ id: 'a', syncLevel: 100 }, { id: 'b', syncLevel: 200 }] }) });
    opsStore.invalidate();
    assert.equal(opsStore.patchPlayer('a', { syncLevel: 500 }), false, '未ロード時は false');
    await opsStore.load();
    assert.equal(opsStore.patchPlayer('a', { syncLevel: 500, syncLevelEstimated: false }), true);
    assert.equal(opsStore.get().players[0].syncLevel, 500);
    assert.equal(opsStore.get().players[1].syncLevel, 200, '他は不変');
    assert.equal(opsStore.patchPlayer('zzz', { syncLevel: 1 }), false);
});

await testAsync('load 失敗時は既存データを保持する (旧実装と同じ: 代入前に throw)', async () => {
    let fail = false;
    opsStore.configure({ load: async () => { if (fail) throw new Error('network'); return { season: { id: 1 }, bosses: [], players: [] }; } });
    opsStore.invalidate();
    await opsStore.load();
    fail = true;
    await assert.rejects(() => opsStore.load());
    assert.ok(opsStore.get(), '失敗しても前回の盤面が残る');
    assert.equal(opsStore.get().season.id, 1);
});

await testAsync('レース: 進行中の load は invalidate で破棄される (無効化済み盤面が復活しない)', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    opsStore.configure({ load: async () => { await gate; return { season: { id: 'stale' }, bosses: [], players: [] }; } });
    opsStore.invalidate();
    const p = opsStore.load();           // 応答待ちに入る
    opsStore.invalidate();               // その間に書き込み操作が発生
    release();
    const fetched = await p;
    assert.equal(fetched.season.id, 'stale', '呼び出し元にはフェッチ結果が返る (描画には使える)');
    assert.equal(opsStore.get(), null, 'ストアには保存されない — 無効化が勝つ');
});

await testAsync('レース: 並行 load では遅い古の応答が新しい応答を上書きしない', async () => {
    const gates = [];
    let n = 0;
    opsStore.configure({ load: () => new Promise(r => { const id = ++n; gates.push(() => r({ season: { id }, bosses: [], players: [] })); }) });
    opsStore.invalidate();
    const p1 = opsStore.load();          // 古い load (遅い)
    const p2 = opsStore.load();          // 新しい load (速い)
    gates[1]();                          // 新しい方が先に完了
    await p2;
    assert.equal(opsStore.get().season.id, 2);
    gates[0]();                          // 古い方が遅れて完了
    await p1;
    assert.equal(opsStore.get().season.id, 2, '古い応答はストアを上書きしない');
});

// 後続テストが本物のローダに触らないよう既定へ戻す
opsStore.configure({});
opsStore.invalidate();

// ---- 状態ストア: seasonStore (js/state/seasonStore.js) ------------------------
console.log('\nstate/seasonStore:');

const seasonStore = globalThis.seasonStore;
await testAsync('ensure: キャッシュ優先・無ければ1回だけロード', async () => {
    let calls = 0;
    seasonStore.configure({ load: async () => { calls++; return { season: { id: 5 }, bosses: [{ n: 1 }] }; } });
    seasonStore.invalidate();
    const a = await seasonStore.ensure();
    const b = await seasonStore.ensure();
    assert.equal(a.season.id, 5);
    assert.equal(a, b, '2回目はキャッシュを返す');
    assert.equal(calls, 1, 'ロードは1回だけ');
});

await testAsync('ensure: 取得失敗は {season:null,bosses:[]} をキャッシュ (invalidate まで再試行しない)', async () => {
    let calls = 0;
    seasonStore.configure({ load: async () => { calls++; throw new Error('network'); } });
    seasonStore.invalidate();
    const a = await seasonStore.ensure();
    assert.equal(a.season, null);
    assert.deepEqual(a.bosses, []);
    await seasonStore.ensure();
    assert.equal(calls, 1, '失敗結果もキャッシュされ再試行しない (旧実装と同一)');
    seasonStore.invalidate();
    await seasonStore.ensure().catch(() => {});
    assert.equal(calls, 2, 'invalidate 後は再試行する');
});

await testAsync('ensure: ローダ未定義なら null を返しキャッシュしない (supabase未ロード時)', async () => {
    seasonStore.configure({});           // 既定に戻す (node 環境では supabase 関数が存在しない)
    seasonStore.invalidate();
    assert.equal(await seasonStore.ensure(), null);
    assert.equal(seasonStore.get(), null, 'キャッシュされない');
});

await testAsync('patchBosses / invalidate 中の ensure 破棄 (opsStore と同じ世代ガード)', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    seasonStore.configure({ load: async () => { await gate; return { season: { id: 9 }, bosses: [{ n: 1 }] }; } });
    seasonStore.invalidate();
    const p = seasonStore.ensure();
    seasonStore.invalidate();            // 応答待ち中に書き込み操作
    release();
    await p;
    assert.equal(seasonStore.get(), null, '無効化済みシーズンは復活しない');
    // patchBosses: シーズン一致のみ
    seasonStore.configure({ load: async () => ({ season: { id: 9 }, bosses: [{ n: 1 }] }) });
    await seasonStore.ensure();
    assert.equal(seasonStore.patchBosses(8, [{ n: 9 }]), false);
    assert.equal(seasonStore.patchBosses(9, [{ n: 2 }]), true);
    assert.equal(seasonStore.get().bosses[0].n, 2);
});

// 後続テストが本物のローダに触らないよう既定へ戻す
seasonStore.configure({});
seasonStore.invalidate();

// ---- 結果 --------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
