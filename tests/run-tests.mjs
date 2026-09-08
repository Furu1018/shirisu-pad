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
import '../js/domain/mockExclusion.js';   // globalThis.mockExclusionDomain (運営による模擬提出の除外)
import '../js/domain/planDiff.js';        // globalThis.planDiffDomain (配信プランの差分 — L4 通知抑制 / L5 運営ガード)
import '../js/domain/reservations.js';    // globalThis.reservationsDomain (凸の予約 — L2 / 課題E)
import '../js/domain/availability.js';    // globalThis.availabilityDomain (戦闘可能時間の読み方)
import '../js/domain/clientGate.js';      // globalThis.clientGateDomain (互換ゲート — L2 ⑦)
import '../js/domain/popularTeams.js';  // globalThis.popularTeamsDomain (人気編成の合算集計)
import '../js/domain/testSeason.js';    // globalThis.testSeasonDomain (テスト終了時のキャラ整理)
import '../js/domain/charMaster.js';    // globalThis.charMasterDomain (手動登録の二者確認)
import '../js/domain/memberStatus.js';  // globalThis.memberStatusDomain (メンバー状況ボード)
import '../js/domain/opsLayout.js';     // globalThis.opsLayoutDomain (戦況タブの折りたたみ + コックピット)
import '../js/domain/opsStage.js';      // globalThis.opsStageDomain (運営モードの段階: 準備/前日/当日/終了)
import '../js/domain/growth.js';       // globalThis.growthDomain (ユニオンメンバーの育成データ — BlaBlaLINK 由来)
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
        strong_attributes: opts.strong || [],   // ソルバーでは使わない (2026-09-08) — 渡しても結果が変わらないことを下で確認する
    };
}

function makeInput(bosses, players, opts = {}) {
    return {
        season: { current_level: opts.currentLevel ?? 1 },
        bosses,
        players,
        currentSlot: opts.currentSlot ?? 'h21',
        onlyAvailableNow: !!opts.onlyAvailableNow,
        ...(opts.ignoreLevels ? { ignoreLevels: true } : {}),
    };
}

// ---- テストランナー --------------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
    try {
        const r = fn();
        // ★ async のテストをここに渡すと、中身を待たずに「合格」にしてしまう。
        //   assert が一つも効かない**静かに通るテスト**になる (2026-09-09 に実際に踏んだ —
        //   変異を入れても赤くならず気づいた)。非同期は下の testAsync を await して使うこと
        if (r && typeof r.then === 'function') {
            throw new Error('async のテストは testAsync を使うこと (このままでは中身が検証されません)');
        }
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




test('得意属性は算出に影響しない (2026-09-08: ソルバーから外した。予約が本人の希望を表す)', () => {
    // ★ 同じ盤面で得意属性を付けても割当が1つも変わらないこと (仕組みを外した証拠)
    {
        const bs0 = [boss(1, 'fire', { remainingB: 5 }), boss(2, 'water', { remainingB: 5 }), boss(3, 'electric', { remainingB: 5 })];
        const shot = (strong) => JSON.stringify(compute(makeInput(bs0, [player('A', { fire: 10, water: 10, electric: 10, iron: 10, wind: 10 }, { strong })])).levels
            .map(lv => lv.bosses.map(b => b.attacks.map(a => [a.memberId, a.loadoutSlot, a.hourIdx]))));
        assert.equal(shot(['fire']), shot([]), '得意属性1つで割当が変わった');
        assert.equal(shot(['fire', 'water', 'electric', 'iron']), shot([]), '得意属性4つで割当が変わった');
    }
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


// ---- 模擬の測定レベル (boss_level) --------------------------------------------
// ルール: 記録レベル L の編成は「対象レベル ≤ L」にだけ使える。
// level == null (レベル未指定 = 移行前の提出) は全レベルで使える。
console.log('\n測定レベルの廃止:');

// 2026-09-06: 模擬の「測定ボスレベル」は概念ごと廃止した。
// 「Lv1で測った値をLv3に流用すると過大評価」という想定を実データが否定したため
// (同一編成のレベル違い測定6件すべてが Lv1比96〜105%・実凸90件のSLv補正集計でも低下傾向なし)。
// この想定でソルバーが候補を絞った結果、第44回は未消化49凸になった。

test('★ Lv1で測った編成でも Lv2/Lv3 のボスに割り当てられる (廃止前は出せなかった)', () => {
    // Lv1 のボスは全滅済み → 割当は Lv2 から始まる。廃止前はここで0凸になっていた
    const bs = [boss(1, 'fire', { remainingB: 0, totalB: 100 })];
    const p = player('A', { fire: 30 });
    p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 1, levels: { '1': 30 } }] };
    const plan = compute(makeInput(bs, [p], { currentLevel: 2 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1, `Lv1測定でも Lv2 に出せるはず: ${used.length}凸`);
    assert.equal(used[0].dmgB, 30);
});

test('★ 記録レベルは結果に残さない (loadoutLevel は廃止)', () => {
    const p = player('A', { fire: 30 });
    p.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, level: 1, levels: { '1': 30 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 20, totalB: 100 })], [p], { currentLevel: 3 }));
    const a = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks))[0];
    assert.equal(a.loadoutLevel, undefined, '測定レベルは概念ごと無くしたので結果に出さない');
    assert.equal(plan.ignoreLevels, undefined, '緊急モードのフラグも廃止');
});

test('★ 複数レベルの測定が残っている既存データは中央値を使う (最大値だとブレの上振れを拾う)', () => {
    const p = player('A', { fire: 40 });
    // 廃止前に Lv1/Lv3/Lv4 で測った行。中央値は 30
    p.loadoutsByAttr = { fire: [{ dmgB: 40, team: ['a','b','c','d','e'], slot: 1, levels: { '1': 40, '3': 30, '4': 20 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 3 }));
    const a = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks))[0];
    assert.equal(a.dmgB, 30, `中央値の30が使われるはず: ${a.dmgB}`);
});

test('★ 並べ替え・消費も代表値で行う (最大値のまま残すと弱い編成が生き残る)', () => {
    // Codex指摘 2026-09-06: 選択は代表値なのに並び・消費が最大値だと、
    // 「最大値は高いが代表値は低い編成」が上位に並び、完了凸の推定消費で先に消えてしまう。
    // 編成が記録されていない完了凸は「上位から消費」なので、その差が結果に出る
    const p = player('A', { fire: 100 });
    p.loadoutsByAttr = { fire: [
        { dmgB: 100, team: ['a','b','c','d','e'], slot: 1, levels: { '1': 100, '2': 1, '3': 1 } },  // 代表値 1
        { dmgB: 50,  team: ['f','g','h','i','j'], slot: 2, levels: { '1': 50, '2': 50, '3': 50 } }, // 代表値 50
    ] };
    // 灼熱PTで1凸済み・編成は未記録 → 代表値が上位の1件が消費済みとみなされる
    p.attacks = [{ boss_number: 1, characters: [] }];
    p.attackCount = 1;
    // boss() の第2引数は弱点 (持っていくPT属性)。灼熱PTで殴るボス1体だけを置く
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 200, totalB: 300 })], [p], { currentLevel: 1 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    // 代表値の高い編成② (50) が消費済みになり、残るのは代表値1の編成①
    assert.equal(used.length, 1, `残り1凸のはず: ${used.length}`);
    assert.equal(used[0].dmgB, 1, `代表値で消費すると残るのは1B: ${used[0].dmgB} (最大値で消費すると50Bになる)`);
});

test('★ 偶数個の測定は中央2つの平均', () => {
    const p = player('A', { fire: 40 });
    p.loadoutsByAttr = { fire: [{ dmgB: 40, team: ['a','b','c','d','e'], slot: 1, levels: { '1': 40, '2': 30, '3': 20, '4': 10 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 1 }));
    const a = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks))[0];
    assert.equal(a.dmgB, 25, `(20+30)/2 = 25 のはず: ${a.dmgB}`);
});

test('unusedSummary: 未消化の理由別合計 (模擬未提出は「未提出」として分ける・凸数の多い順・key/label 付き)', () => {
    // 2026-09-05: 留意点の1行目に「未消化 25凸 — 模擬未提出 12 · キャラ被り 7 …」を出すための集計
    const bs = [boss(1, 'fire', { remainingB: 0, totalB: 100 })];
    const none = player('未提出', {});                      // 模擬を1属性も出していない
    const one = player('1属性だけ', { fire: 30 });          // 灼熱1つだけ → 使い切ると余る
    one.loadoutsByAttr = { fire: [{ dmgB: 30, team: ['a','b','c','d','e'], slot: 1, levels: { '1': 30 } }] };
    const plan = compute(makeInput(bs, [none, one], { currentLevel: 2 }));
    // 1属性だけの人は Lv2 に1凸だけ出せる (測定レベルでは絞られない) → 残り2凸 + 未提出3凸
    assert.equal(plan.unusedAttacks, 5);
    const byName = Object.fromEntries(plan.unusedDetail.map(d => [d.name, d]));
    assert.equal(byName['未提出'].key, 'noSubmission');
    assert.equal(byName['未提出'].label, '模擬未提出');
    assert.match(byName['未提出'].reason, /模擬未提出/, '旧文言「提出属性を使い切り」だと未提出と区別がつかない');
    assert.equal(byName['1属性だけ'].key, 'attrsExhausted');
    assert.deepEqual(plan.unusedSummary.map(s => [s.key, s.attacks, s.members.map(m => m.name)]),
        [['noSubmission', 3, ['未提出']], ['attrsExhausted', 2, ['1属性だけ']]], '凸数の多い順');
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

test('dmgB と levels が矛盾する入力は levels 側が正 (防御)', () => {
    // 互換ミラーの damage_b がずれていても、実測値そのものである levels を信じる
    const p = player('A', { fire: 5 });
    p.loadoutsByAttr = { fire: [{ dmgB: 5, team: ['a','b','c','d','e'], slot: 1, levels: { '2': 18 } }] };
    const plan = compute(makeInput([boss(1, 'fire', { remainingB: 100, totalB: 300 })], [p], { currentLevel: 1 }));
    const used = plan.levels.flatMap(l => l.bosses.flatMap(b => b.attacks));
    assert.equal(used.length, 1);
    assert.equal(used[0].dmgB, 18, `levels の 18 が正: ${used[0].dmgB}`);
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

// ---- opsLayoutDomain (戦況タブの折りたたみ + コックピット) ----------------------
console.log('\nopsLayoutDomain:');
{
    const dom = globalThis.opsLayoutDomain;
    test('resolveOpen: 前日/当日の既定 (当日はボス・残凸・メンバー状況・運営アクションだけ開く) / always は常に開 / 運営OFFは全開', () => {
        const ids = dom.CARDS.map(c => c.id);
        const openDay = ids.filter(id => dom.resolveOpen(id, 'day', null, true));
        assert.deepEqual(openDay, ['opsSecBoss', 'opsSecRemaining', 'opsSecMembers', 'opsSecActions']);
        const openPre = ids.filter(id => dom.resolveOpen(id, 'pre', null, true));
        assert.deepEqual(openPre, ['opsSecMembers', 'opsSecReserve', 'opsSecPlan', 'opsSecActions']);
        assert.ok(ids.every(id => dom.resolveOpen(id, 'day', { day: Object.fromEntries(ids.map(i => [i, false])) }, false)), '運営OFFは記憶に関係なく全開');
        assert.equal(dom.resolveOpen('opsSecActions', 'day', { day: { opsSecActions: false } }, true), true, 'always は畳めない');
        assert.equal(dom.resolveOpen('unknown', 'day', null, true), true);
    });
    test('予約カード: 当日は畳み、承認待ちの件数を見出しに出す', () => {
        // 当日に開くカードを増やすと縦に長くなり、折りたたみを入れた意味が消える。
        // 代わりに「承認待ち n」を見出しのサマリーに出して気づけるようにする
        assert.equal(dom.resolveOpen('opsSecReserve', 'day', null, true), false, '当日は畳むこと');
        assert.equal(dom.resolveOpen('opsSecReserve', 'pre', null, true), true, '前日は開くこと');
        const s = dom.summarize({ season: null, reservations: { pending: 2, approved: 3 } });
        assert.equal(s.summaries.opsSecReserve.text, '承認待ち 2 · 固定中 3');
        assert.equal(s.summaries.opsSecReserve.bad, true, '承認待ちがあるなら目立たせる');
        const none = dom.summarize({ season: null, reservations: { pending: 0, approved: 3 } });
        assert.equal(none.summaries.opsSecReserve.bad, false);
        // 未ロード / 39未適用は何も出さない (「予約0件」と混同させない)
        assert.equal(dom.summarize({ season: null }).summaries.opsSecReserve.text, '');
    });
    test('withStored / parseStored: フェーズ別に記憶し、元オブジェクトは変えない / 壊れた JSON は空', () => {
        const s0 = { pre: {}, day: {} };
        const s1 = dom.withStored(s0, 'day', 'opsSecBoss', false);
        assert.equal(dom.resolveOpen('opsSecBoss', 'day', s1, true), false, '当日の記憶が既定より優先');
        assert.equal(dom.resolveOpen('opsSecBoss', 'pre', s1, true), false, '前日は既定 (閉) のまま');
        assert.deepEqual(s0, { pre: {}, day: {} }, '元は不変');
        const s2 = dom.withStored(s1, 'pre', 'opsSecBoss', true);
        assert.equal(dom.resolveOpen('opsSecBoss', 'pre', s2, true), true);
        assert.deepEqual(dom.parseStored('{broken'), { pre: {}, day: {} });
        assert.deepEqual(dom.parseStored(null), { pre: {}, day: {} });
        assert.deepEqual(dom.parseStored(JSON.stringify(s2)), s2);
    });
    test('summarize: 見出しサマリーとコックピット (HP鮮度⚠️・残凸・未完・締め凸未返答)', () => {
        const now = Date.parse('2026-09-05T12:00:00+09:00');
        const bosses = [
            { boss_number: 1, remaining_hp_raw: 0, updated_at: '2026-09-05T11:20:00+09:00' },
            { boss_number: 2, remaining_hp_raw: 5, updated_at: '2026-09-05T11:00:00+09:00' },
        ];
        const players = [{ attackCount: 3 }, { attackCount: 1 }, { attackCount: 0 }];
        const mbRows = [{ todo: true, finish: 'pending' }, { todo: false, finish: null }, { todo: true, finish: null }];
        const r = dom.summarize({ season: { month_key: '2026-09', current_level: 2 }, bosses, players, mbRows, coordList: [{ status: 'available' }, { status: 'coordinating' }, { status: 'off' }], published: true, finishAttr: 'fire', now });
        assert.equal(r.summaries.opsSecBoss.text, 'Lv2 · 残1体 · HP更新 40分前 ⚠️');
        assert.equal(r.summaries.opsSecBoss.bad, true);
        assert.equal(r.summaries.opsSecRemaining.text, '2名 / 5凸残');
        assert.equal(r.summaries.opsSecMembers.text, '未完 2 · 締め凸未返答 1');
        assert.equal(r.summaries.opsSecCoord.text, 'オンライン 2 · 調整中 1');
        assert.equal(r.summaries.opsSecFinish.text, '灼熱 締め凸を検索中');
        assert.equal(r.summaries.opsSecPlan.text, '配信中');
        assert.equal(r.summaries.opsSecSeason.text, '2026-09 · Lv2');
        const ck = Object.fromEntries(r.cockpit.map(t => [t.key, t]));
        assert.equal(ck.hp.value, '40分前'); assert.equal(ck.hp.bad, true);
        assert.equal(ck.remain.value, 5); assert.equal(ck.todo.value, 2); assert.equal(ck.finish.value, 1);
        assert.equal(ck.todo.id, 'opsSecMembers');
        // シーズン無し / メンバー状況未ロード
        const e = dom.summarize({ season: null, bosses: [], players: [], mbRows: null, now });
        assert.equal(e.summaries.opsSecSeason.text, 'シーズン無し');
        assert.equal(e.cockpit.find(t => t.key === 'todo').value, '—');
        assert.equal(e.cockpit.find(t => t.key === 'hp').value, '—');
        assert.equal(dom.summarize({ season: { current_level: 1 }, bosses: [{ updated_at: new Date(now - 30 * 1000).toISOString() }], now }).summaries.opsSecBoss.text, 'Lv1 · 残0体 · HP更新 たった今');
    });
}

// ---- opsStageDomain (運営モードの段階: 準備 / 前日 / 当日 / 終了 — 運営UI再設計 2026-09-08) ----
console.log('\nopsStageDomain:');
{
    const dom = globalThis.opsStageDomain;
    const _fsStage = (await import('node:fs')).default;
    const _pathStage = (await import('node:path')).default;
    const _ROOTStage = _pathStage.resolve(_pathStage.dirname((await import('node:url')).fileURLToPath(import.meta.url)), '..');
    const T = (s) => Date.parse(s);
    const season = { id: 7, is_active: true, hard_date: '2026-09-11', month_key: '2026-09' };
    test('detect: シーズン無し=準備 / ハード日前=前日 / 当日は 5時〜翌4時 / 翌日 5時以降=終了 / 終了済み=準備', () => {
        assert.equal(dom.detect({ season: null }).stage, 'prep');
        assert.equal(dom.detect({ season: { ...season, is_active: false } }).stage, 'prep');
        assert.equal(dom.detect({ season: { ...season, hard_date: null } }).stage, 'pre');
        assert.equal(dom.detect({ season, now: T('2026-09-10T23:59:00+09:00') }).stage, 'pre');
        assert.equal(dom.detect({ season, now: T('2026-09-11T04:59:00+09:00') }).stage, 'pre', '5時より前はまだ前日');
        assert.equal(dom.detect({ season, now: T('2026-09-11T05:00:00+09:00') }).stage, 'day');
        assert.equal(dom.detect({ season, now: T('2026-09-12T04:59:00+09:00') }).stage, 'day', '翌4時までは当日');
        assert.equal(dom.detect({ season, now: T('2026-09-12T05:00:00+09:00') }).stage, 'end');
        assert.equal(dom.detect({ season, now: T('2026-09-20T12:00:00+09:00') }).stage, 'end');
    });
    test('detect: 手動上書きは自動より優先し overridden を立てる / 不正な値は無視 / 記憶はシーズンごと', () => {
        const r = dom.detect({ season, now: T('2026-09-10T12:00:00+09:00'), override: 'day' });
        assert.equal(r.stage, 'day'); assert.equal(r.auto, 'pre'); assert.equal(r.overridden, true);
        assert.equal(dom.detect({ season, now: T('2026-09-10T12:00:00+09:00'), override: 'pre' }).overridden, false, '自動と同じ値なら上書きではない');
        assert.equal(dom.detect({ season, now: T('2026-09-10T12:00:00+09:00'), override: 'bogus' }).stage, 'pre');
        const raw = dom.serializeOverride(7, 'end');
        assert.equal(dom.parseOverride(raw, 7), 'end');
        assert.equal(dom.parseOverride(raw, 8), null, '別シーズンの記憶を引き継がない');
        assert.equal(dom.parseOverride(raw, null), null, '終わったシーズンの記憶をシーズン無し (準備) に持ち越さない');
        assert.equal(dom.parseOverride(dom.serializeOverride(null, 'day'), null), 'day', 'シーズン無しのときの記憶は使える');
        assert.equal(dom.parseOverride(dom.serializeOverride(null, 'day'), 7), null);
        assert.equal(dom.parseOverride('{broken', 7), null);
        assert.equal(dom.serializeOverride(7, 'bogus'), null);
        assert.equal(dom.nextOf('pre'), 'day'); assert.equal(dom.prevOf('prep'), 'prep'); assert.equal(dom.nextOf('end'), 'end');
    });
    test('★ jstDate: Intl 無しの実装と同じ日付を返す (5時境界・翌4時59分・翌5時)', () => {
        const ts = ['2026-09-11T04:59:00+09:00', '2026-09-11T05:00:00+09:00', '2026-09-12T04:59:00+09:00',
                    '2026-09-12T05:00:00+09:00', '2026-09-11T23:59:59+09:00', '2026-09-12T00:00:00+09:00', '2026-12-31T23:30:00+09:00'];
        for (const t of ts) {
            const ms = Date.parse(t);
            assert.equal(dom.jstDate(ms), dom.jstDateNoIntl(ms), `Intl とフォールバックがずれた: ${t}`);
        }
        assert.equal(dom.jstDateNoIntl(Date.parse('2026-09-11T04:59:00+09:00')), '2026-09-11');
        assert.equal(dom.jstDateNoIntl(Date.parse('2026-09-10T23:30:00+09:00')), '2026-09-10');
        // raidDayKey: 5時より前は前日のレイド日
        const season = { id: 1, is_active: true, hard_date: '2026-09-11' };
        assert.equal(dom.detect({ season, now: Date.parse('2026-09-11T04:59:00+09:00') }).auto, 'pre');
        assert.equal(dom.detect({ season, now: Date.parse('2026-09-11T05:00:00+09:00') }).auto, 'day');
        assert.equal(dom.detect({ season, now: Date.parse('2026-09-12T04:59:00+09:00') }).auto, 'day');
        assert.equal(dom.detect({ season, now: Date.parse('2026-09-12T05:00:00+09:00') }).auto, 'end');
        // ソースにフォールバックがあること
        const src = _fsStage.readFileSync(_pathStage.join(_ROOTStage, 'js', 'domain', 'opsStage.js'), 'utf8');
        assert.ok(/function jstDate\(now\) \{\s*\n\s*try \{/.test(src), 'Intl を try で囲んでいない');
        assert.ok(/\} catch \{\s*\n\s*return jstDateNoIntl\(now\);/.test(src), 'フォールバックに落ちていない');
    });

    test('★ 未ロードの盤面を 0 と混同しない: チェックリストの「ボス」は pending / ヒーローは「読み込んでいます」', () => {
        const season = { id: 1, is_active: true, hard_date: '2026-09-11' };
        // 前日: bosses null → 0/5 ではなく pending
        const rows = dom.checklist({ stage: 'pre', season, bosses: null, mbRows: null, reservations: null, published: null });
        const b = rows.find(r => r.key === 'bosses');
        assert.equal(b.pending, true, '未ロードのボスを 0/5 として数えている');
        assert.equal(b.value, null);
        const loaded = dom.checklist({ stage: 'pre', season, bosses: [], mbRows: null, reservations: null, published: null }).find(r => r.key === 'bosses');
        assert.equal(loaded.pending, false); assert.equal(loaded.value, 0);
        // 当日: remainingTotal null → 「全員3凸完了」と言わない・終了へ飛ばない
        const h = dom.hero({ stage: 'day', season, rows: [], reservations: null, pendingRepublish: 0, freshMin: null, remainingTotal: null, finPending: null });
        assert.match(h.lead, /読み込んでいます/);
        assert.notEqual(h.action, 'end');
    });

    test('★ 当日のヒーローは終了処理へ飛ばさない (レイド中にシーズンを非アクティブ化できてしまう)', () => {
        const season = { id: 1, is_active: true, hard_date: '2026-09-11' };
        const h = dom.hero({ stage: 'day', season, rows: [], reservations: null, pendingRepublish: 0, freshMin: 3, remainingTotal: 0, finPending: 0 });
        assert.match(h.lead, /全員 3 凸完了/);
        assert.notEqual(h.action, 'end', '当日なのに終了処理へ誘導している');
        assert.match(h.why, /翌日 5 時以降/);
        // 終了の段階では終了へ
        assert.equal(dom.hero({ stage: 'end', season, attacksDone: 60, attackCap: 90 }).action, 'end');
        // index.html 側: 自動判定が当日なら handleOpsEndSeason を止める / 未ロードは null のまま渡す / 配信はこのシーズンだけ
        const html = _fsStage.readFileSync(_pathStage.join(_ROOTStage, 'index.html'), 'utf8');
        const fn = html.match(/async function handleOpsEndSeason\(\) \{[\s\S]{0,900}/)?.[0] || '';
        assert.ok(/if \(stNow && stNow\.auto === 'day'\) \{/.test(fn), '当日の終了を止めていない');
        assert.ok(/レイド当日はシーズンを終了できません/.test(fn));
        assert.ok(/const bosses = snap \? \(snap\.bosses \|\| \[\]\) : null, players = snap \? \(snap\.players \|\| \[\]\) : null;/.test(html), '未ロードを [] に潰している');
        assert.ok(/remainingTotal: players \? Math\.max\(0, attackCap - attacksDone\) : null,/.test(html), '未ロードの残凸を 0 にしている');
        assert.ok(/function _opsPublishedFor\(season\) \{[\s\S]{0,300}Number\(_opsPublishedPlan\.season_id\) === Number\(season\.id\)\);/.test(html), '配信の有無をシーズンで絞っていない');
        assert.ok(/const published = _opsPublishedFor\(season\);/.test(html), '段階のチェックリストがシーズン照合を使っていない');
        assert.ok(/published: _opsPublishedFor\(snap\?\.season \|\| null\),/.test(html), 'コックピットがシーズン照合を使っていない (null をそのまま渡す)');
        // コックピット: 未取得 (null) は「未算出」ではなく「配信を確認中」
        const lay = globalThis.opsLayoutDomain;
        assert.equal(lay.summarize({ season: null, published: null }).summaries.opsSecPlan.text, '配信を確認中');
        assert.equal(lay.summarize({ season: null, published: false }).summaries.opsSecPlan.text, '未算出');
        assert.equal(lay.summarize({ season: null, published: false, planComputed: true }).summaries.opsSecPlan.text, '算出済み (未配信)');
    });

    test('visibleIn: stages の無いカードは全段階 / ある場合はその段階だけ / 空 = どの段階でも「その他」', () => {
        assert.equal(dom.visibleIn({ id: 'x' }, 'pre'), true);
        assert.equal(dom.visibleIn({ id: 'x', stages: ['day'] }, 'pre'), false);
        assert.equal(dom.visibleIn({ id: 'x', stages: ['day'] }, 'day'), true);
        assert.equal(dom.visibleIn({ id: 'x', stages: [] }, 'day'), false);
    });
    test('checklist(前日): ボス設定 / 提出 / 時間帯の確認 / 通知OFF / 予約 / 配信 — 未ロードは pending (0 と混同しない)', () => {
        const bosses = [1, 2, 3, 4, 5].map(n => ({ boss_number: n, attribute: 'fire', weakness: 'water', total_hp_raw: n <= 4 ? 100 : 0 }));
        const mbRows = [
            { mockOk: true, availSupported: true, availConfirmed: true, push: true, reasons: [] },
            { mockOk: false, availSupported: true, availConfirmed: false, push: false, reasons: [{ key: 'mock' }, { key: 'availConfirm' }, { key: 'push' }] },
            { mockOk: true, availSupported: true, availConfirmed: false, push: true, reasons: [{ key: 'availConfirm' }] },
        ];
        const rows = dom.checklist({ stage: 'pre', season, bosses, mbRows, reservations: { pending: 2, approved: 1 }, published: false, pendingRepublish: 0 });
        const by = Object.fromEntries(rows.map(r => [r.key, r]));
        assert.deepEqual(rows.map(r => r.key), ['bosses', 'mock', 'avail', 'push', 'resv', 'publish']);
        assert.equal(by.bosses.value, 4); assert.equal(by.bosses.done, false);
        assert.equal(by.mock.value, 2); assert.equal(by.mock.total, 3); assert.equal(by.mock.nudge, 'mock');
        assert.equal(by.avail.value, 1); assert.equal(by.avail.label, '戦闘可能時間の確認');
        assert.equal(by.push.value, 1); assert.equal(by.push.done, false);
        assert.equal(by.resv.value, '承認待ち 2'); assert.equal(by.resv.done, false);
        assert.equal(by.publish.value, '未'); assert.equal(by.publish.done, false);
        const p = Object.fromEntries(dom.checklist({ stage: 'pre', season, bosses, mbRows: null, reservations: null, published: null }).map(r => [r.key, r]));
        assert.equal(p.mock.pending, true); assert.equal(p.resv.pending, true); assert.equal(p.publish.pending, true);
        const ok = dom.checklist({ stage: 'pre', season, bosses: bosses.map(b => ({ ...b, total_hp_raw: 100 })), mbRows: [mbRows[0]], reservations: { pending: 0 }, published: true });
        assert.ok(ok.every(r => r.done), `残っている: ${ok.filter(r => !r.done).map(r => r.key)}`);
        const rp = dom.checklist({ stage: 'pre', season, bosses, mbRows: [mbRows[0]], reservations: { pending: 0 }, published: true, pendingRepublish: 1 }).find(r => r.key === 'publish');
        assert.equal(rp.done, false); assert.equal(rp.action, 'republish');
        const legacy = dom.checklist({ stage: 'pre', season, bosses, mbRows: [{ mockOk: true, availSupported: false, slots: ['h05'], flex: false, push: true }], reservations: { pending: 0 }, published: true }).find(r => r.key === 'avail');
        assert.equal(legacy.label, '戦闘可能時間の登録'); assert.equal(legacy.value, 1);
        assert.deepEqual(dom.checklist({ stage: 'day' }), []); assert.deepEqual(dom.checklist({ stage: 'prep' }), []);
    });
    test('checklist(終了): バックアップはハード日以降に保存したものだけ「保存済み」 / 終了 / リセットは任意', () => {
        const rows = dom.checklist({ stage: 'end', season, backupSavedAt: '2026-09-10T20:00:00+09:00' });
        assert.equal(rows[0].key, 'backup'); assert.equal(rows[0].done, false, 'ハード日より前の保存を数えている');
        assert.equal(dom.checklist({ stage: 'end', season, backupSavedAt: '2026-09-12T09:00:00+09:00' })[0].done, true);
        assert.equal(rows[1].key, 'end'); assert.equal(rows[2].optional, true);
    });
    test('hero(前日): 承認待ち > 配信後の予約 > 最初の未完 (催促の導線) > 全部済み / 未ロードは読み込み中', () => {
        const rows = dom.checklist({ stage: 'pre', season, bosses: [], mbRows: [{ mockOk: false, availSupported: true, availConfirmed: false, push: true, reasons: [] }], reservations: { pending: 0 }, published: false });
        assert.equal(dom.hero({ stage: 'pre', rows, reservations: { pending: 3 } }).action, 'reserve');
        assert.equal(dom.hero({ stage: 'pre', rows, reservations: { pending: 0 }, pendingRepublish: 1 }).action, 'republish');
        assert.equal(dom.hero({ stage: 'pre', rows, reservations: { pending: 0 } }).action, 'season-edit', 'ボス未設定が最初');
        const m = dom.hero({ stage: 'pre', rows: rows.filter(r => r.key !== 'bosses'), reservations: { pending: 0 } });
        assert.equal(m.action, 'nudge:mock'); assert.match(m.lead, /模擬の提出が残り 1 人/);
        assert.match(dom.hero({ stage: 'pre', rows: rows.map(r => ({ ...r, done: true })), reservations: { pending: 0 } }).lead, /配信済み/);
        assert.equal(dom.hero({ stage: 'pre', rows: [{ key: 'mock', pending: true }], reservations: null }).action, 'members');
    });
    test('hero(当日): HP更新30分以上 > 締め凸未返答 > 承認待ち > 配信後の予約 > 残凸 > 全員完了 / 準備・終了', () => {
        assert.equal(dom.hero({ stage: 'day', freshMin: 38, finPending: 2, remainingTotal: 10 }).action, 'hp');
        assert.equal(dom.hero({ stage: 'day', freshMin: 5, finPending: 2, remainingTotal: 10 }).action, 'members');
        assert.equal(dom.hero({ stage: 'day', freshMin: 5, finPending: 0, reservations: { pending: 1 }, remainingTotal: 10 }).action, 'reserve');
        assert.equal(dom.hero({ stage: 'day', freshMin: 5, finPending: 0, pendingRepublish: 1, remainingTotal: 10 }).action, 'republish');
        const r = dom.hero({ stage: 'day', freshMin: 5, finPending: 0, remainingTotal: 41 });
        assert.equal(r.action, 'remaining'); assert.match(r.lead, /41 凸/);
        // 当日の全員完了は終了へ飛ばさない (Codex指摘 2026-09-08) — 終了は翌日5時以降の「終了」の段階で
        const done = dom.hero({ stage: 'day', freshMin: null, finPending: 0, remainingTotal: 0 });
        assert.match(done.lead, /全員 3 凸完了/); assert.equal(done.action, 'members');
        // 締め凸の返答が未取得 (null) なら残凸0でも「全員完了」と言わない (Codex再監査 2026-09-08)
        const unk = dom.hero({ stage: 'day', freshMin: null, finPending: null, remainingTotal: 0 });
        assert.match(unk.lead, /読み込んでいます/); assert.notEqual(unk.action, 'end');
        assert.equal(dom.hero({ stage: 'prep' }).action, 'create');
        const e = dom.hero({ stage: 'end', attacksDone: 90, attackCap: 96 });
        assert.equal(e.action, 'end'); assert.match(e.lead, /90 凸 \/ 96/);
    });
    test('nudgeTargets: 理由で絞り、通知を購読していて「今回は難しい」でない人だけ', () => {
        const rows = [
            { id: 1, push: true, availUnavailable: false, reasons: [{ key: 'mock' }] },
            { id: 2, push: false, availUnavailable: false, reasons: [{ key: 'mock' }] },
            { id: 3, push: true, availUnavailable: true, reasons: [{ key: 'mock' }, { key: 'availConfirm' }] },
            { id: 4, push: true, availUnavailable: false, reasons: [{ key: 'availConfirm' }] },
            { id: 5, push: true, availUnavailable: false, reasons: [{ key: 'slots' }] },
        ];
        assert.deepEqual(dom.nudgeTargets(rows, 'mock').map(r => r.id), [1]);
        assert.deepEqual(dom.nudgeTargets(rows, 'avail').map(r => r.id), [4, 5]);
        assert.deepEqual(dom.nudgeTargets(rows, 'x'), []);
    });
    test('opsLayout CARDS の段階: 前日=メンバー状況・予約・プラン・Discord / 当日=ボス・残り・締め凸・プラン・運営アクション / 準備・終了=シーズン制御', () => {
        const lay = globalThis.opsLayoutDomain;
        const vis = (s) => lay.CARDS.filter(c => dom.visibleIn(c, s)).map(c => c.id);
        assert.deepEqual(vis('pre'), ['opsSecMembers', 'opsSecReserve', 'opsSecPlan', 'opsSecDiscord']);
        assert.deepEqual(vis('day'), ['opsSecBoss', 'opsSecRemaining', 'opsSecFinish', 'opsSecPlan', 'opsSecActions']);
        assert.deepEqual(vis('prep'), ['opsSecSeason']);
        assert.deepEqual(vis('end'), ['opsSecSeason', 'opsSecGrowth']);
        assert.ok(lay.CARDS.every(c => Array.isArray(c.stages)), 'stages の無いカードがある (全段階に出てしまう)');
    });
    const html = (await import('node:fs')).readFileSync(new URL('../index.html', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
    test('★ 配線: 運営タブは段階で出し分ける (段階ヘッダ・ヒーロー・チェックリスト・その他・設定タブの運営ブロックの移動)', () => {
        assert.ok(html.includes('<script defer src="./js/domain/opsStage.js"></script>'), 'opsStage.js を読み込んでいない');
        const init = html.match(/function _initOpsTabStructure\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/id="opsStageBar"/.test(init) && /id="opsStageHero"/.test(init) && /id="opsStageList"/.test(init), '段階ヘッダ・ヒーロー・チェックリストの置き場が無い');
        assert.ok(/_initOpsEtc\(\);/.test(init) && /_renderOpsStage\(\);/.test(init), '初期化で その他 と段階を描いていない');
        const etc = html.match(/function _initOpsEtc\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/#tab-settings \.dc-card\[data-ops-only\]/.test(etc), '設定タブの運営ブロックを その他 へ移していない');
        assert.ok(/opsMaintBackup/.test(etc) && /opsMaintNotify/.test(etc), '移した運営ブロックに id を付けていない (ジャンプできない)');
        const st = html.match(/function _renderOpsStage\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/dom\.detect\(\{ season, now: Date\.now\(\), override:/.test(html) && /dom\.checklist\(/.test(st) && /dom\.hero\(/.test(st), '判定・チェックリスト・ヒーローをドメインで組んでいない');
        assert.ok(/_applyOpsStageCards\(st\.stage\)/.test(st), '段階でカードを出し入れしていない');
        assert.ok(/if \(!_opsMode\)/.test(st) && /_applyOpsStageCards\(null\)/.test(st), '運営OFF (メンバー) でカードを元の並びに戻していない');
        assert.ok(/\[data-stage\]/.test(st), '[data-stage] の出し分けを段階の描画でやっていない');
        const ck = html.match(/function _renderOpsCockpit\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_renderOpsStage\(\)/.test(ck), 'コックピットの更新と一緒に段階を描き直していない');
        const ph = html.match(/function _opsCardPhase\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_opsCurrentStage\(\)/.test(ph), 'カードの既定 (前日/当日) が段階を見ていない');
        const mp = html.match(/function _mbCurrentPhase\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_opsCurrentStage\(\)/.test(mp), 'メンバー状況の前日/当日が段階を見ていない');
        const stg = html.match(/async function renderSettingsTab\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(!/renderSettingsNotifyStatus\(\)/.test(stg), '設定タブがまだ運営ブロックを描いている');
        const etcOpen = html.match(/function _setOpsEtcOpen\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/renderSettingsNotifyStatus\(\)/.test(etcOpen) && /renderClientGateSettings\(\)/.test(etcOpen), 'その他 を開いたときに運営ブロックを描いていない');
        assert.ok(/onclick="openOpsSeasonCreateModal\(\)" class="dc-ops-action" data-stage="prep"/.test(html), 'シーズン作成が準備段階に限られていない');
        assert.equal((html.match(/handleOpsQuickCreateTestSeason\('(fresh|midraid)'\)" class="dc-ops-testlink" data-stage="prep"/g) || []).length, 2, 'テスト作成が小リンクになっていない');
        assert.ok(/onclick="handleOpsEndSeason\(\)" class="dc-ops-action" data-stage="end"/.test(html) && /onclick="handleOpsResetDamages\(\)" class="dc-ops-action" data-stage="end"/.test(html), '終了・リセットが終了段階に限られていない');
        const ng = html.match(/async function _opsNudgeGroup\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/dom\.nudgeTargets\(_mb\.rows, kind\)/.test(ng) && /showPushPreview\(groups\)/.test(ng), '催促の対象と確認が無い');
        assert.ok(/shirisuko_backup_saved_at_v1/.test(html.match(/async function handleSettingsBackup\(\) \{[\s\S]*?\n        \}\n/)?.[0] || ''), 'バックアップの保存時刻を記憶していない (終了のチェックリストが埋まらない)');
    });
}

// ---- memberStatusDomain (メンバー状況ボード) -----------------------------------
console.log('\nmemberStatusDomain:');
{
    const dom = globalThis.memberStatusDomain;
    const P = (o) => ({ id: 1, name: 'A', damagesByAttr: {}, attacks: [], syncLevel: 0, syncLevelEstimated: true, availableSlots: [], flexTime: false, notifyAllHours: false, strong_attributes: [], ...o });
    test('phaseFor: ハード日当日以降は day、前日までは pre、未設定は pre', () => {
        assert.equal(dom.phaseFor('2026-09-05', new Date(2026, 8, 4, 23, 59)), 'pre');
        assert.equal(dom.phaseFor('2026-09-05', new Date(2026, 8, 5, 0, 0)), 'day');
        assert.equal(dom.phaseFor('2026-09-05', new Date(2026, 8, 7)), 'day');
        assert.equal(dom.phaseFor(null, new Date()), 'pre');
    });
    test('buildRows(前日): 模擬不足・SLv未登録(前回値つき)・時間帯未登録・通知購読なし を理由に積む / 揃っていれば todo=false', () => {
        const players = [
            P({ id: 1, name: '未完', damagesByAttr: { fire: 10, water: 5 }, syncLevel: 558, syncLevelEstimated: false }),
            P({ id: 2, name: '完了', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, availableSlots: ['h21', 'h22'] }),
            P({ id: 3, name: '隙間', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, flexTime: true }),
        ];
        const extras = { pushPlayerIds: [2, 3], slvThisSeasonIds: [2, 3], finishRequests: [], proxyEvents: [],
            availConfirmations: [2, 3].map(id => ({ player_id: id })) };   // 1 は今期未確認のまま
        const rows = dom.buildRows({ players, extras, phase: 'pre' });
        const r1 = rows.find(r => r.id === 1);
        // 時間帯そのものが未登録なら「今期未確認」は積まない (未登録の方が具体的)
        assert.deepEqual(r1.reasons.map(r => r.key), ['mock', 'slv', 'slots', 'push']);
        assert.equal(r1.reasons[0].label, '模擬 被りなし2/3');
        assert.equal(r1.mockUsable, 2); assert.equal(r1.mockOk, false);
        assert.deepEqual(r1.missingAttrs, ['electric', 'iron', 'wind']);
        assert.equal(r1.reasons[1].label, 'SLv未登録 (前回 558)');
        assert.equal(r1.slvNow, null); assert.equal(r1.slvPrev, 558);
        assert.equal(rows.find(r => r.id === 2).todo, false);
        assert.equal(rows.find(r => r.id === 3).todo, false, '⏳隙間型は時間帯未登録にしない');
        assert.equal(rows.find(r => r.id === 2).slvNow, 600);
    });
    test('模擬の必要範囲は「キャラ被りなしで3属性」— 3属性でOK / 5属性でも被りで2しか回せなければ要対応 / 編成未記録は両立扱い', () => {
        const T = (chars) => chars;
        const okThree = P({ id: 1, damagesByAttr: { fire: 1, water: 1, wind: 1 }, teamsByAttr: { fire: T(['a', 'b']), water: T(['c', 'd']), wind: T(['e']) }, syncLevel: 600, syncLevelEstimated: false, flexTime: true });
        const fiveButOverlap = P({ id: 2, damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, teamsByAttr: { fire: ['X', 'a'], water: ['X', 'b'], electric: ['X', 'c'], iron: ['Y', 'd'], wind: ['Y', 'e'] }, syncLevel: 600, syncLevelEstimated: false, flexTime: true });
        const noTeams = P({ id: 3, damagesByAttr: { fire: 1, water: 1, wind: 1 }, teamsByAttr: {}, syncLevel: 600, syncLevelEstimated: false, flexTime: true });
        // availConfirmations = 今期の戦闘可能時間を確認済み (37)。無いと全員「今期未確認」で要対応になる
        const ex = { pushPlayerIds: [1, 2, 3], slvThisSeasonIds: [1, 2, 3],
            availConfirmations: [1, 2, 3].map(id => ({ player_id: id })) };
        const rows = dom.buildRows({ players: [okThree, fiveButOverlap, noTeams], extras: ex, phase: 'pre' });
        assert.equal(rows[0].mockOk, true); assert.equal(rows[0].todo, false, '被りなし3属性なら5属性でなくても完了');
        assert.equal(rows[1].mockUsable, 2); assert.equal(rows[1].mockOk, false);
        assert.match(rows[1].reasons[0].label, /被りなし2\/3 \(提出5属性・キャラ被り\)/);
        assert.equal(rows[2].mockOk, true, '編成未記録は被り判定できないので両立扱い');
        assert.equal(dom.maxDisjointAttrs(['fire', 'water'], null, { fire: ['ラピ：レッドフード'], water: ['ラピ:レッドフード'] }), 1, '全角/半角コロンの表記ゆれも同一キャラ (NFKC)');
        assert.equal(dom.maxDisjointAttrs(['fire', 'water'], null, { fire: ['ラ ピ'], water: ['ラピ'] }), 2, '内部空白は既存の charKey と同じく別キャラ扱い (独自に潰さない)');
        // slot1 同士は被るが slot2 なら回せる → 全編成を見て OK にする (代表編成だけだと偽陰性)
        const lo = {
            fire: [{ team: ['X', 'a'] }, { team: ['p', 'q'] }],
            water: [{ team: ['X', 'b'] }],
            wind: [{ team: ['X', 'c'] }, { team: ['r', 's'] }],
        };
        assert.equal(dom.maxDisjointAttrs(['fire', 'water', 'wind'], lo, { fire: ['X', 'a'], water: ['X', 'b'], wind: ['X', 'c'] }), 3);
        assert.equal(dom.maxDisjointAttrs(['fire', 'water', 'wind'], null, { fire: ['X', 'a'], water: ['X', 'b'], wind: ['X', 'c'] }), 1, '代表編成だけなら 1');
        // slot1 が被り・slot2 が未記録 (team 空) → 判定できないのでワイルドカード = OK 側に倒す
        const loUnknown = { fire: [{ team: ['X', 'a'] }, { team: [] }], water: [{ team: ['X', 'b'] }], wind: [{ team: ['X', 'c'] }, { team: [] }] };
        assert.equal(dom.maxDisjointAttrs(['fire', 'water', 'wind'], loUnknown, {}), 3, '未記録の slot はワイルドカード');
        const twoLoadouts = P({ id: 4, damagesByAttr: { fire: 1, water: 1, wind: 1 }, loadoutsByAttr: lo, teamsByAttr: { fire: ['X', 'a'], water: ['X', 'b'], wind: ['X', 'c'] }, syncLevel: 600, syncLevelEstimated: false, flexTime: true });
        assert.equal(dom.buildRows({ players: [twoLoadouts], extras: { pushPlayerIds: [4], slvThisSeasonIds: [4] }, phase: 'pre' })[0].mockOk, true, 'buildRows は loadoutsByAttr を優先して判定する');
        const s = Object.fromEntries(dom.summarize(rows, 'pre').map(x => [x.key, x]));
        assert.equal(s.mock.value, 2); assert.equal(s.mock.sub, '5属性 1');
        const m = dom.nudgeMessage(rows[1], 'pre');
        assert.match(m.body, /キャラ被りなしで3属性必要・あと1属性/);
    });
    test('★ 戦闘可能時間は 未登録 / 今期未確認 / 確認済み の3状態を区別する', () => {
        // 第44回の実害: availability は無期限のプロフィール設定なので、前月のまま残っている人が
        // 「登録済み」に見えて、当日いないのに候補へ出る。今期確認したかを別に持つ (37)
        const base = { damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false };
        const players = [
            P({ id: 1, name: '未登録', ...base, availableSlots: [] }),
            P({ id: 2, name: '登録あり未確認', ...base, availableSlots: ['h21'] }),
            P({ id: 3, name: '確認済み', ...base, availableSlots: ['h21'] }),
            P({ id: 4, name: '今回は難しい', ...base, availableSlots: [] }),
            P({ id: 5, name: '確認後に変更', ...base, availableSlots: ['h21', 'h22', 'h23'] }),
        ];
        const extras = {
            pushPlayerIds: [1, 2, 3, 4, 5], slvThisSeasonIds: [1, 2, 3, 4, 5],
            availConfirmations: [
                { player_id: 3, slot_count: 1 },
                { player_id: 4, unavailable: true },
                { player_id: 5, slot_count: 1 },            // 確認時は1枠 → いま3枠
            ],
        };
        const rows = dom.buildRows({ players, extras, phase: 'pre' });
        const keysOf = (id) => rows.find(r => r.id === id).reasons.map(r => r.key);
        assert.deepEqual(keysOf(1), ['slots'], '未登録は従来どおり「時間帯未登録」だけ');
        assert.deepEqual(keysOf(2), ['availConfirm'], '登録はあるが今期未確認');
        assert.deepEqual(keysOf(3), [], '確認済みなら要対応なし');
        assert.deepEqual(keysOf(4), [], '★「今回は難しい」は確認済み扱い (分かっている方が良い状態)');
        assert.deepEqual(keysOf(5), ['availChanged'], '確認後に枠数が変わったら知らせる');
        assert.equal(rows.find(r => r.id === 5).reasons[0].label, '時間帯を確認後に変更 (1→3枠)');
        // ★ 枠数が同じでも中身が違えば検出する (h21 で確認 → h22 に付け替え)
        const swapped = dom.buildRows({
            players: [P({ id: 6, name: '付け替え', ...base, availableSlots: ['h22'] })],
            extras: { pushPlayerIds: [6], slvThisSeasonIds: [6],
                availConfirmations: [{ player_id: 6, slot_count: 1, slots_snapshot: ['h21'] }] },
            phase: 'pre',
        });
        assert.deepEqual(swapped[0].reasons.map(r => r.key), ['availChanged'],
            '枠数が同じでも中身が変われば知らせる (slots_snapshot があるとき)');
        assert.match(swapped[0].reasons[0].label, /中身が変化/);
        // スナップショットが無い旧行は従来どおり枠数で見る (同数なら検出しない)
        const legacy = dom.buildRows({
            players: [P({ id: 7, name: '旧行', ...base, availableSlots: ['h22'] })],
            extras: { pushPlayerIds: [7], slvThisSeasonIds: [7], availConfirmations: [{ player_id: 7, slot_count: 1 }] },
            phase: 'pre',
        });
        assert.deepEqual(legacy[0].reasons, [], '旧行は枠数一致なら確認済みのまま');
        // 集計にも「今期確認」の欄が出る
        const sum = dom.summarize(rows, 'pre');
        const ac = sum.find(x => x.key === 'availConfirm');
        assert.ok(ac, '集計に availConfirm がある');
        assert.equal(ac.value, 3, '確認済みは3人 (id 3,4,5)');
        assert.equal(ac.total, 5);
    });

    test('★ 未確認だけの人には「確認のお願い」を送る (未登録の文面と分ける)', () => {
        const base = { damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false };
        const rows = dom.buildRows({
            players: [P({ id: 2, name: '未確認', ...base, availableSlots: ['h21'] })],
            // ★ availConfirmations: [] = 37適用済みで誰も確認していない (省略は「機能未適用」になる)
            extras: { pushPlayerIds: [2], slvThisSeasonIds: [2], availConfirmations: [] }, phase: 'pre',
        });
        const msg = dom.nudgeMessage(rows[0], 'pre');
        assert.ok(msg, '催促の文面が出る');
        assert.match(msg.title, /確認/);
        assert.doesNotMatch(msg.body, /未登録/, '未登録ではないので「未登録です」と言わない');
    });

    test('★ 「今回は難しい」人には催促を送らない (出られない人に督促しない)', () => {
        // 模擬もSLvも足りていない = 本来なら催促対象。だが本人は今期「難しい」と申告済み
        const rows = dom.buildRows({
            players: [P({ id: 2, name: '不参加', damagesByAttr: { fire: 1 }, availableSlots: [] })],
            extras: { pushPlayerIds: [2], availConfirmations: [{ player_id: 2, unavailable: true }] }, phase: 'pre',
        });
        assert.equal(rows[0].availUnavailable, true);
        assert.ok(rows[0].reasons.some(r => r.key === 'mock'), '要対応の理由自体は残す (運営には見せる)');
        assert.equal(dom.nudgeMessage(rows[0], 'pre'), null, 'Push催促は作らない');
        // 当日も同じ
        assert.equal(dom.nudgeMessage(dom.buildRows({
            players: [P({ id: 2, damagesByAttr: { fire: 1 } })],
            extras: { pushPlayerIds: [2], availConfirmations: [{ player_id: 2, unavailable: true }] }, phase: 'day',
        })[0], 'day'), null);
    });

    test('★ 37未適用 (availConfirmations が無い) では確認の理由も集計欄も出さない', () => {
        const base = { damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false };
        const mk = (extras) => dom.buildRows({
            players: [P({ id: 2, name: '未確認', ...base, availableSlots: ['h21'] })],
            extras: { pushPlayerIds: [2], slvThisSeasonIds: [2], ...extras }, phase: 'pre',
        });
        const [off] = mk({});                        // 列/テーブルごと無い = null 相当 (未指定)
        const [offNull] = mk({ availConfirmations: null });
        const [on] = mk({ availConfirmations: [] }); // 適用済みで未確認
        assert.equal(off.availSupported, false);
        assert.equal(offNull.availSupported, false);
        assert.equal(on.availSupported, true);
        assert.ok(!off.reasons.some(r => r.key === 'availConfirm'), '未適用環境で「今期未確認」を積まない');
        assert.equal(dom.nudgeMessage(off, 'pre'), null, '実行できない確認の催促を送らない');
        assert.ok(on.reasons.some(r => r.key === 'availConfirm'), '適用済みなら従来どおり積む');
        const keys = (rows) => dom.summarize(rows, 'pre').map(x => x.key);
        assert.ok(!keys([off]).includes('availConfirm'), '未適用環境では集計欄ごと出さない (0/30 は誤解を招く)');
        assert.ok(keys([on]).includes('availConfirm'));
    });

    test('buildRows(当日): 凸残・締め凸未返答が先頭に来る / 代理は activity_log から数える / 推定SLvは未登録扱い', () => {
        const players = [P({ id: 1, name: 'A', attacks: [{ level: 1, boss_number: 2 }, { level: 2, boss_number: 3 }], syncLevel: 500, syncLevelEstimated: true, availableSlots: ['h20'] })];
        const extras = { pushPlayerIds: [1], slvThisSeasonIds: [1], finishRequests: [{ player_id: 1, status: 'pending' }], proxyEvents: [{ player_id: 1 }, { player_id: 1 }],
            availConfirmations: [{ player_id: 1 }] };
        const [r] = dom.buildRows({ players, extras, phase: 'day' });
        assert.deepEqual(r.reasons.map(x => x.key), ['attacks', 'finish', 'mock', 'slv'], '当日の理由順 (凸→締め凸→模擬→SLv。時間帯・通知は満たしている)');
        assert.equal(r.reasons[0].label, '凸 残1');
        assert.equal(r.atkCount, 2); assert.equal(r.proxyCount, 2);
        assert.equal(r.slvNow, null, '推定SLv (syncLevelEstimated) は登録扱いにしない');
        assert.ok(r.reasons.some(x => x.key === 'slv'));
        const [r0] = dom.buildRows({ players: [P({ id: 1, syncLevel: 0, syncLevelEstimated: false })], extras: { slvThisSeasonIds: [1] }, phase: 'pre' });
        assert.equal(r0.slvNow, null, '今期行があっても sync_level=0 は未登録扱い');
        const [r2] = dom.buildRows({ players, extras: { ...extras, finishRequests: [{ player_id: 1, status: 'accepted' }, { player_id: 1, status: 'pending' }] }, phase: 'day' });
        assert.equal(r2.finish, 'pending', 'pending が1件でもあれば未返答');
    });
    test('summarize / sortRows / nudgeMessage', () => {
        const players = [
            P({ id: 1, name: 'い', damagesByAttr: { fire: 1 } }),
            P({ id: 2, name: 'あ', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, availableSlots: ['h21'] }),
        ];
        const extras = { pushPlayerIds: [2], slvThisSeasonIds: [2] };
        const rows = dom.buildRows({ players, extras, phase: 'pre' });
        const s = Object.fromEntries(dom.summarize(rows, 'pre').map(x => [x.key, x]));
        assert.equal(s.mock.value, 1); assert.equal(s.mock.total, 2); assert.equal(s.mock.bad, true);
        assert.equal(s.push.value, 1);
        assert.deepEqual(dom.sortRows(rows, 'why').map(r => r.name), ['い', 'あ'], '要対応が多い順');
        assert.deepEqual(dom.sortRows(rows, 'name').map(r => r.name), ['あ', 'い']);
        assert.equal(dom.nudgeMessage(rows.find(r => r.id === 1), 'pre'), null, '通知未購読には文面を作らない');
        const m = dom.nudgeMessage({ ...rows.find(r => r.id === 1), push: true }, 'pre');
        assert.match(m.body, /模擬戦データ \(キャラ被りなしで3属性必要・あと2属性: 水冷・電撃・鉄甲・風圧\)/);
        assert.match(m.body, /シンクロレベル/);
        const d = dom.nudgeMessage({ ...rows.find(r => r.id === 1), push: true, reasons: [{ key: 'attacks' }], atkCount: 1 }, 'day');
        assert.match(d.title, /凸報告/); assert.match(d.body, /残り2件/);
    });
}

// ---- charMasterDomain (手動登録の二者確認) -------------------------------------
console.log('\ncharMasterDomain:');
{
    const dom = globalThis.charMasterDomain;
    const H = 3600 * 1000;
    const t0 = Date.parse('2026-08-31T00:00:00Z');
    test('verificationState: 確定 / 要確認 (registered_by あり) / 未確定 (OCR由来) を区別する', () => {
        assert.equal(dom.verificationState({ is_confirmed: true }).kind, 'verified');
        assert.equal(dom.verificationState({ is_confirmed: true, verified_by: 'ねむねこ' }).label, '✅確定 (ねむねこ)');
        assert.equal(dom.verificationState({ is_confirmed: false, registered_by: 'ふるり' }).kind, 'needs_review');
        assert.equal(dom.verificationState({ is_confirmed: false }).kind, 'unconfirmed');
        assert.equal(dom.verificationState(null).kind, 'unconfirmed');
    });
    test('canVerify: 別の運営は即可 / 本人は24時間未満で不可・以後は可 / 確認者不明は不可', () => {
        assert.equal(dom.canVerify({ registeredBy: 'ふるり', registeredAt: t0, actorName: 'ねむねこ', now: t0 + H }).ok, true);
        const self1 = dom.canVerify({ registeredBy: 'ふるり', registeredAt: t0, actorName: 'ふるり', now: t0 + 23 * H });
        assert.equal(self1.ok, false); assert.match(self1.reason, /本人/);
        const self2 = dom.canVerify({ registeredBy: 'ふるり', registeredAt: t0, actorName: 'ふるり', now: t0 + 24 * H });
        assert.equal(self2.ok, true); assert.equal(self2.selfVerify, true);
        assert.equal(dom.canVerify({ registeredBy: 'ふるり', registeredAt: t0, actorName: '', now: t0 + 48 * H }).ok, false);
        assert.equal(dom.canVerify({ registeredBy: null, actorName: 'ふるり' }).ok, true, '登録者不明 (34未適用) は別人扱いで可');
    });
    test('canVerify: 名前の表記ゆれ (空白・全角) は同一人物とみなす / 登録日時不明の本人は不可', () => {
        assert.equal(dom.canVerify({ registeredBy: 'ふる り', registeredAt: t0, actorName: 'ふるり', now: t0 + H }).ok, false);
        assert.equal(dom.canVerify({ registeredBy: 'ふるり', registeredAt: null, actorName: 'ふるり', now: t0 + 100 * H }).ok, false);
    });
    test('isValidSourceUrl: http(s) の絶対URLのみ', () => {
        assert.equal(dom.isValidSourceUrl('https://game8.jp/nikke/492115'), true);
        assert.equal(dom.isValidSourceUrl('game8.jp/nikke/492115'), false);
        assert.equal(dom.isValidSourceUrl('https://x y'), false);
        assert.equal(dom.isValidSourceUrl(''), false);
    });
}

// ---- バックアップ整合 (静的) ------------------------------------------------
// 「テーブルを作ったのにバックアップ/復元に足し忘れる」を仕組みで止める。
// 2026-08-31: activity_log / finish_requests / raid_event_notices の3表が漏れていた
// (復元しても監査ログ・締め凸依頼・通知の二重送信よけが巻き戻らない) のを機に追加。
{
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    // fileURLToPath を通す: 日本語フォルダ名 (自宅 Mac の しりすこPAD) は URL の pathname だと
    // %E3%81%97… にエンコードされたままで ENOENT になる (2026-08-31 pull 直後に発覚)。他テストと同じ方式
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const client = fs.readFileSync(path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
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
        const src = fs.readFileSync(path.join(sqlDir, f), 'utf8').replace(/\r\n/g, '\n');
        for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
            created.add(m[1]);
            if (/\bid\s+BIGSERIAL\b/.test(m[2])) serialTables.add(m[1]);
        }
    }
    const helpers = fs.readFileSync(path.join(sqlDir, '23_restore_helpers.sql'), 'utf8').replace(/\r\n/g, '\n');

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

// ---- 運営による模擬提出の除外 (35_player_damages_exclusion.sql) ------------------
console.log('\nmockExclusionDomain (運営除外):');
{
    const ex = globalThis.mockExclusionDomain;
    test('isExcluded: excluded_at がある行だけ true (null / undefined / 空文字 / 行なしは false)', () => {
        assert.equal(ex.isExcluded({ excluded_at: '2026-09-05T01:00:00.000Z' }), true);
        assert.equal(ex.isExcluded({ excluded_at: null }), false);
        assert.equal(ex.isExcluded({}), false);
        assert.equal(ex.isExcluded({ excluded_at: '' }), false);
        assert.equal(ex.isExcluded(null), false);
    });
    test('splitExcluded: 使える行と除外行に分ける (順序維持・配列以外は空)', () => {
        const rows = [{ id: 1 }, { id: 2, excluded_at: 'x' }, { id: 3, excluded_at: null }];
        const r = ex.splitExcluded(rows);
        assert.deepEqual(r.usable.map(x => x.id), [1, 3]);
        assert.deepEqual(r.excluded.map(x => x.id), [2]);
        assert.deepEqual(ex.splitExcluded(null), { usable: [], excluded: [] });
    });
    test('exclusionPatch: 除外は excluded_at(ISO) + by + 理由 (空白正規化・80字上限)、解除は3列とも null', () => {
        const now = new Date('2026-09-05T03:04:05.000Z');
        const p = ex.exclusionPatch({ excluded: true, by: ' ふるり ', reason: '  桁が\n違う   可能性 ', now });
        assert.deepEqual(p, { excluded_at: '2026-09-05T03:04:05.000Z', excluded_by: 'ふるり', excluded_reason: '桁が 違う 可能性' });
        const long = ex.exclusionPatch({ excluded: true, reason: 'あ'.repeat(200), now });
        assert.equal(long.excluded_reason.length, ex.REASON_MAX);
        assert.equal(long.excluded_by, '運営', '運営名が空なら「運営」');
        assert.equal(ex.exclusionPatch({ excluded: true, reason: '   ', now }).excluded_reason, null, '空理由は null');
        assert.deepEqual(ex.exclusionPatch({ excluded: false, reason: 'x', by: 'y' }), { excluded_at: null, excluded_by: null, excluded_reason: null });
        assert.deepEqual(ex.clearPatch(), { excluded_at: null, excluded_by: null, excluded_reason: null });
    });
    test('exclusionLabel: 理由・運営名・時刻が入る / 通常行は空文字', () => {
        const row = { excluded_at: '2026-09-05T01:02:00.000Z', excluded_by: 'ふるり', excluded_reason: '桁違い' };
        const s = ex.exclusionLabel(row);
        assert.ok(s.startsWith('運営が除外 (桁違い) — ふるり '), s);
        assert.match(s, /\d{1,2}\/\d{1,2} \d{2}:\d{2}$/, s);
        assert.ok(ex.exclusionLabel({ excluded_at: '2026-09-05T01:02:00.000Z' }).startsWith('運営が除外 — '), '理由も運営名も無いときは時刻だけ');
        assert.equal(ex.exclusionLabel({}), '');
    });
    test('stripExclusion: 3列だけ落として他は保持 (35未適用フォールバック用)', () => {
        const r = ex.stripExclusion({ player_id: 1, slot: 2, excluded_at: 'x', excluded_by: 'y', excluded_reason: 'z' });
        assert.deepEqual(r, { player_id: 1, slot: 2 });
    });
}

console.log('\n運営除外の配線 (ソース突合):');
{
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
    const client = read('js', 'supabase-client.js');
    const html = read('index.html');
    const check = read('supabase', '99_check_applied.sql');
    // 盤面 (ソルバー・締め凸・残凸表・事前比較・メンバー状況) の唯一の入口で除外行を外す。
    // ここが崩れると「運営が除外したのにプランに使われる」= 今回の改修の目的そのものが壊れる
    test('盤面ローダは excluded_* を最優先 select で読み、除外行を盤面から外して excludedByAttr に別立てする', () => {
        assert.ok(client.includes("['player_id, attribute, damage_b, updated_at, characters, slot, boss_level, levels, excluded_at, excluded_by, excluded_reason', ['player_id', 'attribute', 'slot']]"));
        assert.ok(client.includes('excludedByAttr: excludedByPlayer.get(p.id) || {}'));
        assert.match(client, /exDom \? exDom\.isExcluded\(d\) : d\.excluded_at != null/);
    });
    test('35 の部分適用 (excluded_at だけ) でも除外行が盤面・本人画面・スナップショットから漏れない中間 select がある', () => {
        // 3列版 → excluded_at 単独版 → 無し の順 (Codex指摘 2026-09-05: 中間段が無いと部分適用で除外がプランに漏れる)
        const order = (full, mid, none) => {
            const i = client.indexOf(full), j = client.indexOf(mid), k = client.indexOf(none, j + 1);
            assert.ok(i >= 0 && j > i && k > j, `select の段順が崩れている: full=${i} mid=${j} none=${k}`);
        };
        order("['player_id, attribute, damage_b, updated_at, characters, slot, boss_level, levels, excluded_at, excluded_by, excluded_reason'",
              "['player_id, attribute, damage_b, updated_at, characters, slot, boss_level, levels, excluded_at'",
              "['player_id, attribute, damage_b, updated_at, characters, slot, boss_level, levels'");
        order("'attribute, damage_b, updated_at, characters, slot, boss_level, levels, excluded_at, excluded_by, excluded_reason'",
              "'attribute, damage_b, updated_at, characters, slot, boss_level, levels, excluded_at'",
              "'attribute, damage_b, updated_at, characters, slot, boss_level, levels'");
        order("'player_id, attribute, damage_b, characters, slot, boss_level, levels, excluded_at, excluded_by, excluded_reason'",
              "'player_id, attribute, damage_b, characters, slot, boss_level, levels, excluded_at'",
              "'player_id, attribute, damage_b, characters, slot, boss_level, levels'");
        // SQL 側も 1 つの ALTER で 3 列 (部分適用状態を作らない)
        const sql = read('supabase', '35_player_damages_exclusion.sql');
        assert.equal((sql.match(/ALTER TABLE player_damages/g) || []).length, 1, '35 は ALTER TABLE 1 文で 3 列を足す');
        assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS excluded_/g) || []).length, 3);
        assert.match(sql, /SET lock_timeout/);
    });
    test('_selectUsableDamages (提出状況・人気編成・活動) も除外行を落とす', () => {
        const body = client.match(/async function _selectUsableDamages[\s\S]*?\n}\n/)?.[0] || '';
        assert.ok(body.includes('excluded_at'), body);
        assert.ok(/isExcluded\(d\)/.test(body));
        assert.ok(/_isMissingColumnErr\(r\.error, 'excluded_at'\)/.test(body), '列欠損の判定は _isMissingColumnErr');
    });
    test('本人の保存し直し (提出・単値保存・測定削除) は除外解除 payload を含む', () => {
        const n = (client.match(/\.\.\._exclusionClear\(\)/g) || []).length;
        assert.ok(n >= 5, `_exclusionClear() の使用箇所が ${n} (期待 5 以上: 単値保存3経路 + 提出 + 測定削除)`);
        assert.ok(/window\.supabaseSaveMockSubmission[\s\S]*?const basePayload = \{[\s\S]*?_exclusionClear\(\)/.test(client));
    });
    test('_upsertPlayerDamages は 35 未適用で excluded_* を落として再試行し、旧形式にも持ち込まない (判定は _isMissingColumnErr)', () => {
        const body = client.match(/async function _upsertPlayerDamages[\s\S]*?\n}\n/)?.[0] || '';
        assert.ok(/\['excluded_at', 'excluded_by', 'excluded_reason'\]\.some\(c => _isMissingColumnErr\(res\.error, c\)\)/.test(body));
        assert.ok(!/\/excluded_\/i/.test(body), '文言の緩い正規表現で列欠損を判定しない (列欠損以外のエラーを隠す)');
        assert.ok(/const legacy = rows2\.map\(\(\{ slot, boss_level, levels, excluded_at, excluded_by, excluded_reason, \.\.\.rest \}\) => rest\)/.test(body));
    });
    test('supabaseSetMockExclusion は 35 未適用を SQL の適用案内に変換する', () => {
        assert.ok(/window\.supabaseSetMockExclusion = async function/.test(client));
        assert.ok(client.includes('supabase/35_player_damages_exclusion.sql'));
    });
    test('index.html: mockExclusion.js を読み込み、残凸表の 🧹整理 と除外/解除ハンドラ・本人向け表示がある', () => {
        assert.ok(html.includes('<script defer src="./js/domain/mockExclusion.js"></script>'));
        assert.ok(html.includes('id="opsRemTidyBtn"'));
        for (const fn of ['handleOpsRemainingTidyToggle', 'handleOpsRemExclude', 'handleOpsRemUnexclude']) {
            assert.ok(new RegExp(`function ${fn}\\(`).test(html), `${fn} が無い`);
        }
        assert.ok(html.includes('⚠ 運営除外'), '本人の模擬パネルに除外バッジ');
        assert.ok(html.includes('id="myTeamEditExclNote"'), '編成編集モーダルに除外の案内');
        assert.ok(/mock_exclude:\s*\{/.test(html), '設定タブのログ種別');
    });
    test('★ 予約テスト (序盤): testScenario=fresh は凸をシードしない / 中盤は従来どおり', () => {
        // 凸をシードすると HP の小さいテストボスは撃破済みになり「未凸の状態で予約を組む」体験ができない
        const core = client.match(/window\.supabaseCreateSeason = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(core, 'シーズン作成の本体が見つからない');
        assert.ok(/if \(payload\.testScenario !== 'fresh'\) \{[\s\S]{0,200}supabaseSeedTestMockAttacks\(/.test(core),
            '序盤シナリオで凸のシードを飛ばしていない');
        assert.ok(/testScenario: isTest \? \(payload\.testScenario \|\| 'midraid'\) : null/.test(core));
        const quick = client.match(/window\.supabaseQuickCreateTestSeason = async function \(opts = \{\}\)[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(quick, 'クイックテストがシナリオを受け取っていない');
        assert.ok(/const testScenario = opts\.scenario === 'fresh' \? 'fresh' : 'midraid';/.test(quick), '既定が中盤でない (従来の挙動が変わる)');
        assert.ok(/return window\.supabaseCreateSeason\(\{\s*\n\s*testScenario,/.test(quick), '本体へ渡していない');
        // 運営画面に2つの入口
        assert.ok(/handleOpsQuickCreateTestSeason\('fresh'\)/.test(html), '序盤のボタンが無い');
        assert.ok(/handleOpsQuickCreateTestSeason\('midraid'\)/.test(html), '中盤のボタンが無い');
        assert.ok(/await window\.supabaseQuickCreateTestSeason\(\{ scenario \}\)/.test(html), 'シナリオを渡していない');
    });
    test('99_check_applied.sql に 35 の判定行がある', () => {
        assert.ok(check.includes("'35_player_damages_exclusion'"));
    });

    // ---- 37: 今期の戦闘可能時間の確認 ------------------------------------------
    test('★ supabaseLoadAvailabilityConfirmations は未適用環境で null を返す ([] にしない)', () => {
        const body = client.match(/window\.supabaseLoadAvailabilityConfirmations = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(body, '関数が見つからない');
        // ★ [] を返すと「37適用済みで全員が未確認」と区別がつかず、実行できない確認の催促を送る
        assert.ok(/catch\s*\{\s*return null;/.test(body), '通信/テーブル欠損の catch は null を返すこと');
        assert.ok(!/catch\s*\{\s*return \[\];/.test(body), '未適用を空配列に潰さない');
        // slots_snapshot だけ未適用のときは列を落として読み直す (テーブルはあるので null にしない)
        assert.ok(/_isMissingColumnErr\(error, 'slots_snapshot'\)/.test(body));
    });
    test('★ 盤面ローダーは 37未適用でも誰も除外しない / 「難しい」人は全経路から外す', () => {
        // 37未適用 (テーブルごと無い) のときだけ除外なしで進む。判定は上の別テストで固定
        assert.ok(/supabase\/37 が未適用のため/.test(client), '未適用時の警告が無い');
        // 時間帯を空にするだけでは「いつでも可」に化けるので、flexTime も落とし印も立てる
        assert.ok(/unavailableThisSeason: unavailableIds\.has\(Number\(p\.id\)\)/.test(client));
        assert.ok(/flexTime: unavailableIds\.has\(Number\(p\.id\)\) \? false :/.test(client));
        for (const f of ['js/optimal-plan.js', 'index.html']) {
            const src = read(...f.split('/'));
            assert.ok(src.includes('!p.unavailableThisSeason'), `${f} で除外していない`);
        }
    });
    test('99_check_applied.sql に 36 / 37 の判定行がある', () => {
        assert.ok(check.includes("'36_finish_requests_level'"));
        assert.ok(check.includes("'37_availability_confirmations'"));
        assert.ok(check.includes('slots_snapshot'), '37 は追補の列まで見ること');
    });
    // 保存キューの**振る舞い**は tests/avail-save.mjs が実行して確かめる
    // (ソース文字列の検査は「実際に前の保存を待っているか」を保証しない — Codex指摘 2026-09-07)。
    // ここでは静的にしか見えないものだけ残す
    test('戦闘可能時間: デバウンスは引数なしで _availDoSave を呼ぶ', () => {
        // setTimeout(_availDoSave, 250) だと第2引数の遅延時間が opts に渡り、opts.rethrow が
        // undefined になるだけでなく将来のオプション追加で誤動作する
        assert.ok(!/setTimeout\(_availDoSave,/.test(html));
        assert.ok(/setTimeout\(\(\) => _availDoSave\(\), \d+\)/.test(html));
    });
    test('★ 37未適用は「未確認」と区別する (unsupported センチネル)', () => {
        const body = client.match(/window\.supabaseLoadMyAvailabilityConfirmation = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(body, '関数が見つからない');
        assert.ok(/_isMissingTableErr\(error, 'availability_confirmations'\)/.test(body), 'テーブル欠損だけを未適用と判定すること');
        assert.ok(/return \{ unsupported: true \}/.test(body));
        assert.ok(!/\} catch \{ return null; \}/.test(body), '通信断まで「未確認」に潰さない');
        // 画面側: 未適用なら確認UIごと出さない (押すと SQL 適用エラーになるだけ)。
        // シーズンが無いときも同じ扱い ("アクティブなシーズンがありません" で失敗するだけ)
        assert.ok(/if \(c && \(c\.unsupported \|\| c\.noSeason\)\) \{ el\.style\.display = 'none'; return; \}/.test(html), 'バッジを隠していない');
        assert.ok(/if \(c && \(c\.unsupported \|\| c\.noSeason\)\) \{ box\.style\.display = 'none'; box\.innerHTML = ''; return; \}/.test(html), '確認ブロックを隠していない');
    });
    test('★ シーズンが無くなったら確認UIを描き直す (前シーズンの「確認済み」を残さない)', () => {
        const fn = html.match(/async function _loadMyAvailConfirm\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_myAvailConfirm = \{ noSeason: true \};/.test(fn), 'シーズン無しの状態を持っていない');
        // ★ 何も描かずに return すると、状態は null なのに画面は前シーズンの「確認済み」のまま残り、
        //   押すと「アクティブなシーズンがありません」で失敗する (Codex指摘 2026-09-07)
        assert.ok(/_myAvailConfirm = \{ noSeason: true \};\s*\n\s*_renderMyAvailConfirm\(\);\s*\n\s*return;/.test(fn),
            'シーズン無しで描き直さずに return している');
    });
    test('★ 盤面ローダーは「今回は難しい」の取得失敗を握り潰さない', () => {
        // 握り潰すと通信断・RLS の失敗が「誰も難しいと言っていない」と同じ結果になり、
        // 申告した本人がプラン・締め凸候補に戻ってくる (Codex指摘 2026-09-07)
        assert.ok(/if \(uErr && !_isMissingTableErr\(uErr, 'availability_confirmations'\)\) throw uErr;/.test(client));
        assert.ok(/function _isMissingTableErr\(error, table\)/.test(client), 'テーブル欠損の判定ヘルパーが無い');
        const helper = client.match(/function _isMissingTableErr[\s\S]*?\n}\n/)?.[0] || '';
        assert.ok(/PGRST205|42P01/.test(helper), '欠損コードで判定すること (文言だけの緩い判定にしない)');
        assert.ok(/blob\.includes\(table\)/.test(helper), '対象テーブル名を含むことを要求すること');
        // ★ 文言でのフォールバックを持たない — プロキシ等が同じ文言を返すと障害を「未適用」と誤分類し、
        //   「今回は難しい」と申告した人を盤面に戻してしまう (Codex指摘 2026-09-07)
        assert.ok(!/could not find the table|does not exist/i.test(helper), 'エラー文言での判定を残さない');
        // 一時的な通信断で当日の運営盤面が丸ごと開けなくなるので、1回だけ取り直してから throw する
        assert.ok(/1回だけ取り直します/.test(client), '再試行が無い');
    });
    test('★ 自分の確認状態は「取得失敗」を「未確認」に偽装しない', () => {
        // 偽装すると、確認済みの人にまで「確認がまだです」と出て、押すと保存エラーになる
        assert.ok(/_myAvailConfirm = \{ loadFailed: true \};/.test(html), '取得失敗の印が無い');
        assert.ok(!/catch \{ \/\* 未適用・シーズン無しなら未確認扱い \*\/ \}/.test(html), '旧い握り潰しが残っている');
        assert.ok(/c\.loadFailed/.test(html), '描画側が取得失敗を扱っていない');
        // 取得失敗のときは確認ボタンを出さない (状態が分からないまま押させない)。
        // ★ バッジ側 (el.textContent) の分岐と取り違えないよう box.innerHTML を含む方を取る
        const box = [...html.matchAll(/if \(c && c\.loadFailed\) \{[\s\S]*?\n            \}/g)]
            .map(m => m[0]).find(t => t.includes('box.innerHTML')) || '';
        assert.ok(box, '確認ブロックの loadFailed 分岐が無い');
        assert.ok(!/<button/.test(box), '状態不明なのに確認ボタンを出している');
    });
    test('★ 確認スナップショットは「実際に保存した時間帯」を使う', () => {
        // 保存の後で _availUI.slots を読み直すと、保存中に本人が時間を変えた場合に
        // 「availability は h21 なのに確認済みの記録は h22」というずれが残る (Codex指摘 2026-09-07)。
        // 振る舞いは tests/avail-save.mjs が実行して確かめる
        assert.ok(/const slots = await _availDoSaveInner\(\{ rethrow: true \}\);/.test(html),
            '保存の戻り値をスナップショットに使っていない');
        assert.ok(/if \(!Array\.isArray\(slots\)\) throw new Error/.test(html), '保存できなかった場合に確認を書かない');
    });
    test('★ 「今回は難しい」人には催促ボタンを押させない', () => {
        assert.ok(/const canNudge = r\.todo && r\.push && !r\.availUnavailable;/.test(html));
    });
}

// ---- L2: 凸の予約 ------------------------------------------------------------
console.log('\nreservationsDomain (凸の予約):');
{
    const rv = globalThis.reservationsDomain;
    // SQL との突き合わせ用に先に読む (test() の中は同期なので await できない)
    const _fs = await import('node:fs');
    const _path = await import('node:path');
    const { fileURLToPath: _f2p } = await import('node:url');
    const _ROOT = _path.resolve(_path.dirname(_f2p(import.meta.url)), '..');
    const _sqlRes = _fs.readFileSync(_path.join(_ROOT, 'supabase', '39_plan_reservations.sql'), 'utf8').replace(/\r\n/g, '\n');
    const _sqlRpc = _fs.readFileSync(_path.join(_ROOT, 'supabase', '40_attack_with_reservation_rpc.sql'), 'utf8').replace(/\r\n/g, '\n');
    // クライアント側と SQL の食い違いも見るので読んでおく
    const _client = _fs.readFileSync(_path.join(_ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
    const res = (o = {}) => ({
        // ★ approved_at: 承認済み起点かどうかの印。approved / cancel_requested / fulfilled / released は
        //   「一度承認された」ことにする (isFixed は approved_at の有無で cancel_requested を区別する)。
        //   未承認の取り下げを作るときは approved_at: null を明示する
        approved_at: o.approved_at !== undefined ? o.approved_at
            : (['approved', 'cancel_requested', 'fulfilled', 'released'].includes(o.status ?? 'approved') ? '2026-09-07T00:00:00Z' : null),
        id: o.id ?? 1, season_id: 30, player_id: o.pid ?? 'p1',
        raid_level: o.lv ?? 2, boss_number: o.boss ?? 3,
        time_mode: o.flex ? 'flex' : 'fixed', time_slot: o.flex ? null : (o.slot ?? 'h21'),
        loadout_slot: o.lo ?? 1, characters_snapshot: o.team ?? ['A', 'B', 'C', 'D', 'E'],
        expected_damage_b: o.dmg ?? 13.1, status: o.status ?? 'approved',
    });

    test('★ 予約: 取り消し希望 (cancel_requested) の間も固定は外れない (解除には運営の承認が要る)', () => {
        const rows = [
            res({ id: 1, pid: 'p1', status: 'approved' }),
            res({ id: 2, pid: 'p2', status: 'cancel_requested' }),
            res({ id: 3, pid: 'p3', status: 'requested' }),
            res({ id: 4, pid: 'p4', status: 'released' }),
        ];
        assert.deepEqual(rv.toSolverConstraints(rows).map(c => c.reservationId).sort(), [1, 2],
            '取り消し希望を出しただけで固定が外れている');
        assert.equal(rv.isFixed(rows[1]), true);
        assert.equal(rv.isFixed(rows[2]), false);
        // ★ 未承認の申請を本人が引っ込めた cancel_requested (approved_at 無し) は固定にしない
        const withdrawn = { ...res({ id: 5, pid: 'p5', status: 'cancel_requested' }), approved_at: null };
        assert.equal(rv.isFixed(withdrawn), false, '未承認の申請を引っ込めただけで固定になっている');
        assert.deepEqual(rv.toSolverConstraints([withdrawn]), []);
        assert.equal(rv.fingerprint([withdrawn]), '', '未承認の取り下げが指紋に入っている');
        // 固定されている cancel_requested は自動解除・凸の紐づけの対象
        const fixedCancel = { ...res({ id: 6, pid: 'p6', lv: 1, boss: 1, status: 'cancel_requested' }) };
        assert.deepEqual(rv.findInfeasible([fixedCancel], { currentLevel: 2, bosses: [] }).map(h => h.id), [6],
            '取り消し希望中はレベルが終わっても固定のまま残る');
        assert.equal(rv.matchForAttack([{ ...fixedCancel, characters_snapshot: [] }], { playerId: 'p6', level: 1, bossNumber: 1, characters: [] }).id, 6,
            '取り消し希望中に本人が凸しても消し込めない');
    });

    test('★ 予約: 指紋は拘束に効く行だけで作る (申請が増えても変わらない / 承認・解除で変わる)', () => {
        const base = [res({ id: 1, pid: 'p1', status: 'approved' }), res({ id: 3, pid: 'p3', status: 'requested' })];
        const fp = rv.fingerprint(base);
        assert.equal(fp, '1:approved');
        assert.equal(rv.fingerprint([...base, res({ id: 9, pid: 'p9', status: 'requested' })]), fp, '申請が増えただけで変わっている');
        assert.notEqual(rv.fingerprint([res({ id: 1, pid: 'p1', status: 'approved' }), res({ id: 3, pid: 'p3', status: 'approved' })]), fp, '承認で変わらない');
        assert.notEqual(rv.fingerprint([res({ id: 1, pid: 'p1', status: 'released' })]), fp, '解除で変わらない');
        assert.notEqual(rv.fingerprint([res({ id: 1, pid: 'p1', status: 'cancel_requested' })]), fp, '取り消し希望で変わらない');
        // 順序に依存しない
        assert.equal(rv.fingerprint([res({ id: 2, pid: 'a', status: 'approved' }), res({ id: 1, pid: 'b', status: 'approved' })]),
            rv.fingerprint([res({ id: 1, pid: 'b', status: 'approved' }), res({ id: 2, pid: 'a', status: 'approved' })]));
        assert.equal(rv.fingerprint(null), '');
    });

    test('予約: ソルバーの拘束になるのは approved / cancel_requested だけ (requested・終端は含めない)', () => {
        const rows = ['requested', 'approved', 'cancel_requested', 'fulfilled', 'released', 'rejected']
            .map((s, i) => res({ id: i + 1, status: s, boss: i + 1 }));
        const c = rv.toSolverConstraints(rows);
        // ★ approved と cancel_requested が拘束 (取り消し希望を出しただけでは固定を外さない — ユーザー決定)
        assert.deepEqual(c.map(x => x.reservationId).sort(), [2, 3], `拘束の集合が違う: ${JSON.stringify(c.map(x => x.reservationId))}`);
    });

    test('予約: 拘束は安定ソートされる (DB の返却順に依存しない)', () => {
        const mk = (o) => res({ ...o, status: 'approved' });
        const a = [mk({ id: 1, lv: 3, boss: 1, pid: 'z' }), mk({ id: 2, lv: 2, boss: 5, pid: 'a' }),
                   mk({ id: 3, lv: 2, boss: 5, pid: 'a', lo: 2 })];
        const key = (c) => c.map(x => `${x.level}/${x.bossNumber}/${x.memberId}/${x.loadoutSlot}`).join(',');
        assert.equal(key(rv.toSolverConstraints(a)), key(rv.toSolverConstraints([...a].reverse())),
            '並び順で結果が変わる');
        assert.equal(key(rv.toSolverConstraints(a)), '2/5/a/1,2/5/a/2,3/1/z/1');
    });

    test('予約: 壊れた行は拘束にしない (範囲外のレベル・ボス・編成)', () => {
        const bad = [res({ lv: 0 }), res({ lv: 9 }), res({ boss: 0 }), res({ boss: 6 }),
                     res({ lo: 0 }), res({ lo: 3 }), { ...res(), player_id: null }];
        assert.deepEqual(rv.toSolverConstraints(bad), []);
        assert.deepEqual(rv.toSolverConstraints(null), []);
    });

    test('予約: 隙間型は時刻を持たない拘束になる', () => {
        const c = rv.toSolverConstraints([res({ flex: true })]);
        assert.equal(c[0].flex, true);
        assert.equal(c[0].timeSlot, null);
        const f = rv.toSolverConstraints([res({ slot: 'h21' })]);
        assert.equal(f[0].flex, false);
        assert.equal(f[0].timeSlot, 'h21');
    });

    test('予約: 撃破・レベル通過は自動で解除の対象になる / 時間切れは対象外', () => {
        const rows = [
            res({ id: 1, lv: 1, boss: 1 }),
            res({ id: 2, lv: 2, boss: 3 }),
            res({ id: 3, lv: 2, boss: 4 }),
            res({ id: 4, lv: 3, boss: 5 }),
            res({ id: 5, lv: 2, boss: 3, status: 'requested' }),
        ];
        const board = { currentLevel: 2, bosses: [
            { boss_number: 3, remaining_hp_raw: 0 }, { boss_number: 4, remaining_hp_raw: 5e9 }] };
        const out = rv.findInfeasible(rows, board);
        assert.deepEqual(out.map(x => [x.id, x.reason]), [[1, 'level_passed'], [2, 'boss_defeated']]);
        assert.ok(!out.some(x => x.reason === 'no_show'), '時刻を過ぎただけで解除してはいけない');
    });

    test('★ 予約: findInfeasible は bosses を渡さなければレベル通過だけを外す (手動HP更新の誤認よけ)', () => {
        // 運営がボスHPを1体ずつ手で更新する運用だと、新レベルの「まだ更新前 = 残HP0」のボスを
        // 撃破済みと誤認して新レベルの予約まで外してしまう。レベル開放時は bosses: [] で呼ぶ
        const rows = [
            res({ id: 1, pid: 'p1', lv: 1, boss: 1, status: 'approved' }),   // 前のレベル → 通過
            res({ id: 2, pid: 'p2', lv: 2, boss: 3, status: 'approved' }),   // いまのレベル → 残す
            res({ id: 3, pid: 'p3', lv: 2, boss: 4, status: 'requested' }),  // 承認前は対象外
            res({ id: 4, pid: 'p4', lv: 3, boss: 3, status: 'approved' }),   // ★ 次のレベルの同じボス → 残す
        ];
        const out = rv.findInfeasible(rows, { currentLevel: 2, bosses: [] });
        assert.deepEqual(out.map(h => [h.id, h.reason]), [[1, 'level_passed']]);
        // ★ raid_level が無い行は外さない (Number(null) は 0 なので、放っておくと通過扱いになる)
        const legacy = [{ ...res({ id: 9, pid: 'p9', lv: 1, boss: 1, status: 'approved' }), raid_level: null }];
        assert.deepEqual(rv.findInfeasible(legacy, { currentLevel: 2, bosses: [] }), [], 'raid_level が無い旧行を外している');
        // bosses を渡せば撃破も見る。★ ただし「いまのレベル」の撃破だけ —
        //   B3 が Lv2 で倒れても、Lv3 の B3 の予約はまだ実行できる (次のレベルで復活する)
        const dead = rv.findInfeasible(rows, { currentLevel: 2, bosses: [{ boss_number: 3, remaining_hp_raw: 0 }] });
        assert.deepEqual(dead.map(h => [h.id, h.reason]).sort(), [[1, 'level_passed'], [2, 'boss_defeated']],
            '次のレベルの予約まで外している');
    });

    test('予約: 残凸の検査は「生きている予約 + 実凸」で数える', () => {
        const rows = [res({ id: 1, status: 'approved' }), res({ id: 2, status: 'requested', boss: 4 }),
                      res({ id: 3, status: 'fulfilled', boss: 5 }), res({ id: 4, status: 'released', boss: 1 })];
        assert.equal(rv.capacityLeft(rows, 'p1', 0), 1, '生きているのは2件なので残り1');
        assert.equal(rv.capacityLeft(rows, 'p1', 1), 0, '実凸1件を足すと空きなし');
        assert.equal(rv.capacityLeft(rows, 'p9', 0), 3, '別人は影響しない');
    });

    test('予約: 遷移表は DB (reservation_set_status) と同じ', () => {
        assert.equal(rv.canTransition('requested', 'approved'), true);
        assert.equal(rv.canTransition('requested', 'fulfilled'), false, '承認を飛ばして実行済みにできてはいけない');
        assert.equal(rv.canTransition('approved', 'released'), true);
        assert.equal(rv.canTransition('cancel_requested', 'approved'), true, '運営が却下したら承認済みへ戻る');
        for (const t of ['fulfilled', 'released', 'rejected']) {
            assert.deepEqual(rv.TRANSITIONS[t], [], `${t} は終端であるべき`);
        }
    });

    test('予約: 承認前の影響は主指標2つ + 他人への波及を出す', () => {
        const plan = (o) => ({
            fullyClearedThrough: o.clear, unusedAttacks: o.unused, totalCreditedB: o.credited,
            levels: [{ level: 2, bosses: [{ bossNumber: 3, attacks: o.attacks || [] }] }],
        });
        const base = plan({ clear: 3, unused: 12, credited: 700, attacks: [{ memberId: 1, loadoutSlot: 1 }] });
        const worse = plan({ clear: 2, unused: 14, credited: 690, attacks: [{ memberId: 2, loadoutSlot: 1 }] });
        const bad = rv.approvalImpact(base, worse, globalThis.planDiffDomain);
        assert.equal(bad.blocking, true);
        assert.ok(bad.warnings.some(w => w.includes('完全攻略の見込みが消えます')));
        assert.ok(bad.warnings.some(w => w.includes('未消化の凸が 12 → 14')));
        assert.equal(bad.creditedDiffB, -10);
        assert.equal(bad.movedCount, 2, '割当が変わる人数を出していない');
        const same = rv.approvalImpact(base, plan({ clear: 3, unused: 12, credited: 700, attacks: [{ memberId: 1, loadoutSlot: 1 }] }), globalThis.planDiffDomain);
        assert.deepEqual(same.warnings, []);
        assert.equal(same.blocking, false);
        assert.equal(same.movedCount, 0);
    });

    // ---- ⑧ 申請UI 用の純ロジック ----------------------------------------------
    {
        const HO = [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4];
        const hourKeyOf = (i) => (HO[i] == null ? null : `h${String(HO[i]).padStart(2, '0')}`);
        const planRow = (o = {}) => ({
            level: o.lv ?? 2, bossNumber: o.boss ?? 3, loadoutSlot: o.slot ?? 1,
            team: o.team ?? ['a', 'b', 'c', 'd', 'e'], dmgB: o.dmg ?? 33.4,
            flex: !!o.flex, hourIdx: o.flex ? null : (o.idx ?? 16),
        });

        test('★ ⑧ 申請: 配信の行をそのまま予約の内容にする (時刻・編成・ダメージ)', () => {
            const r = rv.planRowToDraft(planRow(), hourKeyOf);
            assert.equal(r.ok, true);
            assert.equal(r.draft.raidLevel, null, 'レベルは本人が選ばない (2026-09-08) — 予約に載せない');
            assert.equal(r.draft.bossNumber, 3);
            assert.equal(r.draft.loadoutSlot, 1);
            assert.equal(r.draft.flex, false);
            assert.equal(r.draft.timeSlot, 'h21', 'hourIdx 16 は 21時');
            assert.deepEqual(r.draft.characters, ['a', 'b', 'c', 'd', 'e'], '承認時の写しを載せていない');
            assert.equal(r.draft.expectedDamageB, 33.4);
            assert.equal(r.draft.sourceType, 'plan');
        });

        test('★ ⑧ 申請: ⏳隙間型は時刻を約束しない / 時刻不明は申請にしない', () => {
            const f = rv.planRowToDraft(planRow({ flex: true }), hourKeyOf);
            assert.equal(f.ok, true);
            assert.equal(f.draft.flex, true);
            assert.equal(f.draft.timeSlot, null, '隙間型に時刻を入れてはいけない');
            // ★ 時刻不明を fixed のまま出すと DB の CHECK で弾かれる = 押しても何も起きない
            const n = rv.planRowToDraft({ ...planRow(), hourIdx: null }, hourKeyOf);
            assert.equal(n.ok, false);
            assert.equal(n.reason, 'no_time');
        });

        test('⑧ 申請: 範囲外のレベル・ボス・編成枠は下書きにしない', () => {
            assert.equal(rv.planRowToDraft(planRow({ lv: 0 }), hourKeyOf).ok, false);
            assert.equal(rv.planRowToDraft(planRow({ lv: 5 }), hourKeyOf).ok, false);
            assert.equal(rv.planRowToDraft(planRow({ boss: 6 }), hourKeyOf).ok, false);
            assert.equal(rv.planRowToDraft(planRow({ slot: 3 }), hourKeyOf).ok, false);
            assert.equal(rv.planRowToDraft(null, hourKeyOf).ok, false);
        });

        test('★ ⑧ 申請: 同じ枠の生きている予約は「申請済み」— 時刻違いを別物にしない', () => {
            const rows = [res({ id: 1, pid: 'p1', lv: 2, boss: 3, status: 'requested' })];
            const key = { playerId: 'p1', level: 2, bossNumber: 3, loadoutSlot: 1 };
            assert.ok(rv.findActiveFor(rows, key), '見つからない');
            // ★ 時刻が違っても同じ枠 (DB の部分一意索引と同じ4つで突き合わせる)
            const other = [res({ id: 2, pid: 'p1', lv: 2, boss: 3, slot: 'h05', status: 'approved' })];
            assert.ok(rv.findActiveFor(other, key), '時刻違いを別物にしている (二重申請できてしまう)');
            // 終わった予約は枠を持たない
            for (const st of ['fulfilled', 'released', 'rejected']) {
                assert.equal(rv.findActiveFor([res({ id: 3, pid: 'p1', lv: 2, boss: 3, status: st })], key), null, st);
            }
            // ★ レベル違いも同じ枠 (2026-09-08: 同じカードは1日1回。DB の索引もレベルを含まない)
            assert.ok(rv.findActiveFor(rows, { ...key, level: 3 }), 'レベル違いを別物にしている (二重申請できてしまう)');
            // 別人・別ボス・別編成は別物
            assert.equal(rv.findActiveFor(rows, { ...key, playerId: 'p2' }), null);
            assert.equal(rv.findActiveFor(rows, { ...key, bossNumber: 4 }), null);
            assert.equal(rv.findActiveFor(rows, { ...key, loadoutSlot: 2 }), null);
        });

        test('★ ⑧ 申請: 予約中の編成とキャラが被る編成は申請できない (同じキャラは1日1回 — 2026-09-08 実機で発覚)', () => {
            const rows = [{ ...res({ id: 1, pid: 'p1', boss: 3, team: ['A', 'B', 'C', 'D', 'E'], status: 'approved' }), raid_level: null }];
            const key = { playerId: 'p1', bossNumber: 4, loadoutSlot: 1, doneAttacks: 0 };
            const r = rv.canRequest(rows, { ...key, characters: ['E', 'x', 'y', 'z', 'w'] });
            assert.equal(r.ok, false); assert.equal(r.reason, 'char_conflict'); assert.equal(r.with.id, 1);
            assert.equal(rv.canRequest(rows, { ...key, characters: ['v', 'w', 'x', 'y', 'z'] }).ok, true, '被らなければ申請できる');
            assert.equal(rv.canRequest(rows, { ...key, characters: [] }).ok, true, '編成が分からなければ止めない');
            // 表記ゆれ (全角/空白/大小) は同じキャラとみなす
            assert.equal(rv.canRequest(rows, { ...key, characters: [' e '] }).reason, 'char_conflict');
            // 終わった予約・別人の予約とは被らない
            assert.equal(rv.canRequest([{ ...rows[0], status: 'released' }], { ...key, characters: ['A'] }).ok, true);
            assert.equal(rv.canRequest([{ ...rows[0], player_id: 'p2' }], { ...key, characters: ['A'] }).ok, true);
            assert.equal(rv.conflictingReservation(rows, { playerId: 'p1', characters: ['A'], excludeId: 1 }), null, '自分自身は除ける');
            // 壊れた写し (オブジェクト・空白だけ・null) を "[object Object]" や '' として一致させない (Codex指摘)
            const broken = [{ ...rows[0], characters_snapshot: [{}, '   ', null, 'Z'] }];
            assert.equal(rv.canRequest(broken, { ...key, characters: ['[object Object]', '', ' '] }).ok, true, '壊れた写しが一致している');
            assert.equal(rv.canRequest(broken, { ...key, characters: [{}, 'z'] }).reason, 'char_conflict', '文字列の部分は見る');
        });

        test('★ ⑧ 申請: 残凸を超える申請はボタンを出さない (DBで弾かれる前に止める)', () => {
            const key = { playerId: 'p1', level: 2, bossNumber: 3, loadoutSlot: 1 };
            assert.equal(rv.canRequest([], { ...key, doneAttacks: 0 }).ok, true);
            // 生きている予約2件 + 実凸1件 = 3 → もう申請できない
            const full = [res({ id: 1, pid: 'p1', lv: 1, boss: 1 }), res({ id: 2, pid: 'p1', lv: 1, boss: 2 })];
            const r = rv.canRequest(full, { ...key, doneAttacks: 1 });
            assert.equal(r.ok, false);
            assert.equal(r.reason, 'no_capacity');
            // 同じ枠を二重に申請させない
            const dup = rv.canRequest([res({ id: 9, pid: 'p1', lv: 2, boss: 3 })], { ...key, doneAttacks: 0 });
            assert.equal(dup.ok, false);
            assert.equal(dup.reason, 'already');
        });
    }

    test('★ ⑧配線: 39未適用では申請の導線ごと出さない / 下書きはドメインで作る', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const client = _fs.readFileSync(_path.join(_ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
        // 自分の予約は null (未適用) と [] (0件) を区別する。混ぜると押した瞬間に SQL 適用エラーになる
        const loader = client.match(/window\.supabaseLoadMyReservations = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(loader, '自分の予約のローダーが無い');
        assert.ok(/_isMissingReservationTable\(error\)\) return null;/.test(loader));
        const fn = html.match(/function _planRowResvHtml[\s\S]{0,2400}/)?.[0] || '';
        assert.ok(fn, '行ごとの予約表示が無い');
        assert.ok(/if \(!rv \|\| !Array\.isArray\(rows\)\) return '';/.test(fn), '未適用で導線を出している');
        // ★ 下書きは画面で組み立てない (時刻・編成の取り違えに気づけない)
        assert.ok(/rv\.planRowToDraft\(/.test(fn));
        assert.ok(/rv\.findActiveFor\(/.test(fn), '申請済みの判定をドメインでやっていない');
        assert.ok(/rv\.canRequest\(/.test(fn), '残凸の検査をドメインでやっていない');
        // ★ 残凸は「このプランで報告済みの数」ではなく当日の実凸総数で数える (Codex指摘)
        assert.ok(/doneAttacks: Number\(_myPubState\?\.todayAttacks\) \|\| 0/.test(fn), '実凸総数で数えていない');
        // ★ 実行できない予約を作らせない (過去レベル・撃破済みボス)
        assert.ok(/if \(liveLv && level < liveLv\) return '';/.test(fn), '過去レベルの行にも申請導線を出している');
        assert.ok(/Number\(liveBoss\.remaining_hp_raw\) <= 0\) return '';/.test(fn), '撃破済みボスにも申請導線を出している');
        // 申請の実処理も同じ下書きを使う
        const h = html.match(/async function handleClaimPlanRow[\s\S]{0,4200}/)?.[0] || '';
        assert.ok(/rv\.planRowToDraft\(row,/.test(h), '申請時に下書きを作り直していない');
        assert.ok(/if \(!draft\.ok\)/.test(h), '下書きが作れないのに申請している');
        assert.ok(/_claimBusy/.test(h), '二重押しよけが無い');
        assert.ok(/sourcePlanId: st\.planId/.test(h), 'どの配信から生まれた予約か残していない');
        // ★ 画面を開いたあとにプレイヤーを切り替えると、別メンバー名義の申請ができてしまう
        assert.ok(/String\(me0\.id\) !== String\(st\.viewerId\)/.test(h), '本人性を確認していない');
    });

    // ---- モック②: 自分から申請する (どのボス / どのレベル / 何時 / どの編成) ----
    {
        const B = (o = {}) => ({ boss_number: o.n ?? 3, name: 'アニヒリオ', attribute: 'iron', weakness: 'wind', remaining_hp_raw: o.hp ?? 100 });
        const LO = (o = {}) => ({ slot: o.slot ?? 2, characters: o.team ?? ['a', 'b', 'c', 'd', 'e'], dmgB: o.dmg ?? 13.1 });
        test('★ 申請シート: ボス・時刻・編成が揃えば下書きになる (時刻 fixed / ⏳ flex) — レベルは聞かない', () => {
            const r = rv.buildRequestDraft({ boss: B(), level: 2, timeSlot: 'h23', flex: false, loadout: LO(), currentLevel: 2 });
            assert.equal(r.ok, true);
            assert.deepEqual(r.draft, { raidLevel: null, bossNumber: 3, loadoutSlot: 2, flex: false, timeSlot: 'h23',
                characters: ['a', 'b', 'c', 'd', 'e'], expectedDamageB: 13.1, sourceType: 'self' });
            assert.equal(r.note, '', '開いているレベルに注記は要らない');
            const f = rv.buildRequestDraft({ boss: B(), level: 2, timeSlot: null, flex: true, loadout: LO(), currentLevel: 2 });
            assert.equal(f.ok, true); assert.equal(f.draft.flex, true); assert.equal(f.draft.timeSlot, null);
        });
        test('★ 申請シート: 足りないものを名指しで返す (押せるのに弾かれる、を作らない)', () => {
            const base = { boss: B(), level: 2, timeSlot: 'h23', flex: false, loadout: LO(), currentLevel: 2 };
            assert.deepEqual(rv.buildRequestDraft({ ...base, boss: null }).missing, ['boss']);
            // ★ 倒れたボスは次のレベルにもいる — 申請は通し、本人に注記だけ出す (2026-09-08)
            assert.equal(rv.buildRequestDraft({ ...base, boss: B({ hp: 0 }) }).ok, true, '倒れたボスへの申請を止めている');
            assert.match(rv.buildRequestDraft({ ...base, boss: B({ hp: 0 }) }).note, /次のレベル/);
            // レベルは聞かないので、無くても範囲外でも足りないものにならない
            assert.equal(rv.buildRequestDraft({ ...base, level: null }).ok, true);
            assert.equal(rv.buildRequestDraft({ ...base, level: 5 }).ok, true);
            assert.deepEqual(rv.buildRequestDraft({ ...base, timeSlot: null }).missing, ['time'], '時刻未選択 (⏳でもない) を通している');
            assert.deepEqual(rv.buildRequestDraft({ ...base, timeSlot: 'あ' }).missing, ['time'], '形式が違う時刻を通している (DB の CHECK で弾かれる)');
            assert.deepEqual(rv.buildRequestDraft({ ...base, loadout: null }).missing, ['loadout']);
            assert.deepEqual(rv.buildRequestDraft({ ...base, loadout: LO({ dmg: 0 }) }).missing, ['loadout'], 'ダメージ未保存の編成を通している');
            assert.deepEqual(rv.buildRequestDraft({ ...base, loadout: LO({ slot: 3 }) }).missing, ['loadout']);
            assert.deepEqual(rv.buildRequestDraft({ boss: null, level: null, timeSlot: null, loadout: null }).missing, ['boss', 'time', 'loadout'], '複数まとめて返す');
        });
        test('申請シート: レベルは聞かない — 指定しても下書きに載らず、注記も出ない (2026-09-08)', () => {
            const r = rv.buildRequestDraft({ boss: B(), level: 3, timeSlot: 'h23', flex: false, loadout: LO(), currentLevel: 2 });
            assert.equal(r.ok, true);
            assert.equal(r.draft.raidLevel, null);
            assert.equal(r.note, '');
        });
        test('★ ⑧配線: 申請シートがモック②の形で入っている', () => {
            const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
            assert.ok(html.includes('id="myResvRequestModal"'), 'シートが無い');
            const render = html.match(/function _resvReqRender\(\) \{[\s\S]{0,12000}/)?.[0] || '';
            // ★ レベルは聞かない (2026-09-08)。ボスは全レベル共通で、置くレベルは運営の算出が時刻から決める。
            //   ボスも選ばせない (同日ユーザー指摘): 編成の弱点属性で行くボスが決まる。確認の1行だけ
            for (const t of ['どの編成で', '何時に', 'この内容で申請する', 'に行きます']) {
                assert.ok(render.includes(t), `「${t}」が無い`);
            }
            assert.ok(!render.includes('どのレベルを'), 'レベルを聞いている (本人が選ぶものではない)');
            assert.ok(!/_resvReqPick\('level'/.test(render), 'レベルのチップが残っている');
            assert.ok(!render.includes("lbl('どのボスを')"), 'ボスを選ばせている (編成で決まる)');
            assert.ok(!/_resvReqPick\('boss'/.test(render), 'ボスのボタンが残っている');
            assert.ok(render.indexOf("lbl('どの編成で')") < render.indexOf("lbl('何時に')"), '編成より先に時刻を聞いている');
            // ★ 時刻のチップと注記がテンプレートに差し込まれていること (置換の取りこぼしで `$1` が残った — Codex指摘)
            assert.ok(render.includes("${timeChips.join('')}") && render.includes('${timeNote}'), '時刻の選択が描かれない');
            assert.ok(!/\$1\b/.test(render), 'テンプレートに置換の残骸 ($1) がある');
            // ボスは編成から決まる (_resvReqBossOf) — 選び直しの経路も同じ
            assert.ok(/function _resvReqBossOf\(lo\)/.test(html));
            assert.ok(/_resvReq\.boss = _resvReqBossOf\(_resvReq\.lo\);/.test(html), '編成を選んでもボスが決まらない');
            // ★ 足りないものの判定と残凸はドメインに寄せる
            assert.ok(/rv\.buildRequestDraft\(/.test(render), '下書きをドメインで作っていない');
            assert.ok(/rv\.canRequest\(/.test(render), '残凸と重複を見ていない');
            // 時刻は本人の登録時間帯から (何でも選べると守れない約束になる)
            assert.ok(/HOUR_ORDER\.filter\(h => slotSet\.has\(_hourKey\(h\)\)\)/.test(render), '登録時間帯から選ばせていない');
            // 倒れているボスも選べる (次のレベルにもいる) — 「いまのLvでは撃破済み」と分かる形で
            assert.ok(!/dead \? 'disabled'/.test(render), '倒れたボスを選べなくしている');
            assert.ok(render.includes('いまのLvでは撃破済み'));
            // 入口: ホームの「引き受けた凸」カードと配信プランカードの両方 (モック①)
            assert.ok((html.match(/onclick="openMyResvRequest\(\)"/g) || []).length >= 2, '入口が2つ無い');
            // 下スワイプで閉じられる
            assert.ok(/\['myResvRequestModal', \(\) => closeMyResvRequestModal\(\)\]/.test(html));
        });
    }

    test('★ 算出は「押した時点の DB の予約」を固定制約として渡す (実機で発覚: 渡していなかった)', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        // 10時の予約が承認済みなのに 6時に組まれ、配信の reservationCount が 0 だった。
        // computeOptimalPlan が reservations をソルバーに渡していなかった
        const fn = html.match(/function computeOptimalPlan\(options = \{\}, snapshot = null\) \{[\s\S]{0,1600}/)?.[0] || '';
        assert.ok(/reservations: \(rv && resvRows\) \? rv\.toSolverConstraints\(resvRows\) : \[\]/.test(fn), 'ソルバーに予約を渡していない');
        // ★ 運営カードの _resv.rows に頼らない (開いていないと null)。押した時点の DB から取り直す
        const run = html.match(/async function computeAndRenderOptimalPlan[\s\S]{0,9000}/)?.[0] || '';
        assert.ok(/reservations = await window\.supabaseLoadReservations\(snapshot\.season\.id\);/.test(run), '算出時に予約を取り直していない');
        assert.ok(/computeOptimalPlan\(\{ \.\.\.options, previousPlan, reservations: Array\.isArray\(reservations\) \? reservations : \[\] \}, snapshot\)/.test(run),
            '取り直した予約を渡していない');
        // 取れなければ止める (予約を無視したプランを配信すると約束が破れる)
        assert.ok(/予約の取得に失敗したため算出を止めました/.test(run), '取得失敗でも予約なしで組んでいる');
        // _resv.rows を書き換えるときは世代を進める (進行中の一覧取得の古い応答で上書きされない)
        assert.ok(/_resv\.gen\+\+;[^\n]*\n\s*_resv\.rows = reservations;/.test(run), '世代を進めずに _resv.rows を書き換えている');
        // ★ 算出時の予約の指紋をプランに焼き込み、配信直前に取り直して照合する
        assert.ok(/plan\.reservationFingerprint = \(window\.reservationsDomain && Array\.isArray\(reservations\)\)/.test(run), '指紋を焼き込んでいない');
        // ★ 配信直前の照合は fail-closed。confirm の前と INSERT の直前の両方で見る
        const guard = html.match(/async function _publishReservationGuard[\s\S]{0,2200}/)?.[0] || '';
        assert.ok(guard, '配信直前の予約ガードが無い');
        assert.ok(/if \(fp === 'unsupported'\) return true;/.test(guard), '39未適用を素通りしていない');
        assert.ok(/if \(fp == null \|\| !rv/.test(guard), '指紋が無い古い算出結果を止めていない');
        assert.ok(/予約の取得に失敗したため配信を止めました/.test(guard), '取得失敗で止めていない');
        assert.ok(/if \(!Array\.isArray\(nowRows\)\) \{/.test(guard), '取得結果 null で止めていない');
        assert.ok(/if \(rv\.fingerprint\(nowRows\) !== fp\) \{/.test(guard), '指紋を照合していない');
        assert.equal((html.match(/if \(!\(await _publishReservationGuard\(seasonId\)\)\) return;/g) || []).length, 2,
            'confirm の前と INSERT の直前の2箇所で照合していない');
        assert.ok(/: \(reservations === null \? 'unsupported' : null\);/.test(run), '39未適用の印を焼き込んでいない');
        assert.ok(!/_resv\.rows\)\s*\}, snapshot\)/.test(run), '画面の状態 (_resv.rows) をそのまま渡している');
    });

    test('★ モーダル→モーダルの切替で history.back() と pushState を同じバッチに出さない (ページ外へ出る)', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const fn = html.match(/const onClassChange = \(records\) => \{[\s\S]{0,3400}/)?.[0] || '';
        assert.ok(fn, 'history 連携が見つからない');
        // 閉じると開くを集めてから相殺する
        assert.ok(/const opened = \[\], closed = \[\];/.test(fn), '閉じる・開くを集めていない');
        // ★ 走査順は DOM 順でなく操作の順 (MutationRecord の順)
        assert.ok(/const onClassChange = \(records\) => \{/.test(html), 'MutationRecord を受け取っていない');
        assert.ok(/\(Array\.isArray\(records\) \? records : \[\]\)\.forEach\(rec => \{/.test(fn), 'レコードの順で走査していない');
        assert.ok(/while \(opened\.length && closed\.length && !closingFromPop && armed > 0\) \{/.test(fn), '相殺していない');
        assert.ok(/closed\.shift\(\);[\s\S]{0,80}stack\.push\(opened\.shift\(\)\);/.test(fn), '相殺で state を引き継いでいない');
        // 相殺のあとに残った分だけ back / push する
        assert.ok(/closed\.forEach\(\(\) => \{[\s\S]{0,200}history\.back\(\)/.test(fn));
        assert.ok(/opened\.forEach\(el => \{[\s\S]{0,200}history\.pushState/.test(fn));
    });

    test('★ モック④: 運営プランと本人のプランに「🔒予約」ピン / 「N件を固定して計算」', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(/const resvPin = a\.fromReservation \?/.test(html), '運営プランの行にピンが無い');
        assert.ok(/\$\{meTag\}\$\{resvPin\}\$\{reservedTag\}/.test(html), 'ピンを行に差し込んでいない');
        assert.ok(/件を固定して計算しました/.test(html), '「N件を固定して計算」が無い');
        assert.ok(/statChip\('🔒予約を固定'/.test(html));
        assert.ok(/固定できなかった予約が/.test(html), '守れなかった予約を運営に見せていない');
        // 本人の配信プランの行にも (2026-09-08: 3枠の一覧では「予約で固定」の行として出る)
        const mine = html.match(/function _planMineHtml\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/rv\.homeSlots\(\{ plan, viewerId,/.test(mine), '本人の一覧を homeSlots で組んでいない');
        assert.ok(mine.includes('🔒 予約で固定'), '本人の行に予約の印が無い');
    });

    // ===== 本人のホーム = 3枠 (2026-09-08) =====
    test('★ ホーム3枠: ヒーローと「わたしの凸」が同じ homeSlots で組まれ、空き枠は理由つき・タップで申請', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const now = html.match(/function _homeSlotsNow\(identity\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/rv\.homeSlots\(\{ plan: st \? st\.plan : null, viewerId: identity\.id, reservations: resv,/.test(now), '3枠をドメインで組んでいない');
        // 予約は本人のぶんだけ (プレイヤー切替直後の古い一覧で他人の予約を出さない)
        assert.ok(/_myResvRows\.filter\(r => String\(r\.player_id\) === String\(identity\.id\)\)/.test(now));
        const strip = html.match(/function _heroPlanStripHtml\(identity, hero\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/const h = _homeSlotsNow\(identity\);/.test(strip), 'ヒーローが3枠を使っていない');
        assert.ok(/_homeSlotCardHtml\(slot, i, hero\)/.test(strip));
        assert.ok(/_homeStaleBannerHtml\(h, hero\)/.test(strip), '「運営が組み直し中」を出していない');
        const card = html.match(/function _homeSlotCardHtml\(slot, i, hero\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        for (const k of ["slot.kind === 'empty'", "slot.kind === 'done'", "slot.kind === 'fixed'"]) assert.ok(card.includes(k), `${k} の描き分けが無い`);
        assert.ok(/esc\(slot\.text \|\| ''\)/.test(card), '空き枠に理由 (日本語) を出していない');
        assert.ok(card.includes("openMyResvRequest()"), '空き枠から申請シートを開けない');
        // 39未適用なら申請の導線は出さない
        assert.ok(/const canAsk = Array\.isArray\(_myResvRows\);/.test(card));
        assert.ok(/'🔒 予約 \(組み直し待ち\)'/.test(card), '配信に入っていない予約を区別していない');
        // 「運営が組み直し中」の帯は配信カード本文にも
        const body = html.match(/function _renderMyPubBody\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/resvStaleBanner = _homeStaleBannerHtml\(_homeSlotsNow\(\{ id: viewerId \}\), false\)/.test(body));
        assert.ok(/\$\{resvStaleBanner\}\$\{frozenBanner\}/.test(body), '帯を本文に差し込んでいない');
        assert.ok(html.includes('運営が組み直し中です — 予約の枠は動きません'));
        // 予約が変わったらヒーローを描き直す (予約の一覧を読んだあと)
        const resv = html.match(/async function renderMyReservations\(identity\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/const k = _homeSlotsKey\(_homeSlotsNow\(identity\)\);\s*\n\s*if \(k !== _heroPlanKey\) renderMyNextAction\(identity\);/.test(resv), '予約が変わってもヒーローが古いまま');
        // CSS: 固定 / 空き の見た目
        assert.ok(/\.dc-plan-card\.fixed \{/.test(html) && /\.dc-plan-card\.empty \{/.test(html));
    });

    test('★ モック⑤: 予約先が倒れた / レベルが終わったら自動で外して本人に知らせる', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const fn = html.match(/async function _releaseInfeasibleReservations[\s\S]{0,4200}/)?.[0] || '';
        assert.ok(fn, '自動解除が無い');
        assert.ok(/rv\.findInfeasible\(rows, board\)/.test(fn), '対象の判定をドメインでやっていない');
        // ★ 楽観ロック: 別端末が先に外していたら通知しない (2重通知よけ)。
        //   期待する状態は行の実際の状態 (approved / 承認済み起点の cancel_requested)
        assert.ok(/\{ expectFrom: h\.row\.status, reason: h\.reason, actor: 'system' \}/.test(fn), 'expectFrom を approved に固定している');
        assert.ok(/if \(released\.length === 0\) return;/.test(fn), '外せた分だけ通知する形になっていない');
        assert.ok(/supabaseLogActivityStrict\?\.\('reservation_release'/.test(fn), '監査ログが無い');
        assert.ok(/playerIds: \[r\.player_id\]/.test(fn), '本人だけに送っていない');
        // ★ 一時的な失敗は1回だけ取り直す。競合 (別端末が先に外した) は取り直さない
        assert.ok(/for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(fn), '取り直しが無い');
        assert.ok(/状態が変わっています\|もう変更できません\/\.test\(msg\)\) break;/.test(fn), '競合まで取り直している');
        // Push が届かなかったことを運営が見える形で残す
        assert.ok(/への解除通知が届きませんでした/.test(fn), 'Push 失敗を握り潰している');
        // ★ 定期点検: 運営端末は30秒ごとにレベル通過分だけ見直す (bosses は渡さない)
        assert.ok(/if \(_opsMode && r\?\.season\?\.id && typeof _releaseInfeasibleReservations === 'function'\) \{\s*\n\s*_releaseInfeasibleReservations\(r\.season\.id,\s*\n\s*\{ currentLevel: Number\(r\.season\.current_level\) \|\| 1, bosses: \[\] \}, '定期点検'\)/.test(html),
            '定期点検が無い、または bosses を渡している');
        assert.ok(/予約していたボスが倒れました/.test(fn));
        assert.ok(/新しいプランを確認してください/.test(fn), '「代わりの割当」への導線の文言が無い');
        // ★ _checkRaidEvents への接続。撃破はレベル開放と同時でないときだけ、
        //   レベル開放時は bosses を渡さない (手動HP更新の誤認よけ)
        assert.ok(/if \(ev\.defeated\.length > 0 && !levelJustOpened\) \{\s*\n\s*await _releaseInfeasibleReservations\(cur\.seasonId, \{ currentLevel: level, bosses \}/.test(html),
            '撃破時の接続が無い、または levelJustOpened を見ていない');
        assert.ok(/_releaseInfeasibleReservations\(cur\.seasonId, \{ currentLevel: ev\.levelOpened, bosses: \[\] \}/.test(html),
            'レベル開放時に bosses を渡している (新レベルの予約まで外す)');
    });

    test('★ ⑧配線: 締め凸の了承は即予約 / 予約が作れなくても了承は成立させる', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        // ★ 同じボスに生きている予約があれば作らない — レベルも編成枠も見ない (Codex指摘 2026-09-08)。
        //   レベルを見ると、本人がレベル無しで出した予約 (raid_level NULL) を見落とし、
        //   一意索引 (誰が・ボス・編成枠) で insert が弾かれて「了承だけ成立して固定されない」になる
        const fr = html.match(/async function _reserveForFinishRequest\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(mine\.some\(r => rv\.isActive\(r\) && Number\(r\.boss_number\) === Number\(bossNumber\)\)\) return;/.test(fr), '同じボスの予約を見ていない');
        assert.ok(!/Number\(r\.raid_level\) === Number\(level\)/.test(fr), 'レベルで絞っている (レベル無しの予約を見落とす)');
        const fn = html.match(/async function _reserveForFinishRequest[\s\S]{0,1900}/)?.[0] || '';
        assert.ok(fn, '締め凸→予約の関数が無い');
        // ★ 依頼したのは運営なので、改めて承認を挟まない
        assert.ok(/status: 'approved'/.test(fn), '了承を承認待ちで作っている (運営がもう一度承認する羽目になる)');
        assert.ok(/sourceType: 'finish_request'/.test(fn));
        // ★ 締め凸は「いまから行く」もの。時刻を約束させると守れないほうが普通になる
        assert.ok(/flex: true, timeSlot: null/.test(fn), '締め凸に時刻を約束させている');
        // ★ 押し直しても増やさない。**編成枠は見ない** — 押し直す間に一番強い編成が
        //   ①→② に変わると、枠まで見る判定では別物になり同じ依頼から2件できる
        assert.ok(/Number\(r\.boss_number\) === Number\(bossNumber\)\)\) return;/.test(fn), '同じボスの重複を見ていない');
        assert.ok(!/rv\.findActiveFor\(mine, \{ playerId: id\.id, level, bossNumber, loadoutSlot: slot \}\)/.test(fn),
            '編成枠まで見ている (押し直しで二重予約になる)');
        // 39未適用なら何もしない (了承だけ成立)
        assert.ok(/if \(!Array\.isArray\(mine\)\) return;/.test(fn));
        // ★ 予約が作れなくても了承は成立させる (返答はもうサーバへ届いている)
        const caller = html.match(/if \(status === 'accepted'\) \{[\s\S]{0,600}/)?.[0] || '';
        assert.ok(/console\.warn\('\[finish→予約\]'/.test(caller), '予約の失敗で了承ごと失敗している');
        // ★ ただし黙らない — 「了承済みなのに予約が無い」は運営が知る必要がある
        assert.ok(/凸の固定に失敗しました/.test(html), '失敗を握り潰している');
    });

    test('★ ⑧配線: ホームの「引き受けた凸」/ 取り消しは希望を出すだけ', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(html.includes('id="myReservationsCard"'), 'カードが無い');
        const fn = html.match(/async function renderMyReservations[\s\S]{0,6500}/)?.[0] || '';
        assert.ok(fn, '描画関数が無い');
        // ★ 39未適用 (null) だけ非表示。0件 ([]) でも出す — ここが「自分から申請する」の入口 (モック①)
        assert.ok(/if \(!Array\.isArray\(_myResvRows\)\) \{ card\.style\.display = 'none'; return; \}/.test(fn));
        assert.ok(/openMyResvRequest\(\)/.test(fn), 'カードから申請シートを開けない');
        assert.ok(html.includes('まだ引き受けた凸はありません'), '0件のときの文言が無い');
        assert.ok(/rv\.isActive\(r\)/.test(fn), '生きている予約の判定をドメインでやっていない');
        // ★ 取り消しは希望を出すだけ。解除には運営の承認が要る (ユーザー決定)
        const cancel = html.match(/async function handleRequestCancelReservation[\s\S]{0,900}/)?.[0] || '';
        assert.ok(/'cancel_requested'/.test(cancel), '本人が直接解除できてしまう');
        assert.ok(!/'released'/.test(cancel), '本人の操作で解除している');
        assert.ok(/expectFrom: r\.status/.test(cancel), '取り違えた操作を弾いていない');
        // ホームの描画に載っている
        assert.ok(/renderMyReservations\(id\);\s*\/\/ 🔒 引き受けた凸/.test(html), 'ホームで呼んでいない');
    });

    test('★ ⑧配線: 模擬タブから申請できる (ボスは属性から引く / 保存済みの提出を使う)', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(html.includes('id="myTeamEditResvSec"'), '編成編集モーダルに予約欄が無い');
        const fn = html.match(/async function _renderTeamEditResv[\s\S]{0,3200}/)?.[0] || '';
        assert.ok(fn, '予約欄の描画関数が無い');
        // ★ 本人にボスを選ばせない — 選ばせると弱点でない編成で予約できてしまう
        assert.ok(/\(ctx\?\.bosses \|\| \[\]\)\.find\(b => b\.weakness === attrKey\)/.test(fn), 'ボスを属性から引いていない');
        // 倒れているボスも予約できる (次のレベルにもいる・2026-09-08)。置くレベルは運営の算出が時刻から決める
        assert.ok(!/Number\(boss\.remaining_hp_raw\) <= 0\) return;/.test(fn), '倒れたボスを予約できなくしている');
        assert.ok(fn.includes('倒れているボスも予約できる'));
        assert.ok(/if \(!Array\.isArray\(mine\)\) return;/.test(fn), '39未適用でも欄を出している');
        assert.ok(/rv\.findActiveFor\(/.test(fn), '申請済みの判定をしていない');
        // ★ 編集中の値ではなく保存済みの提出を使う (承認内容と提出が食い違わないように)
        assert.ok(/allRowsForResv\(\)/.test(fn), '保存済みの提出を見ていない');
        assert.ok(/提出すると、この編成で凸を予約できます/.test(fn), '未保存でも申請できてしまう');
        // ★ 模擬タブは埋め込みフォームではなく、共通の申請シートをこの属性・編成で開く (モック②)
        const open = html.match(/function handleRequestReservationFromMock[\s\S]{0,400}/)?.[0] || '';
        assert.ok(/openMyResvRequest\(\{ attr: c\.attr, slot: c\.slot \}\)/.test(open), '共通シートを開いていない');
        assert.ok(html.includes('id="myTeamEditResvOpen"'), '模擬タブの入口ボタンが無い');
    });

    test('★ ⑧: 凸報告は承認済みの予約に紐づけて消し込む (4経路すべて)', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        // ★ 紐づけないと、承認済みの予約が fulfilled にならないまま残り、
        //   実凸と合わせて残凸を二重に消費する = 約束を守る仕組みが本人を止める (Codex指摘)
        assert.ok(/async function _reservationIdForAttack/.test(html), '紐づけの共通処理が無い');
        const n = (html.match(/_reservationIdForAttack\(/g) || []).length;
        assert.ok(n >= 5, `呼び出しが足りない (定義1 + 4経路 = 5以上のはずが ${n})`);
        assert.equal((html.match(/reservationId: r/g) || []).length, 4, '凸報告4経路すべてに渡していない');
        // 曖昧なときは紐づけない (間違った予約を消し込む方が害が大きい)
        const m = rv.matchForAttack;
        const R = (o) => ({ id: o.id, player_id: 'p1', status: o.st || 'approved', raid_level: 2,
            boss_number: o.boss ?? 3, characters_snapshot: o.team || [] });
        const key = { playerId: 'p1', level: 2, bossNumber: 3, characters: ['a', 'b'] };
        assert.equal(m([], key).reason, 'none');
        assert.equal(m([R({ id: 5 })], key).id, 5, '1件なら紐づける');
        assert.equal(m([R({ id: 5, st: 'requested' })], key).id, null, '承認前の予約に紐づけている');
        assert.equal(m([R({ id: 5, boss: 4 })], key).id, null, '別ボスに紐づけている');
        // 2件あるときは編成で絞れたときだけ
        const two = [R({ id: 5, team: ['b', 'a'] }), R({ id: 6, team: ['c', 'd'] })];
        assert.equal(m(two, key).id, 5, '編成で絞れていない');
        assert.equal(m(two, { ...key, characters: [] }).reason, 'ambiguous', '曖昧なのに紐づけている');
        assert.equal(m(two, { ...key, characters: [] }).id, null);
    });

    test('★ ⑧: 承認は「承認時点の提出」で固定し直す', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const client = _fs.readFileSync(_path.join(_ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
        // ユーザー決定は「承認時点で固定」。申請時の写しのままだと、
        // 申請から承認までの間に本人が模擬を直したとき古い内容で固定される (Codex指摘)
        assert.ok(/async function _snapshotAtApproval/.test(html), '承認時の読み直しが無い');
        assert.ok(/申請後に本人が編成を変えています/.test(html), '変わったことを運営に見せていない');
        assert.ok(/characters: snap\?\.characters \|\| null, expectedDamageB: snap\?\.expectedDamageB \|\| null/.test(html));
        assert.ok(/p_characters: Array\.isArray\(o\.characters\)/.test(client), 'RPC に渡していない');
        // SQL 側: 承認の瞬間だけ載せ直す。引数を増やしたので旧シグネチャは落とす
        assert.ok(/DROP FUNCTION IF EXISTS reservation_set_status\(BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT\);/.test(_sqlRes),
            '旧シグネチャを落としていない (PostgREST から呼ぶと曖昧になる)');
        assert.ok(/characters_snapshot = CASE WHEN p_to = 'approved' AND p_characters IS NOT NULL/.test(_sqlRes));
        const check = _fs.readFileSync(_path.join(_ROOT, 'supabase', '99_check_applied.sql'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(/reservation_set_status\(bigint,text,text,text,text,bigint,jsonb,numeric\)/.test(check),
            '99 の判定行が旧シグネチャのまま');
    });

    test('★ ⑧: 画面のプレイヤー切替後に別名義で申請・取消できない', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const cancel = html.match(/async function handleRequestCancelReservation[\s\S]{0,1200}/)?.[0] || '';
        assert.ok(/String\(me0\.id\) !== String\(r\.player_id\)/.test(cancel), '取消の本人性を見ていない');
        // 申請シートは開いた本人の identity で作る (送信直前に取り直す)
        const sheet = html.match(/async function handleResvReqSubmit[\s\S]{0,3600}/)?.[0] || '';
        assert.ok(/const me = getCurrentIdentity\(\);\s*\n\s*if \(!me\?\.id\) return;/.test(sheet), '送信直前に本人を取り直していない');
        assert.ok(/playerId: me\.id/.test(sheet), '開いたときの本人ではなく送信時の本人で作ること');
        // ★ 開いた本人と送信時の本人が違えば送らない (別メンバーの時間帯・提出で申請してしまう)
        assert.ok(/String\(me\.id\) !== String\(st\.playerId\)/.test(sheet), '開いた本人との照合が無い');
        // ★ 送信は世代を握り、閉じて開き直された画面を完了処理で閉じない
        assert.ok(/const seq = st\.seq;/.test(sheet), '送信の世代を握っていない');
        assert.ok((sheet.match(/if \(seq !== st\.seq\) return;/g) || []).length >= 2, '取得後と作成後の両方で世代を見ていない');
        // ★ 送信直前に最新の予約・凸数で残凸と重複を見直す (押せたのに DB で弾かれる、を作らない)
        assert.ok(/const \[mineNow, atksNow\] = await Promise\.all/.test(sheet), '送信直前に取り直していない');
        assert.ok(/const chk = rv\.canRequest\(st\.mine, \{ playerId: me\.id/.test(sheet), '送信直前に canRequest していない');
        // 戦闘可能時間の取得失敗を「未登録」と混同しない
        assert.ok(/_resvReq\.slotsFailed = !Array\.isArray\(slots\);/.test(html));
        assert.ok(/戦闘可能時間を取得できませんでした/.test(html));
    });

    // ===== 2026-09-08: 予約から「レベル」を外す =====
    test('★ 予約: レベルの無い予約 (メンバー発) は拘束になる / 並びは level null を先頭に', () => {
        const noLv = { ...res({ id: 7, status: 'approved', boss: 2 }), raid_level: null };
        const c = rv.toSolverConstraints([res({ id: 8, status: 'approved', lv: 3, boss: 1 }), noLv]);
        assert.equal(c.length, 2, 'レベル無しの予約が拘束から落ちた');
        assert.equal(c[0].level, null, 'level は null のまま渡す (ソルバーが時刻から決める)');
        assert.equal(c[0].reservationId, 7);
        assert.equal(c[1].level, 3);
        // 壊れたレベル (範囲外) は今までどおり落とす
        assert.equal(rv.toSolverConstraints([{ ...res({ status: 'approved' }), raid_level: 9 }]).length, 0);
    });
    test('予約: describe はレベルが無ければ Lv を出さない', () => {
        const bn = new Map([[3, 'ボス3']]);
        assert.equal(rv.describe({ ...res(), raid_level: null }, bn), 'ボス3 21時 編成①');
        assert.equal(rv.describe(res({ lv: 2 }), bn), 'Lv2 ボス3 21時 編成①');
    });
    test('★ 予約: レベルの無い予約はどのレベルの凸にも紐づく (消し込み) — ただし編成が違えば紐づけない', () => {
        const rows = [{ ...res({ id: 5, status: 'approved', boss: 3, team: ['a', 'b', 'c', 'd', 'e'] }), raid_level: null }];
        const m = rv.matchForAttack(rows, { playerId: 'p1', level: 3, bossNumber: 3, characters: [] });
        assert.equal(m.id, 5, 'レベル指定つきの凸にレベル無しの予約が紐づかない');
        assert.equal(rv.matchForAttack(rows, { playerId: 'p1', level: 3, bossNumber: 4, characters: [] }).id, null, 'ボス違いは紐づけない');
        // ★ 候補が1件でも、編成が分かっていて約束の編成と違えば紐づけない (Codex指摘 2026-09-08)。
        //   21時に編成①で約束した予約が、9時の編成②の凸で消し込まれてはいけない
        const other = rv.matchForAttack(rows, { playerId: 'p1', level: 3, bossNumber: 3, characters: ['f', 'g', 'h', 'i', 'j'] });
        assert.equal(other.id, null, '別の編成の凸で予約が消し込まれる');
        assert.equal(other.reason, 'team_mismatch');
        const same = rv.matchForAttack(rows, { playerId: 'p1', level: 3, bossNumber: 3, characters: ['e', 'd', 'c', 'b', 'a'] });
        assert.equal(same.id, 5, '順不同で同じ編成なら紐づける');
        // ★ OCR は5人のうち3人しか読めなくても凸を登録する — 読めた3人が約束の編成に入っていれば同じ編成 (Codex指摘)
        assert.equal(rv.matchForAttack(rows, { playerId: 'p1', level: 3, bossNumber: 3, characters: ['a', 'b', 'c'] }).id, 5, '部分的に読めた編成を別物にしている');
        assert.equal(rv.matchForAttack(rows, { playerId: 'p1', level: 3, bossNumber: 3, characters: ['a', 'b', 'x'] }).reason, 'team_mismatch', '約束に無いキャラが混ざっているのに紐づけた');
        // 写しの無い旧予約は編成で判定できないので従来どおり紐づける
        const noSnap = [{ ...res({ id: 6, status: 'approved', boss: 3, team: [] }), raid_level: null }];
        assert.equal(rv.matchForAttack(noSnap, { playerId: 'p1', level: 3, bossNumber: 3, characters: ['f', 'g'] }).id, 6);
    });
    test('★ 予約: 置けない理由はすべて日本語 (コードのまま出さない) / 見込み時刻を添える', () => {
        for (const k of Object.keys(rv.UNMET_JP)) assert.ok(/[ぁ-んァ-ン一-龥]/.test(rv.UNMET_JP[k]), k);
        for (const k of Object.keys(rv.UNASSIGNED_JP)) assert.ok(/[ぁ-んァ-ン一-龥]/.test(rv.UNASSIGNED_JP[k]), k);
        assert.equal(rv.unmetText({ reason: 'time_passed' }), '約束の時刻を過ぎています');
        const t = rv.unmetText({ reason: 'no_boss_at_time', detail: { level: 2, killedLabel: '9時', nextOpenLabel: '11時' } });
        assert.match(t, /そのボスがいない見込み/);
        assert.match(t, /Lv2 は 9時に撃破の見込み/);
        assert.match(t, /Lv3 の開放は 11時/);
        assert.equal(rv.unmetText({ reason: 'zzz' }), '置けませんでした', '未知の理由でもコードを出さない');
    });
    test('★ 予約: 承認すると固定済みの予約が置けなくなるなら止める (同じ人 = 承認不可 / 他人 = 強く警告)', () => {
        const plan = (unmet) => ({ fullyClearedThrough: 3, unusedAttacks: 10, totalCreditedB: 700, levels: [], unmetReservations: unmet });
        // 候補 (id 42, p1) を足すと、p1 の固定済み id 41 が置けなくなる = キャラ被り
        const r = rv.approvalImpact(plan([]), plan([{ reservationId: 41, memberId: 'p1', memberName: 'A', bossNumber: 3, loadoutSlot: 1, reason: 'conflict' }]), null, 42, 'p1');
        assert.equal(r.blocking, true);
        assert.equal(r.blockingHard, true, '同じ人のキャラ被りを承認できてしまう');
        assert.equal(r.breaks.length, 1);
        assert.match(r.breaksText, /A の予約 \(B3 編成①\) が置けなくなります: ほかの凸とキャラが被るため置けません/);
        assert.ok(r.warnings.some(w => w.includes('固定済みの予約が置けなくなります')));
        // 他人の予約が置けなくなる = 止めないが警告
        const o = rv.approvalImpact(plan([]), plan([{ reservationId: 41, memberId: 'p2', memberName: 'B', bossNumber: 3, loadoutSlot: 1, reason: 'conflict' }]), null, 42, 'p1');
        assert.equal(o.blockingHard, false); assert.equal(o.blocking, true); assert.equal(o.breaks.length, 1);
        // もともと置けていなかった予約は「承認で壊れた」に数えない
        const already = plan([{ reservationId: 41, memberId: 'p1', reason: 'conflict' }]);
        assert.equal(rv.approvalImpact(already, already, null, 42, 'p1').breaks.length, 0);
    });
    test('★ 予約: 承認前の影響は「候補そのものが置けない」を最初の警告にして止める', () => {
        const plan = (unmet) => ({ fullyClearedThrough: 3, unusedAttacks: 10, totalCreditedB: 700, levels: [], unmetReservations: unmet });
        const r = rv.approvalImpact(plan([]), plan([{ reservationId: 42, reason: 'no_boss_at_time' }]), null, 42);
        assert.equal(r.blocking, true);
        assert.equal(r.cannotPlace, true);
        assert.match(r.warnings[0], /この予約は置けません: 約束の時刻には、そのボスがいない見込みです/);
        // 別の予約が新たに置けなくなるのは「候補が置けない」ではなく「固定済みが壊れる」(breaks) — 承認不可ではないが警告
        const ok = rv.approvalImpact(plan([]), plan([{ reservationId: 41, reason: 'conflict' }]), null, 42);
        assert.equal(ok.cannotPlace, false, '別の予約の未達で候補を止めてはいけない');
        assert.equal(ok.blockingHard, false, '本人が分からないのに承認不可にしている');
        assert.equal(ok.breaks.length, 1); assert.equal(ok.blocking, true);
        // 何も壊れなければ blocking も false
        const calm = rv.approvalImpact(plan([]), plan([]), null, 42, 'p1');
        assert.equal(calm.blocking, false); assert.equal(calm.breaks.length, 0); assert.equal(calm.breaksText, '');
    });

    // ===== 本人のホーム = 3枠 (2026-09-08) =====
    {
        const mkPlan = (attacks, unassigned = []) => ({
            levels: [{ level: 2, bosses: [{ bossNumber: 3, name: 'ボス3', attribute: 'water', weakness: 'fire',
                attacks: attacks.map(a => ({ memberId: 'p1', loadoutSlot: 1, hourIdx: 8, hourLabel: '13時', team: ['a', 'b', 'c', 'd', 'e'], dmgB: 30, ...a })) }] }],
            unassigned,
        });
        test('★ ホーム3枠: 予約したカードが先頭・配信の割当が続き・空きには理由 (日本語)', () => {
            const resv = [{ ...res({ id: 1, status: 'approved', boss: 3, slot: 'h21', lo: 1 }), raid_level: null, approved_at: 'x' }];
            const plan = mkPlan([{ reservationId: 1, hourIdx: 16, hourLabel: '21時' }, { loadoutSlot: 2, hourIdx: 4, hourLabel: '9時' }],
                                [{ memberId: 'p1', reason: 'char_conflict' }]);
            const h = rv.homeSlots({ plan, viewerId: 'p1', reservations: resv, doneCounts: new Map(), todayAttacks: 0 });
            assert.equal(h.slots.length, 3);
            assert.equal(h.slots[0].kind, 'fixed'); assert.equal(h.slots[0].inPlan, true); assert.equal(h.slots[0].timeSlot, 'h21');
            assert.equal(h.slots[0].level, 2, '配信に入っていればそのレベルを添える');
            assert.equal(h.slots[1].kind, 'plan'); assert.equal(h.slots[1].loadoutSlot, 2);
            assert.equal(h.slots[2].kind, 'empty');
            assert.equal(h.slots[2].text, 'ほかの凸とキャラが被って、使える編成が残っていません');
            assert.equal(h.stale, false);
        });
        test('★ ホーム3枠: 配信が予約を知らなければ stale (運営が組み直し中) / 3枠を超える配信は落とす', () => {
            const resv = [{ ...res({ id: 9, status: 'approved', boss: 3, slot: 'h21', lo: 2 }), raid_level: null, approved_at: 'x' }];
            // 配信は編成① だけ = 予約 (編成②) を知らない
            const plan = mkPlan([{ loadoutSlot: 1 }, { loadoutSlot: 1, hourIdx: 10 }, { loadoutSlot: 1, hourIdx: 12 }]);
            const h = rv.homeSlots({ plan, viewerId: 'p1', reservations: resv, doneCounts: new Map(), todayAttacks: 0 });
            assert.equal(h.stale, true, '配信が予約を知らないのに stale でない');
            assert.equal(h.slots[0].kind, 'fixed'); assert.equal(h.slots[0].inPlan, false);
            assert.equal(h.slots.filter(x => x.kind === 'plan').length, 2, '予約1 + 配信2 で3枠。4枚目を出してはいけない');
        });
        test('★ ホーム3枠: 配信が「置けなかった」予約は stale (組み直し中) にせず unmet で理由を持つ / 配信後の予約にも数えない', () => {
            const resv = [{ ...res({ id: 5, status: 'approved', boss: 3, slot: 'h21', lo: 1 }), raid_level: null, approved_at: 'x' }];
            const plan = mkPlan([{ loadoutSlot: 2, hourIdx: 4, hourLabel: '9時' }]);
            plan.unmetReservations = [{ reservationId: 5, memberId: 'p1', reason: 'conflict' }];
            const h = rv.homeSlots({ plan, viewerId: 'p1', reservations: resv, doneCounts: new Map(), todayAttacks: 0 });
            assert.equal(h.stale, false, '置けなかったのを組み直し待ちにしている');
            assert.equal(h.slots[0].kind, 'fixed'); assert.equal(h.slots[0].unmet, 'conflict');
            assert.equal(h.slots[0].unmetText, 'ほかの凸とキャラが被るため置けません');
            assert.equal(rv.pendingRepublish(resv, plan).count, 0, '置けない予約を「配信後の予約」に数えている');
        });
        test('ホーム3枠: 配信が無ければ空きは「算出待ち」/ プラン外の実凸は枠を消費 / 取り消し希望中も固定', () => {
            const h0 = rv.homeSlots({ plan: null, viewerId: 'p1', reservations: [], doneCounts: new Map(), todayAttacks: 0 });
            assert.deepEqual(h0.slots.map(x => x.kind), ['empty', 'empty', 'empty']);
            assert.equal(h0.slots[0].text, '運営の算出待ちです');
            assert.equal(h0.stale, false, '配信が無いのは stale ではない');
            const h1 = rv.homeSlots({ plan: mkPlan([{}]), viewerId: 'p1', reservations: [], doneCounts: new Map(), todayAttacks: 2 });
            assert.deepEqual(h1.slots.map(x => x.kind), ['plan', 'done', 'done']);
            const cr = [{ ...res({ id: 3, status: 'cancel_requested', boss: 3 }), raid_level: null, approved_at: 'x' }];
            assert.equal(rv.homeSlots({ plan: null, viewerId: 'p1', reservations: cr, doneCounts: new Map() }).slots[0].kind, 'fixed');
            const req = [{ ...res({ id: 4, status: 'requested', boss: 3 }), raid_level: null }];
            assert.equal(rv.homeSlots({ plan: null, viewerId: 'p1', reservations: req, doneCounts: new Map() }).fixedCount, 0, '承認前は固定ではない');
        });
        test('★ 配信後の予約: 配信に入っていない固定予約だけ数える (運営ホームの「確認して下さい」の根拠)', () => {
            const rows = [
                { ...res({ id: 1, status: 'approved', boss: 3, lo: 1 }), raid_level: null },        // 配信に入っている (reservationId)
                { ...res({ id: 2, status: 'approved', boss: 3, lo: 2 }), raid_level: null },        // 入っていない
                { ...res({ id: 3, status: 'requested', boss: 4 }), raid_level: null },              // 承認前は数えない
                { ...res({ id: 4, status: 'approved', boss: 4, pid: 'p2' }), raid_level: null },    // 別人・入っていない
            ];
            const plan = mkPlan([{ reservationId: 1 }]);
            const p = rv.pendingRepublish(rows, plan);
            assert.deepEqual(p.items.map(x => x.id), [2, 4]);
            assert.equal(p.count, 2);
            assert.equal(rv.pendingRepublish(rows, null).count, 3, '配信が無ければ固定予約は全部「配信後」');
            // reservationId が無い古い配信でも、同じカード (誰が・ボス・編成枠) が**同じ時刻**で入っていれば数えない
            const old = mkPlan([{ reservationId: undefined, loadoutSlot: 1, hourIdx: 16, hourLabel: '21時' }]);
            assert.deepEqual(rv.pendingRepublish(rows, old).items.map(x => x.id), [2, 4]);
            // ★ 時刻が違えば「入っている」とみなさない (Codex指摘 2026-09-08: 9時の古い割当が 21時の予約を満たしたことになる)
            const oldWrongTime = mkPlan([{ reservationId: undefined, loadoutSlot: 1, hourIdx: 4, hourLabel: '9時' }]);
            assert.deepEqual(rv.pendingRepublish(rows, oldWrongTime).items.map(x => x.id), [1, 2, 4]);
        });
        test('★ ホーム3枠: reservationId の無い古い配信は、時刻まで揃うときだけ予約を満たしたことにする', () => {
            const resv = [{ ...res({ id: 1, status: 'approved', boss: 3, slot: 'h21', lo: 1 }), raid_level: null, approved_at: 'x' }];
            // 同じカードだが 9時 → 予約 (21時) は配信に入っていない = stale
            const wrong = rv.homeSlots({ plan: mkPlan([{ hourIdx: 4, hourLabel: '9時' }]), viewerId: 'p1', reservations: resv, doneCounts: new Map(), todayAttacks: 0 });
            assert.equal(wrong.stale, true, '時刻違いの古い割当で予約が満たされたことになっている');
            assert.equal(wrong.slots[0].inPlan, false);
            // 21時なら満たしている
            const right = rv.homeSlots({ plan: mkPlan([{ hourIdx: 16, hourLabel: '21時' }]), viewerId: 'p1', reservations: resv, doneCounts: new Map(), todayAttacks: 0 });
            assert.equal(right.stale, false);
            assert.equal(right.slots[0].inPlan, true);
            // ⏳隙間型の予約は flex の行だけが満たす
            const fx = [{ ...res({ id: 2, status: 'approved', boss: 3, flex: true, lo: 1 }), raid_level: null, approved_at: 'x' }];
            assert.equal(rv.homeSlots({ plan: mkPlan([{ flex: true, hourIdx: null, hourLabel: null }]), viewerId: 'p1', reservations: fx, doneCounts: new Map() }).stale, false);
            assert.equal(rv.homeSlots({ plan: mkPlan([{ hourIdx: 16 }]), viewerId: 'p1', reservations: fx, doneCounts: new Map() }).stale, true);
            assert.equal(rv.slotIdxOf('h21'), 16); assert.equal(rv.slotIdxOf('h05'), 0); assert.equal(rv.slotIdxOf('h00'), 19); assert.equal(rv.slotIdxOf('x'), null);
        });
    }

    test('予約: SQL と JS が同じ状態・同じ遷移表を持っている', () => {
        // ★ 片方だけ変えると「画面では押せるのにサーバで弾かれる」になる。機械的に突き合わせる
        const m = _sqlRes.match(/status TEXT NOT NULL DEFAULT 'requested'\s*\n\s*CHECK \(status IN \(([^)]*)\)\)/);
        assert.ok(m, 'status の CHECK が見つからない');
        const sqlStatuses = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort();
        assert.deepEqual(sqlStatuses, [...rv.STATUS].sort(), 'SQL と JS で状態の集合が違う');
        const pick = (from) => {
            const mm = _sqlRes.match(new RegExp(`v_from = '${from}'\\s*AND p_to IN \\(([^)]*)\\)`));
            return mm ? [...mm[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort() : null;
        };
        for (const from of ['requested', 'approved', 'cancel_requested']) {
            assert.deepEqual(pick(from), [...rv.TRANSITIONS[from]].sort(), `${from} の遷移が SQL と違う`);
        }
        // 「枠を押さえている状態」も同じ集合であること (残凸の検査が食い違うと予約を作れない/作りすぎる)
        const cap = _sqlRes.match(/status IN \('requested', 'approved', 'cancel_requested'\)/g) || [];
        assert.ok(cap.length >= 2, `残凸トリガーと部分一意索引が同じ集合を使っていない (${cap.length})`);
        assert.deepEqual([...rv.ACTIVE].sort(), ['approved', 'cancel_requested', 'requested']);
    });

    test('予約: 凸報告RPCが「採番・insert・残HP・消し込み」を1つでやる', () => {
        assert.ok(/CREATE OR REPLACE FUNCTION report_attack\(/.test(_sqlRpc));
        // 同じ人の凸を直列化していないと attack_number が衝突する
        assert.ok(/pg_advisory_xact_lock/.test(_sqlRpc), '直列化していない');
        // 残HPは read-modify-write でなく1文で引く (同時凸で取りこぼさない)
        assert.ok(/SET remaining_hp_raw = GREATEST\(0, COALESCE\(remaining_hp_raw, 0\) - p_damage_raw\)/.test(_sqlRpc));
        // 予約の消し込みと履歴が同じ関数の中にある
        assert.ok(/status = 'fulfilled'/.test(_sqlRpc));
        assert.ok(/INSERT INTO plan_reservation_events/.test(_sqlRpc));
        // 別のボスを殴って予約が消えるのを防ぐ
        assert.ok(/v_res\.boss_number <> p_boss_number/.test(_sqlRpc));
    });

    test('★ 予約: 残凸の検査は同時実行でも破れない (同じ鍵で直列化する)', () => {
        // 2端末が同時に予約を作ると、どちらも同じ v_active を読んで両方通る (Codex指摘 2026-09-07)
        const fn = _sqlRes.match(/CREATE OR REPLACE FUNCTION plan_reservations_capacity_check[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] || '';
        assert.ok(fn, '容量トリガーが見つからない');
        assert.ok(/pg_advisory_xact_lock/.test(fn), '容量検査を直列化していない');
        // ★ 鍵は凸報告RPC と同一にすること — 別の鍵だと「予約を作りながら凸を報告」で同じ穴が開く
        const key = /hashtextextended\('attack:' \|\| ([\w.]+)\.?season_id \|\| ':' \|\| ([\w.]+)\.?player_id, 0\)/;
        assert.ok(key.test(fn), `予約側の鍵の形が違う`);
        assert.ok(/hashtextextended\('attack:' \|\| p_season_id \|\| ':' \|\| p_player_id, 0\)/.test(_sqlRpc),
            '凸報告RPC 側の鍵の形が違う');
    });

    test('★ 予約: 予約と無関係な凸で3凸を超えたら「守れない予約」を返す', () => {
        // 承認済み予約2件 + 予約なしの凸2件 = 4 になる経路がある (Codex指摘 2026-09-07)。
        // ★ 凸は止めない (ゲーム内では既に起きている) が、黙って飲み込まない
        assert.ok(/v_over := GREATEST\(0, \(v_active \+ v_done \+ 1\) - 3\)/.test(_sqlRpc), '超過を数えていない');
        assert.ok(/'over_capacity', v_over/.test(_sqlRpc), '超過を返していない');
        assert.ok(/'reservations_at_risk', to_jsonb\(v_at_risk\)/.test(_sqlRpc), '守れない予約を返していない');
        // 消し込む予約自身は二重に数えない
        assert.ok(/p_reservation_id IS NULL OR id <> p_reservation_id/.test(_sqlRpc));
        // クライアントが握り潰していないこと
        assert.ok(/overCapacity: Number\(rpc\.over_capacity\) \|\| 0/.test(_client));
        assert.ok(/reservationsAtRisk/.test(_client));
    });

    test('★ 予約: 約束と違う形で実行されたら記録する (止めはしない)', () => {
        assert.ok(/v_res\.raid_level IS DISTINCT FROM p_level/.test(_sqlRpc), 'レベルのずれを見ていない');
        assert.ok(/'編成が違う'/.test(_sqlRpc), '編成のずれを見ていない');
        // 履歴の理由に載せる (黙って fulfilled にすると約束どおりに見えてしまう)
        assert.ok(/COALESCE\('凸報告により実行済み \(' \|\| v_mismatch \|\| '\)', '凸報告により実行済み'\)/.test(_sqlRpc));
        assert.ok(/'mismatch', v_mismatch/.test(_sqlRpc));
        // ★ 消し込めるのは固定されている予約 (approved / 承認済み起点の cancel_requested)
        assert.ok(/v_res\.status = 'cancel_requested' AND v_res\.approved_at IS NOT NULL/.test(_sqlRpc), 'RPC が取り消し希望中の予約を消し込めない');
        assert.ok(/VALUES \(p_reservation_id, v_res\.status, 'fulfilled'/.test(_sqlRpc), '履歴の from_status を approved に固定している');
        // ★ ボス違いだけは止める (別のボスを殴って予約が消えるのは事故)
        assert.ok(/v_res\.boss_number <> p_boss_number[\s\S]{0,200}RAISE EXCEPTION/.test(_sqlRpc));
    });

    test('★ 予約: 履歴は append-only / 状態は RPC 経由だけ', () => {
        // RLS が anon 全許可なので、REST から直接 status を書くと履歴だけ欠ける
        assert.ok(/BEFORE UPDATE OR DELETE ON plan_reservation_events/.test(_sqlRes), '履歴が書き換えられる');
        assert.ok(/BEFORE UPDATE ON plan_reservations[\s\S]{0,120}plan_reservations_status_via_rpc/.test(_sqlRes),
            '状態の直接更新が通る');
        // ★ 承認済み以降は「固定する範囲」の後出し変更も弾く
        assert.ok(/承認済みの予約の内容 \(誰が・レベル・ボス・時刻・編成\) は変更できません/.test(_sqlRes),
            '承認済みの中身を書き換えられる');
        assert.ok(/NEW\.characters_snapshot IS DISTINCT FROM OLD\.characters_snapshot/.test(_sqlRes));
        // 承認の瞬間だけは RPC がスナップショットを載せ直せる
        assert.ok(/NEW\.status = 'approved'/.test(_sqlRes), '承認時にスナップショットを固定し直せない');
        assert.ok(/current_setting\('app\.reservation_rpc', true\)/.test(_sqlRes));
        // 正規の経路 (RPC) は自分で名乗る。名乗りが無いと自分の更新まで弾かれる
        assert.ok(/set_config\('app\.reservation_rpc', 'on', true\)/.test(_sqlRes), 'RPC が名乗っていない');
        assert.ok(/set_config\('app\.reservation_rpc', 'on', true\)/.test(_sqlRpc), '凸報告RPC が名乗っていない');
    });

    test('★ 予約: 期待する現在の状態は必須 (取り違えた操作を通さない)', () => {
        assert.ok(/p_expect_from IS NULL OR p_expect_from = ''[\s\S]{0,200}RAISE EXCEPTION/.test(_sqlRes));
        assert.ok(/if \(!o\.expectFrom\) throw new Error/.test(_client), 'クライアント側で省略できてしまう');
    });

    test('★ 予約: 固定時刻は形式まで DB で縛る', () => {
        // 'あ' でも保存できると、ソルバーは未知の時刻を「指定なし」として最速枠に寄せる
        assert.ok(/time_slot ~ '\^h\(0\[0-9\]\|1\[0-9\]\|2\[0-3\]\)\$'/.test(_sqlRes), '時刻の形式を縛っていない');
    });

    test('予約: attacks との紐づけは片方向 (循環参照を作らない)', () => {
        assert.ok(/ALTER TABLE attacks ADD COLUMN IF NOT EXISTS reservation_id/.test(_sqlRes));
        assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_attacks_reservation/.test(_sqlRes));
        // plan_reservations 側に attack_id を作ると相互FK = 復元順が決まらなくなる
        assert.ok(!/attack_id\s+BIGINT/.test(_sqlRes), 'plan_reservations.attack_id を作ってはいけない');
    });

    test('予約: 時刻を確約できない凸が増える候補は警告する', () => {
        const plan = (attacks) => ({
            fullyClearedThrough: 3, unusedAttacks: 12, totalCreditedB: 700,
            levels: [{ level: 2, bosses: [{ bossNumber: 3, attacks }] }],
        });
        const base = plan([{ memberId: 1, loadoutSlot: 1 }]);
        const risky = plan([{ memberId: 1, loadoutSlot: 1, flex: true }]);
        const r = rv.approvalImpact(base, risky, globalThis.planDiffDomain);
        assert.ok(r.warnings.some(w => w.includes('時刻を確約できない凸が増えます')), JSON.stringify(r.warnings));
        assert.equal(r.blocking, false, '時間リスクだけでは承認を止めない (鈍らせるだけ)');
    });
}

// ---- L1: ソルバーの安定化 (前回の約束を守る) ----------------------------------
console.log('\nL1 安定化 (前回配信の割当を守る):');
{
    // 盤面: 3人・弱点がバラけた2ボス。誰がどのボスへ行くかを入れ替えても総与ダメが大きく変わらない形にする
    const mkPlayer = (id, name, byAttr, opts = {}) => ({
        id, name, attackCount: opts.done || 0,
        syncLevel: 500, syncLevelEstimated: false,
        damagesByAttr: Object.fromEntries(Object.entries(byAttr).map(([k, v]) => [k, Math.max(...v.map(x => x.dmgB))])),
        teamsByAttr: {}, loadoutsByAttr: byAttr, attacks: opts.attacks || [],
        availableSlots: opts.slots || ['h05', 'h09', 'h13', 'h17', 'h21'],
        flexTime: false, notifyAllHours: false, strong_attributes: [],
    });
    const lo = (dmgB, team, slot = 1) => ({ dmgB, team, slot, level: null, levels: null });
    // ボス1 の弱点=fire / ボス2 の弱点=water
    const twoBosses = [
        { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord',
          total_hp_raw: 30e9, remaining_hp_raw: 30e9 },
        { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'electric', weakness: 'water', tier: 'lord',
          total_hp_raw: 30e9, remaining_hp_raw: 30e9 },
    ];
    const mkInput = (players, extra = {}) => ({
        season: { id: 1, current_level: 1, hard_date: '2026-09-05' },
        bosses: twoBosses.map(b => ({ ...b })), players,
        currentSlot: 'h05', timeAware: true, onlyAvailableNow: false, crossBoss: false,
        ...extra,
    });
    // 両属性に出せる人が2人。どちらがどちらへ行っても総与ダメはほぼ同じ = 安定化が効くはずの形
    const basePlayers = () => [
        mkPlayer(1, 'A', { fire: [lo(16, ['a1', 'a2', 'a3', 'a4', 'a5'])], water: [lo(16, ['a6', 'a7', 'a8', 'a9', 'a10'])] }),
        mkPlayer(2, 'B', { fire: [lo(16, ['b1', 'b2', 'b3', 'b4', 'b5'])], water: [lo(16, ['b6', 'b7', 'b8', 'b9', 'b10'])] }),
        mkPlayer(3, 'C', { fire: [lo(15, ['c1', 'c2', 'c3', 'c4', 'c5'])] }),
    ];
    const rowsOf = (plan) => {
        const out = [];
        (plan.levels || []).filter(lv => !lv.infinite).forEach(lv => (lv.bosses || []).forEach(b =>
            (b.attacks || []).forEach(a => out.push(`L${lv.level}/B${b.bossNumber}/${a.memberId}/${a.loadoutSlot}`))));
        return out.sort();
    };

    test('L1: previousPlan を渡さなければ stability は null (従来と同じ扱い)', () => {
        const p = compute(mkInput(basePlayers()));
        assert.equal(p.stability, null);
    });

    test('L1: 前回と同じ盤面なら、前回の割当がそのまま維持される', () => {
        const first = compute(mkInput(basePlayers()));
        const again = compute(mkInput(basePlayers(), { previousPlan: first }));
        assert.deepEqual(rowsOf(again), rowsOf(first), '同じ盤面で割当が動いた');
        assert.ok(again.stability, 'stability が出ていない');
        assert.equal(again.stability.reason, 'kept');
        assert.equal(again.stability.applied, true);
    });

    test('L1: 前回の割当を人為的に入れ替えても、損が閾値未満ならそちらを守る', () => {
        const natural = compute(mkInput(basePlayers()));
        // A と B のボスを入れ替えた「前回プラン」を作る (火力が同じなので総与ダメはほぼ変わらない)
        const swapped = JSON.parse(JSON.stringify(natural));
        let touched = 0;
        swapped.levels.filter(lv => !lv.infinite).forEach(lv => lv.bosses.forEach(b => b.attacks.forEach(a => {
            if (a.memberId === 1) { a.memberId = 2; a.memberName = 'B'; touched++; }
            else if (a.memberId === 2) { a.memberId = 1; a.memberName = 'A'; touched++; }
        })));
        assert.ok(touched >= 2, `入れ替え対象が足りない (${touched})`);
        const kept = compute(mkInput(basePlayers(), { previousPlan: swapped }));
        assert.equal(kept.stability.applied, true, `守られなかった: ${JSON.stringify(kept.stability)}`);
        assert.deepEqual(rowsOf(kept), rowsOf(swapped), '前回どおりに置かれていない');
        // 自然解とは違う = 本当に「前回どおり」を選んでいる (通るだけのテストにしない)
        assert.notDeepEqual(rowsOf(kept), rowsOf(natural));
    });

    test('L1: 前回の約束が実現不能なら黙って諦め、残りは通常どおり埋まる', () => {
        // 前回 A がボス1へ行く約束だったが、実際には A がもう3凸済み
        const first = compute(mkInput(basePlayers()));
        const players = basePlayers();
        players[0] = mkPlayer(1, 'A', { fire: [lo(16, ['a1', 'a2', 'a3', 'a4', 'a5'])] }, { done: 3 });
        const p = compute(mkInput(players, { previousPlan: first }));
        const ids = new Set(rowsOf(p).map(r => r.split('/')[2]));
        assert.ok(!ids.has('1'), '3凸済みの人が置かれている');
        assert.ok(p.totalAttacks > 0, '残りが埋まっていない');
    });

    test('L1: 踏破レベルが上がるなら約束を捨てる (無条件)', () => {
        // 前回プランは「1人だけがボス1へ行く」= HPを削り切れない案。
        // 通常解は全員を動員して踏破できる → clearLevel で通常解を採るはず
        const players = basePlayers();
        const natural = compute(mkInput(players));
        const crippled = JSON.parse(JSON.stringify(natural));
        crippled.levels.filter(lv => !lv.infinite).forEach(lv => lv.bosses.forEach(b => {
            b.attacks = b.attacks.slice(0, 1);   // 各ボス1凸だけの約束にする
        }));
        const p = compute(mkInput(players, { previousPlan: crippled }));
        assert.ok(p.stability, 'stability が出ていない');
        // 拘束解の方が踏破が低いなら通常解が採られる。同じなら守られる — どちらでも
        // 「1凸だけ」で終わっていないことが要件 (約束のせいで攻略を捨てていない)
        assert.ok(p.totalAttacks > 2, `約束に引きずられて凸が減っている: ${p.totalAttacks}`);
    });

    test('L1: 壊れた previousPlan でも落ちない', () => {
        const players = basePlayers();
        for (const bad of [null, {}, { levels: null }, { levels: [{ level: 9, bosses: [] }] },
                           { levels: [{ level: 1, bosses: [{ bossNumber: 1, attacks: [{ }] }] }] }]) {
            const p = compute(mkInput(players, { previousPlan: bad }));
            assert.ok(p && Array.isArray(p.levels), `落ちた: ${JSON.stringify(bad)}`);
        }
    });

    // ---- ここから下は「拘束を直接組み立てて」経路を通す。
    //      自然解から作った previousPlan だけだと、閾値・保護・被り判定の分岐に入らない ----
    const stickyPlan = (entries) => ({
        levels: [{
            level: 1,
            bosses: [1, 2].map(n => ({
                bossNumber: n,
                attacks: entries.filter(e => e.boss === n)
                    .map(e => ({ memberId: e.id, memberName: `P${e.id}`, loadoutSlot: e.slot || 1 })),
            })),
        }],
    });

    test('L1: 閾値の内側なら損でも約束を守り、閾値を超えたら組み直す', () => {
        // A は fire が強く water が弱い / B はその逆。素直に組めば A→B1・B→B2。
        // 前回の約束が逆 (A→B2・B→B1) のとき、損の大きさで採否が変わることを見る。
        // ★ 残凸を1にする (done:2) — 3凸あると「約束を置いたうえで良い方にも行く」ので損が出ない。
        // ★ ボスHPを大きくして誰も倒せない盤面にする — 撃破すると次レベルが開いて
        //   credited が跳ね、閾値の内側/外側を作り分けられない
        const bigHp = [
            { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord',
              total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
            { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'electric', weakness: 'water', tier: 'lord',
              total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
        ];
        const mk = (waterA, fireB) => [
            mkPlayer(1, 'A', { fire: [lo(30, ['a1', 'a2', 'a3', 'a4', 'a5'])], water: [lo(waterA, ['a6', 'a7', 'a8', 'a9', 'a10'])] }, { done: 2 }),
            mkPlayer(2, 'B', { fire: [lo(fireB, ['b1', 'b2', 'b3', 'b4', 'b5'])], water: [lo(30, ['b6', 'b7', 'b8', 'b9', 'b10'])] }, { done: 2 }),
        ];
        const swapped = stickyPlan([{ id: 1, boss: 2 }, { id: 2, boss: 1 }]);
        // ① 損が小さい (各 5B ずつ低いだけ = 合計 10B) → 守る
        const small = compute(mkInput(mk(25, 25), { previousPlan: swapped, bosses: bigHp.map(b => ({ ...b })) }));
        assert.equal(small.stability.applied, true, `小さい損で守られなかった: ${JSON.stringify(small.stability)}`);
        assert.ok(small.stability.creditedGapB < small.stability.thresholdB,
            `閾値の内側のはず: gap=${small.stability.creditedGapB} th=${small.stability.thresholdB}`);
        // ★ 閾値そのものを固定する (定数を 0 にする変異を検出するため)
        assert.ok(small.stability.thresholdB >= 30 - 1e-9,
            `閾値が小さすぎる: ${small.stability.thresholdB}`);
        // ② 損が大きい (各 30B → 1B = 合計 58B) → 組み直す
        const big = compute(mkInput(mk(1, 1), { previousPlan: swapped, bosses: bigHp.map(b => ({ ...b })) }));
        assert.equal(big.stability.applied, false, `大きい損でも守ってしまった: ${JSON.stringify(big.stability)}`);
        assert.equal(big.stability.reason, 'creditedGain');
    });

    test('L1: 踏破レベルが上がるなら閾値に関係なく組み直す', () => {
        // ボス1 (HP30) は A の fire 30 でちょうど倒せる。前回の約束は A を water 側に回す案 =
        // ボス1 が倒せず踏破が落ちる。損は小さくても踏破が上がる通常解を採るべき
        // ★ 残凸を1にする (done:2)。3凸あると、約束を置いたあとで貪欲がボス1も倒してしまい
        //   踏破レベルが並んでしまう (この分岐に入らない)
        const players = [
            mkPlayer(1, 'A', { fire: [lo(30, ['a1', 'a2', 'a3', 'a4', 'a5'])], water: [lo(29, ['a6', 'a7', 'a8', 'a9', 'a10'])] }, { done: 2 }),
            mkPlayer(2, 'B', { water: [lo(30, ['b6', 'b7', 'b8', 'b9', 'b10'])] }, { done: 2 }),
        ];
        const away = stickyPlan([{ id: 1, boss: 2 }, { id: 2, boss: 2 }]);
        const p = compute(mkInput(players, { previousPlan: away }));
        assert.equal(p.stability.applied, false, `踏破が落ちる約束を守ってしまった: ${JSON.stringify(p.stability)}`);
        assert.equal(p.stability.reason, 'clearLevel');
    });

    test('L1: 約束した凸はオーバーキル圧縮で外されない', () => {
        // ボス1 (HP30) に 25B → 30B の順で約束する。25B を置いた時点で残5B、30B で撃破。
        // 通常の trimOverkill は「25B を外しても倒せる」ので外しにいくが、
        // 約束した凸を外すと「安定させるために置いたのに消える」= 目的と矛盾するので残す。
        // ★ 逆順 (30B が先) だと 2人目を置く前にボスが落ちて、そもそも置かれない
        //   (撃破済みのボスには約束を置かない)。この順序でないと圧縮の分岐に入らない
        // ★ ボス2 を倒せる C を入れてレベルを踏破させる — 踏破できないと吸収モードになり、
        //   撃破済みのボスは横断ループが飛ばすので trimOverkill 自体が走らない
        const players = [
            mkPlayer(1, 'A', { fire: [lo(25, ['a1', 'a2', 'a3', 'a4', 'a5'])] }),
            mkPlayer(2, 'B', { fire: [lo(30, ['b1', 'b2', 'b3', 'b4', 'b5'])] }),
            mkPlayer(3, 'C', { water: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5'])] }),
        ];
        const both = stickyPlan([{ id: 1, boss: 1 }, { id: 2, boss: 1 }]);
        const p = compute(mkInput(players, { previousPlan: both }));
        const b1 = p.levels.find(lv => lv.level === 1).bosses.find(b => b.bossNumber === 1);
        const ids = (b1.attacks || []).map(a => a.memberId).sort();
        assert.deepEqual(ids, [1, 2], `約束した凸が外された: ${JSON.stringify(ids)} / ${JSON.stringify(p.stability)}`);
    });

    test('L1: 約束でもキャラが被る編成は置かない (同じ人を2回使わない)', () => {
        // A の fire と water がキャラを共有している。前回の約束が両方でも、2つ目は置けない
        const players = [
            mkPlayer(1, 'A', {
                fire: [lo(30, ['共有', 'a2', 'a3', 'a4', 'a5'])],
                water: [lo(30, ['共有', 'a7', 'a8', 'a9', 'a10'])],
            }),
        ];
        const both = stickyPlan([{ id: 1, boss: 1 }, { id: 1, boss: 2 }]);
        const p = compute(mkInput(players, { previousPlan: both }));
        const lv1 = p.levels.find(lv => lv.level === 1);
        const mine = lv1.bosses.flatMap(b => b.attacks || []).filter(a => a.memberId === 1);
        assert.equal(mine.length, 1, `キャラ被りの編成まで置かれた: ${JSON.stringify(mine.map(a => a.dmgB))}`);
    });

    // ⚠ この規則 (countStickyKept) の**回帰検出は tests/bench-stability.mjs の ①** が担う。
    //   最小盤面では「拘束解の方が約束を壊す」状況を作れなかった (圧縮の戻り・温存パスの
    //   相互作用で起きるため)。規則を外すと bench の同一盤面違反が 0% → 3.5% になることを確認済み。
    //   ここでは「結果として約束が壊れていないこと」だけを固定する
    test('L1: 拘束解の方が約束を壊すなら通常解を採る (同一盤面で人が動かない土台)', () => {
        // 前回プランをそのまま基準にして同じ盤面を解き直す。拘束を先に置くと貪欲の途中状態が
        // ずれて、かえって前回の割当を壊すことがある。そのときは通常解 (= 前回そのもの) を採る
        const players = basePlayers();
        const first = compute(mkInput(players));
        const again = compute(mkInput(basePlayers(), { previousPlan: first }));
        // どちらを採ったにせよ、**前回の割当が1つも壊れていない**ことが要件
        const rows = (plan) => {
            const m = new Map();
            (plan.levels || []).filter(lv => !lv.infinite).forEach(lv => (lv.bosses || []).forEach(b =>
                (b.attacks || []).forEach(a => {
                    const k = `${a.memberId}`;
                    if (!m.has(k)) m.set(k, []);
                    m.get(k).push(`L${lv.level}/B${b.bossNumber}/${a.loadoutSlot}`);
                })));
            m.forEach(v => v.sort());
            return m;
        };
        const before = rows(first), after = rows(again);
        before.forEach((list, id) => {
            const pool = [...(after.get(id) || [])];
            list.forEach(r => {
                const i = pool.indexOf(r);
                assert.ok(i >= 0, `${id} の約束「${r}」が消えた (前: ${list.join(',')} / 後: ${(after.get(id) || []).join(',')})`);
                pool.splice(i, 1);
            });
        });
        assert.ok(['kept', 'lessKept'].includes(again.stability.reason), `想定外の判定: ${JSON.stringify(again.stability)}`);
    });

    test('L1: 拘束は決定的な順序で入る (前回プランの並び順で結果が変わらない)', () => {
        // 同じボスに2人ぶん約束する = 置いた順で usedB / overflowB の配り方が変わる形。
        // 並べ替えを外すと入力の配列順がそのまま出るので、逆順で渡すと結果が変わる
        const players = [
            mkPlayer(1, 'A', { fire: [lo(20, ['a1', 'a2', 'a3', 'a4', 'a5'])] }),
            mkPlayer(2, 'B', { fire: [lo(25, ['b1', 'b2', 'b3', 'b4', 'b5'])] }),
        ];
        const fwd = stickyPlan([{ id: 1, boss: 1 }, { id: 2, boss: 1 }]);
        const rev = JSON.parse(JSON.stringify(fwd));
        rev.levels.forEach(lv => lv.bosses.forEach(b => (b.attacks || []).reverse()));
        const shot = (p) => JSON.stringify(p.levels.filter(lv => !lv.infinite).map(lv => lv.bosses.map(b =>
            (b.attacks || []).map(a => [a.memberId, a.dmgB, a.usedB, a.overflowB]))));
        const a = compute(mkInput(players, { previousPlan: fwd }));
        const b = compute(mkInput(players, { previousPlan: rev }));
        assert.equal(shot(a), shot(b), '前回プランの並び順で結果が変わる (投入順が入力依存になっている)');
    });
}

// ---- L2: 予約がソルバーを拘束する --------------------------------------------
console.log('\nL2 予約の拘束 (ソルバー):');
{
    const mkPlayer = (id, name, byAttr, opts = {}) => ({
        id, name, attackCount: opts.done || 0,
        syncLevel: 500, syncLevelEstimated: false,
        damagesByAttr: Object.fromEntries(Object.entries(byAttr).map(([k, v]) => [k, Math.max(...v.map(x => x.dmgB))])),
        teamsByAttr: {}, loadoutsByAttr: byAttr, attacks: opts.attacks || [],
        availableSlots: opts.slots || ['h05', 'h09', 'h13', 'h17', 'h21'],
        flexTime: false, notifyAllHours: false, strong_attributes: [],
    });
    const lo = (dmgB, team, slot = 1) => ({ dmgB, team, slot, level: null, levels: null });
    const bosses2 = () => ([
        { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord',
          total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
        { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'electric', weakness: 'water', tier: 'lord',
          total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
    ]);
    const mkInput = (players, extra = {}) => ({
        season: { id: 1, current_level: 1, hard_date: '2026-09-05' },
        bosses: bosses2(), players,
        currentSlot: 'h05', timeAware: true, onlyAvailableNow: false, crossBoss: false,
        ...extra,
    });
    const rowOf = (plan, memberId) => {
        const out = [];
        (plan.levels || []).filter(lv => !lv.infinite).forEach(lv => (lv.bosses || []).forEach(b =>
            (b.attacks || []).filter(a => a.memberId === memberId).forEach(a =>
                out.push(`L${lv.level}/B${b.bossNumber}/${a.loadoutSlot}/${a.hourLabel || (a.flex ? 'flex' : '-')}`))));
        return out.sort();
    };
    // A は fire が強い。素直に組めば A→B1 (fire)
    const players2 = () => [
        mkPlayer(1, 'A', { fire: [lo(60, ['a1', 'a2', 'a3', 'a4', 'a5'])], water: [lo(10, ['a6', 'a7', 'a8', 'a9', 'a10'])] }, { done: 2 }),
        mkPlayer(2, 'B', { water: [lo(60, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { done: 2 }),
    ];
    const resv = (o) => ({ reservationId: o.id ?? 1, memberId: o.member, level: o.lv ?? 1,
        bossNumber: o.boss, loadoutSlot: o.lo ?? 1, flex: !!o.flex, timeSlot: o.flex ? null : (o.slot ?? 'h13') });

    // ===== 2026-09-08: レベルの無い予約 (メンバー発) は時間軸からレベルを決める =====
    // 盤面: A/B は 9時にしか出られない → Lv1 (各20B) は 9時に踏破 → Lv2 は 9時開放 (火力不足で踏破はしない)
    const tl = () => ([
        mkPlayer(1, 'A', { fire: [lo(60, ['a1', 'a2', 'a3', 'a4', 'a5'])] }, { slots: ['h09'] }),
        mkPlayer(2, 'B', { water: [lo(60, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { slots: ['h09'] }),
        mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5'])] }, { done: 2, slots: ['h05', 'h07', 'h13'] }),
    ]);
    const smallB = (b1hp = 20e9) => bosses2().map(b => ({ ...b, total_hp_raw: 20e9,
        remaining_hp_raw: b.boss_number === 1 ? b1hp : 20e9 }));
    const free = (o) => ({ ...resv(o), level: null });
    const rv = globalThis.reservationsDomain;

    test('★ L2: レベル無しの予約は「その時刻にそのボスがいるレベル」に置かれる (Lv1 の窓 / Lv2 の窓)', () => {
        const early = compute(mkInput(tl(), { bosses: smallB(), reservations: [free({ id: 1, member: 3, boss: 1, slot: 'h07' })] }));
        assert.deepEqual(rowOf(early, 3), ['L1/B1/1/7時'], `7時は Lv1 の窓: ${JSON.stringify(rowOf(early, 3))} / ${JSON.stringify(early.unmetReservations)}`);
        assert.deepEqual(early.unmetReservations, []);
        const late = compute(mkInput(tl(), { bosses: smallB(), reservations: [free({ id: 2, member: 3, boss: 1, slot: 'h13' })] }));
        assert.deepEqual(rowOf(late, 3), ['L2/B1/1/13時'], `13時は Lv2 の窓: ${JSON.stringify(rowOf(late, 3))} / ${JSON.stringify(late.unmetReservations)}`);
        assert.deepEqual(late.unmetReservations, []);
        assert.equal(late.reservationCount, 1);
    });

    test('★ L2: いまのレベルで倒れたボスに、次のレベルが開く前の時刻 → 置かず「そのボスがいない見込み」を日本語で', () => {
        const p = compute(mkInput(tl(), { bosses: smallB(0), reservations: [free({ id: 3, member: 3, boss: 1, slot: 'h07' })] }));
        // 置けない予約は拘束にならない = 本人はほかの凸に普通に使われる (運営が2択で処理するまで)
        assert.ok(!rowOf(p, 3).includes('L1/B1/1/7時'), `倒れているボスへ置いてしまった: ${JSON.stringify(rowOf(p, 3))}`);
        assert.equal(p.unmetReservations.length, 1);
        const u = p.unmetReservations[0];
        assert.equal(u.reason, 'no_boss_at_time');
        assert.equal(u.reservationId, 3);
        assert.equal(u.memberName, 'C', '運営の画面で名前を出すため');
        assert.equal(u.detail?.killed, true);
        assert.equal(u.detail?.nextOpenLabel, '9時', `次の開放見込み: ${JSON.stringify(u.detail)}`);
        const t = rv.unmetText(u);
        assert.match(t, /そのボスがいない見込み/);
        assert.match(t, /Lv1 ではもう倒れています/);
        assert.match(t, /Lv2 の開放は 9時/);
        assert.ok(!/no_boss_at_time/.test(t), 'コードが日本語に混ざっている');
    });

    test('★ L2: 約束の時刻を過ぎたレベル無しの予約は time_passed / ⏳隙間型は倒れていれば次のレベルへ', () => {
        const past = compute(mkInput(tl(), { bosses: smallB(), currentSlot: 'h13',
            reservations: [free({ id: 4, member: 3, boss: 1, slot: 'h07' })] }));
        assert.equal(past.unmetReservations[0]?.reason, 'time_passed', JSON.stringify(past.unmetReservations));
        assert.equal(rv.unmetText(past.unmetReservations[0]), '約束の時刻を過ぎています');
        const fx = compute(mkInput(tl(), { bosses: smallB(0), reservations: [free({ id: 5, member: 3, boss: 1, flex: true })] }));
        assert.deepEqual(rowOf(fx, 3), ['L2/B1/1/flex'], `倒れたボスの隙間予約は次のレベルへ: ${JSON.stringify(rowOf(fx, 3))} / ${JSON.stringify(fx.unmetReservations)}`);
    });

    test('★ L2: レベル付きの予約 (締め凸の了承) は今までどおりそのレベルに置く', () => {
        const p = compute(mkInput(tl(), { bosses: smallB(), reservations: [resv({ id: 6, member: 3, boss: 1, lv: 2, slot: 'h13' })] }));
        assert.deepEqual(rowOf(p, 3), ['L2/B1/1/13時']);
        // Lv1 の窓の時刻に Lv2 を指定 = 開放前 → 置かず before_open
        const q = compute(mkInput(tl(), { bosses: smallB(), reservations: [resv({ id: 7, member: 3, boss: 1, lv: 2, slot: 'h07' })] }));
        assert.equal(q.unmetReservations[0]?.reason, 'before_open', JSON.stringify(q.unmetReservations));
        assert.match(rv.unmetText(q.unmetReservations[0]), /Lv2 の開放は 9時/);
    });

    test('★ L2: 後のレベルに予約がある人の残り凸は、手前のレベルの貪欲に使わせない (別編成でも)', () => {
        // C は火の編成を2つ持ち、残り1凸。編成①を Lv2 (13時) に予約 → 手前の Lv1 で編成②を使われると
        // 残り凸が無くなり、Lv2 の約束が置けない。取り置きが無いと L1/B1/2/5時 になる
        const ps = tl();
        ps[2] = mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5']), lo(25, ['c6', 'c7', 'c8', 'c9', 'c10'], 2)] },
                         { done: 2, slots: ['h05', 'h07', 'h13'] });
        const p = compute(mkInput(ps, { bosses: smallB(), reservations: [free({ id: 8, member: 3, boss: 1, lo: 1, slot: 'h13' })] }));
        assert.deepEqual(rowOf(p, 3), ['L2/B1/1/13時'], `取り置きが効いていない: ${JSON.stringify(rowOf(p, 3))} / ${JSON.stringify(p.unmetReservations)}`);
        assert.deepEqual(p.unmetReservations, []);
        // 残り2凸なら、手前のレベルで編成②を使ってよい (取り置くのは予約のぶんだけ)
        ps[2] = mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5']), lo(25, ['c6', 'c7', 'c8', 'c9', 'c10'], 2)] },
                         { done: 1, slots: ['h05', 'h07', 'h13'] });
        const q = compute(mkInput(ps, { bosses: smallB(), reservations: [free({ id: 9, member: 3, boss: 1, lo: 1, slot: 'h13' })] }));
        assert.ok(rowOf(q, 3).includes('L2/B1/1/13時'), `予約が置けていない: ${JSON.stringify(rowOf(q, 3))}`);
        assert.ok(rowOf(q, 3).some(r => r.startsWith('L1/') && r.includes('/2/')), `編成②を手前で使ってよい: ${JSON.stringify(rowOf(q, 3))}`);
    });

    test('★ L2: レベルの解決は予約込みで解き直してもう1回引く (窓が縮んだら次のレベルへ)', () => {
        // D (6時) と E (7時) の予約で Lv1 の2体が 7時までに倒れる → Lv1 の窓は [5時, 7時) に縮む。
        // レベル付きの予約だけで解いた1回目の窓は [5時, 9時) なので、C の 8時の予約は1回目では Lv1 に入るが、
        // 2回目で Lv2 に移らないと「倒れたボスへ置けない」= 未達になる
        const ps = [
            ...tl(),
            mkPlayer(4, 'D', { fire: [lo(60, ['d1', 'd2', 'd3', 'd4', 'd5'])] }, { done: 2, slots: ['h06'] }),
            mkPlayer(5, 'E', { water: [lo(60, ['e1', 'e2', 'e3', 'e4', 'e5'])] }, { done: 2, slots: ['h07'] }),
        ];
        ps[2] = mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5'])] }, { done: 2, slots: ['h05', 'h08', 'h13'] });
        const p = compute(mkInput(ps, { bosses: smallB(), reservations: [
            free({ id: 11, member: 4, boss: 1, slot: 'h06' }), free({ id: 12, member: 5, boss: 2, slot: 'h07' }),
            free({ id: 13, member: 3, boss: 1, slot: 'h08' }),
        ] }));
        assert.deepEqual(p.unmetReservations, [], `2回目の引き直しが効いていない: ${JSON.stringify(p.unmetReservations)}`);
        assert.deepEqual(rowOf(p, 3), ['L2/B1/1/8時'], `8時は縮んだ窓の外 = Lv2: ${JSON.stringify(rowOf(p, 3))}`);
    });

    test('★ L2: Lv3 踏破後の時刻に置かれたボス5の予約は、Lv4 で約束の編成・時刻で置く (Codex指摘: 黙って壊れていた)', () => {
        // Lv3 (残HP わずか) を 5時に踏破 → Lv4 開放 5時。C は編成① (30B) を 13時に予約。編成② (50B) の方が強い
        const b5 = () => ([
            { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord', total_hp_raw: 292e9, remaining_hp_raw: 1e9 },
            { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'electric', weakness: 'water', tier: 'lord', total_hp_raw: 292e9, remaining_hp_raw: 1e9 },
            // Lv3 のボス5 (有限) も残りわずか — 3体倒せば Lv3 踏破 → Lv4 (ボス5・無限) が開く
            { boss_number: 5, boss_code: 'B5', name: 'ボス5', attribute: 'water', weakness: 'fire', tier: 'tyrant', total_hp_raw: 349e9, remaining_hp_raw: 1e9 },
        ]);
        const ps = [
            mkPlayer(1, 'A', { fire: [lo(60, ['a1', 'a2', 'a3', 'a4', 'a5'])] }, { done: 2, slots: ['h05'] }),
            mkPlayer(2, 'B', { water: [lo(60, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { done: 2, slots: ['h05'] }),
            mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5']), lo(50, ['c6', 'c7', 'c8', 'c9', 'c10'], 2)] }, { done: 1, slots: ['h05', 'h13'] }),
            // F が Lv3 のボス5 (有限) を倒す。C の凸は Lv4 の予約のために取り置かれるので、C 抜きで Lv3 を踏破できる盤面にする
            mkPlayer(6, 'F', { fire: [lo(60, ['f1', 'f2', 'f3', 'f4', 'f5'])] }, { done: 2, slots: ['h05'] }),
        ];
        const lv4rows = (plan, id) => (plan.levels || []).filter(lv => lv.infinite).flatMap(lv => lv.bosses.flatMap(b =>
            (b.attacks || []).filter(a => a.memberId === id).map(a => `${a.loadoutSlot}/${a.hourLabel || (a.flex ? 'flex' : '-')}/${a.reservationId ?? '-'}`))).sort();
        const p = compute(mkInput(ps, { season: { id: 1, current_level: 3, hard_date: '2026-09-05' }, bosses: b5(),
            reservations: [free({ id: 21, member: 3, boss: 5, lo: 1, slot: 'h13' })] }));
        assert.equal(p.lv4Open, true, `前提: Lv4 が開く (${p.fullyClearedThrough})`);
        assert.ok(lv4rows(p, 3).includes('1/13時/21'), `約束の編成①を 13時に置いていない: ${JSON.stringify(lv4rows(p, 3))}`);
        assert.deepEqual(p.unmetReservations, []);
        // 残り1凸なら、強い編成② ではなく約束の編成① だけを置く
        ps[2] = mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5']), lo(50, ['c6', 'c7', 'c8', 'c9', 'c10'], 2)] }, { done: 2, slots: ['h05', 'h13'] });
        const q = compute(mkInput(ps, { season: { id: 1, current_level: 3, hard_date: '2026-09-05' }, bosses: b5(),
            reservations: [free({ id: 22, member: 3, boss: 5, lo: 1, slot: 'h13' })] }));
        assert.equal(q.lv4Open, true, `前提: C 抜きで Lv3 を踏破できる (${q.fullyClearedThrough})`);
        assert.deepEqual(lv4rows(q, 3), ['1/13時/22'], `強い編成で約束を上書きした: ${JSON.stringify(lv4rows(q, 3))}`);
        assert.deepEqual(q.unmetReservations, []);
        // 取り置きは Lv4 の予約ぶんにも効く: 残り1凸の C は Lv3 で使われない
        assert.deepEqual(rowOf(q, 3), [], `Lv4 の予約ぶんが Lv3 で使われた: ${JSON.stringify(rowOf(q, 3))}`);
        // ★ Lv4 に解決した予約が置けなかったら、未達として理由つきで出る (黙って落とさない)。
        //   編成② を予約したのに提出が編成① しか無い → loadout_gone
        ps[2] = mkPlayer(3, 'C', { fire: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5'])] }, { done: 2, slots: ['h05', 'h13'] });
        const u = compute(mkInput(ps, { season: { id: 1, current_level: 3, hard_date: '2026-09-05' }, bosses: b5(),
            reservations: [free({ id: 23, member: 3, boss: 5, lo: 2, slot: 'h13' })] }));
        assert.equal(u.lv4Open, true);
        assert.equal(u.unmetReservations.length, 1, `Lv4 の未達を落とした: ${JSON.stringify(u.unmetReservations)}`);
        assert.equal(u.unmetReservations[0].level, 4);
        assert.equal(u.unmetReservations[0].reason, 'loadout_gone');
    });

    test('★ 未割当の理由: 提出なし / 編成を使い切った / キャラ被り — 本人のホームの空き枠に日本語で出すため', () => {
        const ps = [
            mkPlayer(1, 'A', { fire: [lo(60, ['a1', 'a2', 'a3', 'a4', 'a5'])] }, { slots: ['h09'] }),      // 1枚だけ → 使い切り
            mkPlayer(2, 'B', { water: [lo(60, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { slots: ['h09'] }),
            mkPlayer(4, 'D', {}, {}),                                                                       // 提出なし
            mkPlayer(5, 'E', { fire: [lo(50, ['x', 'e2', 'e3', 'e4', 'e5']), lo(40, ['x', 'e7', 'e8', 'e9', 'e10'], 2)] }, { done: 1 }),   // 被り
        ];
        const p = compute(mkInput(ps, { bosses: smallB() }));
        const by = new Map((p.unassigned || []).map(u => [u.memberId, u]));
        assert.equal(by.get(4)?.reason, 'no_loadout', JSON.stringify(p.unassigned));
        assert.equal(by.get(4)?.remaining, 3);
        assert.equal(by.get(1)?.reason, 'cards_used_up', JSON.stringify(p.unassigned));
        assert.equal(by.get(5)?.reason, 'char_conflict', JSON.stringify(p.unassigned));
        assert.equal(by.get(4)?.memberName, 'D');
        for (const u of p.unassigned) assert.ok(rv.UNASSIGNED_JP[u.reason], `日本語が無い理由: ${u.reason}`);
    });

    test('L2: 予約を渡さなければ unassigned 以外の出力は従来どおり (指紋テストが割当を固定)', () => {
        const p = compute(mkInput(players2()));
        assert.ok(Array.isArray(p.unassigned));
        assert.deepEqual(p.unmetReservations, []);
    });

    test('L2: 予約は素直な解より優先される (弱い編成でも約束どおり置く)', () => {
        const natural = compute(mkInput(players2()));
        assert.deepEqual(rowOf(natural, 1), ['L1/B1/1/5時'], `前提が崩れた: ${JSON.stringify(rowOf(natural, 1))}`);
        // A を water 側 (10B) に予約する = 素直な解より明確に損だが、約束なので守る
        const p = compute(mkInput(players2(), { reservations: [resv({ id: 7, member: 1, boss: 2, slot: 'h13' })] }));
        assert.deepEqual(rowOf(p, 1), ['L1/B2/1/13時'], `予約が効いていない: ${JSON.stringify(rowOf(p, 1))}`);
        assert.deepEqual(p.unmetReservations, []);
        assert.equal(p.reservationCount, 1);
    });

    test('★ L2: 予約後に本人が編成を変えても、承認時のスナップショットで計画する', () => {
        // ユーザー決定 2026-09-07: 「予約した編成はそのまま守り、残り2凸は本人が調整する」。
        // 現在の模擬を見に行くと、編成を変えた瞬間に約束と違う指示になる (Codex指摘)
        const snap = (o) => ({ ...resv(o), team: o.team, expectedB: o.exp });
        // 本人の現在の fire ① は c1〜c5 / 60B。予約は承認時の a1〜a5 / 44B
        const changed = () => [
            mkPlayer(1, 'A', { fire: [lo(60, ['c1', 'c2', 'c3', 'c4', 'c5'])] }, { done: 2 }),
            mkPlayer(2, 'B', { water: [lo(60, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { done: 2 }),
        ];
        const p = compute(mkInput(changed(), {
            reservations: [snap({ id: 31, member: 1, boss: 1, slot: 'h13', team: ['a1', 'a2', 'a3', 'a4', 'a5'], exp: 44 })],
        }));
        assert.deepEqual(rowOf(p, 1), ['L1/B1/1/13時'], '予約が置けていない');
        assert.deepEqual(p.unmetReservations, [], '編成を変えただけで実行不能にしてはいけない');
        const a = p.levels[0].bosses.find(b => b.bossNumber === 1).attacks.find(x => x.memberId === 1);
        assert.deepEqual(a.team, ['a1', 'a2', 'a3', 'a4', 'a5'], '現在の編成で計画してしまっている');
        assert.equal(a.dmgB, 44, '現在のダメージで計画してしまっている');
    });

    test('★ L2: 予約した編成を本人が消しても予約は守る', () => {
        // 編成が消えたら unmet にする実装だと、本人の操作ひとつで約束が消える
        const gone = () => [
            mkPlayer(1, 'A', { water: [lo(10, ['a6', 'a7', 'a8', 'a9', 'a10'])] }, { done: 2 }),   // fire ごと無い
            mkPlayer(2, 'B', { water: [lo(60, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { done: 2 }),
        ];
        const p = compute(mkInput(gone(), {
            reservations: [{ ...resv({ id: 32, member: 1, boss: 1, slot: 'h13' }),
                team: ['a1', 'a2', 'a3', 'a4', 'a5'], expectedB: 44 }],
        }));
        assert.deepEqual(rowOf(p, 1), ['L1/B1/1/13時'], '編成が消えたら予約も消えてしまっている');
        assert.deepEqual(p.unmetReservations, []);
    });

    test('★ L2: スナップショットで置いた枠は同属性の別ボスに使い回されない', () => {
        // 合成した候補は avail に居ないので、手で外さないと同じ編成枠が2回使われる。
        // ★ キャラ被りでは検出できない形にする — スナップショットのキャラ (a*) と
        //   現在の編成のキャラ (c*) を別にすれば、被り判定は素通りする
        const bothFire = [
            { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord',
              total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
            { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'water', weakness: 'fire', tier: 'lord',
              total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
        ];
        const one = [mkPlayer(1, 'A', { fire: [lo(50, ['c1', 'c2', 'c3', 'c4', 'c5'])] }, { done: 1 })];
        // 予約なし = fire ① は1回しか使えない (残凸2でも編成は1つ)
        const base = compute(mkInput(one, { bosses: bothFire }));
        assert.equal(rowOf(base, 1).length, 1, `前提が崩れた: ${JSON.stringify(rowOf(base, 1))}`);
        const p = compute(mkInput(one, {
            bosses: bothFire,
            reservations: [{ ...resv({ id: 33, member: 1, boss: 1, slot: 'h13' }),
                team: ['a1', 'a2', 'a3', 'a4', 'a5'], expectedB: 44 }],
        }));
        const rows = rowOf(p, 1);
        assert.deepEqual(rows, ['L1/B1/1/13時'],
            `予約で使った編成枠が別ボスにも使われた: ${JSON.stringify(rows)}`);
    });

    test('L2: スナップショットが無い旧予約は現在の編成に落ちる (移行互換)', () => {
        const p = compute(mkInput(players2(), { reservations: [resv({ id: 34, member: 1, boss: 1, slot: 'h13' })] }));
        assert.deepEqual(rowOf(p, 1), ['L1/B1/1/13時']);
        const a = p.levels[0].bosses.find(b => b.bossNumber === 1).attacks.find(x => x.memberId === 1);
        assert.equal(a.dmgB, 60, '現在の測定値で置くこと');
    });

    test('★ L2 モック④: 予約で置いた凸にだけ「予約」の印が付く (他の凸には付けない = 指紋を変えない)', () => {
        const p = compute(mkInput(players2(), { reservations: [resv({ id: 7, member: 1, boss: 2, slot: 'h13' })] }));
        const all = p.levels.flatMap(lv => lv.bosses.flatMap(b => b.attacks));
        const mine = all.filter(a => a.memberId === 1);
        assert.equal(mine.length, 1);
        assert.equal(mine[0].fromReservation, true, '予約の印が無い');
        assert.equal(mine[0].reservationId, 7, '予約 id を持っていない');
        const others = all.filter(a => a.memberId !== 1);
        assert.ok(others.length > 0, '前提: 他の凸がある');
        assert.ok(others.every(a => !('fromReservation' in a) && !('reservationId' in a)),
            '予約でない凸にも印 (null) を付けている — 配信 JSON と指紋テストの出力が変わる');
        assert.equal(p.reservationCount, 1);
    });

    test('L2: 予約は時刻まで守る (貪欲の最速枠に寄せない)', () => {
        const p = compute(mkInput(players2(), { reservations: [resv({ member: 1, boss: 1, slot: 'h21' })] }));
        assert.deepEqual(rowOf(p, 1), ['L1/B1/1/21時'], '約束した時刻に置いていない');
        // ⏳隙間型の予約は時刻を約束しない
        const f = compute(mkInput(players2(), { reservations: [resv({ member: 1, boss: 1, flex: true })] }));
        assert.deepEqual(rowOf(f, 1), ['L1/B1/1/flex']);
    });

    test('L2: 予約は L1 の安定化より強い (前回の割当と食い違っても予約が勝つ)', () => {
        const natural = compute(mkInput(players2()));
        const p = compute(mkInput(players2(), {
            previousPlan: natural,                                  // 前回は A→B1
            reservations: [resv({ member: 1, boss: 2, slot: 'h13' })],   // 予約は A→B2
        }));
        assert.deepEqual(rowOf(p, 1), ['L1/B2/1/13時'], `予約より前回の割当が勝ってしまった: ${JSON.stringify(rowOf(p, 1))}`);
    });

    test('L2: 実現できない予約は理由つきで返す (黙って飲み込まない)', () => {
        // ① 本人が3凸済み
        const done3 = players2();
        done3[0] = mkPlayer(1, 'A', { fire: [lo(60, ['a1', 'a2', 'a3', 'a4', 'a5'])] }, { done: 3 });
        const p1 = compute(mkInput(done3, { reservations: [resv({ id: 11, member: 1, boss: 1 })] }));
        assert.equal(p1.unmetReservations.length, 1);
        assert.equal(p1.unmetReservations[0].reason, 'attacks_done');
        assert.equal(p1.unmetReservations[0].reservationId, 11);
        // ② 予約した編成が模擬から消えた (slot2 を予約したが slot2 が無い)
        const p2 = compute(mkInput(players2(), { reservations: [resv({ id: 12, member: 1, boss: 1, lo: 2 })] }));
        assert.equal(p2.unmetReservations[0].reason, 'loadout_gone');
        // ③ 対象ボスが撃破済み
        const dead = bosses2();
        dead[0].remaining_hp_raw = 0;
        const p3 = compute(mkInput(players2(), { bosses: dead, reservations: [resv({ id: 13, member: 1, boss: 1 })] }));
        assert.equal(p3.unmetReservations[0].reason, 'boss_defeated');
    });

    test('L2: レベルが開く前の時刻を約束していたら置かない (勝手に後ろへずらさない)', () => {
        // 現在 h13 起点。h05 の予約は開放より前なので実行できない
        const p = compute(mkInput(players2(), {
            currentSlot: 'h13',
            reservations: [resv({ id: 21, member: 1, boss: 1, slot: 'h05' })],
        }));
        assert.deepEqual(rowOf(p, 1).filter(r => r.includes('/5時')), [], '開放前の時刻に置いてしまった');
        assert.equal(p.unmetReservations.length, 1, `理由を返していない: ${JSON.stringify(p.unmetReservations)}`);
    });

    test('L2: 同じキャラを1日2回使う予約は置かない (物理的に実行できない)', () => {
        const shared = [
            mkPlayer(1, 'A', {
                fire: [lo(60, ['共有', 'a2', 'a3', 'a4', 'a5'])],
                water: [lo(60, ['共有', 'a7', 'a8', 'a9', 'a10'])],
            }),
        ];
        const p = compute(mkInput(shared, {
            reservations: [resv({ id: 31, member: 1, boss: 1, slot: 'h13' }), resv({ id: 32, member: 1, boss: 2, slot: 'h17' })],
        }));
        assert.equal(rowOf(p, 1).length, 1, `キャラ被りの予約まで置かれた: ${JSON.stringify(rowOf(p, 1))}`);
        assert.equal(p.unmetReservations.length, 1);
        assert.equal(p.unmetReservations[0].reason, 'conflict');
    });

    test('L2: 予約を渡さなければ従来どおり (unmetReservations は空)', () => {
        const p = compute(mkInput(players2()));
        assert.deepEqual(p.unmetReservations, []);
        assert.equal(p.reservationCount, 0);
        assert.equal(p.stability, null);
    });

    test('L2: 同じ予約が二重に渡されても1回だけ置く (Codex指摘 2026-09-08)', () => {
        const r = free({ id: 77, member: 3, boss: 1, slot: 'h07' });
        const p = compute(mkInput(tl(), { bosses: smallB(), reservations: [r, { ...r }] }));
        assert.deepEqual(rowOf(p, 3), ['L1/B1/1/7時'], `二重に置いた: ${JSON.stringify(rowOf(p, 3))}`);
        assert.equal(p.reservationCount, 1);
    });

    test('L2: 予約の投入順は入力の並びに依存しない', () => {
        // ★ 同じボスに2人ぶん予約する = 置いた順で usedB / overflowB の配り方が変わる形にする。
        //   別々のボスに1人ずつだと、並べ替えを外しても結果が同じで検出できない
        const small = [
            { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord',
              total_hp_raw: 40e9, remaining_hp_raw: 40e9 },
            { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'electric', weakness: 'water', tier: 'lord',
              total_hp_raw: 200e9, remaining_hp_raw: 200e9 },
        ];
        const two = [
            mkPlayer(1, 'A', { fire: [lo(20, ['a1', 'a2', 'a3', 'a4', 'a5'])] }, { done: 2 }),
            mkPlayer(2, 'B', { fire: [lo(35, ['b1', 'b2', 'b3', 'b4', 'b5'])] }, { done: 2 }),
        ];
        const rs = [resv({ id: 1, member: 1, boss: 1, slot: 'h13' }), resv({ id: 2, member: 2, boss: 1, slot: 'h13' })];
        const shot = (p) => JSON.stringify((p.levels || []).filter(lv => !lv.infinite).map(lv => lv.bosses.map(b =>
            (b.attacks || []).map(a => [a.memberId, a.loadoutSlot, a.hourLabel, a.usedB, a.overflowB]))));
        const a = compute(mkInput(two, { bosses: small.map(b => ({ ...b })), reservations: rs }));
        const b = compute(mkInput(two, { bosses: small.map(b => ({ ...b })), reservations: [...rs].reverse() }));
        assert.equal(shot(a), shot(b), '予約の並び順で結果が変わる (投入順が入力依存になっている)');
    });

    test('L2: 予約した凸はオーバーキル圧縮で外されない', () => {
        // ボス1 (HP30) に 25B → 30B の順で予約する。25B を置いた時点で残5B、30B で撃破。
        // 通常の圧縮は「25B を外しても倒せる」ので外しにいくが、約束は外してはいけない。
        // ★ ボス2 を倒せる C を入れてレベルを踏破させる — 踏破できないと吸収モードになり、
        //   撃破済みのボスは横断ループが飛ばすので圧縮自体が走らない
        const small = [
            { boss_number: 1, boss_code: 'B1', name: 'ボス1', attribute: 'water', weakness: 'fire', tier: 'lord',
              total_hp_raw: 30e9, remaining_hp_raw: 30e9 },
            { boss_number: 2, boss_code: 'B2', name: 'ボス2', attribute: 'electric', weakness: 'water', tier: 'lord',
              total_hp_raw: 30e9, remaining_hp_raw: 30e9 },
        ];
        const three = [
            mkPlayer(1, 'A', { fire: [lo(25, ['a1', 'a2', 'a3', 'a4', 'a5'])] }),
            mkPlayer(2, 'B', { fire: [lo(30, ['b1', 'b2', 'b3', 'b4', 'b5'])] }),
            mkPlayer(3, 'C', { water: [lo(30, ['c1', 'c2', 'c3', 'c4', 'c5'])] }),
        ];
        const p = compute(mkInput(three, {
            bosses: small.map(b => ({ ...b })),
            reservations: [resv({ id: 41, member: 1, boss: 1, slot: 'h05' }), resv({ id: 42, member: 2, boss: 1, slot: 'h05' })],
        }));
        const b1 = p.levels.find(lv => lv.level === 1).bosses.find(b => b.bossNumber === 1);
        const ids = (b1.attacks || []).map(a => a.memberId).sort();
        assert.deepEqual(ids, [1, 2], `予約した凸が外された: ${JSON.stringify(ids)} / ${JSON.stringify(p.unmetReservations)}`);
        assert.deepEqual(p.unmetReservations, []);
    });
}

// ---- 戦闘可能時間の読み方 (ホームの帯 / 開始の通知 / 締め凸の範囲) ----------------
console.log('\navailabilityDomain (戦闘可能時間):');
{
    const av = globalThis.availabilityDomain;
    const H = (...hs) => hs.map(h => `h${String(h).padStart(2, '0')}`);
    test('rangesOf / labelOf: 5時始まりの並びで区間にまとめ、深夜は「翌」で読む', () => {
        assert.deepEqual(av.rangesOf(H(5, 6, 7, 8, 9, 21, 22, 23, 0, 1, 2)).map(r => [r.start, r.end, r.hours]), [[5, 9, 5], [21, 2, 6]]);
        assert.equal(av.labelOf(H(5, 6, 7, 8, 9, 21, 22, 23, 0, 1, 2)), '5〜9時・21〜翌2時 (11時間)');
        assert.equal(av.labelOf(H(13)), '13時 (1時間)');
        assert.equal(av.labelOf([]), '未登録');
        assert.equal(av.labelOf([], { flexTime: true }), '⏳ 隙間時間型 (時刻は約束しない)');
        assert.equal(av.labelOf(H(1, 2)), '翌1〜翌2時 (2時間)');
    });
    test('★ windowStartsAt: 区間の始まりだけ真 (途中の時刻では毎時通知しない) / 5時は並びの先頭', () => {
        const s = H(9, 10, 11, 21, 22);
        assert.equal(av.windowStartsAt(s, 9), true);
        assert.equal(av.windowStartsAt(s, 10), false);
        assert.equal(av.windowStartsAt(s, 21), true);
        assert.equal(av.windowStartsAt(s, 12), false, 'OFF の時刻を始まりにしている');
        assert.equal(av.windowStartsAt(H(5, 6), 5), true, '5時は並びの先頭なので始まり');
        // ★ 翌4時と5時は同じ「レイド日」の両端 (5時始まり・翌4時終わり)。当日の5時に4時から続いている人はいない
        assert.equal(av.windowStartsAt(H(4, 5), 5), true, 'レイド日は5時始まり。翌4時は前の枠ではない');
        assert.deepEqual(av.windowAt(s, 10), { start: 9, end: 11, hours: 3 });
        assert.equal(av.windowAt(s, 12), null);
    });
    test('★ canAttackWithin: 今から N 時間の範囲 (日付またぎ) / 隙間型は常に可 / 未登録は範囲指定なら不可', () => {
        assert.equal(av.canAttackWithin(H(1), 23, 3), true, '23時から3時間 = 23,0,1 を含む');
        assert.equal(av.canAttackWithin(H(2), 23, 3), false);
        assert.equal(av.canAttackWithin(H(13), 10, 3), false, '10,11,12 に 13 は入らない');
        assert.equal(av.canAttackWithin(H(13), 10, 4), true);
        assert.equal(av.canAttackWithin([], 10, 2), false, '未登録は「出られる時間が分からない」');
        assert.equal(av.canAttackWithin([], 10, 2, { flexTime: true }), true);
        assert.equal(av.canAttackWithin([], 10, null), true, '制限なしは全員');
    });
    test('★ reminderTargets: 残凸あり・今期参加できる・隙間型でない・その時刻が区間の始まり の人だけ', () => {
        const ps = [
            { id: 1, name: 'A', attackCount: 0, availableSlots: H(13, 14, 15) },          // 13時が始まり
            { id: 2, name: 'B', attackCount: 3, availableSlots: H(13, 14) },              // 3凸済み
            { id: 3, name: 'C', attackCount: 1, availableSlots: H(12, 13) },              // 13時は途中
            { id: 4, name: 'D', attackCount: 0, availableSlots: H(13), flexTime: true },  // 隙間型は時刻を約束しない
            { id: 5, name: 'E', attackCount: 0, availableSlots: H(13), unavailableThisSeason: true },
            { id: 6, name: 'F', attackCount: 2, availableSlots: H(13) },
        ];
        const t = av.reminderTargets(ps, 13);
        assert.deepEqual(t.map(x => [x.id, x.remaining]), [[1, 3], [6, 1]]);
        assert.deepEqual(t[0].window, { start: 13, end: 15, hours: 3 });
        assert.deepEqual(av.reminderTargets(ps, 14), [], '区間の途中では誰にも送らない');
    });
}

// ---- 締め凸検索: 人数と時間範囲 (2026-09-08) --------------------------------------
console.log('\nfinishDomain (人数・時間範囲):');
{
    const fd = globalThis.finishDomain;
    const _fs = await import('node:fs');
    const _path = await import('node:path');
    const { fileURLToPath: _f2p } = await import('node:url');
    const _ROOT = _path.resolve(_path.dirname(_f2p(import.meta.url)), '..');
    const A = { name: 'A', dmg: 10 }, B = { name: 'B', dmg: 6 }, C = { name: 'C', dmg: 5 };
    test('★ computeFinishPlans: 人数を指定したらその人数の組合せだけ / 届かなければ cannotKill', () => {
        assert.equal(fd.computeFinishPlans([A, B, C], 8, { shots: 1 }).tight.members.length, 1);
        const two = fd.computeFinishPlans([A, B, C], 8, { shots: 2 });
        assert.equal(two.tight.shots, 2, '1人で足りても2人の組合せを出す');
        assert.deepEqual(two.tight.members.map(m => m.name), ['B', 'C'], '2人ならオーバーキル最小は B+C (11)');
        const three = fd.computeFinishPlans([A, B, C], 8, { shots: 3 });
        assert.equal(three.tight.shots, 3, '3人指定なら 1/2人で足りても3人で探す');
        assert.equal(fd.computeFinishPlans([B, C], 20, { shots: 2 }).cannotKill, true, '2人では届かない');
        assert.equal(fd.computeFinishPlans([A, B, C], 8, { shots: 9 }).tight.shots, 1, '範囲外の指定は自動扱い');
        // 指定なしは従来どおり (1→2、削れないときだけ3)
        assert.equal(fd.computeFinishPlans([A, B, C], 8).tight.shots, 1);
    });
    test('★ filterByWindow: 今から N 時間に出られる人だけ (隙間型は通す / 未登録は外す / 制限なしは全員)', () => {
        const H = (...hs) => hs.map(h => `h${String(h).padStart(2, '0')}`);
        const ps = [
            { name: 'A', dmg: 10, availableSlots: H(13) },
            { name: 'B', dmg: 9, availableSlots: H(20) },
            { name: 'C', dmg: 8, availableSlots: [], flexTime: true },
            { name: 'D', dmg: 7, availableSlots: [] },
        ];
        assert.deepEqual(fd.filterByWindow(ps, { curHour: 12, hours: 2 }).map(p => p.name), ['A', 'C']);
        assert.deepEqual(fd.filterByWindow(ps, { curHour: 12, hours: null }).map(p => p.name), ['A', 'B', 'C', 'D']);
        assert.deepEqual(fd.filterByWindow(ps, { curHour: 23, hours: 24 }).map(p => p.name), ['A', 'B', 'C'], '24時間なら登録のある人は全員');
    });
    test('★ 配線: 締め凸検索に「何人で」「今から」のチップがあり、候補と組合せに効く', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const fn = html.match(/function renderOpsFinishList\(attrKey\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/const candidates = finishDomain\.filterByWindow\(candidatesAll, \{ curHour: curHourJst, hours: _opsFinish\.hours \}\);/.test(fn), '範囲で候補を絞っていない');
        assert.ok(fn.includes("handleOpsFinishOpt('shots'") && fn.includes("handleOpsFinishOpt('hours'"), 'チップが無い');
        assert.ok(/listEl\.innerHTML = controls \+ header \+ rows \+ pushBtn \+ timelineHtml;/.test(fn), 'チップを描いていない');
        assert.ok(/return finishDomain\.computeFinishPlans\(candidates, remHP, \{ shots: _opsFinish\.shots \}\);/.test(html), '人数を組合せに渡していない');
        assert.ok(/if \(_opsCurrentAttr\) renderOpsFinishList\(_opsCurrentAttr\);/.test(html), 'チップを押しても描き直さない');
    });
    test('★ 配線: ホームに「あなたの戦闘可能時間」の帯 (要約 + 24コマ + 今の時刻) と変更ボタン', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(html.includes('id="myAvailStripCard"') && html.includes('id="myAvailStripBody"'));
        assert.ok(html.includes('<script defer src="./js/domain/availability.js"></script>'));
        const fn = html.match(/async function renderMyAvailStrip\(identity\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/dom\.labelOf\(slots, \{ flexTime: !!prefs\.flexTime \}\)/.test(fn), '要約をドメインで作っていない');
        assert.ok(/HOUR_ORDER\.map\(h => \{/.test(fn) && /outline:2px solid #FF3D44/.test(fn), '24コマと今の時刻の印が無い');
        assert.ok(/const seq = \+\+_availStripSeq;/.test(fn) && (fn.match(/if \(seq !== _availStripSeq\) return;/g) || []).length >= 2, '世代ガードが無い');
        assert.ok(/renderMyAvailStrip\(id\);\s*\/\/ ⏰/.test(html), 'ホームの描画から呼んでいない');
        assert.ok(/renderMyAvailStrip\(null\);/.test(html), '未選択で隠していない');
        const close = html.match(/function closeMyAvailModal\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/renderMyAvailStrip\(id\)/.test(close), '変更のあと帯を描き直していない');
    });
    test('★ 配線: 当日、時間帯の始まりに「戦闘可能時間になりました」を本人へ (運営端末が送り手・二重送信よけ)', () => {
        const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const fn = html.match(/async function _checkAvailReminders\(season\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(fn, '通知の関数が無い');
        assert.ok(/if \(season\.hard_date !== todayJst\) return;/.test(fn), '当日以外にも送る');
        assert.ok(/dom\.reminderTargets\(players, hour\)/.test(fn), '相手の判定をドメインでやっていない');
        assert.ok(/supabaseClaimRaidNotice\(season\.id, 'avail_start', ref, me\?\.id\)/.test(fn), '二重送信よけ (確保) が無い');
        assert.ok(/supabaseMarkRaidNoticeSent\(season\.id, 'avail_start', ref\)/.test(fn), '送信済みを記録していない');
        assert.ok(/supabaseReleaseRaidNotice\(season\.id, 'avail_start', ref\)/.test(fn), '送信失敗で確保を戻していない');
        assert.ok(/ignoreAvailability: true/.test(fn) && /playerIds: \[t\.id\]/.test(fn), '本人だけに送っていない');
        assert.ok(fn.includes('戦闘可能時間になりました'));
        // Codex指摘 (2026-09-08): 残凸は送る直前に本人の実凸で見直す / 1人の失敗で残りを落とさない / 30分を過ぎたら送らない
        assert.ok(/supabaseLoadMyAttacks\?\.\(t\.id, season\.id, season\.hard_date\)/.test(fn), '残凸を取り直していない');
        assert.ok(/if \(remaining <= 0\) continue;/.test(fn));
        assert.ok(/for \(const t of targets\) \{\s*\n[^\n]*\n\s*try \{/.test(fn), '人ごとに try で囲んでいない');
        assert.ok(/if \(minute >= 30\) return;/.test(fn), '遅れすぎた通知を止めていない');
        // 「何時まで待てば誰が最適？」は絞る前の全員で
        assert.ok(/_buildFinishTimeline\(attrKey, candidatesAll, remainingHpB\)/.test(html), '時間別ベストを範囲で絞ってしまっている');
        // 定期チェックから呼ばれる (運営ONの端末)
        assert.ok(/if \(_opsMode && r\?\.season\?\.id && typeof _checkAvailReminders === 'function'\) \{\s*\n\s*_checkAvailReminders\(r\.season\)/.test(html), '定期チェックから呼んでいない');
    });
}

// ---- 模擬提出シートの再設計 (2026-09-08 モック a3a7b6e9) -------------------------
console.log('\n模擬提出シート (提出バー固定):');
{
    const _fs = await import('node:fs');
    const _path = await import('node:path');
    const { fileURLToPath: _f2p } = await import('node:url');
    const _ROOT = _path.resolve(_path.dirname(_f2p(import.meta.url)), '..');
    const html = _fs.readFileSync(_path.join(_ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    const modal = html.match(/<div class="player-select-modal" id="myTeamEditModal">[\s\S]*?<!-- ========== 🔒 凸を申請する/)?.[0] || '';
    test('★ 提出バーがシートの下に固定され、要約・提出ボタン・削除リンク・予約の導線を持つ', () => {
        assert.ok(modal, 'モーダルが無い');
        assert.ok(/<div class="te-bar">[\s\S]*id="myTeamEditBarSum"[\s\S]*id="myTeamEditSubmit"[\s\S]*class="te-dellink"/.test(modal), 'バーの部品が足りない');
        assert.ok(/\.te-bar \{\s*\n\s*position:sticky; bottom:0;/.test(html), 'バーが固定されていない');
        assert.ok(/\.te-sheet \{ padding:0; gap:0; \}/.test(html), 'シートの余白をバーに合わせていない');
        // 削除は小さな赤いリンクに格下げ (フッターの並びのボタンではない)
        assert.ok(!/class="btn danger"|🗑 削除/.test(modal), '削除がボタンのまま');
        // 予約の区画はシートから外し、バーの1行の案内に (ユーザー決定 B)
        assert.ok(/class="te-barlinks">[\s\S]*id="myTeamEditResvSec"[\s\S]*id="myTeamEditResvOpen"/.test(modal), '予約の導線がバーに無い');
        assert.ok(!/<div id="myTeamEditResvSec" class="te-sec"/.test(modal), '予約の区画が残っている');
    });
    test('★ 見出しは「模擬を提出する」+ 属性ピル / 編成①②はセグメントに提出済みダメージ', () => {
        assert.ok(/id="myTeamEditAttrPill"/.test(modal) && />模擬を提出する<\/h2>/.test(modal), '見出しが違う');
        assert.ok(/document\.getElementById\('myTeamEditTitle'\)\.textContent = '模擬を提出する';/.test(html), '開いたときに見出しを上書きしている');
        assert.ok(/function _renderTeamEditSlotTabs\(existingSlots, rows = \[\]\)/.test(html), 'セグメントに提出値を渡していない');
        assert.ok(/_renderTeamEditSlotTabs\(existingSlots, allRows\);/.test(html));
        assert.ok(/class="te-seg\$\{slot === _myTeamEditSlot \? ' on' : ''\}"/.test(html), 'セグメントの選択状態が無い');
        assert.ok(html.includes("'<small>未提出</small>'"), '未提出の編成が分かる表示が無い');
    });
    test('★ 並び: ① 編成 (スクショ読み取りは見出しの横) → ② ダメージ → ③ キャラを選ぶ', () => {
        const i1 = modal.indexOf('① 編成'), i2 = modal.indexOf('② ダメージ'), i3 = modal.indexOf('③ キャラを選ぶ');
        assert.ok(i1 > 0 && i2 > i1 && i3 > i2, `並びが違う: ${i1}/${i2}/${i3}`);
        assert.ok(/<label class="te-ocrmini"[\s\S]*id="myTeamEditOcrInput"[\s\S]*<\/label>\s*\n\s*<\/p>\s*\n\s*<div class="te-slots" id="teSlots">/.test(modal), 'スクショ読み取りが編成の見出しの横に無い');
        assert.ok(!/class="te-ocr"/.test(modal), '旧「まとめて入れる」の区画が残っている');
        // 値の保持先の契約は変えない (ピッカーは #myTeamEditFields の5つの input に書く)
        assert.ok(/id="myTeamEditFields" hidden/.test(modal));
    });
    test('★ 「よく使われている編成」と「人気編成の参考」は1つの折りたたみ (ユーザー決定 C)', () => {
        assert.ok(modal.includes('★ みんなの編成'), '見出しが無い');
        assert.ok(!/myTeamEditPopularToggle/.test(html), '旧トグルが残っている');
        assert.ok(!/async function toggleTeamEditPopular/.test(html), '旧の開閉関数が残っている');
        assert.ok(/if \(typeof _teSyncPopular === 'function'\) _teSyncPopular\(_teTopOpen\);/.test(html), 'よく使う編成の開閉で統計を同居させていない');
        const sync = html.match(/async function _teSyncPopular\(open\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(_tePopularLoadedFor === attrKey \|\| _tePopularLoadingFor === attrKey\) return;/.test(sync), '開くたびに読み直している / 読込中の二重読みを止めていない');
        assert.ok(/if \(_myTeamEditAttr !== attrKey\) return;/.test(sync), '別属性に切り替わったのに描いてしまう');
    });
    test('★ 実機FB (2026-09-08): 提出したら閉じる / 本体をスクロールさせない / キーボード中は下部ナビを隠す', () => {
        const save = html.match(/async function handleMyTeamEditSave\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(!redirected\) \{\s*\n[^\n]*を提出しました[^\n]*\n\s*closeMyTeamEditModal\(\);/.test(save), '提出しても閉じない');
        // モーダルが開いている間は body を固定 (開閉は classList を監視して一箇所で)
        assert.ok(/body\.modal-lock \{ position: fixed;/.test(html), '固定の CSS が無い');
        const lock = html.match(/function _syncModalLock\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/document\.body\.classList\.add\('modal-lock'\)/.test(lock) && /document\.body\.style\.top = `-\$\{_modalLockY\}px`/.test(lock), '開いたときに固定していない');
        assert.ok(/window\.scrollTo\(0, y\);\s*\n\s*if \(typeof _navShowNow === 'function'\) _navShowNow\(\);/.test(lock), '閉じたときに元の位置へ戻して自動隠しを抑止していない');
        // モバイルだけ固定 / 固定中にタブが変わっていたら切替先の保存位置へ (Codex指摘)
        assert.ok(/window\.matchMedia\('\(max-width: 767px\)'\)\.matches/.test(lock), 'PC でも固定している');
        assert.ok(/const y = \(cur === _modalLockTab\) \? _modalLockY/.test(lock), '固定中のタブ切替を考えていない');
        assert.ok(/_tabScrollY\[prevName\] = lockedY !== null \? lockedY :/.test(html), 'タブ切替の位置保存が固定中の 0 を保存する');
        assert.ok(/new MutationObserver\(\(\) => _syncModalLock\(\)\)/.test(html), 'open の付け外しを監視していない');
        // ソフトキーボード中は下部ナビを隠す
        assert.ok(/body\.kb-open \.bottom-nav \{ display: none !important; \}/.test(html));
        assert.ok(/document\.addEventListener\('focusin'/.test(html) && /classList\.add\('kb-open'\)/.test(html));
    });
    test('★ 実機FB (2026-09-08): 模擬カードに予約の印 / 予約中の編成は削除できない', () => {
        const panels = html.match(/async function renderMyDamagePanels\(identity\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_myMockResv = new Map\(\);/.test(panels), '予約の地図を作っていない');
        assert.ok(/supabaseLoadMyReservations\(ctx\.season\.id, identity\.id\)/.test(panels), '自分の予約を読んでいない');
        assert.ok(/filter\(r => rv\.isActive\(r\)\)/.test(panels), '生きている予約だけに絞っていない');
        // 印は右上のピルではなく、カード全体の薄い鍵 (class) + 名前行の小さな文字 (実機FB: ピルはダメージの数字と重なった)
        assert.ok(/const resvCls = resv \? ` resv \$\{resv\._unmet \? 'unmet' : resv\.status\}` : '';/.test(panels), 'カードの透かし用 class が無い');
        assert.ok(/\$\{isPickedVisible \? ' planpick' : ''\}\$\{resvCls\}"/.test(panels), '透かしをカードに差し込んでいない');
        assert.ok(/class="dc-dmg-resvtag"/.test(panels) && /\$\{resvTag\}/.test(panels), '名前行の文字が無い');
        // 置けていない予約は「!」(unmet) — 配信プランの unmetReservations を見る
        assert.ok(/r\._unmet = unmetIds\.has\(String\(r\.id\)\)/.test(panels), '置けていない予約を判定していない');
        assert.ok(/resv\._unmet \? 'unmet' : resv\.status/.test(panels), '置けていない予約の透かしを鍵のままにしている');
        assert.ok(/\.dc-dmg-panel\.resv\.unmet \{/.test(html), '「!」の透かしの CSS が無い');
        // 申請の3経路すべてで、予約中の編成とのキャラ被りを止める
        assert.equal((html.match(/characters: (Array\.isArray\(a\.team\) \? a\.team : \[\]|st\.lo\.characters|d\.draft\.characters|draft\.draft\.characters)/g) || []).length, 4, 'canRequest に編成を渡していない経路がある');
        // ホームの行の「引き受ける」は作る直前に予約を取り直して canRequest を通す (描いたあとの予約を見ずに作れた — Codex指摘)
        const claim = html.match(/async function handleClaimPlanRow\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/const fresh = await window\.supabaseLoadMyReservations\?\.\(st\.seasonId, st\.viewerId\);/.test(claim), '直前に取り直していない');
        assert.ok(claim.indexOf('rv.canRequest(fresh,') > 0 && claim.indexOf('rv.canRequest(fresh,') < claim.indexOf('supabaseCreateReservation('), '作る前に canRequest を通していない');
        assert.ok(/rv\.conflictingReservation\(mine, \{ playerId: identity\.id, characters:/.test(html), '模擬タブの予約欄でキャラ被りを見ていない');
        // 承認側: 本人の固定済みが置けなくなるなら承認不可
        assert.ok(/if \(impact && impact\.blockingHard\) \{/.test(html), '承認でキャラ被りを止めていない');
        assert.ok(/window\.planDiffDomain, row\.id, row\.player_id\)/.test(html), '候補の本人を渡していない');
        assert.ok(!/\$\{resvBadge\}/.test(panels), '右上のピルが残っている');
        assert.ok(/\.dc-dmg-panel\.resv \{\s*\n\s*background-image: url\("data:image\/svg\+xml/.test(html), '薄い鍵の透かしの CSS が無い');
        const del = html.match(/async function _deleteMyTeamEditSlot\(slot\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_myMockResv\.get\(`\$\{_myTeamEditAttr\}\|\$\{slot\}`\)/.test(del), '削除で予約を見ていない');
        // ★ 画面の地図は別人のものかもしれない → 削除の直前に本人の予約を取り直す (Codex指摘)
        assert.ok(/supabaseLoadMyReservations\(ctx\.season\.id, id\.id\)/.test(del), '削除の直前に本人の予約を取り直していない');
        assert.ok(/_myMockResvFor === id\.id/.test(del), '別人の地図で判定してしまう');
        assert.ok(/凸を予約しています/.test(del) && del.indexOf('凸を予約しています') < del.indexOf('supabaseDeletePlayerDamageSlot'), '予約中でも削除できてしまう');
    });
    test('★ 提出バーは 編成の変更・ダメージ入力・開いたとき・提出のあと に描き直される', () => {
        assert.ok(/function _renderTeamEditBar\(\)/.test(html));
        const note = html.match(/function _renderTeamEditLevelNote\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_renderTeamEditBar\(\)/.test(note), 'ダメージ入力で描き直していない');
        const icon = html.match(/function updateMyTeamEditIcon\(idx\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_renderTeamEditBar\(\)/.test(icon), '編成の変更で描き直していない');
        assert.ok(/_myTeamEditSubmittedB = \(window\.mockLevelsDomain && _myTeamEditLevels\)/.test(html), '開いた時点の提出値を基準にしていない');
        const save = html.match(/async function handleMyTeamEditSave\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_myTeamEditSubmittedB = hasEntries \? dmgVal : 0;\s*\n\s*_myTeamEditOpenedTeamCount = canonical\.length;\s*\n\s*_renderTeamEditBar\(\);/.test(save), '提出のあとに基準 (提出値・編成の人数) を更新していない');
        assert.ok(/_teAllRows = rows \|\| \[\];\s*\n\s*_renderTeamEditResv\(id, saveAttr, savedSlot\)/.test(save), '提出のあとに予約の導線を描き直していない');
    });
}

// ---- 配信プランの差分 (L4 通知抑制 / L5 運営ガード) ----------------------------
console.log('\nplanDiffDomain (配信プランの差分):');
{
    const pd = globalThis.planDiffDomain;
    // プランの最小フィクスチャ: levels[].bosses[].attacks[]
    const atk = (id, o = {}) => ({
        memberId: id, memberName: `P${id}`, dmgB: o.dmgB ?? 10,
        hourIdx: o.hourIdx === undefined ? 16 : o.hourIdx,
        hourLabel: o.hourLabel === undefined ? '21時' : o.hourLabel,
        flex: !!o.flex, loadoutSlot: o.slot ?? 1, team: o.team ?? ['A', 'B', 'C', 'D', 'E'],
    });
    const plan = (spec) => ({
        levels: spec.map(lv => ({
            level: lv.level,
            bosses: lv.bosses.map(b => ({ bossNumber: b.n, name: `B${b.n}`, weakness: b.w || 'fire', attacks: b.a })),
        })),
    });
    const base = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1), atk(2)] }, { n: 5, a: [atk(3)] }] }]);

    test('planDiff: 同じプランなら誰も変わらない (unchanged に全員)', () => {
        const d = pd.diffPlans(base, plan([{ level: 2, bosses: [{ n: 3, a: [atk(1), atk(2)] }, { n: 5, a: [atk(3)] }] }]));
        assert.equal(d.first, false);
        assert.deepEqual(d.changed, []);
        assert.deepEqual(pd.unchangedIds(d).sort(), [1, 2, 3]);
    });
    test('planDiff: 初回配信は first=true (全員を「変わった」に積まない)', () => {
        const d = pd.diffPlans(null, base);
        assert.equal(d.first, true);
        assert.deepEqual(d.changed, []);
        assert.equal(d.totalAfter, 3, '割当のある人数は数えている');
    });
    test('planDiff: ボスが変わった人だけ changed に入る (他は unchanged)', () => {
        // P1 が B3 → B5 へ移動。P2/P3 はそのまま
        const next = plan([{ level: 2, bosses: [{ n: 3, a: [atk(2)] }, { n: 5, a: [atk(3), atk(1)] }] }]);
        const d = pd.diffPlans(base, next);
        assert.deepEqual(pd.changedIds(d), [1]);
        assert.deepEqual(pd.unchangedIds(d).sort(), [2, 3]);
        assert.equal(d.changed[0].kind, 'boss');
    });
    test('planDiff: 時刻だけ変わっても「変わった」に数える (時刻は約束の一部 — 2026-09-07 決定)', () => {
        const next = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1, { hourIdx: 18, hourLabel: '23時' }), atk(2)] }, { n: 5, a: [atk(3)] }] }]);
        const d = pd.diffPlans(base, next);
        assert.deepEqual(pd.changedIds(d), [1]);
        assert.equal(d.changed[0].kind, 'time');
        assert.match(d.changed[0].afterText, /23時/);
    });
    test('planDiff: 編成 (スロット・キャラ) が変わっても「変わった」に数える', () => {
        const slotChanged = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1, { slot: 2 }), atk(2)] }, { n: 5, a: [atk(3)] }] }]);
        assert.equal(pd.diffPlans(base, slotChanged).changed[0].kind, 'team');
        const charChanged = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1, { team: ['A', 'B', 'C', 'D', 'Z'] }), atk(2)] }, { n: 5, a: [atk(3)] }] }]);
        assert.equal(pd.diffPlans(base, charChanged).changed[0].kind, 'team');
    });
    test('planDiff: 割当が消えた / 増えた人を区別する', () => {
        const gone = plan([{ level: 2, bosses: [{ n: 3, a: [atk(2)] }, { n: 5, a: [atk(3)] }] }]);
        const dg = pd.diffPlans(base, gone);
        assert.equal(dg.changed.find(c => c.memberId === 1).kind, 'gone');
        assert.equal(dg.changed.find(c => c.memberId === 1).afterText, '割当なし');
        const added = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1), atk(2), atk(9)] }, { n: 5, a: [atk(3)] }] }]);
        assert.equal(pd.diffPlans(base, added).changed.find(c => c.memberId === 9).kind, 'added');
    });
    test('planDiff: 同じ割当なら**並び順が違っても**変化なし (位置で比べていない)', () => {
        // 1人が2凸持つとき、レベル/ボスの列挙順が入れ替わっただけで「変わった」にしてはいけない
        const a2 = plan([{ level: 1, bosses: [{ n: 1, a: [atk(7, { hourLabel: '9時', hourIdx: 4 })] }] },
                         { level: 2, bosses: [{ n: 3, a: [atk(7)] }] }]);
        const b2 = plan([{ level: 2, bosses: [{ n: 3, a: [atk(7)] }] },
                         { level: 1, bosses: [{ n: 1, a: [atk(7, { hourLabel: '9時', hourIdx: 4 })] }] }]);
        assert.deepEqual(pd.diffPlans(a2, b2).changed, []);
    });
    test('planDiff: 2つの割当で**時刻が入れ替わった**のを見逃さない (集合で比べない)', () => {
        // 同じ人が Lv1B1 と Lv2B3 を持ち、時刻だけ入れ替わる。
        // 時刻を集合として比べると {21時,23時} が一致して「変化なし」に化ける
        const before = plan([{ level: 1, bosses: [{ n: 1, a: [atk(5, { hourIdx: 16, hourLabel: '21時' })] }] },
                             { level: 2, bosses: [{ n: 3, a: [atk(5, { hourIdx: 18, hourLabel: '23時' })] }] }]);
        const after  = plan([{ level: 1, bosses: [{ n: 1, a: [atk(5, { hourIdx: 18, hourLabel: '23時' })] }] },
                             { level: 2, bosses: [{ n: 3, a: [atk(5, { hourIdx: 16, hourLabel: '21時' })] }] }]);
        const d = pd.diffPlans(before, after);
        assert.deepEqual(pd.changedIds(d), [5], `時刻の入れ替えを検出できていない: ${JSON.stringify(d.changed)}`);
        assert.equal(d.changed[0].kind, 'time');
    });
    test('planDiff: 凸数が減った/増えたは boss 扱い (時刻や編成の比較に落とさない)', () => {
        const one = plan([{ level: 2, bosses: [{ n: 3, a: [atk(6)] }] }]);
        const two = plan([{ level: 2, bosses: [{ n: 3, a: [atk(6)] }, { n: 5, a: [atk(6)] }] }]);
        assert.equal(pd.diffPlans(one, two).changed[0].kind, 'boss');
        assert.equal(pd.diffPlans(two, one).changed[0].kind, 'boss');
    });
    test('planDiff: ⏳隙間型は時刻を約束しないので、hourLabel の有無で揺れない', () => {
        const f1 = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1, { flex: true, hourLabel: null, hourIdx: null })] }] }]);
        const f2 = plan([{ level: 2, bosses: [{ n: 3, a: [atk(1, { flex: true, hourLabel: '21時', hourIdx: 16 })] }] }]);
        assert.deepEqual(pd.diffPlans(f1, f2).changed, [], 'flex 同士は時刻差で変化にしない');
    });
    test('planDiff: summaryText は人数・種類・名前を出す / 変化なしも言い切る', () => {
        const same = pd.summaryText(pd.diffPlans(base, base));
        assert.match(same, /変わる人はいません/);
        const next = plan([{ level: 2, bosses: [{ n: 3, a: [atk(2)] }, { n: 5, a: [atk(3), atk(1)] }] }]);
        const s = pd.summaryText(pd.diffPlans(base, next));
        assert.match(s, /1名の割当が変わります/);
        assert.match(s, /そのまま 2名/);
        assert.match(s, /P1/);
        assert.match(pd.summaryText(pd.diffPlans(null, base)), /初回の配信です/);
    });
    test('planDiff: 壊れた入力でも落ちない (null / levels なし / attacks なし)', () => {
        assert.equal(pd.rowsByPlayer(null).size, 0);
        assert.equal(pd.rowsByPlayer({}).size, 0);
        assert.equal(pd.rowsByPlayer({ levels: [{ level: 1 }] }).size, 0);
        assert.equal(pd.diffPlans(null, null).totalAfter, 0);
        assert.deepEqual(pd.changedIds(null), []);
        assert.deepEqual(pd.unchangedIds(undefined), []);
        // memberId が無い凸は落とす (集計に nullish な鍵を作らない)
        const broken = { levels: [{ level: 1, bosses: [{ bossNumber: 1, attacks: [{ dmgB: 5 }] }] }] };
        assert.equal(pd.rowsByPlayer(broken).size, 0);
    });
}

console.log('\n通知抑制・運営ガードの配線 (ソース突合):');
{
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
    const html = read('index.html');
    const client = read('js', 'supabase-client.js');

    test('L4: 撃破Push が「運営の再配信をご確認ください」と書かない (再配信を煽らない)', () => {
        assert.ok(!html.includes('割当が変わる可能性があるので、運営の再配信をご確認ください'),
            '撃破のたびに全員へ再配信を促す文面が残っている');
        assert.ok(html.includes('割当が変わる場合は運営から個別にお知らせします'));
    });
    test('L4: 通知を止めるのは「差分の基準を確認済み かつ 変わらなかった人」だけ', () => {
        assert.ok(/const changed = new Set\(dd\.changedIds\(publishDiff\)/.test(html));
        // ★ 止める側を先に決め、残り全員へ送る (「変わった人だけ送る」だと、
        //   別の運営の配信を確認していた人が漏れる — Codex指摘 2026-09-07)
        assert.ok(/Number\(a\.plan_id\) === Number\(prevPlanId\)/.test(html), 'ack の基準を照合していない');
        assert.ok(/targets = stale\.filter\(a => !keepSet\.has\(Number\(a\.player_id\)\)\)/.test(html));
        assert.ok(/} else {\s*\n\s*targets = stale\.map/.test(html), '差分が無いときの全員フォールバックが要る');
    });
    test('L4: ack の引き継ぎは「差分を取った相手を確認済みの行」だけを進める', () => {
        assert.ok(/window\.supabaseCarryOverPlanAcks = async function \(seasonId, playerIds, newPlanId, basePlanId\)/.test(client));
        assert.ok(/\.eq\('plan_id', base\)/.test(client), '基準の plan_id に限定していない');
        assert.ok(!/\.neq\('plan_id', newPlanId\)/.test(client), '「新しい行以外を全部」は並行配信で事故る');
        assert.ok(html.includes('supabaseCarryOverPlanAcks(seasonId, keep, pub?.id, prevPlanId)'));
    });
    test('L4: 「変わりました」と断定するのは差分が取れたときだけ', () => {
        assert.ok(/const asserted = !!\(window\.planDiffDomain && publishDiff && !publishDiff\.first\)/.test(html));
        assert.ok(/asserted \? '🔄 あなたの割当が変わりました' : '🔄 新しい凸プランを配信しました'/.test(html));
    });
    test('L4: プレビューを閉じずに再度開いても、先の待ち手が必ず解決される', () => {
        const fn = html.match(/function showPushPreview\([\s\S]*?\n            \}\);\n        \}\n/)?.[0] || '';
        assert.ok(/if \(_pushPreviewResolver\) \{/.test(fn), '再入時に先の resolver を解決していない');
        assert.ok(/prev\(prevSel \? null : false\);/.test(fn));
    });
    test('L3: 凍結が旧世代に当たったら stale として運営に知らせる', () => {
        const fn = client.match(/window\.supabaseSetPlanFrozen = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(/stale = !!\(latest && Number\(latest\.id\) !== pid\)/.test(fn));
        assert.ok(/return \{ ok: true, stale \};/.test(fn));
        assert.ok(html.includes('操作中に別の運営が新しいプランを配信しました'));
    });
    test('L4: 締め凸候補は属性ごとに選べる (5属性一斉を既定にしない)', () => {
        assert.ok(html.includes('showPushPreview(groups, { selectable: true })'));
        assert.ok(/opportunities\.sort\(\(a, b\) => a\.remB - b\.remB\)/.test(html), '残HPの少ない順 = 締めに近い順');
        assert.ok(/checked: i === 0/.test(html), '既定は先頭1件だけ ON');
        assert.ok(/if \(!picked \|\| picked\.length === 0\) return;/.test(html));
    });
    test('L4: showPushPreview の既定 (selectable なし) は従来どおり boolean を返す', () => {
        const body = html.match(/function closePushPreview\([\s\S]*?\n        }\n/)?.[0] || '';
        assert.ok(/r\(sel \? picked : !!confirmed\)/.test(body), body.slice(0, 200));
        // 選択状態はモーダルを閉じる**前**に読む
        const iRead = body.indexOf('data-push-group');
        const iClose = body.indexOf("classList.remove('open')");
        assert.ok(iRead >= 0 && iClose > iRead, '閉じてから読むと選択が取れない');
    });
    test('L5: 配信前に前回との差分を出し、同じ差分を通知の絞り込みに使い回す', () => {
        assert.ok(/publishDiff = window\.planDiffDomain\.diffPlans\(prevPlan, _opsLastPlan\)/.test(html));
        assert.ok(/Number\(prevPub\.season_id\) === Number\(seasonId\)/.test(html), '別シーズンの配信を前回扱いにしない');
        assert.ok(html.includes('window.planDiffDomain.summaryText(publishDiff)'));
    });
    test('L3: 「中止」は削除ではなく凍結 (プランは残す・確認記録も消さない)', () => {
        const fn = html.match(/async function handleOpsUnpublishPlan\([\s\S]*?\n        }\n/)?.[0] || '';
        assert.ok(fn.includes('supabaseSetPlanFrozen'), '凍結を呼んでいない');
        assert.ok(!/supabaseDeleteAllPublishedPlans|\.delete\(\)/.test(fn), '中止の経路から削除を呼んではいけない');
        assert.ok(fn.includes('メンバーの画面にはプランが残ったまま'), '何が起きるかを確認文で説明する');
        assert.ok(fn.includes('「確認しました」の記録は消えません'));
        // 凍結中は同じボタンが「解除」になる (状態で意味が変わるので文言も変える)
        assert.ok(html.includes("btn.textContent = frozen ? '▶️ 組み直し中を解除' : '⏳ 組み直し中にする'"));
    });
    test('L3: 配信は旧行を消さない (前回との差分を後から引けるようにする)', () => {
        const fn = client.match(/window\.supabasePublishPlan = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(!/\.delete\(\)/.test(fn), `配信が旧行を削除している: ${fn.slice(0, 160)}`);
        assert.ok(fn.includes('旧配信は**消さない**'));
    });
    test('L3: 最新の配信は id 降順だけで選ぶ (端末の時計ずれで最新が入れ替わらない)', () => {
        const fn = client.match(/window\.supabaseGetPublishedPlan = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(!/order\('published_at'/.test(fn), 'published_at で並べると時計ずれに弱い');
        assert.ok(/order\('id', \{ ascending: false \}\)/.test(fn));
        // 38未適用環境では frozen 列を落として再試行 = 「常に配信中」に静かに劣化
        assert.ok(/_isMissingColumnErr\(r\.error, 'frozen_at'\)/.test(fn));
    });
    test('L3: 1つ前の配信を引ける (本人への「前回から変わったか」の材料)', () => {
        assert.ok(/window\.supabaseGetPreviousPublishedPlan = async function/.test(client));
        const fn = client.match(/window\.supabaseGetPreviousPublishedPlan = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(/\.lt\('id', cur\)/.test(fn), '「いまより古い中で最大の id」で引く');
        assert.ok(/order\('id', \{ ascending: false \}\)\.limit\(1\)/.test(fn));
    });
    test('L3: 凍結の読み書きは 38 未適用で静かに劣化し、操作だけ適用を案内する', () => {
        const fn = client.match(/window\.supabaseSetPlanFrozen = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(fn.includes('supabase/38_published_plans_freeze.sql'));
        assert.ok(/_isMissingColumnErr\(error, 'frozen_at'\)/.test(fn));
    });
    test('L3: 本人の画面に「組み直し中」と「前回から変わったか」を出す', () => {
        assert.ok(html.includes('運営がプランを組み直し中です'));
        assert.ok(html.includes('あなたの割当が変わりました'));
        assert.ok(html.includes('前回の配信から、あなたの割当は変わっていません'));
        // ★ 文言が有ることではなく**状態に配線されていること**を見る
        //   (定数を false にすれば文言は残ったまま出なくなる — 変異テストで素通りした)
        assert.ok(/const frozenBanner = frozen\s*\n/.test(html), 'frozenBanner が frozen だけで決まっていない');
        assert.ok(/const changeBanner = !myChange \? ''\s*\n/.test(html));
        assert.ok(/\$\{frozenBanner\}\$\{changeBanner\}/.test(html), '2つのバナーが本文に差し込まれていない');
        assert.ok(/frozen: !!pub\.frozen_at/.test(html), '凍結状態が _myPubState に入っていない');
        assert.ok(/const \{ plan, viewerId, doneCounts, stale, liveLevel, ack, frozen, frozenBy, myChange \} = _myPubState;/.test(html));
        // 差分の取得に失敗したら黙って出さない (誤った「変わっていません」を出さない)
        assert.ok(/myChange = null;/.test(html));
        // 取得中に別の描画が始まったら捨てる (世代ガード)
        assert.ok(/差分の取得中に新しい render が始まっていたら捨てる/.test(html));
    });
    test('L3: 99_check_applied.sql に 38 の判定行がある', () => {
        assert.ok(read('supabase', '99_check_applied.sql').includes("'38_published_plans_freeze'"));
    });
    test('L5: 最終配信の状況 (誰が・いつ・無配信の警告) を戦況タブに出す', () => {
        assert.ok(html.includes('id="opsPlanPubStatus"'));
        assert.ok(/function _renderOpsPubStatus\(/.test(html));
        assert.ok(html.includes('いま配信中のプランはありません'));
    });
    test('planDiff.js が index.html から読み込まれている', () => {
        assert.ok(html.includes('<script defer src="./js/domain/planDiff.js"></script>'));
    });
    test('L1 配線: 算出は「いま配信中のプラン」を previousPlan として渡す', () => {
        // ★ 手元の直前の算出結果ではなく**配信したもの**が基準。
        //   メンバーへの約束は配信したものなので、何度算出し直しても基準は動かない
        assert.ok(/previousPlan: options\.previousPlan \|\| null,/.test(html), 'ソルバーへ渡していない');
        assert.ok(/const pub = typeof window\.supabaseGetPublishedPlan === 'function'/.test(html));
        assert.ok(/if \(pub && Number\(pub\.season_id\) === Number\(snapshot\?\.season\?\.id\)\) \{/.test(html),
            '別シーズンの配信を基準にしてしまう');
        // ★ 何を基準に組んだかを焼き込み、配信直前に照合する (並行配信で相手の約束を壊さない)
        assert.ok(/plan\.basisPlanId = basisPlanId;/.test(html), '基準の配信IDを焼き込んでいない');
        assert.ok(/if \(_opsLastPlan\?\.stickyOn && Number\(basis \|\| 0\) !== Number\(prevPlanId \|\| 0\)\) \{/.test(html),
            '配信直前に基準のずれを照合していない');
        assert.ok(html.includes('別の運営が新しいプランを配信しました'));
    });
    test('L1 配線: 安定化 OFF で組んだプランは基準の照合をしない', () => {
        // OFF は「前回を尊重しない」と決めて算出したもの。照合すると出せなくなるだけ
        assert.ok(/plan\.stickyOn = !!_opsPlanSticky;/.test(html));
        assert.ok(/_opsLastPlan\?\.stickyOn &&/.test(html), 'OFF でも照合してしまう');
        assert.ok(/const plan = computeOptimalPlan\(\{ \.\.\.options, previousPlan, reservations: [^}]*\}, snapshot\);/.test(html));
        // 取得に失敗しても算出は続ける (安定化は「あれば嬉しい」もので、止める理由にならない)
        assert.ok(/配信中プランの取得skip \(安定化なしで算出\)/.test(html));
    });
    test('L1 配線: 既定は「前回を尊重」。運営が OFF にできる', () => {
        assert.ok(/let _opsPlanSticky = true;/.test(html), '既定が尊重になっていない');
        assert.ok(/localStorage\.getItem\(_OPS_PLAN_STICKY_KEY\) !== '0'/.test(html), '既定OFFに倒れる読み方になっている');
        assert.ok(html.includes('id="opsPlanStickyBtn"'));
        assert.ok(/function toggleOpsPlanSticky\(\)/.test(html));
        // OFF のときは配信中プランを取りにいかない (無駄な取得をしない)
        assert.ok(/if \(_opsPlanSticky\) \{\s*\n\s*try \{/.test(html), 'OFF でも取得している');
    });
    test('L2 配線: 予約カードは運営ONのときだけ取得・描画する', () => {
        const fn = html.match(/async function renderOpsReservations\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(fn, 'renderOpsReservations が無い');
        assert.ok(/if \(!_opsMode\) return;/.test(fn), '運営OFFでも取得してしまう');
        // 世代ガード: ↻連打や切替で古い応答が後着しても描かない
        assert.ok(/const gen = \+\+_resv\.gen;/.test(fn));
        assert.ok((fn.match(/if \(gen !== _resv\.gen\) return;/g) || []).length >= 3, '世代の照合が足りない');
        // 盤面の描き直しから呼ばれている (押さないと出ない状態にしない)
        assert.ok(/renderOpsReservations\(\);\s*\/\/ 🔒 凸の予約/.test(html));
    });
    test('L2 配線: 39未適用は「予約0件」と区別して適用を案内する', () => {
        const fn = html.match(/async function renderOpsReservations\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(rows === null\) \{/.test(fn), 'null (未適用) と [] (0件) を区別していない');
        assert.ok(fn.includes('39_plan_reservations.sql'));
        // クライアント側も null を返すこと ([] にすると押せてしまい適用エラーになる)
        const cf = client.match(/window\.supabaseLoadReservations = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(/if \(_isMissingReservationTable\(error\)\) return null;/.test(cf));
    });
    test('L2 配線: 承認は「固定した場合の影響」を見せてから', () => {
        const fn = html.match(/async function handleReservationApprove\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/_reservationImpact\(rowNow\)/.test(fn), '影響を出していない (いまの写しで解く)');
        assert.ok(fn.includes('完全攻略の見込み'));
        assert.ok(fn.includes('未消化の凸'));
        assert.ok(fn.includes('ほかに割当が変わる人'));
        // 影響の算出は「承認済みだけ」と「+候補」の2解を比べる
        const im = html.match(/async function _reservationImpact\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/solve\(base\), solve\(\[\.\.\.base, \{ \.\.\.row, status: 'approved' \}\]\)/.test(im));
        assert.ok(/rv\.toSolverConstraints\(rows\)/.test(im), 'ソルバーへ拘束として渡していない');
    });
    test('L2 配線: 状態を進めたら盤面を捨てる / 二重押しを止める', () => {
        const fn = html.match(/async function _resvTransition\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(_resv\.busy\.has\(rid\)\) return false;/.test(fn), '二重押しを止めていない');
        assert.ok(/opsStore\.invalidate\(\);/.test(fn), '予約が変わったのに盤面を読み直していない');
        // 取り違えた承認・解除を防ぐ (別の運営が先に操作していたら弾く)
        assert.ok(/expectFrom: 'requested'/.test(html));
        assert.ok(/expectFrom: 'cancel_requested'/.test(html));
    });
    test('★ B: 承認 → 固定して組み直す → 差分を見て配信 (1タップ) / 自動配信はしない (2026-09-08)', () => {
        const ap = html.match(/async function handleReservationApprove\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/const ok = await _resvTransition\(id, 'approved'/.test(ap), '承認の成否を見ていない');
        assert.ok(/if \(!ok\) return;/.test(ap) && /await _recomputeAndOfferPublish\('承認した予約を固定して組み直しました'\);/.test(ap),
            '承認のあとに組み直し→配信の流れへ入っていない');
        // ★ 承認待ちが他にも残っている間は配信の確認を出さず、組み直しだけ (ユーザー決定 2026-09-08)。
        //   最後の1件を承認したときに差分と配信の確認を出す
        // 承認したばかりの行は数えない (一覧の取り直しに失敗しても最後の1件で配信へ進める — Codex指摘)
        assert.ok(/const remaining = \(_resv\.rows \|\| \[\]\)\.filter\(r => r\.status === 'requested' && Number\(r\.id\) !== Number\(id\)\)\.length;/.test(ap), '残りの承認待ちを数えていない');
        assert.ok(/if \(remaining > 0\) \{\s*\n\s*await _recomputeOnly\(\);\s*\n[^\n]*残り \$\{remaining\} 件を承認してから配信へ進みます[^\n]*\n\s*return;/.test(ap),
            '承認待ちが残っているのに配信の確認を出している');
        assert.ok(ap.indexOf('if (remaining > 0)') < ap.indexOf("await _recomputeAndOfferPublish('承認した予約を固定して組み直しました')"), '順序が逆');
        const ro = html.match(/async function _recomputeOnly\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/await computeAndRenderOptimalPlan\(\{ onlyAvailableNow: false \}\)/.test(ro), '組み直していない');
        assert.ok(!/handleOpsPublishPlan/.test(ro), '組み直しだけのはずが配信の確認を出している');
        const fl = html.match(/async function _recomputeAndOfferPublish\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/await computeOptimalPlan|await computeAndRenderOptimalPlan\(\{ onlyAvailableNow: false \}\)/.test(fl), '算出していない');
        // ★ 算出が無効化されたら古いプランを配信しない
        assert.ok(/if \(!_opsLastPlan \|\| _opsLastPlan === before\)/.test(fl), '古いプランを配信してしまう');
        // 配信は handleOpsPublishPlan (差分・予約の照合・確認ダイアログ) を通す = 自動配信ではない
        assert.ok(/await handleOpsPublishPlan\(\);/.test(fl), '配信の確認を通していない');
        assert.ok(!/supabasePublishPlan\(/.test(fl), '確認を飛ばして直接配信している');
        // 承認できなかったとき (別の運営が先に操作 等) は流れに入らない
        const tr = html.match(/async function _resvTransition\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/let ok = false;/.test(tr) && /ok = true;/.test(tr) && /return ok;/.test(tr), '成否を返していない');
    });
    test('★ C→: 候補そのものが置けない予約は承認しない (理由は日本語)', () => {
        const ap = html.match(/async function handleReservationApprove\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(impact && impact\.cannotPlace\) \{/.test(ap), '置けない候補を止めていない');
        assert.ok(/impact\.cannotPlaceText/.test(ap), '理由を出していない');
        const im = html.match(/async function _reservationImpact\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/window\.planDiffDomain, row\.id, row\.player_id\)/.test(im), '候補IDと本人を渡していない (置けたか・本人の予約が壊れるかを判定できない)');
        // 影響は承認に使う写し (いまの提出) で解く — 申請時の写しで解くと申請後の編成変更のキャラ被りをすり抜ける (Codex指摘)
        const iSnap = ap.indexOf('const snap = await _snapshotAtApproval(row);'), iImp = ap.indexOf('_reservationImpact(rowNow)');
        assert.ok(iSnap >= 0 && iImp > iSnap, '影響の算出より前に承認時点の写しを取っていない');
        assert.ok(/const rowNow = snap \? \{ \.\.\.row, characters_snapshot: snap\.characters, expected_damage_b: snap\.expectedDamageB \} : row;/.test(ap), 'いまの写しで解いていない');
        assert.equal((ap.match(/_snapshotAtApproval\(row\)/g) || []).length, 1, '写しを2回取っている (影響と承認で別の内容になり得る)');
    });
    test('★ A: 運営ホームのヒーロー「配信後の予約があります、確認して下さい」→ 組み直し→配信へ飛ぶ', () => {
        const fn = html.match(/async function renderMyNextAction\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(fn.includes('配信後の予約があります、確認して下さい'), '文言が違う');
        assert.ok(/if \(_opsMode && season\?\.id\) \{/.test(fn), '運営ONのときだけ調べる');
        assert.ok(/rv\.pendingRepublish\(rows, samePlan\)/.test(fn), '判定をドメインに寄せていない');
        // 別シーズンの配信を「入っている」と見なさない
        assert.ok(/Number\(pub\.season_id\) === Number\(season\.id\)/.test(fn));
        // 最優先: 当日の「残り凸」より先に判定される
        assert.ok(fn.indexOf('opsPending.count > 0') < fn.indexOf("season.hard_date === todayStr) {"), '当日の分岐より後になっている');
        assert.ok(/onclick: '_opsGotoRepublish\(\)', label: /.test(fn), '押して飛べない');
        assert.ok(/function _opsGotoRepublish\(\) \{ _recomputeAndOfferPublish\(null\)/.test(html));
        // ★ 当日に本人の残り凸があるときは、運営の用事はサブリンク (本人の「戦闘に入る」を隠さない — Codex指摘 2026-09-08)
        assert.ok(/subLink = opsNotice\s*\n\s*\? heroSub\(opsNotice\.onclick, `\$\{opsNotice\.lead\} →`\)/.test(fn), '当日の残凸より運営の用事を優先している');
        assert.ok(/if \(opsNotice && atkCount != null && atkCount >= 3\) \{\s*\n[^\n]*\n\s*opsHero\(\);/.test(fn), '全凸消化後は運営の用事をヒーローにしていない');
        assert.ok(/\} else if \(opsNotice\) \{\s*\n[^\n]*\n\s*opsHero\(\);/.test(fn), '当日以外で運営の用事をヒーローにしていない');
        // ★ 承認待ち (requested / cancel_requested) があればホームで気づける (ユーザー要望 2026-09-08)。
        //   承認が先 (承認すると組み直し→配信の流れに入り、配信後の予約も一緒に片づく)
        assert.ok(/opsWaiting = rows\.filter\(r => r\.status === 'requested' \|\| r\.status === 'cancel_requested'\)\.length;/.test(fn), '承認待ちを数えていない');
        assert.ok(fn.includes('承認待ちの予約が ${opsWaiting}件あります'), '承認待ちの文言が無い');
        assert.ok(fn.indexOf('_opsMode && opsWaiting > 0') < fn.indexOf('opsPending && opsPending.count > 0'), '承認待ちより配信後の予約が先になっている');
        assert.ok(/onclick: '_opsGotoReservations\(\)', label: /.test(fn), '予約カードへ飛べない');
        const go = html.match(/function _opsGotoReservations\(\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        // 実機FB (2026-09-08): タブ切替直後は上のカードがあとから描かれて目標がずれる →
        // 一覧を取り直してから、位置が動かなくなるまでスクロールを合わせ直す
        assert.ok(/expandOpsCard\('opsSecReserve'\)/.test(go), '予約カードを開いていない');
        assert.ok(/await renderOpsReservations\(true\)/.test(go), '一覧の取り直しを待っていない');
        assert.ok(/_opsScrollSettled\('opsSecReserve'\)/.test(go), '描画が落ち着くまで合わせ直していない');
        const settle = html.match(/function _opsScrollSettled\(id\) \{[\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(tries < 8\) setTimeout\(step, 320\);/.test(settle), '合わせ直しを繰り返していない');
        assert.ok(/Math\.abs\(top - last\) > 4/.test(settle), '位置が動いたときだけ合わせ直す条件が無い');
        // 配信の状況行にも出す
        const st = html.match(/function _renderOpsPubStatus\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/pendingRepublish\(_resv\.rows, published\.plan\)\.count/.test(st));
        assert.ok(st.includes('配信後の予約が'));
    });
    test('★ D: 固定できなかった予約の表示はコードでなく日本語 (unmetText) / レベル無しは Lv を出さない', () => {
        const view = html.match(/固定できなかった予約が \$\{plan\.unmetReservations\.length\}件あります[^\n]*/)?.[0] || '';
        assert.ok(view, '表示が無い');
        assert.ok(/reservationsDomain\.unmetText\(u\)/.test(view), 'unmetText を通していない');
        assert.ok(!/\$\{u\.reason/.test(view), 'コードをそのまま出している');
        assert.ok(/u\.level != null \? `Lv\$\{Number\(u\.level\)\} ` : ''/.test(view), 'レベル無しでも Lv を出している');
        assert.ok(view.includes('実行済みなら凸報告で消えます'), '運営の2択 (C) を示していない');
    });
    test('L2 配線: 凸報告は原子的なRPCを通る (40未適用だけ従来経路)', () => {
        const fn = client.match(/window\.supabaseAddAttack = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(/supabase\.rpc\('report_attack'/.test(fn), 'RPC を使っていない');
        assert.ok(/p_reservation_id: opts\.reservationId \?\? null/.test(fn));
        // 「3凸済み」「予約の不一致」など意味のある拒否を握り潰して従来経路へ落ちない
        assert.ok(/const missing = \/report_attack\/\.test\(msg\) && \/does not exist\|schema cache\|function\/i\.test\(msg\);/.test(fn));
        assert.ok(/if \(!missing\) throw rpcErr;/.test(fn));
        // 予約つきなのに RPC が無い環境では、黙って予約を無視せずエラーにする
        assert.ok(fn.includes('予約つきの凸報告には supabase/40_attack_with_reservation_rpc.sql'));
    });
    test('L2 配線: reservations.js を読み込み、予約カードがカード定義にある', () => {
        assert.ok(html.includes('<script defer src="./js/domain/reservations.js"></script>'));
        assert.ok(html.includes('id="opsResvList"'));
        const layout = read('js', 'domain', 'opsLayout.js');
        assert.ok(/id: 'opsSecReserve'/.test(layout));
    });

    test('L1 配線: 安定化の結果を運営に見せる (効いたのか組み直したのか)', () => {
        assert.ok(/const st = plan\.stability;/.test(html));
        assert.ok(html.includes('前回の割当をそのまま維持しました'));
        assert.ok(html.includes('踏破できるレベルが上がるので組み直しました'));
        assert.ok(html.includes('時間を確約できない凸が増えるので組み直しました'));
        assert.ok(html.includes('総与ダメが大きく増えるので組み直しました'));
        // 本文に差し込まれていること (定数を作っただけで出していない、を防ぐ)
        assert.ok(/el\.innerHTML = summary \+ stickyHtml \+ viewToggle \+ bodyHtml \+ warnHtml;/.test(html));
    });
}

// ---- 互換ゲート (L2 ⑦) --------------------------------------------------------
console.log('\nclientGateDomain (互換ゲート):');
{
    const cg = globalThis.clientGateDomain;
    const _fs = (await import('node:fs')).default;
    const fs = _fs;
    const _path = (await import('node:path')).default;
    const path = _path;
    const { fileURLToPath } = await import('node:url');
    // fileURLToPath を通す: 日本語フォルダ名は URL の pathname だと ENOENT になる (他テストと同じ方式)
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    test('★ fail-open: ゲートが無い・読めない・壊れているときは止めない', () => {
        // ここを fail-closed にすると、一時的な通信断でユニオン全員のアプリが止まる
        for (const gate of [null, undefined, {}, 'ゴミ', 0, { min_client_build: null },
                            { min_client_build: 'あ' }, { min_client_build: -5 }]) {
            assert.equal(cg.evaluate({ build: 1, gate }).blocked, false, `gate=${JSON.stringify(gate)} で止めている`);
        }
    });

    test('★ ゲートを配る回は誰も止めない (min_client_build = 0 が既定)', () => {
        // 配る回に締めると、締められた側に更新経路が無くなる (2段階リリースの要)
        assert.equal(cg.evaluate({ build: 0, gate: { min_client_build: 0 } }).blocked, false);
        assert.equal(cg.evaluate({ build: 1, gate: { min_client_build: 0, min_plan_schema: 3 } }).blocked, false,
            'プラン版だけ上げてもクライアントは止めない');
    });

    test('古い版だけを止める (同じ版は通す)', () => {
        const gate = { min_client_build: 2026090701 };
        assert.equal(cg.evaluate({ build: 2026090700, gate }).blocked, true, '1つ古い');
        assert.equal(cg.evaluate({ build: 2026090701, gate }).blocked, false, 'ちょうど');
        assert.equal(cg.evaluate({ build: 2026090702, gate }).blocked, false, '新しい');
        assert.equal(cg.evaluate({ build: 0, gate }).blocked, true, '版を持たない旧クライアント');
    });

    test('★ 止めるのは プラン表示・凸報告・配信 の3つだけ', () => {
        const v = cg.evaluate({ build: 1, gate: { min_client_build: 9 } });
        assert.equal(v.blocked, true);
        for (const f of ['plan', 'attack', 'publish']) {
            assert.equal(cg.allows(v, f), false, `${f} を通している`);
        }
        // 更新できない人が何もできなくなるので、それ以外は止めない
        for (const f of ['mock', 'availability', 'chars', 'settings', undefined]) {
            assert.equal(cg.allows(v, f), true, `${f} まで止めている`);
        }
        // 止まっていなければ全部通る
        const ok = cg.evaluate({ build: 10, gate: { min_client_build: 9 } });
        for (const f of ['plan', 'attack', 'publish']) assert.equal(cg.allows(ok, f), true);
    });

    test('★ 自分より新しい版の配信プランは表示しない', () => {
        // 予約入りのプランを予約を知らない画面で描くと、実際とは違う指示を見せてしまう
        assert.equal(cg.planReadable({ planSchema: 2, supportedSchema: 1 }).readable, false);
        assert.equal(cg.planReadable({ planSchema: 2, supportedSchema: 1 }).reason, 'too_new');
        assert.equal(cg.planReadable({ planSchema: 1, supportedSchema: 1 }).readable, true, '同じ版は読める');
        assert.equal(cg.planReadable({ planSchema: null, supportedSchema: 1 }).readable, true,
            '版を持たない旧配信は 0 として読める (移行互換)');
    });

    test('運営が下限を上げたら、それより古い配信は読ませない', () => {
        const gate = { min_plan_schema: 2 };
        assert.equal(cg.planReadable({ planSchema: 1, supportedSchema: 5, gate }).readable, false);
        assert.equal(cg.planReadable({ planSchema: 1, supportedSchema: 5, gate }).reason, 'too_old');
        assert.equal(cg.planReadable({ planSchema: 2, supportedSchema: 5, gate }).readable, true);
        assert.equal(cg.planReadable({ planSchema: 1, supportedSchema: 5, gate: null }).readable, true,
            '下限が無いときは旧配信も読める');
    });

    test('文面に「いまの版」と「必要な版」が入る (何をすればいいか分かる)', () => {
        const v = cg.evaluate({ build: 3, gate: { min_client_build: 7, message: '更新してね' } });
        const s = cg.describe(v);
        assert.match(s, /更新してね/);
        assert.match(s, /3/); assert.match(s, /7/);
        assert.equal(cg.describe(cg.evaluate({ build: 9, gate: { min_client_build: 7 } })), '',
            '止まっていないときは何も出さない');
        // メッセージ未設定なら既定の文面
        assert.match(cg.describe(cg.evaluate({ build: 1, gate: { min_client_build: 7 } })), /再読み込み/);
    });

    test('★ ⑦配線: 止めるのは3機能だけ / 呼び出し口を1箇所に絞る', () => {
        const html = _fs.readFileSync(_path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const client = _fs.readFileSync(_path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(html.includes('<script defer src="./js/domain/clientGate.js"></script>'), 'ドメインを読み込んでいない');
        // 版は手で上げる単調増加の整数 (app-build のコミットSHAは大小比較できない)
        assert.ok(/const CLIENT_BUILD = \d{10};/.test(html), 'CLIENT_BUILD が無い / 形式が違う');
        assert.ok(/const PLAN_SCHEMA = \d+;/.test(html));
        // ★ 凸報告は4つある呼び出し口 (本人・一括・代理・代理一括) を supabaseAddAttack 1箇所で止める
        assert.ok(/window\.supabaseAddAttack = async function[\s\S]{0,400}_gateGuard\('attack'\)/.test(client),
            '凸報告を1箇所で止めていない');
        assert.ok(/window\.supabasePublishPlan = async function[\s\S]{0,200}_gateGuard\('publish'\)/.test(client),
            '配信を止めていない');
        assert.ok(/!_gateAllows\('plan'\)/.test(html), 'プラン表示を止めていない');
        // ★ 起動時に、他の取得より**先に**読む。止められている操作を掴んでから画面を作る。
        //   handleSetClientGate 内の呼び出しと取り違えないよう、起動の並びごと固定する
        assert.ok(/await _loadClientGate\(\);\s*\n\s*await loadSlvRatioTable\(\);/.test(html),
            '起動時に (他の取得より先に) ゲートを読んでいない');
        // 配信には版を載せ、読む側は自分より新しい版を描かない
        assert.ok(/supabasePublishPlan\(_opsLastPlan, me\?\.id \|\| null, me\?\.name \|\| null, seasonId, PLAN_SCHEMA\)/.test(html));
        assert.ok(/planReadable\(\{[\s\S]{0,120}supportedSchema: PLAN_SCHEMA/.test(html));
        // 41未適用でも配信は止めない (列を落として入れ直す)
        assert.ok(/_isMissingColumnErr\(error, 'plan_schema'\)/.test(client));
    });
    test('★ ⑦配線: 運営側のプラン算出も止める / 締めた直後の端末にも届く', () => {
        const html = _fs.readFileSync(_path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        // 本人の配信カードだけ隠しても、古いアプリの運営画面でプランを組めてしまう (Codex指摘)
        const fn = html.match(/async function computeAndRenderOptimalPlan[\s\S]{0,1200}/)?.[0] || '';
        assert.ok(/!_gateAllows\('plan'\)/.test(fn), '運営の算出を止めていない');
        // ★ 起動しっぱなしの端末に「締めた」を届ける。押す直前と復帰時に取り直す
        assert.ok(/_refreshClientGateIfStale/.test(fn), '算出の直前に取り直していない');
        assert.ok(/visibilitychange[\s\S]{0,160}_refreshClientGateIfStale/.test(html), '復帰時に取り直していない');
        assert.ok(/_gateFetchedAt = Date\.now\(\);/.test(html), '取得時刻を記録していない');
        // 解除は配信の版のしめ切りも戻す (戻さないと「解除しました」なのに旧配信が出ない)
        assert.ok(/\{ minPlanSchema: 0 \}/.test(html), '解除で min_plan_schema を戻していない');
        // ★ 再描画の呼び出し口が4つあるので、表示関数の入口でも見る
        const view = html.match(/function renderOpsPlanView\(\) \{[\s\S]{0,600}/)?.[0] || '';
        assert.ok(/!_gateAllows\('plan'\)/.test(view), '運営の再描画を止めていない');
    });

    test('★ ⑦: セッション途中で締められたら古い指示を画面に残さない', () => {
        const html = _fs.readFileSync(_path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        // 配信カードを差し替えるだけだと、ヒーローの割当ストリップと提出カードの採用マークに
        // 締める前の指示が残り続ける
        const blk = html.match(/if \(pub\?\.plan && \(!_gateAllows\('plan'\)[\s\S]{0,900}/)?.[0] || '';
        assert.ok(blk, 'ゲート分岐が見つからない');
        assert.ok(/_setMyPlanPicks\(null, identity\.id\)/.test(blk), '提出カードの採用マークを消していない');
        assert.ok(/_myPubState = null;/.test(blk), 'ヒーローの割当ストリップを消していない');
        assert.ok(/renderMyNextAction\(identity\);/.test(blk), 'ヒーローを描き直していない');
    });

    test('★ ⑦: 38/41 の欠落はどちらが先に返っても正しく外す', () => {
        const client = _fs.readFileSync(_path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
        // frozen 列が無いだけで plan_schema まで落とすと、新しすぎる配信を旧配信に見せて描いてしまう。
        // ★ 片方向の分岐だと、両方未適用の環境で先に plan_schema 欠落が返ったときに
        //   frozen 欠落を処理できずそのまま throw する (Codex指摘 2026-09-07)
        const blk = client.match(/let want = \{ frozen: true, schema: true \};[\s\S]{0,700}/)?.[0] || '';
        assert.ok(blk, '列を外していく形になっていない');
        assert.ok(/for \(let i = 0; i < 2 && r\.error; i\+\+\)/.test(blk), '2列ぶん試していない');
        assert.ok(/want\.schema && _isMissingColumnErr\(r\.error, 'plan_schema'\)/.test(blk));
        assert.ok(/want\.frozen && \(_isMissingColumnErr\(r\.error, 'frozen_at'\)/.test(blk));
        assert.ok(/else break;/.test(blk), '列欠落以外のエラーまで飲み込んでいる');
        assert.ok(/want\.frozen \? ', frozen_at, frozen_by' : ''/.test(blk));
        assert.ok(/want\.schema \? ', plan_schema' : ''/.test(blk));
    });

    test('★ ⑦: 止める側の操作は判定を取り直してから通す / 取得は single-flight', () => {
        const html = _fs.readFileSync(_path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
        const client = _fs.readFileSync(_path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
        // ★ 前面に開きっぱなしの端末は visibilitychange が起きない。
        //   メモリ上の判定だけ見ると「締めた」が届かず、凸報告と配信を続けられる
        assert.ok(/async function _gateGuard\(feature\)/.test(client), 'ガードが同期のまま');
        assert.ok(/await window\._refreshClientGateIfStale\?\.\(\)/.test(client), '直前に取り直していない');
        assert.ok(/await _gateGuard\('attack'\)/.test(client), '凸報告で await していない');
        assert.ok(/await _gateGuard\('publish'\)/.test(client), '配信で await していない');
        assert.ok(/window\._refreshClientGateIfStale = _refreshClientGateIfStale;/.test(html), '公開していない');
        // ★ 取得が並行すると、新しい「締めた」の後に古い「許可」が着地して判定が戻る
        assert.ok(/if \(_gateInFlight\) return _gateInFlight;/.test(html), 'single-flight でない');
        assert.ok(/if \(seq >= _gateApplied\)/.test(html), '古い応答を捨てていない');
        // ★ bfcache 復帰は visibilitychange が出ないうえ、復帰まで何時間も空くことがある。
        //   ここは間引きを無視して取り直す
        assert.ok(/window\.addEventListener\('pageshow'/.test(html), 'bfcache 復帰を拾っていない');
        assert.ok(/if \(e\?\.persisted\) _gateFetchedAt = 0;/.test(html), 'bfcache 復帰で間引きを外していない');
        // ★ 前面に開きっぱなしの端末にも届かせる (10秒ポーリングに相乗り。間引き5分なので通信は増えない)
        assert.ok(/_refreshClientGateIfStale\(\)\.catch\(\(\) => \{ \/\* fail-open \*\/ \}\);\s*\n\s*\/\/ ★ 凸の予約も同じ周期で/.test(html),
            'ポーリングでゲートを見ていない (締めても画面に古い指示が残る)');
        // ★ 設定画面も取得経路を _loadClientGate 1本に寄せる (直接代入すると古い値が戻る)
        const rs = html.match(/async function renderClientGateSettings[\s\S]{0,900}/)?.[0] || '';
        assert.ok(/await _loadClientGate\(\)/.test(rs), '設定画面が別経路で取っている');
        assert.ok(!/_gateRaw = g;/.test(rs), '_gateRaw を世代確認なしに代入している');
    });

    test('★ ⑦: 版は安全整数だけを採る (BIGINT・小数・例外を投げる値)', () => {
        // SQL の BIGINT は JS の安全整数を超え得る。小数の版番号も比較が壊れる
        assert.equal(cg.evaluate({ build: 5, gate: { min_client_build: Number.MAX_SAFE_INTEGER + 2 } }).blocked, false,
            '安全整数を超える下限で止めている');
        assert.equal(cg.evaluate({ build: 5, gate: { min_client_build: 10.5 } }).blocked, false, '小数の下限で止めている');
        const throwing = { get min_client_build() { throw new Error('boom'); } };
        assert.doesNotThrow(() => cg.normalizeGate(throwing), '値の取得で投げる行で落ちる');
    });

    test('★ ゲートの取得は fail-open (未適用・通信断は null = 誰も止めない)', () => {
        const client = fs.readFileSync(path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
        const body = client.match(/window\.supabaseLoadClientGate = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(body, '取得関数が無い');
        assert.ok(/catch \{ return null; \}/.test(body), '取得失敗で throw すると全員が止まりうる');
        // 設定側は未適用を SQL の適用案内に変える (静かに失敗させない)
        const setter = client.match(/window\.supabaseSetClientGate = async function[\s\S]*?\n};\n/)?.[0] || '';
        assert.ok(/_isMissingTableErr\(error, 'app_gate'\)/.test(setter));
        assert.ok(/supabase\/41_client_gate\.sql/.test(setter));
    });
    test('41_client_gate.sql: 既定は誰も止めない / 再実行で運営の設定を戻さない', () => {
        const sql = fs.readFileSync(path.join(ROOT, 'supabase', '41_client_gate.sql'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(/CREATE TABLE IF NOT EXISTS app_gate/.test(sql));
        assert.ok(/min_client_build BIGINT NOT NULL DEFAULT 0/.test(sql), '既定が 0 でない (配る回に締めてしまう)');
        assert.ok(/ON CONFLICT \(id\) DO NOTHING/.test(sql), '再実行で運営が上げた値を戻してしまう');
        assert.ok(/CHECK \(id = 1\)/.test(sql), '設定行が複数できないようにすること');
        assert.ok(/ALTER TABLE published_plans ADD COLUMN IF NOT EXISTS plan_schema INT/.test(sql));
        assert.ok(/NOTIFY pgrst/.test(sql));
    });
}

// ---- growthDomain (ユニオンメンバーの育成データ) --------------------------------
console.log('\ngrowthDomain:');
{
    const dom = globalThis.growthDomain;
    const _fsG = (await import('node:fs')).default;
    const _pathG = (await import('node:path')).default;
    const _ROOTG = _pathG.resolve(_pathG.dirname((await import('node:url')).fileURLToPath(import.meta.url)), '..');

    // 実測に合わせた素材 (2026-09-08)。id は state_effects では文字列、装備側では数値で来る
    const EFFECTS = [
        { id: '101', function_details: [{ function_type: 'StatAtk', function_value: 1234 }] },
        { id: 202, function_details: [{ function_type: 'StatChargeTime', function_value: -560 }] },
        { id: 303, function_details: [{ function_type: 'StatCritical', function_value: 700 }] },
        { id: 404, function_details: [{ function_type: 'UnknownThing', function_value: 100 }] },
        { id: '101', function_details: [{ function_type: 'StatAtk', function_value: 9999 }] },   // 重複 (先勝ち)
    ];
    const mkDetail = (over = {}) => ({
        name_code: 1012, grade: 3, core: 2, lv: 200,
        skill1_lv: 10, skill2_lv: 9, ulti_skill_lv: 10, combat: 123456, attractive_lv: 30,
        harmony_cube_tid: 5, harmony_cube_lv: 15, favorite_item_tid: 7, favorite_item_lv: 2,
        head_equip_tier: 10, head_equip_lv: 3, head_equip_option1_id: 101, head_equip_option2_id: 303,
        torso_equip_tier: 9, arm_equip_tier: 0, leg_equip_tier: 10, leg_equip_lv: 5, leg_equip_option1_id: 202,
        ...over,
    });
    const NAME_MAP = { '1012': { jp: 'サクラ', pad: 'サクラ' }, '3015': { jp: 'サクラ', pad: '鈴原サクラ' } };

    test('突破: grade 0〜3 / core は grade=3 のときだけ効く / 通し番号は 1〜11', () => {
        assert.equal(dom.gradeText(0, 0), '0凸');
        assert.equal(dom.gradeText(2, 0), '2凸');
        assert.equal(dom.gradeText(3, 0), '3凸');
        assert.equal(dom.gradeText(3, 7), 'コア7');
        // ★ 3凸未満で core が入っていても無視する (段階が飛ぶと「相手のほうが上」を誤判定する)
        assert.equal(dom.gradeText(1, 5), '1凸');
        assert.equal(dom.growthRank(1, 5), 2);
        assert.deepEqual([[0,0],[1,0],[2,0],[3,0],[3,1],[3,7]].map(([g, c]) => dom.growthRank(g, c)), [1, 2, 3, 4, 5, 11]);
    });

    test('オーバーロード: 文字列 id も引ける / チャージ時間の負値を正に / 未知の効果は捨てる / 重複は先勝ち', () => {
        const m = dom.buildOptionMap(EFFECTS);
        // ★ id は state_effects で文字列、装備スロットで数値。数のまま突き合わせないと全部 0 になる
        assert.equal(m.get(101).jp, '攻撃力');
        assert.equal(m.get(101).value, 12.34, '2回目の 9999 を採ってしまっている (先勝ちでない)');
        assert.equal(m.get(202).value, 5.6, 'チャージ時間の負値を正に直していない');
        assert.equal(m.get(303).jp, 'クリティカル確率');
        assert.equal(m.has(404), false, '未知の効果を通している');
        assert.deepEqual(dom.buildOptionMap(null), new Map());
    });

    test('オーバーロード合計: 12枠を合算し、埋まっていない枠と未知 id は数えない', () => {
        const m = dom.buildOptionMap(EFFECTS);
        assert.deepEqual(dom.overloadTotals(mkDetail(), m), { 攻撃力: 12.34, クリティカル確率: 7, チャージ速度: 5.6 });
        assert.equal(dom.overloadSlotCount(mkDetail(), m), 3);
        // 同じ効果が複数枠に付いたら足す
        const two = mkDetail({ torso_equip_option1_id: 101 });
        assert.equal(dom.overloadTotals(two, m).攻撃力, 24.68);
        assert.equal(dom.overloadSlotCount(two, m), 4);
        // 未知の id は 0 枠扱い (state_effects に無い = 意味が分からない)
        assert.equal(dom.overloadSlotCount(mkDetail({ arm_equip_option1_id: 999 }), m), 3);
    });

    test('★ 装備は 企業 / 一般 / 未装着 の3つを区別する (畳むと未装着が一般装備に見える)', () => {
        const e = dom.equipOf(mkDetail());
        assert.deepEqual(e.map((x) => `${x.part}:${x.text}`), ['頭:企業+3', '胴:T9', '腕:未装着', '脚:企業+5']);
        assert.equal(e[0].kind, '企業');
        assert.equal(e[1].kind, '一般');
        assert.equal(e[2].kind, '未装着');
        // 企業の強化は 0〜5 に収める
        assert.equal(dom.equipOf({ head_equip_tier: 10, head_equip_lv: 99 })[0].text, '企業+5');
    });

    test('toRows: PAD に無い name_code は unknown へ / wanted で絞る / 同じキャラは先勝ち', () => {
        const got = dom.toRows({
            characters: [{ name_code: 1012, grade: 3, core: 2 }],
            details: [mkDetail(), mkDetail({ name_code: 9999 }), mkDetail()],
            stateEffects: EFFECTS, nameCodeMap: NAME_MAP,
        });
        assert.equal(got.rows.length, 1, '同じキャラを2行作っている');
        assert.equal(got.rows[0].character_name, 'サクラ');
        assert.equal(got.rows[0].name_code, 1012);
        assert.deepEqual(got.unknown, [{ name_code: '9999', jp: null }]);
        assert.deepEqual(got.rows[0].overload, { 攻撃力: 12.34, クリティカル確率: 7, チャージ速度: 5.6 });
        assert.equal(got.rows[0].equip.length, 4);
        // wanted に無いキャラは落とす (今回のレイドで使われたキャラだけ取り込む)
        const only = dom.toRows({ details: [mkDetail()], stateEffects: EFFECTS, nameCodeMap: NAME_MAP, wanted: ['ラピ'] });
        assert.equal(only.rows.length, 0);
        assert.deepEqual(only.skipped, ['サクラ']);
    });

    test('★ 本当に 0 の値を「未取得」に化けさせない (画面は — なのに差分だけ計算される)', () => {
        const map = { '1': { jp: 'X', pad: 'X' } };
        const zero = dom.toRows({
            details: [{ name_code: 1, grade: 0, core: 0, lv: 1, skill1_lv: 0, skill2_lv: 0, combat: 0, attractive_lv: 0 }],
            stateEffects: EFFECTS, nameCodeMap: map,
        }).rows[0];
        // 未突破・スキルLv0・戦闘力0 は「そういう値」であって「取れなかった」ではない
        assert.equal(zero.grade, 0); assert.equal(zero.core, 0);
        assert.equal(zero.skill1_lv, 0); assert.equal(zero.combat, 0); assert.equal(zero.attractive_lv, 0);

        // 応答に無い項目だけが null になる
        const absent = dom.toRows({ details: [{ name_code: 1 }], stateEffects: EFFECTS, nameCodeMap: map }).rows[0];
        assert.equal(absent.grade, null); assert.equal(absent.skill1_lv, null); assert.equal(absent.combat, null);

        // 0 同士は「同じ」、null 相手は「分からない」。null を 0 として比べない
        const same = dom.compare(zero, zero).rows;
        assert.equal(same.find((r) => r.key === 'combat').lead, 'same');
        assert.equal(same.find((r) => r.key === 'combat').diff, 0);
        assert.equal(same.find((r) => r.key === 'growth').text === undefined, true);
        assert.equal(same.find((r) => r.key === 'growth').mine, '0凸');

        const mixed = dom.compare(absent, zero).rows;
        const s1 = mixed.find((r) => r.key === 'skill1_lv');
        assert.equal(s1.mine, '—');
        assert.equal(s1.theirs, 'Lv0');
        assert.equal(s1.lead, 'unknown', 'null を 0 として比べている');
        assert.equal(s1.diff, null);
        assert.equal(mixed.find((r) => r.key === 'growth').mine, '—', '突破が分からないのに 0凸 と言い切っている');
        // ★ 1項目だけでなく全項目を見る。どれか1つでも null を 0 に畳んでいたら落とす
        const folded = mixed.filter((r) => r.lead !== 'unknown' || r.diff !== null).map((r) => r.label);
        assert.deepEqual(folded, [], `null を 0 として比べている項目がある: ${folded.join(', ')}`);
    });

    test('★ state_effects が足りないまま「オーバーロード無し」として保存させない', () => {
        const map = { '1': { jp: 'X', pad: 'X' } };
        // 枠は埋まっているのに state_effects が空 = 意味が分からない。数えて呼び出し側に返す
        const blind = dom.toRows({
            details: [{ name_code: 1, head_equip_option1_id: 555, torso_equip_option2_id: 556 }],
            stateEffects: [], nameCodeMap: map,
        });
        assert.equal(blind.optionsUnresolved, 2, '解決できなかった枠を数えていない');
        assert.deepEqual(blind.rows[0].overload, {});
        // 解決できていれば 0
        const ok = dom.toRows({ details: [mkDetail()], stateEffects: EFFECTS, nameCodeMap: NAME_MAP });
        assert.equal(ok.optionsUnresolved, 0);
        assert.equal(dom.unresolvedOptions(mkDetail({ arm_equip_option1_id: 999 }), dom.buildOptionMap(EFFECTS)), 1);
    });

    test('★ 同名の別キャラを取り違えない: name_code 3015 は 鈴原サクラ', () => {
        // CDN ではどちらも日本語名が「サクラ」。対応表が name_code で引けていれば取り違えない
        const got = dom.toRows({
            details: [mkDetail({ name_code: 3015 })], stateEffects: EFFECTS, nameCodeMap: NAME_MAP,
        });
        assert.equal(got.rows[0].character_name, '鈴原サクラ');
    });

    test('★ 非公開と一時的な失敗を混ぜない (催促の相手を間違える)', () => {
        assert.equal(dom.statusOfCode(0), 'ok');
        assert.equal(dom.statusOfCode(1301002), 'private');   // user not allow show gamecard
        assert.equal(dom.statusOfCode(1303002), 'private');   // GetUserShiftyspadPrivacy error
        assert.equal(dom.statusOfCode(500), 'error');
        assert.equal(dom.statusOfCode(undefined), 'error');
        assert.ok(dom.STATUS_JP.no_openid.includes('運営'), '未紐づけを本人のせいに読める文言にしない');
    });

    test('★ 比較: 片方が持っていない項目を「差 0」にしない', () => {
        const m = dom.buildOptionMap(EFFECTS);
        const mine = { ...dom.toRows({ details: [mkDetail({ skill1_lv: 4 })], stateEffects: EFFECTS, nameCodeMap: NAME_MAP }).rows[0] };
        const theirs = { ...dom.toRows({ details: [mkDetail()], stateEffects: EFFECTS, nameCodeMap: NAME_MAP }).rows[0] };
        const cmp = dom.compare(mine, theirs);
        const s1 = cmp.rows.find((r) => r.key === 'skill1_lv');
        assert.equal(s1.lead, 'theirs');
        assert.equal(s1.diff, 6);
        assert.equal(cmp.rows.find((r) => r.key === 'lv').lead, 'same');
        assert.equal(cmp.missing, null);

        // 相手のデータが無いとき: 全部 unknown で、差は null (0 ではない)
        const none = dom.compare(mine, null);
        assert.equal(none.missing, 'theirs');
        assert.ok(none.rows.every((r) => r.lead === 'unknown' && r.diff === null), '欠けを「同じ」に見せている');
        assert.ok(none.rows.every((r) => r.theirs === '—'));
        assert.deepEqual(dom.compare(null, null).rows, []);
    });

    test('比較: オーバーロードは片方にしか無い項目も並べる', () => {
        const mine = { overload: { 攻撃力: 10 } };
        const theirs = { overload: { 攻撃力: 12.5, クリティカル確率: 7 } };
        const cmp = dom.compare(mine, theirs);
        const keys = cmp.overload.map((o) => o.key);
        assert.deepEqual(keys, ['クリティカル確率', '攻撃力']);
        const atk = cmp.overload.find((o) => o.key === '攻撃力');
        assert.equal(atk.lead, 'theirs'); assert.equal(atk.mine, '10.00%'); assert.equal(atk.theirs, '12.50%');
        // 自分が持っていない項目は 0% として並ぶ (「無い」ことが見えるほうがよい)
        assert.equal(cmp.overload.find((o) => o.key === 'クリティカル確率').mine, '0.00%');
    });

    test('compareSquad / usedCharacters: 編成ぶんをまとめて、凸記録から対象を集める', () => {
        const mine = { サクラ: { grade: 3, core: 0 } };
        const theirs = { サクラ: { grade: 3, core: 5 } };
        const list = dom.compareSquad(['サクラ', 'ラピ'], mine, theirs);
        assert.equal(list.length, 2);
        assert.equal(list[0].character, 'サクラ');
        assert.equal(list[0].rows.find((r) => r.key === 'growth').lead, 'theirs');
        assert.equal(list[1].missing, 'both', '両方持っていない扱いになっていない');
        // 凸記録は文字列でもオブジェクトでも来る (古いスキーマ対策)
        assert.deepEqual(dom.usedCharacters([{ characters: ['B', 'A'] }, { characters: [{ name: 'A' }, { name: 'C' }] }]),
            ['A', 'B', 'C']);
        assert.deepEqual(dom.usedCharacters(null), []);
    });

    test('★ ブックマークレット: 1行・構文が通る・埋め込んだ値が壊れない', () => {
        const snip = dom.buildImportSnippet({
            // 名前に ' と \ を入れる — 文字列連結で組むと、ここで壊れる
            targets: [{ openid: '3273786220482814289', label: "ふる'り\\さん" }, { openid: '16669553168687894762', label: 'B' }],
            wantedCodes: [1012, 3015],
        });
        assert.ok(snip.startsWith('javascript:'), 'ブックマークレットの形になっていない');
        assert.ok(!/\n/.test(snip), '改行があるとブックマークに登録できない');
        // 実際に構文として通ること (壊れたコードを配らない)
        assert.doesNotThrow(() => new Function(snip.slice('javascript:'.length)));
        assert.ok(snip.includes('3273786220482814289') && snip.includes('16669553168687894762'));
        assert.ok(snip.includes('1012') && snip.includes('3015'), '取りたい name_code が入っていない');
        // ★ DevTools を閉じて使うので、出力はページ上のボックス。console に出すと見えない
        assert.ok(/document\.createElement\("textarea"\)/.test(snip), '出力先がページ上のボックスでない');
        assert.ok(/credentials:"include"/.test(snip), 'ログイン状態を使っていない');
        // 識別子が数字でないものは落とす / 1人もいなければ作らない
        assert.throws(() => dom.buildImportSnippet({ targets: [{ openid: '' }, { openid: 'abc' }] }), /識別子/);
        assert.throws(() => dom.buildImportSnippet({}), /相手がいません/);
    });

    await testAsync('★ 取り込みの読み取り: 生 JSON も gzip+base64 も読める / 別ツールの出力は言い分ける', async () => {
        const payload = {
            v: 1, at: '2026-09-09T00:00:00Z',
            members: [{ openid: '1', label: 'A', code: 0, area: 81, characters: [], details: [], stateEffects: [] }],
        };
        const raw = await dom.parseImportPayload(JSON.stringify(payload));
        assert.equal(raw.members.length, 1);
        assert.equal(raw.at, '2026-09-09T00:00:00Z');

        // ブックマークレットと同じ手順で固める
        const gz = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'));
        const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        const packed = await dom.parseImportPayload(dom.IMPORT_PREFIX + btoa(bin));
        assert.equal(packed.members.length, 1);
        assert.equal(packed.members[0].label, 'A');

        // 何を貼り直せばよいかが分かる文言で投げる
        await assert.rejects(dom.parseImportPayload(''), /空です/);
        await assert.rejects(dom.parseImportPayload('こわれてる'), /認識できませんでした/);
        await assert.rejects(dom.parseImportPayload(JSON.stringify({ profile: { openid: '1' }, areas: [] })), /スクワッド/);
        await assert.rejects(dom.parseImportPayload(dom.IMPORT_PREFIX + 'あああ'), /展開に失敗/);
        // ★ 上限を置く。人が貼るものなので、これを超えるのは事故か別物
        await assert.rejects(dom.parseImportPayload('x'.repeat(8 * 1000 * 1000 + 1)), /大きすぎます/);

        // ★ gzip 爆弾は**展開しきる前に**止める (全部展開してから測っても手遅れ)
        const bomb = new Blob([JSON.stringify({ members: [], pad: 'a'.repeat(2000000) })])
            .stream().pipeThrough(new CompressionStream('gzip'));
        const bb = new Uint8Array(await new Response(bomb).arrayBuffer());
        let bs = '';
        for (const b of bb) bs += String.fromCharCode(b);
        const started = Date.now();
        await assert.rejects(dom.parseImportPayload(dom.IMPORT_PREFIX + btoa(bs), { maxJson: 50000 }),
            /展開した内容が大きすぎます/);
        assert.ok(Date.now() - started < 2000, '打ち切らずに最後まで展開している');
        // 上限の内側なら通る (上限そのものが厳しすぎないこと)
        assert.equal((await dom.parseImportPayload(dom.IMPORT_PREFIX + btoa(bs))).members.length, 0);
    });

    test('★ 保存してよいかの判断: 非公開は保存しない / オーバーロードが読めなければ保存しない', () => {
        const map = { '1012': { jp: 'サクラ', pad: 'サクラ' } };
        const detail = {
            name_code: 1012, grade: 3, core: 2, lv: 200, skill1_lv: 10,
            head_equip_tier: 10, head_equip_lv: 3, head_equip_option1_id: 101,
        };
        const effects = [{ id: '101', function_details: [{ function_type: 'StatAtk', function_value: 1234 }] }];

        const ok = dom.prepareMember({ code: 0, characters: [], details: [detail], stateEffects: effects }, { nameCodeMap: map });
        assert.equal(ok.status, 'ok'); assert.equal(ok.save, true); assert.equal(ok.rows.length, 1);

        // 非公開は「取れなかった」を状態として残す。保存はしない
        const priv = dom.prepareMember({ code: 1301002 }, { nameCodeMap: map });
        assert.equal(priv.status, 'private'); assert.equal(priv.save, false);
        assert.match(priv.detail, /非公開/);

        // ★ state_effects が足りないまま「オーバーロード無し」で残すと、比較が静かに嘘をつく
        const blind = dom.prepareMember({ code: 0, details: [detail], stateEffects: [] }, { nameCodeMap: map });
        assert.equal(blind.save, false, 'オーバーロードを読めないまま保存しようとしている');
        assert.equal(blind.status, 'error');
        assert.match(blind.detail, /オーバーロードを 1 枠/);

        // 1体も取れなければ保存しない (空で上書きしない)
        const empty = dom.prepareMember({ code: 0, details: [], stateEffects: effects }, { nameCodeMap: map });
        assert.equal(empty.save, false);
        assert.match(empty.detail, /1体も取れませんでした/);

        // wanted で絞ったうえで対象が残ればよい
        const want = dom.prepareMember({ code: 0, details: [detail], stateEffects: effects },
            { nameCodeMap: map, wanted: ['サクラ'] });
        assert.equal(want.save, true);
    });

    test('★ 壊れた応答を「成功」に化けさせない (Number([]) も Number("") も 0)', () => {
        assert.equal(dom.statusOfCode(0), 'ok');
        for (const bad of [[], '', '0', null, undefined, {}, NaN, '1301002']) {
            assert.equal(dom.statusOfCode(bad), 'error', `${JSON.stringify(bad)} を error にしていない`);
        }
        assert.equal(dom.statusOfCode(1301002), 'private');
    });

    test('★ 一部しか返っていないスナップショットを保存しない', () => {
        const map = { '1012': { jp: 'サクラ', pad: 'サクラ' } };
        const eff = [{ id: '101', function_details: [{ function_type: 'StatAtk', function_value: 1234 }] }];
        const d = { name_code: 1012, grade: 3, core: 0, head_equip_option1_id: 101 };
        // 3体頼んで1体しか返っていない = 穴の空いた記録になる
        const partial = dom.prepareMember({
            code: 0, requested: 3,
            characters: [{ name_code: 1012 }, { name_code: 2000 }, { name_code: 3000 }],
            details: [d], stateEffects: eff,
        }, { nameCodeMap: map });
        assert.equal(partial.save, false, '欠けたまま保存しようとしている');
        assert.match(partial.detail, /1\/3 体/);
        // requested が無い古い形でも characters から見る
        const legacy = dom.prepareMember(
            { code: 0, characters: [{ name_code: 1012 }, { name_code: 2000 }], details: [d], stateEffects: eff },
            { nameCodeMap: map });
        assert.equal(legacy.save, false);

        // ★ 件数の比較では騙される。頼んだ name_code が返っているかを集合で見ること
        const dup = dom.prepareMember({
            code: 0, requested: 2, characters: [{ name_code: 1012 }, { name_code: 2000 }],
            details: [d, d], stateEffects: eff,      // 同じキャラが2回来て数だけ揃う
        }, { nameCodeMap: map });
        assert.equal(dup.save, false, '重複で数を埋められている');
        const unk = dom.prepareMember({
            code: 0, requested: 2, characters: [{ name_code: 1012 }, { name_code: 2000 }],
            details: [d, { ...d, name_code: 9999 }], stateEffects: eff,   // 対応表に無いキャラで数だけ揃う
        }, { nameCodeMap: map });
        assert.equal(unk.save, false, '対応表に無いキャラで数を埋められている');
        // characters 自体が途中で切れていたら requested との差で気づく
        const cut = dom.prepareMember({
            code: 0, requested: 5, characters: [{ name_code: 1012 }], details: [d], stateEffects: eff,
        }, { nameCodeMap: map });
        assert.equal(cut.save, false, '頼んだ一覧が途中で切れているのを見逃している');
        // 揃っていれば保存する
        assert.equal(dom.prepareMember({
            code: 0, requested: 1, characters: [{ name_code: 1012 }], details: [d], stateEffects: eff,
        }, { nameCodeMap: map }).save, true);
    });

    test('★ parseOpenid: 数字だけ / ?uid= を含むリンク を受け、それ以外の数字は拾わない', () => {
        assert.equal(dom.parseOpenid('123456789'), '123456789');
        assert.equal(dom.parseOpenid('  123456789  '), '123456789');
        assert.equal(dom.parseOpenid('https://www.blablalink.com/profile?uid=123456789'), '123456789');
        assert.equal(dom.parseOpenid('https://x/y?a=1&openid=987654321&b=2'), '987654321');
        assert.equal(dom.parseOpenid('https://x/y#intl_open_id=555555555'), '555555555');
        // ★ 取り違えは「他人の育成が別人に付く」事故。関係ない数字を拾わないこと
        assert.equal(dom.parseOpenid('https://x/y?area=81&t=1725792000000'), null, '別のパラメータを識別子にしている');
        assert.equal(dom.parseOpenid('12345'), null, '短すぎる数字を通している');
        assert.equal(dom.parseOpenid('abc'), null);
        assert.equal(dom.parseOpenid(''), null);
        assert.equal(dom.parseOpenid(null), null);
    });

    test('★ wantedCodesFor: 使われたキャラ → name_code。対応表に無い名前は missing に出す (黙って外さない)', () => {
        const map = { '1012': { jp: 'サクラ', pad: 'サクラ' }, '3015': { jp: 'サクラ', pad: '鈴原サクラ' }, '1007': { jp: 'D', pad: 'D' } };
        const r = dom.wantedCodesFor(['鈴原サクラ', 'D', 'シフティー', 'D'], map);
        assert.deepEqual(r.codes, [1007, 3015], '重複を畳んで昇順にしていない');
        assert.deepEqual(r.missing, ['シフティー'], '対応表に無い名前を黙って外している');
        assert.deepEqual(dom.wantedCodesFor([], map), { codes: [], missing: [] });
        assert.deepEqual(dom.wantedCodesFor(['D'], null), { codes: [], missing: ['D'] });
        // pad が無い行 (CDN にしか無いキャラ) は対応先にしない
        assert.deepEqual(dom.wantedCodesFor(['謎'], { '9999': { jp: '謎', pad: null } }).missing, ['謎']);
    });

    test('★ importSummary: 取れた/非公開/未ひも付け/失敗 を分け、取れなかった人をまとめる', () => {
        const r = dom.importSummary([
            { name: 'a', status: 'ok', count: 5 }, { name: 'b', status: 'ok', count: 3 },
            { name: 'c', status: 'private' }, { name: 'd', status: 'no_openid' },
            { name: 'e', status: 'error' }, { name: 'f', status: 'なにこれ' },
        ]);
        assert.equal(r.ok, 2); assert.equal(r.characters, 8);
        assert.equal(r.private, 1); assert.equal(r.noOpenid, 1);
        assert.equal(r.error, 2, '知らない状態を失敗に寄せていない');
        assert.deepEqual(r.failed.map(x => x.name), ['c', 'd', 'e', 'f']);
        const none = dom.importSummary(null);
        assert.equal(none.ok, 0); assert.equal(none.characters, 0); assert.deepEqual(none.failed, []);
    });

    test('★ 配線: 育成の取り込みパネル (段階「終了」・upsert のみ・43未適用は止める)', () => {
        const rd = (...p) => _fsG.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
        const html = rd('index.html'), client = rd('js', 'supabase-client.js'), layout = rd('js', 'domain', 'opsLayout.js');
        // 置き場所は運営タブの段階「終了」— 使われたキャラが確定するのはレイド後
        assert.ok(/id: 'opsSecGrowth',[^\n]*stages: \['end'\]/.test(layout), '取り込みカードが終了段階に無い');
        assert.ok(/id="opsGrowthBody"/.test(html) && /id="opsGrowthCounts"/.test(html), 'カードの描画先が無い');
        assert.ok(/🧬 育成データの取り込み/.test(html), '見出しが CARDS の title と揃っていない');
        // 盤面の描画と一緒に更新する (運営ONのときだけ中で取得)
        assert.ok(/renderOpsGrowth\(\);/.test(html.match(/async function renderOpsDashboard\(\)[\s\S]*?\n        \}\n/)?.[0] || ''), '盤面の描画から呼んでいない');
        const rg = html.match(/async function renderOpsGrowth\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/if \(!_opsMode\) return;/.test(rg), '運営OFF でも取得している');
        assert.ok(/gen !== _growth\.gen/.test(rg), '追い越した古い応答を捨てていない');
        assert.ok(/usedCharacters\(atks\)/.test(rg) && /wantedCodesFor\(_growth\.used, nameMap\)/.test(rg), '対象をドメインで決めていない');
        // 取り込みは prepareMember の判断に従う (保存してよいかを画面で決めない)
        const imp = html.match(/async function handleGrowthImport\([\s\S]*?\n        \}\n/)?.[0] || '';
        assert.ok(/box = await dom\.parseImportPayload\(text\);/.test(imp), '貼り付けの展開 (非同期) を await していない — box が Promise になり取り込みが必ず失敗する');
        assert.ok(/dom\.prepareMember\(m, \{ nameCodeMap: nameMap, wanted \}\)/.test(imp), '保存してよいかの判断をドメインに任せていない');
        // ★ 1人ずつ await する間に画面が更新されても、開始時の写しで書き続ける (Codex指摘 2026-09-09)
        assert.ok(/const players = \(_growth\.players \|\| \[\]\)\.slice\(\);/.test(imp), '取り込みの材料 (メンバー) の写しを取っていない');
        assert.ok(/const wanted = \(_growth\.used \|\| \[\]\)\.slice\(\);/.test(imp), '取り込みの材料 (対象キャラ) の写しを取っていない');
        assert.ok(/if \(priorStatus\.get\(String\(p\.id\)\) === 'ok'\) continue;/.test(imp), '取り込み済みの状態を未ひも付けで上書きしている');
        assert.ok(/if \(prep\.save\)/.test(imp), 'save の判断を無視して保存している');
        assert.ok(/status: 'no_openid'/.test(imp), '識別子が無い人を状態として残していない');
        // 保存は upsert のみ (2026-09-09 の決定①) — delete を書かない
        const cli = client.match(/window\.supabaseSaveMemberGrowth = [\s\S]*?\n\};\n/)?.[0] || '';
        assert.ok(/\.upsert\(list, \{ onConflict: 'season_id,player_id,character_name' \}\)/.test(cli), 'upsert で保存していない');
        assert.ok(!/\.delete\(/.test(cli), '取り込みで既存行を消している (部分的な結果で記録が欠ける)');
        // 43 未適用は静かに劣化させない (取り込みは運営が明示的に始める操作)
        assert.ok(/supabase\/43_member_growth\.sql/.test(client), '43 未適用の案内が無い');
        assert.ok(/_isMissingTableErr\(error, 'member_growth_status'\)\) return null;/.test(client), '未適用を「全員未取り込み」と混同している');
        // 一意索引に当たったら誰と重複したかを言う (取り違えの事故を見つけられるように)
        assert.ok(/error\.code === '23505'/.test(client) && /に登録済みです/.test(client), '識別子の重複を名前つきで知らせていない');
    });

    test('★ 生成コード: 1人が転んでも残りの取得を続ける / 要求数を記録する', () => {
        const snip = dom.buildImportSnippet({ targets: [{ openid: '1234567890' }], wantedCodes: [1012] });
        assert.doesNotThrow(() => new Function(snip.slice('javascript:'.length)));
        // ここで throw を素通りさせると、1人の通信失敗で全員ぶんの結果が消える
        assert.ok(/\}catch\(e\)\{if\(rec\.code===0\|\|rec\.code==null\)\{rec\.code=-1;\}/.test(snip),
            '1人ぶんの失敗を捕まえていない (全員ぶんが消える)');
        assert.ok(snip.includes('rec.requested=want.length'), '要求数を記録していない (部分取得を検出できない)');
        assert.ok(!/continue;/.test(snip), 'continue で push を飛ばすと、その人の結果が記録から消える');
    });

    test('test() ハーネス: async を渡したら落とす (静かに通るテストを作らせない)', () => {
        const src = _fsG.readFileSync(_pathG.join(_ROOTG, 'tests', 'run-tests.mjs'), 'utf8');
        const fn = src.match(/function test\(name, fn\) \{[\s\S]*?\n\}/)?.[0] || '';
        assert.ok(/typeof r\.then === 'function'/.test(fn), 'async のテストを検出していない');
        assert.ok(/testAsync/.test(fn), '正しい使い方を案内していない');
        // 実際に async を渡すと throw することを、カウンタを汚さずに確かめる
        assert.throws(() => { const r = (async () => {})(); if (r && typeof r.then === 'function') throw new Error('async'); });
    });

    test('43_member_growth.sql: 冪等・識別子の一意性・状態の綴り', () => {
        const sql = _fsG.readFileSync(_pathG.join(_ROOTG, 'supabase', '43_member_growth.sql'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(/ADD COLUMN IF NOT EXISTS blabla_openid TEXT/.test(sql));
        // 1つの識別子を2人に付けない。未設定は何人いてもよいので部分索引
        assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_players_blabla_openid[\s\S]*?WHERE blabla_openid IS NOT NULL/.test(sql),
            '識別子の一意性が無い、または部分索引になっていない');
        assert.ok(/CREATE TABLE IF NOT EXISTS member_growth \(/.test(sql));
        assert.ok(/CREATE TABLE IF NOT EXISTS member_growth_status \(/.test(sql));
        assert.ok(/PRIMARY KEY \(season_id, player_id, character_name\)/.test(sql), 'シーズンごとのスナップショットになっていない');
        // 非公開・未紐づけ・失敗を綴りで固定する
        for (const st of ['ok', 'private', 'no_openid', 'error']) {
            assert.ok(new RegExp(`'${st}'`).test(sql), `状態 ${st} が CHECK に無い`);
        }
        assert.ok(/DROP CONSTRAINT IF EXISTS member_growth_status_status_check/.test(sql), '再実行できない');
        assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql) && /NOTIFY pgrst/.test(sql));
        // 99 の判定行 (SQL Editor で 99 を1回流せば未適用が見える、を保つ)
        const check = _fsG.readFileSync(_pathG.join(_ROOTG, 'supabase', '99_check_applied.sql'), 'utf8');
        assert.ok(/'43_member_growth'/.test(check), '99_check_applied.sql に判定行が無い');
        // 予約の部分索引 (42) も同じ穴を持っていたので塞いである — 3状態を含んでいても
        // さらに AND で絞られていたら一意性は守られない
        assert.ok(/split_part\(indexdef, ' WHERE ', 2\) NOT LIKE '% AND %'/.test(check),
            '部分索引が AND で絞られていないかを見ていない');
        assert.ok(/uq_players_blabla_openid/.test(check) && /no_openid/.test(check), '判定が緩すぎる');
        // ★ 部分条件はその列に掛かっているかまで見る。WHERE と IS NOT NULL を別々に探すと
        //   別の列の条件でも「適用済み」と誤判定する
        assert.ok(/WHERE \(?blabla_openid IS NOT NULL\)?'/.test(check),
            '部分索引の述語を列ごと照合していない (WHERE と IS NOT NULL を別々に探している)');
        // ★ 述語で終端まで固定する。末尾に % があると「AND 別条件」で絞りすぎた索引も通る
        assert.ok(!/blabla_openid IS NOT NULL\)?%'/.test(check),
            '述語のあとに % が付いている (絞りすぎた部分索引を「適用済み」と誤判定する)');
    });
}

// ---- data/blabla-name-codes.json (BlaBlaLINK の name_code → PAD のキャラ名) -----
//   ユニオン育成データ取り込みの土台。ここが狂うと**他人の育成が別キャラに付く**ので、
//   生成時 (scripts/build-blabla-name-codes.mjs) だけでなく、ここでも不変条件を固定しておく。
console.log('\nblablaNameCodes:');
{
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const ROOT = path.resolve(path.dirname((await import('node:url')).fileURLToPath(import.meta.url)), '..');
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'blabla-name-codes.json'), 'utf8'));

    // 手当ての正解表。★ここを正としてピン留めする — 生成スクリプトの OVERRIDES を
    //   書き換えても、宛先が変われば必ずここで落ちる (Codex指摘 2026-09-08)
    const EXPECTED_OVERRIDES = {
        3015: '鈴原サクラ',                     1013: 'ソルジャーEG',
        1014: 'ソルジャーFA',                   1025: 'ソルジャーOW',
        1017: 'フラワー',                       1018: 'オーシャン',
        1023: 'サン',                           5118: '式波・アスカ・ラングレー',
        5119: '綾波レイ',                       5132: 'アヤナミレイ(仮称)',
        5133: '式波・アスカ・ラングレー：WILLE', 5152: 'エイダ・ウォン',
        5153: 'ジル・バレンタイン',             5164: '錦木千束',
        5165: '井ノ上たきな',                   5179: 'クイーン(新島真)',
        5180: '天城雪子',
    };

    test('形: すべての行に jp と resource_id と pad があり、name_code は数字', () => {
        const rows = Object.entries(map.data);
        for (const [nameCode, entry] of rows) {
            assert.match(nameCode, /^\d+$/, `name_code が数字でない: ${nameCode}`);
            assert.ok(entry.jp && typeof entry.jp === 'string', `jp が無い: ${nameCode}`);
            assert.ok(Number.isInteger(entry.resource_id), `resource_id が無い: ${nameCode}`);
            // いまは 200 件すべてに PAD の宛先が付いている。付かない行が現れたら
            // 「CDN に増えて PAD に無いキャラ」なので、気づけるようにここで落とす
            assert.ok(entry.pad && typeof entry.pad === 'string', `pad が無い: ${nameCode} (${entry.jp})`);
        }
    });

    test('★ 表が痩せていない (CDN の一時不調で欠けたまま上書きされると気づけない)', () => {
        const rows = Object.entries(map.data);
        const withPad = rows.filter(([, e]) => e.pad);
        // counts は生成時の自己申告。実データと食い違っていたら手で編集された疑い
        assert.equal(rows.length, map.counts.name_codes, 'counts.name_codes が実データと合っていない');
        assert.equal(withPad.length, map.counts.matched_pad, 'counts.matched_pad が実データと合っていない');
        // 下限。この数は増えることはあっても減らない (減るときは必ず人が確認する)
        assert.ok(rows.length >= 200, `name_code が減っている (${rows.length} < 200)`);
        assert.ok(withPad.length >= 200, `PAD と対応した数が減っている (${withPad.length} < 200)`);
        assert.ok(map.counts.pad_total >= 203, `PAD のキャラ数が減っている (${map.counts.pad_total})`);
    });

    test('★ 1つのキャラに2つの name_code が付いていない (取り込みが混ざる)', () => {
        const byPad = new Map();
        for (const [nameCode, entry] of Object.entries(map.data)) {
            if (!entry.pad) continue;
            if (!byPad.has(entry.pad)) byPad.set(entry.pad, []);
            byPad.get(entry.pad).push(nameCode);
        }
        const dup = [...byPad].filter(([, codes]) => codes.length > 1)
            .map(([name, codes]) => `${name} ← ${codes.join(' / ')}`);
        assert.deepEqual(dup, [], '同じキャラに複数の name_code が付いている');
    });

    test('★ 同名の別キャラを取り違えない: サクラ (1012) と 鈴原サクラ (3015)', () => {
        // CDN 上ではどちらも日本語名が「サクラ」。素直に名前で突き合わせると
        // エヴァコラボの鈴原サクラがニケ本編のサクラに化ける (2026-09-08 に実際に踏んだ)
        assert.equal(map.data['1012'].jp, 'サクラ');
        assert.equal(map.data['3015'].jp, 'サクラ');
        assert.equal(map.data['1012'].pad, 'サクラ');
        assert.equal(map.data['3015'].pad, '鈴原サクラ');
        assert.equal(map.data['3015'].overridden, true, '手当て無しで一致したのなら CDN 側が変わっている');
    });

    test('★ 手当て 17 件の宛先が1つも変わっていない', () => {
        for (const [nameCode, expected] of Object.entries(EXPECTED_OVERRIDES)) {
            const entry = map.data[nameCode];
            assert.ok(entry, `手当てした name_code が表から消えている: ${nameCode} (${expected})`);
            assert.equal(entry.pad, expected, `${nameCode} の宛先が変わっている`);
            assert.equal(entry.overridden, true, `${nameCode} が手当て扱いになっていない`);
        }
        // 手当てが増減したら気づく (勝手に足された/消された手当ての検出)
        const forced = Object.entries(map.data).filter(([, e]) => e.overridden).map(([nc]) => nc).sort();
        assert.deepEqual(forced, Object.keys(EXPECTED_OVERRIDES).sort(), '手当ての一覧が変わっている');
    });

    test('★ 生成スクリプトの OVERRIDES と JSON がずれていない (生成し直し忘れの検出)', () => {
        // ここまでのテストは生成物 (JSON) しか見ないので、**スクリプトだけ直して生成し直さない**と
        // 気づけない。スクリプト側の表も読んで突き合わせ、三者 (スクリプト/JSON/期待値) を揃える
        const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-blabla-name-codes.mjs'), 'utf8');
        const block = src.match(/const OVERRIDES = \{([\s\S]*?)\n\};/);
        assert.ok(block, '生成スクリプトから OVERRIDES を読み取れない (書き方が変わった?)');
        const inScript = {};
        for (const line of block[1].split('\n')) {
            const hit = line.replace(/\/\/.*$/, '').match(/(\d+):\s*'([^']*)'/);
            if (hit) inScript[hit[1]] = hit[2];
        }
        assert.deepEqual(inScript, EXPECTED_OVERRIDES,
            '生成スクリプトの OVERRIDES が期待値と違う (スクリプトを直したら --apply で生成し直すこと)');
    });
}

// ---- 結果 --------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
