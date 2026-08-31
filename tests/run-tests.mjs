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
import '../js/domain/mockCompare.js';
import '../js/domain/raidEvents.js';   // 戦況の変化検知 (撃破/レベル開放)  // globalThis.mockCompareDomain (UI再設計 Stage2)
import '../js/domain/gbCompare.js';    // globalThis.gbCompareDomain (GB連携)
import '../js/domain/mockLevels.js';   // globalThis.mockLevelsDomain (レベル別測定値)
import '../js/domain/popularTeams.js';  // globalThis.popularTeamsDomain (人気編成の合算集計)
import '../js/domain/testSeason.js';    // globalThis.testSeasonDomain (テスト終了時のキャラ整理)
import '../js/state/opsStore.js';      // globalThis.opsStore (リアーキ ステップ3)
import '../js/state/seasonStore.js';   // globalThis.seasonStore (リアーキ ステップ3宿題)

const compute = globalThis.computeOptimalPlanCore;
const { normalizeAttrKey, weaknessPtOf, bossAttributeOf, ATTR_KEYS, fururiDomain, ocrDomain, finishDomain, formatDomain, gbCompareDomain } = globalThis;

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

// ---- 模擬の測定レベル (boss_level) --------------------------------------------
// ルール: 記録レベル L の編成は「対象レベル ≤ L」にだけ使える。
// level == null (レベル未指定 = 移行前の提出) は全レベルで使える。
console.log('\nloadoutLevel:');

test('Lv1で測った編成は Lv2 のボスに割り当てられない', () => {
    // Lv1 のボスは全滅済み → 割当は Lv2 から始まる。
    // Lv1測定の編成しか無い人は Lv2 に出せないので、凸が余る
    const bs = [boss(1, 'fire', { remainingB: 0, totalB: 100 })];
    const p = player('A', { fire: 30 });
    p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 1 }] };
    const plan = compute(makeInput(bs, [p], { currentLevel: 2 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 0, `Lv1測定の編成は Lv2 に出せないはず: ${used.length}凸`);
});

test('Lv2で測った編成は Lv2 にも Lv1 にも使える (高レベル測定は下位互換)', () => {
    const p = player('A', { fire: 30 });
    p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 2 }] };
    for (const lv of [1, 2]) {
        const plan = compute(makeInput([boss(1, 'fire', { remainingB: 20, totalB: 100 })], [p], { currentLevel: lv }));
        const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
        assert.equal(used.length, 1, `Lv2測定の編成は Lv${lv} で使えるはず`);
    }
});

test('レベル未指定 (移行前の提出) は全レベルで使える', () => {
    // ★ ここが崩れると既存235行が Lv2 以降で一切使えなくなり配信プランが壊れる
    const p = player('A', { fire: 30 });
    p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1 }] };   // level 無し
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 20, totalB: 100 })], [p], { currentLevel: 3 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1, 'レベル未指定は Lv3 でも使えるはず');
    assert.equal(used[0].loadoutLevel, null);
});

test('同じ属性でレベル違いの編成を出すと、対象レベルで使える方が選ばれる', () => {
    // Lv1測定 40B (高い) と Lv3測定 25B (低い)。Lv3 のボスには 25B しか使えない
    const p = player('A', { fire: 40 });
    p.loadoutsByAttr = { fire: [
        { dmgB: 40, team: ['a','b','c','d','e'], slot: 1, level: 1 },
        { dmgB: 25, team: ['f','g','h','i','j'], slot: 2, level: 3 },
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 3 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1);
    assert.equal(used[0].dmgB, 25, `Lv3 で使えるのは Lv3測定の25Bだけ: ${used[0].dmgB}`);
    assert.equal(used[0].loadoutLevel, 3);
});

test('Lv3で測った編成は Lv4 (ボス5・無限) には出せない', () => {
    // Lv4 は最上位。Lv3測定では届かない = ボス5への凸が発生しない
    const bs = [
        boss(1, 'fire', { tier: 'lord', remainingB: 0 }),
        boss(2, 'water', { tier: 'lord', remainingB: 0 }),
        boss(3, 'electric', { tier: 'tyrant', remainingB: 0 }),
        boss(4, 'iron', { tier: 'lord', remainingB: 0 }),
        boss(5, 'wind', { tier: 'tyrant', remainingB: 0 }),
    ];
    const p = player('A', { wind: 30 });
    p.loadoutsByAttr = { wind: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 3 }] };
    const plan = compute(makeInput(bs, [p], { currentLevel: 3 }));
    assert.equal(plan.lv4Open, true);
    const lv4 = plan.levels[plan.levels.length - 1];
    assert.equal(lv4.bosses[0].attacks.length, 0, 'Lv3測定ではボス5に出せないはず');
    // 運営が打ち手を判断できるよう、理由が「測定レベル不足」と分かること
    const d = (plan.unusedDetail || []).find(x => x.name === 'A');
    assert.ok(d && /Lv4/.test(d.reason), `理由に Lv4 測り直しの案内が要る: ${d?.reason}`);
});

test('Lv4で測った編成はボス5に出せる (全額計上)', () => {
    const bs = [
        boss(1, 'fire', { tier: 'lord', remainingB: 0 }),
        boss(2, 'water', { tier: 'lord', remainingB: 0 }),
        boss(3, 'electric', { tier: 'tyrant', remainingB: 0 }),
        boss(4, 'iron', { tier: 'lord', remainingB: 0 }),
        boss(5, 'wind', { tier: 'tyrant', remainingB: 0 }),
    ];
    const p = player('A', { wind: 30 });
    p.loadoutsByAttr = { wind: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 4 }] };
    const plan = compute(makeInput(bs, [p], { currentLevel: 3 }));
    const lv4 = plan.levels[plan.levels.length - 1];
    assert.equal(lv4.bosses[0].attacks.length, 1);
    assert.equal(lv4.bosses[0].attacks[0].usedB, 30);
    assert.equal(lv4.bosses[0].attacks[0].loadoutLevel, 4);
});

test('ソルバーはスロット番号に依存しない (枠数を変えても壊れない)', () => {
    // 提出スロットの上限は DB と UI (MY_TEAM_SLOTS) が決めるもので、
    // ソルバーは渡されたロードアウトを枠数に関係なく扱う。
    // 2026-08-12 に 3→2 へ戻したときに、ソルバー側へ枠数の決め打ちが
    // 入り込んでいないことを固定しておく
    const p = player('A', { fire: 10 });
    p.loadoutsByAttr = { fire: [
        { dmgB: 10, team: ['a','b','c','d','e'], slot: 1 },
        { dmgB: 8, team: ['f','g','h','i','j'], slot: 2 },
        { dmgB: 6, team: ['k','l','m','n','o'], slot: 7 },   // 想定外の番号でも素通しする
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 24 })], [p]));
    const atks = plan.levels[0].bosses[0].attacks;
    assert.equal(atks.length, 3, `3凸ぶん出せるはず: ${atks.length}`);
    assert.deepEqual(atks.map(a => a.loadoutSlot), [1, 2, 7]);
});

test('ボス5弱点が得意属性で Lv4 未満測定でも、得意属性が消化される', () => {
    // 「得意属性の消化は Lv4 で満たせる」前提で有限レベルの必須枠を外す最適化 (lv4Mandatory)
    // がある。その前提には「Lv4 で出せる編成を持っていること」も要るので、
    // canAfter に usableAtLevel(lo, 4) を足してある。
    // ⚠ このテストは**そのガード単体を切り分けられていない** (ガードを外しても通る)。
    //    probe/温存の2パス選択で最終プランが一致してしまうため。
    //    ここではシナリオ全体の回帰 (Lv4未満測定の得意属性が消化される) だけを固定している。
    //    ガードを外すと canAfter(A) が false→true に変わることは実測で確認済み
    // 盤面: fire も wind も「A がぴったり削り切れる」大きさにしてある。
    // A の枠を予約しないと、先に処理される fire (b1) を A が取ってしまい、
    // 得意属性の wind は他メンバーで埋まって A の得意消化が消える
    const bs = [
        boss(1, 'fire', { tier: 'lord', remainingB: 20 }),
        boss(2, 'water', { tier: 'lord', remainingB: 5 }),
        boss(3, 'electric', { tier: 'tyrant', remainingB: 5 }),
        boss(4, 'iron', { tier: 'lord', remainingB: 5 }),
        boss(5, 'wind', { tier: 'tyrant', remainingB: 20 }),
    ];
    // A: 得意=wind (ボス5弱点) だが wind は Lv3 でしか測っていない → Lv4 では出せない
    const a = player('A', { wind: 20, fire: 20 }, { strong: ['wind'], attackCount: 2 });
    a.loadoutsByAttr = {
        wind: [{ dmgB: 20, team: ['a1','a2','a3','a4','a5'], slot: 1, level: 3 }],
        fire: [{ dmgB: 20, team: ['b1','b2','b3','b4','b5'], slot: 1 }],
    };
    const others = [
        player('P2', { fire: 9, water: 9, electric: 9 }),
        player('P3', { iron: 9, wind: 9 }),
        player('P4', { fire: 12 }),
        player('P5', { wind: 12 }),
    ];
    const plan = compute(makeInput(bs, [a, ...others], { currentLevel: 3 }));
    const mine = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks.map(x => ({ ...x, w: b.weakness }))))
        .filter(x => x.memberName === 'A');
    assert.equal(mine.length, 1, 'A は残1凸を使うはず');
    assert.equal(mine[0].w, 'wind', `得意属性 wind に割り当てられるはず: ${mine[0].w}`);
});

test('レベル指定と未指定が混ざっても、使える方だけが選ばれる', () => {
    // 「未指定 (全レベル可) の低火力」と「Lv1限定の高火力」が同居するケース。
    // Lv3 のボスには未指定の方しか使えない
    const p = player('A', { fire: 40 });
    p.loadoutsByAttr = { fire: [
        { dmgB: 40, team: ['a','b','c','d','e'], slot: 1, level: 1 },
        { dmgB: 12, team: ['f','g','h','i','j'], slot: 2 },          // 未指定
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 3 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1);
    assert.equal(used[0].dmgB, 12, `Lv3 で使えるのは未指定の12Bだけ: ${used[0].dmgB}`);
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

await testAsync('generation/isCurrentGeneration: load中の invalidate を呼び出し元が検出できる', async () => {
    // プラン算出は load() の戻り値 (snapshot) で描画するため、待機中に invalidate() が
    // 起きた場合はその snapshot が「無効化済みの盤面」であることを検出できる必要がある。
    opsStore.configure({
        load: async () => {
            opsStore.invalidate();   // 応答待ちの間に書き込み操作が起きた状況を再現
            return { season: { id: 9 }, bosses: [], players: [] };
        },
    });
    opsStore.invalidate();
    const genBefore = opsStore.generation();
    const snap = await opsStore.load();
    assert.ok(snap, 'フェッチ結果自体は返る');
    assert.equal(opsStore.isCurrentGeneration(genBefore + 1), false,
        'load中に invalidate されたら「最新世代ではない」と判定できるはず');
    assert.equal(opsStore.get(), null, '無効化済みなのでストアは null のまま (不変条件3)');

    // 競合が無い通常ケースは +1 のまま = そのまま使ってよい
    opsStore.configure({ load: async () => ({ season: { id: 10 }, bosses: [], players: [] }) });
    opsStore.invalidate();
    const g2 = opsStore.generation();
    const snap2 = await opsStore.load();
    assert.equal(opsStore.isCurrentGeneration(g2 + 1), true, '競合が無ければ最新世代');
    assert.equal(opsStore.get(), snap2);
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

await testAsync('レース: invalidate 中の ensure は古い結果を返さず最新世代で取り直す', async () => {
    // 呼び出し元はシーズンIDで凸を書き込むため、無効化前のシーズンを返してはいけない
    // (Codex レビュー指摘)。opsStore.load() の「スナップショット返し」とは意図的に違う契約
    const releases = [];
    let calls = 0;
    seasonStore.configure({ load: () => new Promise(r => { const id = ++calls; releases.push(() => r({ season: { id }, bosses: [] })); }) });
    seasonStore.invalidate();
    const p = seasonStore.ensure();      // 1回目のロードが応答待ちに入る
    seasonStore.invalidate();            // その間に書き込み操作 (シーズン切替など)
    releases[0]();                       // 古いロードが完了 → 破棄され、取り直しが走るはず
    while (releases.length < 2) await new Promise(r => setTimeout(r, 0));
    releases[1]();                       // 取り直し (最新世代) が完了
    const result = await p;
    assert.equal(calls, 2, '最新世代で取り直している');
    assert.equal(result.season.id, 2, '呼び出し元に返るのは取り直した最新の結果');
    assert.equal(seasonStore.get().season.id, 2, 'ストアも最新世代');
});

await testAsync('patchBosses: シーズン一致のみ差し替え', async () => {
    seasonStore.configure({ load: async () => ({ season: { id: 9 }, bosses: [{ n: 1 }] }) });
    seasonStore.invalidate();
    await seasonStore.ensure();
    assert.equal(seasonStore.patchBosses(8, [{ n: 9 }]), false);
    assert.equal(seasonStore.get().bosses[0].n, 1, '不一致では触らない');
    assert.equal(seasonStore.patchBosses(9, [{ n: 2 }]), true);
    assert.equal(seasonStore.get().bosses[0].n, 2);
});

// 後続テストが本物のローダに触らないよう既定へ戻す
seasonStore.configure({});
seasonStore.invalidate();

// ---- ドメイン: ユニオン事前比較 (js/domain/mockCompare.js — UI再設計 Stage2) ----
console.log('\ndomain/mockCompare:');
{
    const { buildMockComparison } = globalThis.mockCompareDomain;
    // フィクスチャ: 基準者 SLv500・灼熱模擬 10B。RATIO は fururi テストと同じ意味 (500=1.0, 600=1.2)
    const MC_RATIO = { '500': 1.0, '600': 1.2, '700': 1.4 };
    const MC_BASE = { slv: 500, dmgByAttr: { fire: 10 } };
    const mcPlayers = [
        { id: 1, name: 'あさひ', slv: 500 },
        { id: 2, name: 'かえで', slv: 600 },
        { id: 3, name: 'さつき', slv: null },   // SLv 未登録
        { id: 4, name: 'たまき', slv: 500 },    // 未提出
    ];
    const mcDamages = [
        { player_id: 1, attribute: 'fire', slot: 1, damage_b: 8 },
        { player_id: 1, attribute: 'fire', slot: 2, damage_b: 9 },    // 2編成目の方が高い
        { player_id: 2, attribute: 'fire', slot: 1, damage_b: 9 },
        { player_id: 3, attribute: 'fire', slot: 1, damage_b: 6 },
        { player_id: 1, attribute: 'water', slot: 1, damage_b: 99 },  // 他属性は無関係
    ];

    test('mockCompare: damage モードは2編成の高い方を採用し slot を返す', () => {
        const r = buildMockComparison({ attribute: 'fire', mode: 'damage', players: mcPlayers, damages: mcDamages, base: null, slvRatioTable: null });
        const asahi = r.rows.find(x => x.playerId === 1);
        assert.equal(asahi.value, 9, '高い方 (slot2=9B) を採用');
        assert.equal(asahi.slot, 2, '採用した slot=2 を返す');
    });

    test('mockCompare: 採用した提出の測定レベルを bossLevel で返す', () => {
        // 比較はレベルで割り引かない (最大値を採用する従来どおり) が、
        // レベル違いが同じ土俵に並ぶので、どのレベルで測った値かは行に出せるようにする
        const dmgs = [
            { player_id: 1, attribute: 'fire', slot: 1, damage_b: 8, boss_level: 3 },
            { player_id: 1, attribute: 'fire', slot: 2, damage_b: 9, boss_level: 1 },  // 採用される方
            { player_id: 2, attribute: 'fire', slot: 1, damage_b: 7 },                 // レベル未指定
            { player_id: 3, attribute: 'fire', slot: 1, damage_b: 6, boss_level: 9 },  // 範囲外→null
        ];
        const r = buildMockComparison({ attribute: 'fire', mode: 'damage', players: mcPlayers, damages: dmgs, base: null, slvRatioTable: null });
        assert.equal(r.rows.find(x => x.playerId === 1).bossLevel, 1, '採用した方 (slot2/Lv1) のレベル');
        assert.equal(r.rows.find(x => x.playerId === 2).bossLevel, null, '未指定は null');
        assert.equal(r.rows.find(x => x.playerId === 3).bossLevel, null, '範囲外は null に倒す');
    });

    test('mockCompare: 未提出者は missing に分離される', () => {
        const r = buildMockComparison({ attribute: 'fire', mode: 'damage', players: mcPlayers, damages: mcDamages, base: null, slvRatioTable: null });
        assert.deepEqual(r.missing.map(m => m.playerId), [4]);
        assert.ok(!r.rows.some(x => x.playerId === 4));
    });

    test('mockCompare: 同値は同順位 (1,2,2,4 方式)', () => {
        const r = buildMockComparison({ attribute: 'fire', mode: 'damage', players: mcPlayers, damages: mcDamages, base: null, slvRatioTable: null });
        // 値: あさひ9 / かえで9 / さつき6 → rank 1,1,3
        assert.deepEqual(r.rows.map(x => x.rank), [1, 1, 3]);
        assert.equal(r.rows[2].playerId, 3);
    });

    test('mockCompare: fururi モードはレーダーと同じ SLv 換算 (calcPerAttackFururi 再利用)', () => {
        const r = buildMockComparison({ attribute: 'fire', mode: 'fururi', players: mcPlayers, damages: mcDamages, base: MC_BASE, slvRatioTable: MC_RATIO });
        const asahi = r.rows.find(x => x.playerId === 1);   // SLv500: 9 / 10 = 0.9
        const kaede = r.rows.find(x => x.playerId === 2);   // SLv600: 9 / (10*1.2) = 0.75
        assert.ok(Math.abs(asahi.value - 0.9) < 1e-9);
        assert.ok(Math.abs(kaede.value - 0.75) < 1e-9);
        assert.equal(asahi.damageB, 9, '元ダメージも保持 (表示用)');
    });

    test('mockCompare: fururi モードで SLv 無しは noSlv に分離 (missing とは別枠)', () => {
        const r = buildMockComparison({ attribute: 'fire', mode: 'fururi', players: mcPlayers, damages: mcDamages, base: MC_BASE, slvRatioTable: MC_RATIO });
        assert.deepEqual(r.noSlv.map(m => m.playerId), [3], '提出はあるが SLv 無し');
        assert.deepEqual(r.missing.map(m => m.playerId), [4], '未提出は missing のまま');
    });

    test('mockCompare: 基準者の当該属性模擬が無い場合は baseMissing=true で行を出さない', () => {
        const r = buildMockComparison({ attribute: 'iron', mode: 'fururi', players: mcPlayers, damages: mcDamages, base: MC_BASE, slvRatioTable: MC_RATIO });
        assert.equal(r.meta.baseMissing, true);
        assert.equal(r.rows.length, 0);
    });

    test('mockCompare: 入力配列・オブジェクトを変異させない', () => {
        const snapPlayers = JSON.stringify(mcPlayers);
        const snapDamages = JSON.stringify(mcDamages);
        buildMockComparison({ attribute: 'fire', mode: 'damage', players: mcPlayers, damages: mcDamages, base: MC_BASE, slvRatioTable: MC_RATIO });
        buildMockComparison({ attribute: 'fire', mode: 'fururi', players: mcPlayers, damages: mcDamages, base: MC_BASE, slvRatioTable: MC_RATIO });
        assert.equal(JSON.stringify(mcPlayers), snapPlayers);
        assert.equal(JSON.stringify(mcDamages), snapDamages);
    });

    test('mockCompare: 空入力・不正入力は安全に空を返す', () => {
        const r = buildMockComparison({ attribute: 'fire', mode: 'damage', players: null, damages: undefined, base: null, slvRatioTable: null });
        assert.deepEqual(r.rows, []);
        assert.deepEqual(r.missing, []);
        assert.equal(r.meta.count, 0);
    });

    test('mockCompare: damage_b が 0 以下の行は未提出扱い', () => {
        const r = buildMockComparison({
            attribute: 'fire', mode: 'damage',
            players: [{ id: 9, name: 'ぜろ', slv: 500 }],
            damages: [{ player_id: 9, attribute: 'fire', slot: 1, damage_b: 0 }],
            base: null, slvRatioTable: null,
        });
        assert.deepEqual(r.missing.map(m => m.playerId), [9]);
    });
}

test('得意属性の予約は「実際に出せる編成が残っているか」まで見る (レベル跨ぎ)', () => {
    // 得意属性の編成がキャラ被りで全滅しているのに枠だけ予約し続けると、
    // 出せる属性への凸まで封じられる。**レベル開始時の初期化にも効かせないと**、
    // 次のレベルの最初の候補選定で弾かれ、そのレベルで1凸もできないまま終わる。
    // 実測で見つけた4人盤面 (canUseAttr をレベル開始時から外すと 139B に落ちる)
    const lo = (dmg, shared, attr) => [{ dmgB: dmg, team: [shared, `${attr}A`, `${attr}B`, `${attr}C`, `${attr}D`], slot: 1 }];
    const mk = (name, slv, strong, spec) => ({
        id: name, name, attackCount: 0, syncLevel: slv, attacks: [],
        availableSlots: [], flexTime: false, strong_attributes: strong, teamsByAttr: {},
        damagesByAttr: Object.fromEntries(Object.entries(spec).map(([a, [d]]) => [a, d])),
        loadoutsByAttr: Object.fromEntries(Object.entries(spec).map(([a, [d, sh]]) => [a, lo(d, sh, a)])),
    });
    const bs = [
        boss(1, 'fire', { attribute: 'wind', totalB: 36, remainingB: 31 }),
        boss(2, 'electric', { attribute: 'water', totalB: 49, remainingB: 48 }),
        boss(3, 'iron', { attribute: 'electric', tier: 'tyrant', totalB: 26, remainingB: 15 }),
        boss(4, 'wind', { attribute: 'iron', totalB: 33, remainingB: 18 }),
        boss(5, 'water', { attribute: 'fire', tier: 'tyrant', totalB: 28, remainingB: 20 }),
    ];
    const ps = [
        mk('M0', 529, ['fire'], { wind: [17.5, '共有B'], electric: [24.5, '共有D'], fire: [25, '共有B'] }),
        mk('M1', 509, ['water'], { electric: [20.5, '共有C'], water: [20, '共有B'], fire: [23, '共有C'] }),
        mk('M2', 653, ['wind'], { wind: [19.5, '共有D'], iron: [22, '共有A'], fire: [7, '共有D'], electric: [13.5, '共有A'] }),
        mk('M3', 503, ['fire', 'iron'], { wind: [13, '共有D'], iron: [16, '共有B'], fire: [7, '共有D'], electric: [23.5, '共有B'] }),
    ];
    const plan = compute({ ...makeInput(bs, ps, { currentSlot: 'h05' }), timeAware: false });
    assert.ok(plan.totalCreditedB >= 144,
        `出せない得意属性の枠でロックしてはいけない (実際 ${plan.totalCreditedB.toFixed(1)}B / ロックすると 139B)`);
});

test('レベルの割当は SLv ではなく実際の提出ダメージ順で決まる', () => {
    // 順位付けだけを切り出す: **同じボスに対する火力は両者とも同じ 10B** にして、
    // オーバーキル差で決まらないようにする。違うのは「その人の総合火力」と SLv だけ。
    // Lv1 (levelPos=0) には火力順位の低い人が寄るのが正しい。
    // SLv 基準のままだと SLv300 の人 (=高火力) が選ばれてしまう
    const bs = [boss(1, 'fire', { remainingB: 10 })];
    const ps = [
        player('高SLv低火力', { fire: 10, water: 10, electric: 10 }, { slv: 800 }),   // 総合10B
        player('低SLv高火力', { fire: 10, water: 40, electric: 40 }, { slv: 300 }),   // 総合30B
    ];
    const plan = compute({ ...makeInput(bs, ps), timeAware: false });
    const lv1 = plan.levels.find(lv => lv.level === 1);
    const first = lv1?.bosses?.[0]?.attacks?.[0];
    assert.ok(first, 'Lv1 のボスに凸が割り当てられること');
    assert.equal(first.memberName, '高SLv低火力',
        `Lv1 には総合火力の低い人が寄るはず (実際は ${first.memberName})`);
});

// ---- 戦況の変化検知 (撃破 / レベル開放) ------------------------------------------
console.log('\n戦況の変化検知:');
{
    const { deadBossNumbers, snapshotBoard, diffRaidEvents } = globalThis.raidEventsDomain;
    const B = (n, totalB, remB) => ({ boss_number: n, total_hp_raw: totalB * 1e9, remaining_hp_raw: remB * 1e9 });
    const snap = (lv, bosses, sid = 1) => snapshotBoard({ id: sid, current_level: lv }, bosses);

    test('総HP未記録 (0) のボスは撃破扱いしない', () => {
        // 古いシーズンは5体とも total=0/rem=0。これを撃破とみなすと全部誤爆する
        const dead = deadBossNumbers([B(1, 0, 0), B(2, 100, 0), B(3, 100, 50)]);
        assert.deepEqual([...dead], [2]);
    });

    test('初回観測 (前回なし) では何も通知しない', () => {
        const cur = snap(1, [B(1, 100, 0), B(2, 100, 0)]);
        const ev = diffRaidEvents(null, cur);
        assert.deepEqual(ev.defeated, []);
        assert.equal(ev.levelOpened, null);
    });

    test('前回は生きていて今回倒れているボスだけを返す', () => {
        const prev = snap(1, [B(1, 100, 30), B(2, 100, 0), B(3, 100, 20)]);
        const cur  = snap(1, [B(1, 100, 0),  B(2, 100, 0), B(3, 100, 20)]);
        const ev = diffRaidEvents(prev, cur);
        assert.deepEqual(ev.defeated, [1], 'B2 は前回から倒れているので再通知しない');
        assert.equal(ev.levelOpened, null);
    });

    test('レベルが上がったときだけ開放を返す', () => {
        const bs = [B(1, 100, 50)];
        assert.equal(diffRaidEvents(snap(1, bs), snap(2, bs)).levelOpened, 2);
        assert.equal(diffRaidEvents(snap(2, bs), snap(2, bs)).levelOpened, null);
        assert.equal(diffRaidEvents(snap(2, bs), snap(1, bs)).levelOpened, null, '下がった場合は出さない');
    });

    test('Lv2 から始まるシーズンでも開放を誤爆しない', () => {
        const bs = [B(1, 100, 50)];
        // 最初に見たときが Lv2 → prev.level=2、次も 2 なので出ない
        assert.equal(diffRaidEvents(snap(2, bs), snap(2, bs)).levelOpened, null);
    });

    test('シーズンが変わったら何も通知しない (別シーズンの盤面と比べない)', () => {
        const prev = snap(1, [B(1, 100, 50)], 1);
        const cur  = snap(1, [B(1, 100, 0)], 2);
        const ev = diffRaidEvents(prev, cur);
        assert.deepEqual(ev.defeated, []);
        assert.equal(ev.levelOpened, null);
    });

    test('レベル開放と撃破が同時でも両方返る', () => {
        const prev = snap(1, [B(1, 100, 10), B(2, 100, 10)]);
        const cur  = snap(2, [B(1, 100, 0),  B(2, 100, 0)]);
        const ev = diffRaidEvents(prev, cur);
        assert.deepEqual(ev.defeated, [1, 2]);
        assert.equal(ev.levelOpened, 2);
        assert.equal(ev.from, 1);
    });
}

// ---- ボス横断の最適化 (フェーズ2: 限定分岐) --------------------------------------
console.log('\nボス横断の最適化:');

test('貴重な人材を代替可能なボスで使い切らない (ボス横断の分岐)', () => {
    // A は fire/water 両方に出せるが残1凸。B は fire 専用、C は water で火力不足。
    // 貪欲は B1(fire) で A を使い切り、B2(water) が C だけで倒せない。
    // 正しくは B1←B(火専)、B2←A(両刀) で両方撃破できる。
    const P = (name, dmg, done) => player(name, dmg, {
        slv: 500, attackCount: done,
        attacks: done ? Array(done).fill({ boss_number: 99 }) : [],
    });
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 20 }), boss(2, 'water', { remainingB: 20 })],
        [P('A両刀', { fire: 20, water: 20 }, 2), P('B火専', { fire: 20 }, 0), P('C水弱', { water: 10 }, 0)],
    ));
    const [b1, b2] = plan.levels[0].bosses;
    assert.equal(b1.cleared, true, 'B1 は撃破できるはず');
    assert.equal(b2.cleared, true, 'B2 も撃破できるはず (A を温存した結果)');
    assert.equal(b1.attacks[0].memberName, 'B火専', 'B1 は代替可能な B を使うはず');
    assert.equal(b2.attacks[0].memberName, 'A両刀', 'A は B2 でしか使えないので回されるはず');
});

test('crossBoss:false で従来の貪欲解に戻せる (feature flag)', () => {
    const P = (name, dmg, done) => player(name, dmg, {
        slv: 500, attackCount: done,
        attacks: done ? Array(done).fill({ boss_number: 99 }) : [],
    });
    const input = makeInput(
        [boss(1, 'fire', { remainingB: 20 }), boss(2, 'water', { remainingB: 20 })],
        [P('A両刀', { fire: 20, water: 20 }, 2), P('B火専', { fire: 20 }, 0), P('C水弱', { water: 10 }, 0)],
    );
    const plan = compute({ ...input, crossBoss: false });
    assert.equal(plan.levels[0].bosses[0].attacks[0].memberName, 'A両刀', '分岐OFFなら従来どおり A を先に使う');
    assert.equal(plan.levels[0].bosses[1].cleared, false, '結果として B2 は倒せない (従来の挙動)');
});

test('分岐は基準解より総与ダメを減らさない (非悪化の不変条件)', () => {
    // 分岐探索は「基準解より credited が下がる案」「確約できない凸が増える案」を採用しない
    const mk = (name, dmg, slv) => player(name, dmg, { slv });
    const input = makeInput(
        [boss(1, 'fire', { remainingB: 30 }), boss(2, 'water', { remainingB: 30 }), boss(3, 'iron', { remainingB: 40, tier: 'tyrant' })],
        [mk('P1', { fire: 20, water: 15 }, 500), mk('P2', { fire: 18, iron: 22 }, 600),
         mk('P3', { water: 25, iron: 20 }, 450), mk('P4', { fire: 12, water: 12, iron: 12 }, 700)],
    );
    const on = compute(input);
    const off = compute({ ...input, crossBoss: false });
    assert.ok(on.totalCreditedB >= off.totalCreditedB - 1e-9,
        `横断ONが基準解を下回ってはいけない (ON ${on.totalCreditedB.toFixed(2)} / OFF ${off.totalCreditedB.toFixed(2)})`);
});

test('全レベル一括の分岐でしか届かない改善を拾う (レベル別1点分岐では不足)', () => {
    // 実測で見つけた4人盤面。貴重な人材の取り合いは Lv1〜Lv3 に連鎖するため、
    // 「このレベルのこの決定点だけ」を振り替える1点分岐では届かない。
    // 全レベル一括キー (wildKey) を候補から外すと 160.5B に落ちる盤面
    // (2026-08-08 に順位付けを実ダメージ基準へ変えた際、旧盤面が検出力を失ったため取り直した)
    const bs = [
        boss(1, 'wind', { attribute: 'iron', totalB: 38, remainingB: 22 }),
        boss(2, 'water', { attribute: 'fire', totalB: 41, remainingB: 39 }),
        boss(3, 'iron', { attribute: 'electric', tier: 'tyrant', totalB: 53, remainingB: 50 }),
        boss(4, 'electric', { attribute: 'water', totalB: 52, remainingB: 31 }),
        boss(5, 'fire', { attribute: 'wind', tier: 'tyrant', totalB: 55, remainingB: 50 }),
    ];
    const ps = [
        player('M0', { iron: 17.5, fire: 19 }, { slv: 632 }),
        player('M1', { electric: 23.5, water: 21 }, { slv: 405 }),
        player('M2', { water: 17, iron: 12.5, wind: 20, electric: 21 }, { slv: 333 }),
        player('M3', { electric: 24.5, water: 22.5, iron: 20, fire: 21.5 }, { slv: 537 }),
    ];
    const input = makeInput(bs, ps, { currentSlot: 'h05' });
    const on = compute({ ...input, timeAware: false });
    const off = compute({ ...input, timeAware: false, crossBoss: false });
    // 一括分岐を外すと ON は OFF と同じ 160.5B に落ちる
    assert.ok(on.totalCreditedB >= off.totalCreditedB + 15,
        `横断分岐で 15B 以上伸びるはず (ON ${on.totalCreditedB.toFixed(1)} / OFF ${off.totalCreditedB.toFixed(1)})`);
});

test('改善した分岐に重ねて分岐する (深さ1では届かない)', () => {
    // 実測で見つけた4人盤面。MAX_DEPTH を 1 に戻すと 179.5B に落ちる
    const bs = [
        boss(1, 'iron', { attribute: 'fire', totalB: 24, remainingB: 10 }),
        boss(2, 'wind', { attribute: 'water', totalB: 45, remainingB: 22 }),
        boss(3, 'fire', { attribute: 'electric', totalB: 40, remainingB: 30 }),
        boss(4, 'water', { attribute: 'iron', totalB: 29, remainingB: 28 }),
        boss(5, 'electric', { attribute: 'wind', tier: 'tyrant', totalB: 21, remainingB: 20 }),
    ];
    const ps = [
        player('M0', { wind: 9.5, iron: 18.5, electric: 21, water: 16.5 }),
        player('M1', { fire: 22.5, wind: 19, water: 8.5, iron: 19.5 }),
        player('M2', { electric: 19, water: 14, fire: 13.5 }),
        player('M3', { fire: 17, water: 14.5, electric: 19, iron: 7.5 }),
    ];
    const plan = compute({ ...makeInput(bs, ps, { currentSlot: 'h05' }), timeAware: false });
    assert.ok(plan.totalCreditedB >= 184,
        `深さを重ねた解に届くはず (実際 ${plan.totalCreditedB.toFixed(1)}B / 深さ1なら 179.5B)`);
});

test('決定点キーはレベルごとに独立している (衝突すると探索が鈍る)', () => {
    // decisionKey からレベルを外すと「このレベルだけ」の候補が全レベル一括と縮退し、
    // 候補の多様性が落ちて 266.5B になる盤面
    const bs = [
        boss(1, 'iron', { attribute: 'fire', totalB: 32, remainingB: 23 }),
        boss(2, 'wind', { attribute: 'water', totalB: 26, remainingB: 13 }),
        boss(3, 'fire', { attribute: 'electric', totalB: 35, remainingB: 34 }),
        boss(4, 'water', { attribute: 'iron', totalB: 39, remainingB: 35 }),
        boss(5, 'electric', { attribute: 'wind', tier: 'tyrant', totalB: 30, remainingB: 22 }),
    ];
    const ps = [
        player('M0', { wind: 21.5, iron: 6, electric: 21 }),
        player('M1', { water: 23.5, electric: 9.5, iron: 18.5 }),
        player('M2', { electric: 10.5, water: 16.5, fire: 21 }),
        player('M3', { fire: 7.5, wind: 11, iron: 23.5 }),
        player('M4', { wind: 18.5, iron: 25, electric: 15.5 }),
        player('M5', { electric: 10, wind: 21, fire: 12.5 }),
    ];
    const plan = compute({ ...makeInput(bs, ps, { currentSlot: 'h05' }), timeAware: false });
    assert.ok(plan.totalCreditedB >= 269,
        `レベル別キーがあれば 269.5B に届く (実際 ${plan.totalCreditedB.toFixed(1)}B / 衝突時 266.5B)`);
});

test('探索の上限は人数から決まる (実時間で打ち切らない)', () => {
    // 実時間 (Date.now) で打ち切ると、端末性能・GC・負荷で同じ盤面から違うプランが出る。
    // 配信 (📤) は「運営が押すたびに同じ指示が出る」ことが前提なので、上限は人数から決める。
    // 大人数盤面を2回解いて完全一致することで、時間依存が入っていないことを担保する
    const ps = [];
    for (let i = 0; i < 28; i++) {
        ps.push(player(`L${i}`, {
            fire: 10 + (i % 7) * 1.5, water: 9 + (i % 5) * 1.7,
            electric: 8 + (i % 4) * 2.1, iron: 11 + (i % 6) * 1.3, wind: 12 + (i % 3) * 1.9,
        }, { slv: 400 + i * 5 }));
    }
    const input = makeInput(
        [boss(1, 'fire', { remainingB: 60 }), boss(2, 'water', { remainingB: 55 }),
         boss(3, 'electric', { remainingB: 58 }), boss(4, 'iron', { remainingB: 52 }),
         boss(5, 'wind', { remainingB: 70, tier: 'tyrant' })],
        ps,
    );
    const a = JSON.stringify(compute(structuredClone(input)));
    const b = JSON.stringify(compute(structuredClone(input)));
    assert.equal(a, b, '大人数盤面でも結果が揺れてはいけない');
    // 時計を「呼ぶたびに1時間進む」ものに差し替えて同じ結果になるか確かめる。
    // ソース文字列の検査と違い、Date['now']() や performance.now() 経由の
    // 時間依存も、実際に打ち切りが発火する形で検出できる
    const realNow = Date.now, realDate = globalThis.Date, realPerf = globalThis.performance;
    let tick = 0;
    try {
        const jump = () => (tick += 3600000);
        Date.now = jump;
        globalThis.performance = { ...(realPerf || {}), now: jump };
        const c = JSON.stringify(compute(structuredClone(input)));
        const d = JSON.stringify(compute(structuredClone(input)));
        assert.equal(c, a, '時計が飛んでも結果が変わってはいけない');
        assert.equal(d, a, '時計が飛んでも結果が変わってはいけない');
    } finally {
        Date.now = realNow; globalThis.Date = realDate; globalThis.performance = realPerf;
    }
});

test('同じ入力からは常に同じプランが出る (探索の決定性)', () => {
    // 分岐探索は探索順・タイブレークを固定してある。実行ごとに配信内容が変わってはいけない
    const mk = (name, dmg, slv) => player(name, dmg, { slv });
    const input = makeInput(
        [boss(1, 'fire', { remainingB: 25 }), boss(2, 'water', { remainingB: 25 }),
         boss(3, 'iron', { remainingB: 30 }), boss(4, 'wind', { remainingB: 20 }),
         boss(5, 'electric', { remainingB: 28, tier: 'tyrant' })],
        [mk('S1', { fire: 18, water: 16, iron: 14 }, 500), mk('S2', { water: 20, wind: 17 }, 520),
         mk('S3', { iron: 19, electric: 15, fire: 13 }, 540), mk('S4', { wind: 21, electric: 18 }, 560),
         mk('S5', { fire: 16, water: 15, electric: 14, iron: 13, wind: 12 }, 580)],
    );
    const a = JSON.stringify(compute(structuredClone(input)));
    const b = JSON.stringify(compute(structuredClone(input)));
    assert.equal(a, b, '同じ入力で結果が揺れてはいけない');
});

test('分岐探索の内部情報が出力に漏れない (JSONB配信の前提)', () => {
    // trace / decisionPolicy / 内部メタが Plan に混ざると 📤配信の JSONB に載る
    const mk = (name, dmg, slv) => player(name, dmg, { slv });
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 20 }), boss(2, 'water', { remainingB: 20 })],
        [mk('R1', { fire: 20, water: 18 }, 500), mk('R2', { fire: 15, water: 15 }, 520),
         mk('R3', { water: 12 }, 480)],
    ));
    const json = JSON.stringify(plan);
    for (const k of ['trace', 'wildKey', 'decisionPolicy', '_lo', '_consumedMandatory', 'chosenTrace']) {
        assert.ok(!json.includes(`"${k}"`), `${k} が出力に含まれてはいけない`);
    }
    assert.ok(!json.includes('null,null'), '未定義値が配列に混ざっていないこと');
});

// ---- オーバーキルの後処理 (フェーズ2a: 抜いても倒せる凸を外す) ------------------
console.log('\nオーバーキル後処理:');

test('撃破を保ったまま不要な凸を外し、損失と凸消費を減らす (実機報告のケース)', () => {
    // 実際に報告された盤面: 目標61.2B に 5人が投入され 69.6B (損失8.4B)。
    // ほりっぴー(5.5B) を抜いても 64.1B で倒せるので、外して1凸を浮かせるのが正しい。
    // 貪欲法は残HPが多い序盤で overkill=0 のため、この無駄を事前に避けられない。
    const mk = (name, dmg, slv) => player(name, { water: dmg }, { slv });
    const plan = compute(makeInput(
        [boss(3, 'water', { remainingB: 61.2, totalB: 61.2, tier: 'tyrant' })],
        [mk('むう', 12.2, 506), mk('ほりっぴー', 5.5, 411), mk('金糸雀', 22.5, 608),
         mk('ふるり', 14.3, 558), mk('MIRIN', 15.1, 651)],
    ));
    const b = plan.levels[0].bosses[0];
    const total = b.attacks.reduce((s, a) => s + a.dmgB, 0);
    assert.equal(b.cleared, true, '撃破は維持されるはず');
    assert.equal(b.attacks.length, 4, '5凸→4凸に減るはず (1凸が浮く)');
    assert.ok(total < 69.5, `総投入が減るはず (実際 ${total.toFixed(1)}B)`);
    assert.ok(!b.attacks.some(a => a.memberName === 'ほりっぴー'), '抜いても倒せる最小の凸が外れるはず');
});

test('trim 後に usedB/overflowB と集計が再計算される', () => {
    // 凸を外すと「外す前の残HP」で計算された usedB/overflowB が残り、
    // totalWaste・画面の超過表示・温存パスの採否判定まで誤る (Codex指摘)
    const mk = (name, dmg, slv) => player(name, { water: dmg }, { slv });
    const plan = compute(makeInput(
        [boss(3, 'water', { remainingB: 61.2, totalB: 61.2, tier: 'tyrant' })],
        [mk('むう', 12.2, 506), mk('ほりっぴー', 5.5, 411), mk('金糸雀', 22.5, 608),
         mk('ふるり', 14.3, 558), mk('MIRIN', 15.1, 651)],
    ));
    const b = plan.levels[0].bosses[0];
    const last = b.attacks[b.attacks.length - 1];
    assert.ok(Math.abs(last.overflowB - 2.9) < 0.05, `最後の凸の超過は2.9のはず (実際 ${last.overflowB.toFixed(1)})`);
    assert.ok(Math.abs(plan.totalWaste - 2.9) < 0.05, `totalWaste は2.9のはず (実際 ${plan.totalWaste.toFixed(1)})`);
    // usedB の合計 = 目標HP (削り切っている)
    const used = b.attacks.reduce((s, a) => s + a.usedB, 0);
    assert.ok(Math.abs(used - 61.2) < 0.05, `usedB合計は目標61.2のはず (実際 ${used.toFixed(1)})`);
});

test('trim で外した必須属性(得意)の凸は予約が戻る', () => {
    // 得意属性の凸を trim で外したのに mandatory を消化済みのままにすると、
    // 後続の同弱点ボスで必須予約が失われ、非必須属性へ凸を使えてしまう (Codex指摘)
    const a = player('A', { fire: 30, water: 30 }, { slv: 500, strong: ['fire'] });
    const b1 = player('B', { fire: 25 }, { slv: 500 });
    const c1 = player('C', { fire: 25 }, { slv: 500 });
    const plan = compute(makeInput(
        // fire弱点ボスが2体。1体目は B+C だけで倒せるので A の凸は trim される
        [boss(1, 'fire', { remainingB: 45 }), boss(2, 'fire', { remainingB: 20 })],
        [a, b1, c1],
    ));
    const bosses = plan.levels[0].bosses;
    // A が fire に出ている (必須予約が戻り、2体目の fire で使われる) こと
    const aAttacks = bosses.flatMap(b => b.attacks).filter(x => x.memberName === 'A');
    assert.ok(aAttacks.length >= 1, 'A は必須の fire で使われるはず (予約が戻る)');
});

test('抜くと倒せなくなる凸は外さない', () => {
    // 3人でギリギリ (10+10+10=30 ≥ 目標28)。どれを抜いても20 < 28 なので全員残す
    const mk = (name, dmg) => player(name, { fire: dmg }, { slv: 500 });
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 28 })],
        [mk('A', 10), mk('B', 10), mk('C', 10)],
    ));
    const b = plan.levels[0].bosses[0];
    assert.equal(b.cleared, true);
    assert.equal(b.attacks.length, 3, '1つでも抜くと倒せないので全員残るはず');
});

test('外した凸のキャラは他ボスで再利用できる (状態が正しく巻き戻る)', () => {
    // A は fire/water 両方に同じキャラ入り編成。fire で一旦使われても、
    // trim で外れたら water で使えるようになる (usedChars/avail/残凸が戻ること)
    const a = player('A', { fire: 30, water: 30 }, {
        slv: 500,
        teamsByAttr: { fire: ['共有1', '火1'], water: ['共有1', '水1'] },
    });
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 20 }), boss(2, 'water', { remainingB: 25 })],
        [a, player('B', { fire: 25 }, { slv: 500 })],
    ));
    const [b1, b2] = plan.levels[0].bosses;
    assert.equal(b1.cleared, true, 'fire は B の25Bで倒せる');
    assert.equal(b2.attacks.length, 1, 'A は water に回れるはず');
    assert.equal(b2.attacks[0].memberName, 'A');
});

// ---- 完了凸のキャラ消費 (同キャラ1日1回 / PLAN-optimal-plan-v3 フェーズ1) --------
console.log('\n完了凸のキャラ消費:');

test('ラピ問題: 鉄甲でラピ使用済みなら灼熱のラピ入り編成は提案しない', () => {
    // 実際に起きた事象: 灼熱にも鉄甲にもラピ入りを提出 → 鉄甲凸(ラピ使用)後にプランを押すと
    // ラピ入り灼熱PTが提案され、ラピは使用済みで凸できなかった。
    const p = player('ふるり', { fire: 20 }, {
        attackCount: 1,
        // B2 = iron弱点ボスへ凸済み。その凸でラピを使った
        attacks: [{ boss_number: 2, characters: ['ラピ', 'ドロシー', 'モダニア', 'ノワール', 'ブラン'] }],
    });
    p.loadoutsByAttr = { fire: [{ dmgB: 20, team: ['ラピ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }] };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'iron', { remainingB: 10 })],
        [p],
    ));
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 0, 'ラピ使用済みなのでラピ入り灼熱は提案されないはず');
});

test('ラピなし代替編成があればそちらが採用される', () => {
    const p = player('ふるり', { fire: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 2, characters: ['ラピ', 'ドロシー', 'モダニア', 'ノワール', 'ブラン'] }],
    });
    // 編成①=ラピ入り(高火力) / 編成②=ラピなし(低火力) → ②が選ばれる
    p.loadoutsByAttr = { fire: [
        { dmgB: 20, team: ['ラピ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 },
        { dmgB: 12, team: ['マキマ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 2 },
    ] };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'iron', { remainingB: 10 })],
        [p],
    ));
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 1, 'ラピなし編成で凸できるはず');
    assert.equal(fireBoss.attacks[0].dmgB, 12, 'ラピなしの編成②が採用されるはず');
});

test('実使用が低火力の編成②でも、合法な編成①を失わない (旧sliceの近似バグ回帰)', () => {
    // 旧実装は「完了凸 = その属性の最高火力編成」と決め打ちしていたため、
    // 実際に②で凸した場合に①(合法)まで消してしまっていた。
    const p = player('A', { fire: 30 }, {
        attackCount: 1,
        // fire弱点ボス(B1)へ、編成②のキャラで凸済み
        attacks: [{ boss_number: 1, characters: ['ベス', 'アニス', 'ネオン', 'ユニ', 'ソーダ'] }],
    });
    p.loadoutsByAttr = { fire: [
        { dmgB: 30, team: ['ヘルム', 'マリアン', 'ノア', 'ミカ', 'リター'], slot: 1 },   // 未使用・高火力
        { dmgB: 10, team: ['ベス', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 2 },     // 実際に使った
    ] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100 })], [p]));
    const atks = plan.levels[0].bosses[0].attacks;
    assert.equal(atks.length, 1, '残り編成①で1凸できるはず');
    assert.equal(atks[0].dmgB, 30, '実使用は②なので、未使用の①(高火力)が残るはず');
});

test('得意属性が完了凸のキャラ被りで全滅しても、他属性をロックしない', () => {
    // seed で avail から消えた属性を mandatory に入れると、出せない属性を予約して
    // 他属性まで止めてしまう (Codex指摘の実装順序の罠)。
    const p = player('A', { fire: 20, water: 15 }, {
        attackCount: 1,
        strong: ['fire'],                       // 得意 = fire (必ず消化したい)
        attacks: [{ boss_number: 3, characters: ['ラピ', 'ドロシー', 'モダニア', 'ノワール', 'ブラン'] }],
    });
    p.loadoutsByAttr = {
        fire:  [{ dmgB: 20, team: ['ラピ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }],   // ラピ被りで出せない
        water: [{ dmgB: 15, team: ['マキマ', 'ベス', 'ノア', 'ミカ', 'リター'], slot: 1 }],
    };
    const plan = compute(makeInput(
        [boss(1, 'water', { remainingB: 10 }), boss(3, 'electric', { remainingB: 10 })],
        [p],
    ));
    const waterBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(waterBoss.attacks.length, 1, 'fire が出せない以上 water に出せるはず (予約で固まらない)');
});

test('完了凸の編成が未記録なら best-effort (候補に残し、要確認として名指し)', () => {
    // 代理凸・一括登録は characters: [] を保存する。被り判定はできないが、
    // 除外せず候補に残し membersUnknownCompletedTeam で運営に確認を促す。
    const p = player('B', { fire: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 2, characters: [] }],   // 編成未記録
    });
    p.loadoutsByAttr = { fire: [{ dmgB: 20, team: ['ラピ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }] };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'iron', { remainingB: 10 })],
        [p],
    ));
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 1, '未記録なので候補に残る (best-effort)');
    assert.ok(plan.membersUnknownCompletedTeam.includes('B'), '要確認として名指しされるはず');
});

test('完了凸のキャラは Lv4 (無限ボス) の割当でも復活しない', () => {
    // Lv4 は別経路 (:537) で割り当てる。seed が全経路に効くことの確認。
    const p = player('C', { fire: 50 }, {
        attackCount: 1,
        attacks: [{ boss_number: 2, characters: ['ラピ', 'ドロシー', 'モダニア', 'ノワール', 'ブラン'] }],
    });
    p.loadoutsByAttr = { fire: [{ dmgB: 50, team: ['ラピ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }] };
    const plan = compute(makeInput(
        [boss(5, 'fire', { remainingB: 1 })],   // ボス5 = Lv4 無限ボスの対象
        [p],
    ));
    const all = plan.levels.flatMap(lv => lv.bosses.flatMap(b => b.attacks));
    assert.ok(all.every(a => !(a.team || []).includes('ラピ')), 'Lv4 でもラピは使えないはず');
});

test('表記揺れ (全角コロン・前後空白・大小文字) でもキャラ被りを検出する', () => {
    // 実データに「アニス:スター」(半角) と「ドロシー：セレンディピティ」(全角) が混在するため、
    // 生値比較だと seed 除外をすり抜けて使用済みキャラ入りを再提案してしまう。
    const p = player('A', { fire: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 2, characters: ['ドロシー：セレンディピティ', 'ラピ', 'モダニア', 'ノワール', 'ブラン'] }],
    });
    p.loadoutsByAttr = { fire: [
        // 同一キャラだが半角コロン + 前後空白 → 正規化しないと別人扱いになる
        { dmgB: 20, team: [' ドロシー:セレンディピティ ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 },
    ] };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'iron', { remainingB: 10 })],
        [p],
    ));
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 0, '表記揺れを吸収して被りと判定するはず');
});

test('部分的な編成記録 (5人未満) は要確認として名指しする', () => {
    // ['ラピ'] だけ / 画像パス除去後に4人になった等。残りのキャラが不明なので
    // 被り判定は不完全 = best-effort の警告対象 (判明分は seed に使う)
    const p = player('D', { fire: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 2, characters: ['ラピ'] }],   // 5人に満たない部分記録
    });
    p.loadoutsByAttr = { fire: [{ dmgB: 20, team: ['マキマ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }] };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'iron', { remainingB: 10 })],
        [p],
    ));
    assert.ok(plan.membersUnknownCompletedTeam.includes('D'), '部分記録は要確認になるはず');
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 1, '判明分と被らない編成は出せる (best-effort)');
});

test('部分記録でも判明しているキャラの被りは除外する', () => {
    const p = player('E', { fire: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 2, characters: ['ラピ'] }],
    });
    p.loadoutsByAttr = { fire: [{ dmgB: 20, team: ['ラピ', 'アニス', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }] };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(2, 'iron', { remainingB: 10 })],
        [p],
    ));
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 0, '判明しているラピの被りは除外されるはず');
});

test('空白だけのキャラ名で偽のキャラ被りを作らない', () => {
    // 生値の truthy 判定 (c &&) だと ' ' は truthy → charKey で '' になり、
    // '' を usedChars に入れると後続の空白項目と「偽の被り」になってしまう。
    const p = player('F', { fire: 20, water: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 3, characters: ['ラピ', ' ', 'モダニア', 'ノワール', 'ブラン'] }],
    });
    p.loadoutsByAttr = {
        // 完了凸と被るキャラは無い。空白項目だけが共通 → 被り扱いされてはいけない
        fire: [{ dmgB: 20, team: ['マキマ', ' ', 'ネオン', 'ユニ', 'ソーダ'], slot: 1 }],
    };
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 }), boss(3, 'electric', { remainingB: 10 })],
        [p],
    ));
    const fireBoss = plan.levels[0].bosses.find(b => b.bossNumber === 1);
    assert.equal(fireBoss.attacks.length, 1, '空白は被り判定に使わない (実キャラは重複なし)');
});

test('テストシーズン相当のデータ (B1/B2共有・B3属性別) で被り回避が働く', () => {
    // 🧪 テストシーズンのシードが生成する編成の形を再現する:
    //   サポート2枠は属性グループごとに共有 / アタッカー3枠は属性別。
    // fire で凸済み → 同じサポートを使う iron は出せず、別サポートの water は出せる、が正。
    const SUP_A = ['サポA1', 'サポA2'];   // fire / iron が共有
    const SUP_B = ['サポB1', 'サポB2'];   // water が使う別サポート
    const p = player('T', { fire: 20, water: 20, iron: 20 }, {
        attackCount: 1,
        attacks: [{ boss_number: 1, characters: [...SUP_A, '火職1', '火職2', '火職3'] }],
    });
    p.loadoutsByAttr = {
        fire: [{ dmgB: 20, team: [...SUP_A, '火職1', '火職2', '火職3'], slot: 1 }],
        iron: [{ dmgB: 20, team: [...SUP_A, '鉄職1', '鉄職2', '鉄職3'], slot: 1 }],   // サポートが被る
        water:[{ dmgB: 20, team: [...SUP_B, '水職1', '水職2', '水職3'], slot: 1 }],   // サポートが別
    };
    const plan = compute(makeInput(
        [
            boss(1, 'fire', { remainingB: 10 }),
            boss(2, 'iron', { remainingB: 10 }),
            boss(3, 'water', { remainingB: 10 }),
        ],
        [p],
    ));
    const byNum = Object.fromEntries(plan.levels[0].bosses.map(b => [b.bossNumber, b]));
    assert.equal(byNum[2].attacks.length, 0, 'サポートが被る iron は提案されないはず');
    assert.equal(byNum[3].attacks.length, 1, 'サポートが別の water は提案されるはず');
    // 提案された編成に使用済みキャラが混ざっていないこと
    const used = new Set([...SUP_A, '火職1', '火職2', '火職3']);
    const all = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.ok(all.every(a => !(a.team || []).some(c => used.has(c))), '使用済みキャラを含む提案は無いはず');
});

test('完了凸が無い入力は従来どおり (回帰保証)', () => {
    // characters を持たない従来入力で、seed 導入前と同じ結果になること。
    const plan = compute(makeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('A', { fire: 12 })],
    ));
    assert.equal(plan.levels[0].bosses[0].attacks.length, 1);
    assert.equal(plan.levels[0].bosses[0].attacks[0].memberName, 'A');
    assert.deepEqual(plan.membersUnknownCompletedTeam, [], '凸が無ければ要確認も空');
});

// ---- ドメイン: GB比較 (js/domain/gbCompare.js) --------------------------------
console.log('\ndomain/gbCompare:');

// GBエクスポートの最小フィクスチャ (単位: ふるり値。値は検算しやすい丸数字)
function gbExportFixture() {
    const comp = (names, n, med) => ({
        compKey: [...names].sort().join('|'),
        members: names.map(nm => ({ gbId: nm + '.webp', name: nm })),
        n, medianFururi: med, arrangements: [],
    });
    return {
        schemaVersion: 1, season: '2026-08',
        base: {
            baseSlv: 558,
            attributes: {
                WATER: { bossCode: 'H.S.T.A.', baseDamage: 10e9 },
                FIRE: { bossCode: 'A.N.M.I.', baseDamage: 20e9 },
            },
        },
        attributes: {
            WATER: {
                attackBenchmark: { n: 100, medianFururi: 1.0 },
                compCohortN: 60,
                comps: [
                    comp(['A', 'B', 'C', 'D', 'E'], 30, 1.2),
                    comp(['A', 'B', 'C', 'D', 'F'], 12, 1.5),
                    comp(['G', 'H', 'I', 'J', 'K'], 8, 0.9),
                ],
            },
            FIRE: {
                attackBenchmark: { n: 80, medianFururi: 1.0 },
                compCohortN: 40,
                comps: [
                    comp(['L', 'M', 'N', 'O', 'P'], 20, 1.0),
                    comp(['A', 'M', 'N', 'O', 'P'], 15, 1.4),   // WATER人気編成と A が被る
                ],
            },
        },
    };
}
const GB_CODES = { WATER: 'H.S.T.A.', FIRE: 'A.N.M.I.' };

test('gbCompare: norm換算とメンバー%の往復', () => {
    const g = gbCompareDomain;
    // fururi 1.2 × base 10B ÷ ratio(558)=4000 → norm 3e6
    const norm = g.normFromFururi(1.2, 10e9, 4000);
    assert.equal(norm, 3e6);
    // メンバー: damage 6e9, ratio(自SLv)=1000 → 自norm 6e6 → 200%
    assert.equal(g.memberPct(6e9, 1000, norm), 200);
    assert.equal(g.normFromFururi(null, 10e9, 4000), null);
    assert.equal(g.memberPct(6e9, 0, norm), null, '係数0はnull (0除算防止)');
});

test('gbCompare: buildIndex はボスコード不一致・名前未解決をフェイルクローズ', () => {
    const g = gbCompareDomain;
    const ex = gbExportFixture();
    ex.attributes.WATER.comps[0].members[0].name = null;   // 名前未解決
    const idx = g.buildIndex(ex, { WATER: 'H.S.T.A.', FIRE: '別コード' });
    assert.ok(idx.attrs.WATER, 'コード一致の属性は残る');
    assert.equal(idx.attrs.FIRE, undefined, 'コード不一致の属性は除外');
    assert.equal(idx.attrs.WATER.comps.length, 2, '名前未解決の編成は除外');
    assert.ok(idx.dropped.some(d => d.includes('FIRE')), '除外理由が記録される');
});

test('gbCompare: 絞り込み (人気=採用順 / 強い=中央値順 / 両方=n>=10かつ属性中央値以上)', () => {
    const g = gbCompareDomain;
    const idx = g.buildIndex(gbExportFixture(), GB_CODES);
    const comps = idx.attrs.WATER.comps;
    assert.equal(g.filterComps(comps, 'popular')[0].n, 30);
    assert.equal(g.filterComps(comps, 'strong')[0].medianFururi, 1.5);
    const both = g.filterComps(comps, 'both', 1.0);
    assert.deepEqual(both.map(c => c.n), [12, 30], 'n>=10 かつ 中央値>=1.0 を中央値順');
});

test('gbCompare: 3凸最適化 — 15キャラ被りなし・同属性2凸・決定的順序', () => {
    const g = gbCompareDomain;
    const idx = g.buildIndex(gbExportFixture(), GB_CODES);
    // WATER + FIRE + FIRE: FIRE の2編成 (L..P / A,M,N,O,P) は M,N,O,P が被るため
    // 同属性2凸が成立せず解なし → error が立ち results は空 (黙って劣化しない)
    const r = g.optimizeTriple(idx, ['WATER', 'FIRE', 'FIRE']);
    assert.equal(r.results.length, 0);
    assert.ok(typeof r.error === 'string' && r.error.includes('組み合わせ'), '解なしの理由を返す');
    // WATER×2 + FIRE なら組める: (A..E)+(G..K) + FIRE(L..P) が最大
    const r2 = g.optimizeTriple(idx, ['WATER', 'WATER', 'FIRE']);
    assert.equal(r2.error, null);
    const b2 = r2.results[0];
    assert.equal(b2.comps.length, 3);
    const all = b2.comps.flatMap(c => c.names);
    assert.equal(new Set(all).size, 15, '15キャラ被りなし');
    // 目的関数: Σ fururi×baseDamage。最適は (A,B,C,D,F:1.5×10B)+(G..K:0.9×10B)+(L..P:1.0×20B)=44B
    // (人気トップの A..E:1.2 ではなく、被り制約下で中央値の高い ABCDF が選ばれる)
    assert.equal(b2.total, 44e9);
    assert.ok(b2.comps.some(c => c.names.includes('F')), '高中央値編成 (ABCDF) が採用される');
    // 凸1優先: 同属性2凸 (WATER×2) は凸1に出力の高い編成 (ABCDF 15B > GHIJK 9B) が入る
    assert.ok(b2.comps[0].names.includes('F'), '凸1に高出力側 (ABCDF)');
    assert.ok(b2.comps[0].estDamage >= b2.comps[1].estDamage, '同属性は凸1 >= 凸2');
    // 同属性で同じ編成の2度使いは禁止されている
    const keys = b2.comps.map(c => c.attr + ':' + c.key);
    assert.equal(new Set(keys).size, 3);
});

test('gbCompare: 属性の順序違いの同一組は重複除去される', () => {
    const g = gbCompareDomain;
    const idx = g.buildIndex(gbExportFixture(), GB_CODES);
    // topK を全件にして具体的な件数で検証する (dedup を外すと WATER 2枠の入れ替えで
    // 同一組が2回ずつ現れ件数が倍になる — 上位だけ見る検査では空振りするため)。
    // WATER の被りなしペアは {A..E, G..K} と {ABCDF, G..K} の2通り × FIRE(L..P) = 2組
    const a = g.optimizeTriple(idx, ['WATER', 'WATER', 'FIRE'], { topK: 99 });
    assert.equal(a.results.length, 2, '順序入れ替えの重複が除去されて2組');
    const keys = a.results.map(r => r.comps.map(c => c.attr + ':' + c.key).sort().join('/'));
    assert.equal(new Set(keys).size, 2, '同一の組が2度現れない');
    const b = g.optimizeTriple(idx, ['FIRE', 'WATER', 'WATER'], { topK: 99 });
    assert.equal(b.results.length, 2);
    assert.equal(a.results[0].total, b.results[0].total, 'picks の順序が違っても同じ最適解');
});

// ---- レベル別測定値 (levels マップ — 31_player_damages_levels) ---------------
console.log('\nloadout levels:');

test('levels{1:30,4:12}: Lv1のボスには30が、Lv2のボスには12が使われる', () => {
    const mk = () => {
        const p = player('A', { fire: 30 });
        p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 1, levels: { '1': 30, '4': 12 } }] };
        return p;
    };
    const p1 = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [mk()], { currentLevel: 1 }));
    const a1 = p1.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(a1.length, 1);
    assert.equal(a1[0].dmgB, 30, `Lv1 では Lv1測定の30を使う: ${a1[0].dmgB}`);
    assert.equal(a1[0].loadoutLevel, 1);
    const p2 = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [mk()], { currentLevel: 2 }));
    const a2 = p2.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(a2.length, 1, 'Lv4測定があるので Lv2 にも出せる');
    assert.equal(a2[0].dmgB, 12, `Lv2 では Lv4測定の12に落ちる (Lv1の30は過大評価): ${a2[0].dmgB}`);
    assert.equal(a2[0].loadoutLevel, 4, '採用した測定のレベルが出る');
});

test('levels のキー"0" (未指定) は全レベルで使え、レベル付き測定より高ければ勝つ', () => {
    const p = player('A', { fire: 30 });
    p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: null, levels: { '0': 20, '1': 30 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 3 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1);
    assert.equal(used[0].dmgB, 20, `Lv3 では "0" の20だけが使える (Lv1の30は不可): ${used[0].dmgB}`);
    assert.equal(used[0].loadoutLevel, null);
});

test('Lv4割当は「Lv4で解決した値」の argmax (静的な最大値順の先頭採用に戻すと落ちる)', () => {
    const bs = [
        boss(1, 'fire', { tier: 'lord', remainingB: 0 }),
        boss(2, 'water', { tier: 'lord', remainingB: 0 }),
        boss(3, 'electric', { tier: 'tyrant', remainingB: 0 }),
        boss(4, 'iron', { tier: 'lord', remainingB: 0 }),
        boss(5, 'wind', { tier: 'tyrant', remainingB: 0 }),
    ];
    const p = player('A', { wind: 25 }, { attackCount: 2 });   // 残1凸 → 良い方1つだけ選ばれる
    p.loadoutsByAttr = { wind: [
        // 静的最大値 25 (ソート先頭) だが Lv4 では 12 しか出ない編成
        { dmgB: 25, team: ['a','b','c','d','e'], slot: 1, level: 1, levels: { '1': 25, '4': 12 } },
        // 未指定 20 = Lv4 でも 20 出る編成 — こちらを選ぶべき
        { dmgB: 20, team: ['f','g','h','i','j'], slot: 2, level: null, levels: { '0': 20 } },
    ] };
    const plan = compute(makeInput(bs, [p], { currentLevel: 3 }));
    const lv4 = plan.levels[plan.levels.length - 1];
    assert.equal(lv4.bosses[0].attacks.length, 1);
    assert.equal(lv4.bosses[0].attacks[0].dmgB, 20, `Lv4解決値 20 > 12 なので編成②: ${lv4.bosses[0].attacks[0].dmgB}`);
    assert.equal(lv4.bosses[0].attacks[0].loadoutSlot, 2);
});

test('dmgB=0 でも levels に有効な測定があれば使える (先行フィルタで捨てない)', () => {
    const p = player('A', { fire: 12 });
    p.loadoutsByAttr = { fire: [{ dmgB: 0, team: ['a','b','c','d','e'], slot: 1, level: null, levels: { '4': 12 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 1 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1, 'levels の 12B が候補になるはず');
    assert.equal(used[0].dmgB, 12);
});

test('dmgB と levels が矛盾する入力は levels 側の最大値に正規化される (防御)', () => {
    const p = player('A', { fire: 5 });
    p.loadoutsByAttr = { fire: [{ dmgB: 5, team: ['a','b','c','d','e'], slot: 1, level: null, levels: { '2': 18 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 1 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1);
    assert.equal(used[0].dmgB, 18, `levels の 18 が正: ${used[0].dmgB}`);
    assert.equal(used[0].loadoutLevel, 2);
});

// ---- popularTeams ドメイン (人気編成 = 模擬 + 過去シーズンの凸の合算) --------
console.log('\npopularTeamsDomain:');
{
    const pt = globalThis.popularTeamsDomain;
    // 解決関数: 模擬 = 表記ゆれ吸収 (ここでは恒等) / 凸 = パス→名前 (末尾のファイル名で引く)
    const PATHMAP = { 'a.webp': 'A', 'b.webp': 'B', 'c.webp': 'C', 'd.webp': 'D', 'e.webp': 'E', 'f.webp': 'F' };
    const resolveMock = (c) => c;
    const resolveHist = (c) => PATHMAP[String(c).split('/').pop()] || null;
    const T5 = ['A', 'B', 'C', 'D', 'E'];
    const P5 = ['./x/a.webp', './x/b.webp', './x/c.webp', './x/d.webp', './x/e.webp'];

    test('popularTeams: 模擬と凸を合算し、同一人物は1人と数える', () => {
        const r = pt.buildPopularTeams({
            mockRows: [{ player_id: 1, attribute: 'wind', characters: T5 }],
            histRows: [
                { player_id: 1, attribute: 'wind', characters: P5 },   // 同一人物 (模擬と凸)
                { player_id: 2, attribute: 'wind', characters: P5 },
            ],
            resolveMock, resolveHist,
        });
        const g = r.wind.list[0];
        assert.equal(g.count, 2, `distinct 2人のはず: ${g.count}`);
        assert.equal(g.mockCount, 1);
        assert.equal(g.histCount, 2);
        assert.equal(r.wind.total, 2);
    });

    test('popularTeams: 順不同で同じ5人は同じ編成として数える', () => {
        const r = pt.buildPopularTeams({
            mockRows: [
                { player_id: 1, attribute: 'fire', characters: ['A', 'B', 'C', 'D', 'E'] },
                { player_id: 2, attribute: 'fire', characters: ['E', 'D', 'C', 'B', 'A'] },
            ],
            histRows: [], resolveMock, resolveHist,
        });
        assert.equal(r.fire.list.length, 1);
        assert.equal(r.fire.list[0].count, 2);
    });

    test('popularTeams: 解決できないパスを含む凸は丸ごと捨てる (部分編成を作らない)', () => {
        const r = pt.buildPopularTeams({
            mockRows: [],
            histRows: [
                { player_id: 1, attribute: 'wind', characters: ['./x/a.webp', './x/unknown.webp', './x/c.webp', './x/d.webp', './x/e.webp'] },
                { player_id: 2, attribute: 'wind', characters: P5 },
            ],
            resolveMock, resolveHist,
        });
        assert.equal(r.wind.list.length, 1, '不完全な凸はグループを作らない');
        assert.equal(r.wind.list[0].count, 1);
    });

    test('popularTeams: 5人未満の凸記録は使わない (模擬は従来どおり寛容)', () => {
        const r = pt.buildPopularTeams({
            mockRows: [{ player_id: 1, attribute: 'iron', characters: ['A', 'B'] }],   // 模擬は部分でも数える
            histRows: [{ player_id: 2, attribute: 'iron', characters: P5.slice(0, 4) }],
            resolveMock, resolveHist,
        });
        assert.equal(r.iron.list.length, 1, '模擬の部分編成だけが残るはず');
        assert.equal(r.iron.list[0].mockCount, 1);
        assert.equal(r.iron.list[0].histCount, 0);
    });

    test('popularTeams: 属性ごとに独立して集計する', () => {
        const r = pt.buildPopularTeams({
            mockRows: [{ player_id: 1, attribute: 'fire', characters: T5 }],
            histRows: [{ player_id: 1, attribute: 'wind', characters: P5 }],
            resolveMock, resolveHist,
        });
        assert.equal(r.fire.list[0].mockCount, 1);
        assert.equal(r.fire.list[0].histCount, 0);
        assert.equal(r.wind.list[0].histCount, 1);
    });

    test('popularTeams: 並びは 人数 → 延べ使用数 → キー昇順で決定的', () => {
        const mk = (pid, chars) => ({ player_id: pid, attribute: 'water', characters: chars });
        const r = pt.buildPopularTeams({
            mockRows: [
                mk(1, ['A', 'B', 'C', 'D', 'E']), mk(2, ['A', 'B', 'C', 'D', 'E']),   // 2人
                mk(3, ['A', 'B', 'C', 'D', 'F']),                                     // 1人・延べ2
                mk(3, ['A', 'B', 'C', 'D', 'F']),
                mk(4, ['B', 'C', 'D', 'E', 'F']),                                     // 1人・延べ1
            ],
            histRows: [], resolveMock, resolveHist,
        });
        const keys = r.water.list.map(g => [...g.team].sort().join(''));
        assert.deepEqual(keys, ['ABCDE', 'ABCDF', 'BCDEF'], `並びが違う: ${keys}`);
    });

    test('popularTeams: 表示用の編成は模擬提出の並びを優先する', () => {
        const r = pt.buildPopularTeams({
            mockRows: [{ player_id: 1, attribute: 'wind', characters: ['E', 'D', 'C', 'B', 'A'] }],
            histRows: [{ player_id: 2, attribute: 'wind', characters: P5 }],   // 解決順は A,B,C,D,E
            resolveMock, resolveHist,
        });
        assert.deepEqual(r.wind.list[0].team, ['E', 'D', 'C', 'B', 'A'], '模擬の並びが代表になる');
    });
}

// ---- mockLevels ドメイン (レベル別測定値 — 31_player_damages_levels) --------
console.log('\nmockLevelsDomain:');
{
    const ml = globalThis.mockLevelsDomain;

    test('mockLevels: normLevels は正の有限数のみ通し、不正キーを無視する', () => {
        const r = ml.normLevels({ 1: 14.2, 4: 12.5, 9: 99, x: 3, 2: -1, 3: 'abc' }, 0, null);
        assert.deepEqual(r, { '1': 14.2, '4': 12.5 });
    });

    // ---- mergeMeasurements: Lv1〜Lv4 をまとめて登録するフォーム用 ----
    test('mergeMeasurements: フォームの内容がそのまま levels になる', () => {
        const r = ml.mergeMeasurements({}, { entries: { 1: 12, 2: 18, 3: 24, 4: 30 } });
        assert.deepEqual(r.levels, { '1': 12, '2': 18, '3': 24, '4': 30 });
        assert.equal(r.damage_b, 30, '互換ミラーは最大値');
        assert.equal(r.boss_level, 4, '互換ミラーは最大値のレベル');
    });

    test('mergeMeasurements: 空欄にしたレベルは消える (既存とマージしない)', () => {
        // 1件ずつの mergeMeasurement と違い、画面の内容が保存結果そのものになる
        const existing = { levels: { '1': 10, '2': 20, '3': 30 }, damage_b: 30, boss_level: 3 };
        const r = ml.mergeMeasurements(existing, { entries: { 1: 11, 4: 44 } });
        assert.deepEqual(r.levels, { '1': 11, '4': 44 }, `Lv2/Lv3 は消えるはず: ${JSON.stringify(r.levels)}`);
        assert.equal(r.damage_b, 44);
        assert.equal(r.boss_level, 4);
    });

    test('mergeMeasurements: 0・空・不正値は登録しない', () => {
        const r = ml.mergeMeasurements({}, { entries: { 1: 0, 2: '', 3: 'abc', 4: 25, 9: 99 } });
        assert.deepEqual(r.levels, { '4': 25 }, `有効なのは Lv4 だけ: ${JSON.stringify(r.levels)}`);
    });

    test('mergeMeasurements: 有効な値が1つも無ければ null', () => {
        assert.equal(ml.mergeMeasurements({}, { entries: {} }), null);
        assert.equal(ml.mergeMeasurements({}, { entries: { 1: 0, 2: -5 } }), null);
    });

    test('mergeMeasurements: 編成が変わったら teamChanged を立てる', () => {
        const existing = { levels: { '1': 10 }, damage_b: 10, boss_level: 1, characters: ['a', 'b', 'c', 'd', 'e'] };
        const same = ml.mergeMeasurements(existing, { entries: { 1: 12 }, characters: ['e', 'd', 'c', 'b', 'a'] });
        assert.equal(same.teamChanged, false, '順不同で同じ編成なら false');
        const diff = ml.mergeMeasurements(existing, { entries: { 1: 12 }, characters: ['a', 'b', 'c', 'd', 'z'] });
        assert.equal(diff.teamChanged, true, '別編成なら true');
    });

    test('mergeMeasurements: 別スロットへ振り替えるときは追記マージで消さない', () => {
        // supabaseSaveMockSubmission は同一編成が別スロットにあるとそちらへ振り替える。
        // そのとき全置換すると、振替先が持っていた別レベルの測定が消える。
        // 呼び出し側は「振替先の既存 levels + フォーム」を entries に渡す約束にしてある
        const target = { levels: { '1': 10, '4': 40 }, damage_b: 40, boss_level: 4, characters: ['a','b','c','d','e'] };
        const form = { '2': 22 };                       // 元スロットのフォームには Lv2 だけ
        const base = ml.normLevels(target.levels, target.damage_b, target.boss_level);
        const r = ml.mergeMeasurements(target, { entries: { ...base, ...form }, characters: ['a','b','c','d','e'] });
        assert.deepEqual(r.levels, { '1': 10, '2': 22, '4': 40 }, `Lv1/Lv4 が残るはず: ${JSON.stringify(r.levels)}`);
        assert.equal(r.damage_b, 40);
    });

    test('bestAtLevel: いまのレベルで使える測定だけを見る (凸報告のHP予測が使う)', () => {
        // Lv1限定30B / Lv4用15B の編成。Lv4 の凸で 30B 削れる予測を出してはいけない
        const lv = { '1': 30, '4': 15 };
        assert.equal(ml.bestAtLevel(lv, 1), 30, 'Lv1では両方使えるので最大の30');
        assert.equal(ml.bestAtLevel(lv, 2), 15, 'Lv2ではLv1測定は使えない');
        assert.equal(ml.bestAtLevel(lv, 4), 15, 'Lv4で30Bを出してはいけない');
        assert.equal(ml.bestAtLevel({ '1': 30 }, 4), null, '使える測定が無ければ null');
        assert.equal(ml.bestAtLevel({ '0': 20, '1': 30 }, 3), 20, '未指定は全レベルで使える');
    });

    test('mergeMeasurements: 未指定 (0) も登録できる (移行前の提出の編集)', () => {
        const r = ml.mergeMeasurements({}, { entries: { 0: 14.3, 4: 30 } });
        assert.deepEqual(r.levels, { '0': 14.3, '4': 30 });
        assert.equal(r.boss_level, 4, '未指定より Lv4 の方が大きいので代表は Lv4');
    });

    test('mockLevels: levels が無ければ (damage_b, boss_level) の1測定として読む (移行互換)', () => {
        assert.deepEqual(ml.normLevels(null, 14.2, 4), { '4': 14.2 });
        assert.deepEqual(ml.normLevels(null, 14.2, null), { '0': 14.2 });
        assert.equal(ml.normLevels(null, 0, 4), null, '測定なしは null');
        // Number(true)===1 の真偽値化け対策 (30 実装時の教訓)
        assert.deepEqual(ml.normLevels(null, 10, true), { '0': 10 });
    });

    test('mockLevels: maxEntry は最大値、タイは "0" > 高レベル (寛容側)', () => {
        assert.deepEqual(ml.maxEntry({ '1': 14, '4': 12 }), { level: 1, value: 14 });
        assert.deepEqual(ml.maxEntry({ '0': 12, '4': 12 }), { level: null, value: 12 });
        assert.deepEqual(ml.maxEntry({ '2': 12, '4': 12 }), { level: 4, value: 12 });
        assert.equal(ml.maxEntry(null), null);
    });

    test('mockLevels: bestAtLevel は「キー0 または キー≥L」の最大値', () => {
        const lv = { '1': 30, '4': 12 };
        assert.equal(ml.bestAtLevel(lv, 1), 30, 'Lv1 には Lv1 測定の 30');
        assert.equal(ml.bestAtLevel(lv, 2), 12, 'Lv2 には Lv4 測定の 12 (Lv1 測定は使えない)');
        assert.equal(ml.bestAtLevel(lv, 4), 12);
        assert.equal(ml.bestAtLevel({ '1': 30 }, 2), null, '届く測定が無ければ null');
        assert.equal(ml.bestAtLevel({ '0': 20, '1': 30 }, 3), 20, '"0" は全レベルで使える');
    });

    test('mockLevels: mergeMeasurement は同一編成なら該当キーだけ追記しミラーを再計算', () => {
        const existing = { levels: { '4': 12 }, damage_b: 12, boss_level: 4,
            characters: ['ラピ:レッドフード', 'クラウン', 'リター', 'シンデレラ', 'ナガ'] };
        const r = ml.mergeMeasurement(existing, { damageB: 14, level: 1,
            characters: ['クラウン', 'ラピ：レッドフード', 'ナガ', 'シンデレラ', 'リター'] });   // 全角コロン+順不同 = 同一編成
        assert.equal(r.teamChanged, false, '表記揺れ・順不同でも同一編成と判定');
        assert.deepEqual(r.levels, { '4': 12, '1': 14 });
        assert.equal(r.damage_b, 14);
        assert.equal(r.boss_level, 1, 'ミラーは最大値の測定キー');
    });

    test('mockLevels: 編成が変わったら levels をリセットして新測定だけ残す', () => {
        const existing = { levels: { '4': 12, '1': 14 }, damage_b: 14, boss_level: 1,
            characters: ['A', 'B', 'C', 'D', 'E'] };
        const r = ml.mergeMeasurement(existing, { damageB: 10, level: 2, characters: ['A', 'B', 'C', 'D', 'F'] });
        assert.equal(r.teamChanged, true);
        assert.deepEqual(r.levels, { '2': 10 }, '旧編成の測定は無効化');
        assert.equal(r.damage_b, 10);
        assert.equal(r.boss_level, 2);
    });

    test('mockLevels: characters 未指定の取り込みは編成不変としてマージ / 不正値は null', () => {
        const existing = { levels: { '4': 12 }, damage_b: 12, boss_level: 4, characters: ['A', 'B', 'C', 'D', 'E'] };
        const r = ml.mergeMeasurement(existing, { damageB: 13, level: null });
        assert.deepEqual(r.levels, { '4': 12, '0': 13 });
        assert.equal(ml.mergeMeasurement(existing, { damageB: 0, level: 1 }), null);
        assert.equal(ml.mergeMeasurement(existing, { damageB: NaN, level: 1 }), null);
    });

    test('mockLevels: 編成未登録の行へ編成付き提出が来たら測定を相続しない (仕切り直し)', () => {
        // 出所不明の測定値を新しい編成に付け替えない (Codexレビュー指摘)
        const existing = { levels: { '0': 20 }, damage_b: 20, boss_level: null, characters: [] };
        const r = ml.mergeMeasurement(existing, { damageB: 15, level: 3, characters: ['A', 'B', 'C', 'D', 'E'] });
        assert.equal(r.teamChanged, true);
        assert.deepEqual(r.levels, { '3': 15 });
    });

    test('mockLevels: sameTeam/charKey の正規化契約 (ソルバーと同一規則のフィクスチャ)', () => {
        // optimal-plan.js:188/224 と同じ受理規則であることを固定する (実装は二重化 —
        // どちらかだけ変えるとこのフィクスチャが乖離を検知する)
        assert.equal(ml.sameTeam(['アニス:スター', ' クラウン '], ['アニス：スター', 'クラウン']), true, 'NFKC+trim');
        assert.equal(ml.sameTeam(['a', 'b'], ['B', 'A']), true, '大小文字・順不同');
        assert.equal(ml.sameTeam(['a', 'b'], ['a', 'b', 'c']), false, '要素数違い');
        assert.equal(ml.sameTeam([], []), false, '空編成は同一と見なさない');
        assert.equal(ml.charKey('ラピ：レッドフード'), 'ラピ:レッドフード'.toLowerCase().normalize('NFKC'));
    });
}

// ---- testSeasonDomain (テスト終了時のキャラマスタ整理) -------------------------
console.log('\ntestSeasonDomain:');
{
    const dom = globalThis.testSeasonDomain;
    const rows = [
        { canonical_name: 'テスト前から居る', sighting_count: 9, is_confirmed: true, created_by_test_season_id: null },
        { canonical_name: 'テスト中OCR', sighting_count: 1, is_confirmed: false, created_by_test_season_id: 29 },
        { canonical_name: 'アイギス', sighting_count: 0, is_confirmed: true, created_by_test_season_id: null },        // 手動登録
        { canonical_name: '別テスト由来', sighting_count: 2, is_confirmed: false, created_by_test_season_id: 27 },
        { canonical_name: 'タグ無しOCR', sighting_count: 1, is_confirmed: false },                                    // 33 未適用時代
    ];
    test('テスト由来タグが今回のテストを指す行だけ既定ON、手動登録・別テスト・タグ無しは既定OFF', () => {
        const out = dom.classifyTestSeasonChars({ snapshotNames: ['テスト前から居る'], currentRows: rows, testSeasonId: 29 });
        assert.deepEqual(out.map(c => c.canonical_name).includes('テスト前から居る'), false, 'スナップショット内は候補にしない');
        const by = Object.fromEntries(out.map(c => [c.canonical_name, c]));
        assert.equal(by['テスト中OCR'].defaultDelete, true);
        assert.equal(by['テスト中OCR'].origin, 'test');
        assert.equal(by['アイギス'].defaultDelete, false);
        assert.equal(by['アイギス'].origin, 'manual');
        assert.equal(by['別テスト由来'].defaultDelete, false);
        assert.equal(by['タグ無しOCR'].defaultDelete, false);
        assert.equal(out[0].canonical_name, 'テスト中OCR', '既定ON が先頭に来る');
    });
    test('testSeasonId が無い / スナップショットが無い / タグ列が無い環境でも落ちず、全て既定OFF', () => {
        const out = dom.classifyTestSeasonChars({ snapshotNames: null, currentRows: rows.map(({ created_by_test_season_id, ...r }) => r), testSeasonId: null });
        assert.equal(out.length, rows.length);
        assert.ok(out.every(c => c.defaultDelete === false));
        assert.deepEqual(dom.classifyTestSeasonChars({}), []);
    });
    test('filterDeletableChars: スナップショット内の名前・重複・不正値は削除対象から外す (未指定なら空)', () => {
        assert.deepEqual(dom.filterDeletableChars(['テスト中OCR', 'テスト前から居る', 'テスト中OCR', '', null, 42], ['テスト前から居る']), ['テスト中OCR']);
        assert.deepEqual(dom.filterDeletableChars(undefined, ['x']), []);
        assert.deepEqual(dom.filterDeletableChars('テスト中OCR', []), [], '配列以外は無視');
    });
    test('境界: スナップショット内かつ今回タグ付きは候補外 / 文字列の testSeasonId でも一致 / sighting_count 欠落は0扱い', () => {
        const out = dom.classifyTestSeasonChars({
            snapshotNames: ['両方'],
            currentRows: [
                { canonical_name: '両方', created_by_test_season_id: 29 },
                { canonical_name: '文字列ID', created_by_test_season_id: 29 },
                { canonical_name: '欠落', is_confirmed: false },
            ],
            testSeasonId: '29',
        });
        assert.deepEqual(out.map(c => c.canonical_name), ['文字列ID', '欠落']);
        assert.equal(out[0].defaultDelete, true);
        assert.equal(out[1].sighting_count, 0);
        assert.equal(out[1].defaultDelete, false);
    });
}

// ---- バックアップ整合 (静的) ------------------------------------------------
// 「テーブルを作ったのにバックアップ/復元に足し忘れる」を仕組みで止める。
// 2026-08-31: activity_log / finish_requests / raid_event_notices の3表が漏れていた
// (復元しても監査ログ・締め凸依頼・通知の二重送信よけが巻き戻らない) のを機に追加。
{
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
    const client = fs.readFileSync(path.join(ROOT, 'js', 'supabase-client.js'), 'utf8');
    const sqlDir = path.join(ROOT, 'supabase');
    const sqlFiles = fs.readdirSync(sqlDir).filter(f => /^\d+_.*\.sql$/.test(f));
    // 宣言が見つからなければ空リストにして、下の test() 内で「テーブルが漏れている」として検知させる
    // (test() の外で assert すると集計に乗らずモジュール例外になる — Codex指摘)
    const listOf = (name) => client.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`))?.[1] ?? '';
    const backup = [...listOf('_BACKUP_TABLES').matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    const restore = [...listOf('_RESTORE_TABLES').matchAll(/^\s*\['([a-z_]+)'/gm)].map(m => m[1]);
    const created = new Set();
    const serialTables = new Set();
    for (const f of sqlFiles) {
        const src = fs.readFileSync(path.join(sqlDir, f), 'utf8');
        for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
            created.add(m[1]);
            if (/\bid\s+BIGSERIAL\b/.test(m[2])) serialTables.add(m[1]);
        }
    }
    const helpers = fs.readFileSync(path.join(sqlDir, '23_restore_helpers.sql'), 'utf8');

    test('バックアップ整合: supabase/ の全テーブルが _BACKUP_TABLES に入っている', () => {
        const missing = [...created].filter(t => !backup.includes(t));
        assert.deepEqual(missing, [], `バックアップ対象から漏れているテーブル: ${missing.join(', ')}`);
        const unknown = backup.filter(t => !created.has(t));
        assert.deepEqual(unknown, [], `supabase/ に定義が無いテーブル: ${unknown.join(', ')}`);
    });
    test('バックアップ整合: _RESTORE_TABLES と _BACKUP_TABLES が同じ集合 (順序は親→子)', () => {
        assert.deepEqual([...restore].sort(), [...backup].sort());
        // 親→子の最低限: players / seasons が先頭側、それを参照する表が後ろ
        const idx = (t) => restore.indexOf(t);
        assert.ok(backup.length > 0 && restore.length > 0, '_BACKUP_TABLES / _RESTORE_TABLES の宣言が見つからない');
        for (const child of ['bosses', 'attacks', 'finish_requests', 'raid_event_notices', 'published_plans', 'plan_acks', 'player_sync_levels', 'fururi_simulation_scores', 'finish_claims']) {
            assert.ok(idx(child) > idx('seasons'), `${child} は seasons より後に投入すること`);
        }
        // players を参照する表 (CASCADE / SET NULL いずれも、投入時に親が要る)
        for (const child of ['attacks', 'player_damages', 'player_sync_levels', 'day_offs', 'availability', 'finish_coordinations', 'finish_requests', 'raid_event_notices', 'activity_log', 'push_subscriptions', 'plan_acks']) {
            assert.ok(idx(child) > idx('players'), `${child} は players より後に投入すること`);
        }
        assert.ok(idx('plan_acks') > idx('published_plans'), 'plan_acks は published_plans より後');
    });
    test('バックアップ整合: BIGSERIAL id を持つ全表が restore_fix_sequences() に入っている', () => {
        const missing = [...serialTables].filter(t => !new RegExp(`pg_get_serial_sequence\\('${t}', 'id'\\)`).test(helpers));
        assert.deepEqual(missing, [], `23_restore_helpers.sql に採番修正が無い表: ${missing.join(', ')}`);
    });
}

// ---- 結果 --------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
