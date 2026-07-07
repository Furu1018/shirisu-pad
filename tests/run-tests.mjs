// ============================================================================
// 最適凸プラン ソルバー 単体テスト
//   node tests/run-tests.mjs
// ============================================================================
import assert from 'node:assert/strict';
import '../js/optimal-plan.js';   // globalThis.computeOptimalPlanCore を定義する

const compute = globalThis.computeOptimalPlanCore;

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
    // Lv1 残5B / Lv2 lord=226.26B / Lv3 lord=349.23B。各レベル1人が一撃で処理。
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
        [boss(1, 'fire', { remainingB: 50, totalB: 226.2627204 })],
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

// ---- 時間考慮モード (timeAware) ------------------------------------------------
console.log('\ntimeAware:');

const timeInput = (bosses, players, opts = {}) => ({ ...makeInput(bosses, players, opts), timeAware: true });

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

test('レベル依存: Lv2 の凸は Lv1 のクリア想定時刻以降に割り当てられる', () => {
    // Lv1 は21時の人しか凸できない → Lv2 は21時以降。
    // 「朝だけの人」は火力があっても Lv2 に時間的に参加できない。
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 5 })],
        [
            player('夜の人', { fire: 10 }, { availableSlots: ['h21'] }),
            player('朝だけの人', { fire: 300 }, { availableSlots: ['h09'] }),
            player('深夜の人', { fire: 300 }, { availableSlots: ['h23'] }),
        ],
        { currentSlot: 'h14' },
    ));
    // Lv1: 律速抑制ペナルティ込みでも「夜の人」(10B, オーバーキル5B) より
    // 朝だけの人は 14時時点で h09 が過ぎており時間対象外。
    const lv1 = plan.levels[0];
    assert.equal(lv1.levelCleared, true);
    // Lv2: openIdx = Lv1 クリア時刻。朝だけの人は参加不可、深夜の人 (23時) のみ。
    const lv2 = plan.levels[1];
    const names = lv2.bosses[0].attacks.map(a => a.memberName);
    assert.ok(!names.includes('朝だけの人'), 'Lv2 に朝だけの人が入ってはいけない');
    if (lv2.levelCleared) {
        assert.equal(lv2.clearHourLabel, '23時');
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

test('時間不足: 火力はあるのに時間内に凸できないと timeConstrained が立つ', () => {
    // 現在22時。凸可能が「過ぎた時間」しかない人だけ → 時間不足
    const plan = compute(timeInput(
        [boss(1, 'fire', { remainingB: 10 })],
        [player('もう寝た人', { fire: 100 }, { availableSlots: ['h09', 'h10'] })],
        { currentSlot: 'h22' },
    ));
    const b1 = plan.levels[0].bosses[0];
    assert.equal(b1.cleared, false);
    assert.equal(b1.timeConstrained, true, '火力不足ではなく時間不足の判定になるはず');
    assert.equal(plan.anyTimeConstrained, true);
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

// ---- 結果 --------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
