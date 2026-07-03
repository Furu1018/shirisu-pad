// ============================================================================
// 最適凸プラン ソルバー (純関数)
// ----------------------------------------------------------------------------
// index.html の computeOptimalPlan から切り出した中核ロジック。
// DOM・Supabase・グローバル状態に依存しないため node で単体テストできる:
//   node tests/run-tests.mjs
//
// 入力: {
//   season:  { current_level },
//   bosses:  [{ boss_number, boss_code, name, attribute, weakness, tier,
//               total_hp_raw, remaining_hp_raw }],
//   players: [{ id, name, attackCount, syncLevel, syncLevelEstimated,
//               damagesByAttr, teamsByAttr, attacks, availableSlots }],
//   currentSlot: 'h21' など (onlyAvailableNow 時のフィルタに使用),
//   onlyAvailableNow: boolean,
//   timeAware: boolean,       // true なら凸可能時間を使って時間帯スケジュールを組む
// }
//
// === 時間考慮モード (timeAware) の考え方 ===
// レイド日は AM5時〜翌AM5時。レベル L+1 は レベル L の5体全滅後にしか殴れない。
// そのため各凸を「メンバーの凸可能時間のうち、そのレベルが開く時刻以降で最も早い
// 時間帯」に割り当て、レベルのクリア想定時刻を次レベルの開始時刻として伝播する。
// - 凸可能時間 未登録のメンバーは「いつでも可 (時間不明)」として扱い timeUnknown を立てる
// - レベルのクリア時刻を決めている凸 (最も遅い凸) に isBottleneck を立てる
// - 火力はあるのに時間内に凸できる人がいない場合は timeConstrained を立てる
// 分単位の正確なスケジュールではなく「実現可能性と律速の可視化」が目的。
// ============================================================================
(function (root) {
    'use strict';

    // レベル別ボスHP (B単位) ※ supabase-client.js の _HARD_LEVEL_HP と一致させること
    const HARD_LEVEL_HP_B = {
        1: { tyrant: 99.8562792, lord: 150.8418136 },
        2: { tyrant: 149.7844188, lord: 226.2627204 },
        3: { tyrant: 292.44529575, lord: 349.2309015 },
    };

    // レイド日の時間帯 (AM5時起点)。index.html の HOUR_ORDER と一致させること。
    const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
    const hourKey = (h) => `h${String(h).padStart(2, '0')}`;
    const IDX_BY_KEY = new Map(HOUR_ORDER.map((h, i) => [hourKey(h), i]));
    const hourLabelOf = (idx) => {
        const h = HOUR_ORDER[idx];
        return (h >= 0 && h <= 4) ? `翌${h}時` : `${h}時`;
    };

    function computeOptimalPlanCore(input) {
        const { season, bosses, players, currentSlot } = input || {};
        if (!season || !Array.isArray(bosses) || bosses.length === 0) return null;
        const onlyAvailableNow = !!input.onlyAvailableNow;
        const timeAware = !!input.timeAware;
        const startLevel = season.current_level || 1;

        // 時間軸: 現在時刻 (currentSlot) からリセット (HOUR_ORDER 末尾) まで
        const nowIdx = timeAware ? (IDX_BY_KEY.get(currentSlot) ?? 0) : 0;
        const LAST_IDX = HOUR_ORDER.length - 1;

        // ボス番号 → 弱点(PT属性) のマップ。各メンバーの使用済み属性は attacks から逆引きする。
        const bossWeaknessByNum = new Map();
        bosses.forEach(b => { if (b.weakness) bossWeaknessByNum.set(b.boss_number, b.weakness); });
        const usedAttrsFor = (p) => {
            const set = new Set();
            (p.attacks || []).forEach(a => {
                const w = bossWeaknessByNum.get(a.boss_number);
                if (w) set.add(w);
            });
            return set;
        };

        // メンバー状態: 残凸数 + 属性別の使い切りダメージ(>0) + SLv + 凸可能時間
        // 「現在凸可能のみ」モードでは availability に現スロットを含む人だけを対象にする。
        // 既に[attr]PT で凸済みの属性は avail から除外 (二重割当防止)
        const memberState = (players || [])
            .filter(p => p.attackCount < 3)
            .filter(p => !onlyAvailableNow || (p.availableSlots || []).includes(currentSlot))
            .map(p => {
                const used = usedAttrsFor(p);
                const avail = {};
                for (const [k, v] of Object.entries(p.damagesByAttr || {})) {
                    if (Number(v) > 0 && !used.has(k)) avail[k] = Number(v);
                }
                // 凸可能時間 → 現在以降の時間帯インデックス集合 (昇順)。未登録は「いつでも可」
                const rawSlots = (p.availableSlots || [])
                    .map(k => IDX_BY_KEY.get(k))
                    .filter(i => i != null && i >= nowIdx)
                    .sort((a, b) => a - b);
                const timeUnknown = (p.availableSlots || []).length === 0;
                return {
                    id: p.id,
                    name: p.name,
                    slv: p.syncLevel || 0,
                    slvEstimated: !!p.syncLevelEstimated,
                    remainingAttacks: 3 - p.attackCount,
                    avail,
                    teamsByAttr: p.teamsByAttr || {},   // 衝突チェック用編成
                    usedChars: new Set(),               // すでに割当済みのキャラ
                    anyTeamRegistered: Object.values(p.teamsByAttr || {}).some(arr => Array.isArray(arr) && arr.length > 0),
                    hourIdxs: timeUnknown ? null : rawSlots,   // null = いつでも可
                    timeUnknown,
                };
            });

        // openIdx 以降でそのメンバーが凸できる最も早い時間帯 (null = 時間的に不可)
        const earliestHourFor = (m, openIdx) => {
            if (!timeAware) return openIdx;
            if (m.hourIdxs === null) return openIdx;   // 時間不明 → 開いた瞬間に可能とみなす
            for (const i of m.hourIdxs) if (i >= openIdx) return i;
            return null;
        };

        // SLv順位 (0=最低, 1=最高)。参加可能メンバー内で相対化。
        const participants = memberState.filter(m => m.remainingAttacks > 0 && Object.keys(m.avail).length > 0);
        const sortedBySlv = [...participants].sort((a, b) => a.slv - b.slv);
        const np = sortedBySlv.length;
        sortedBySlv.forEach((m, i) => { m.slvRank = np > 1 ? i / (np - 1) : 0.5; });

        // 候補スコア(小さいほど良い): オーバーキル + SLvミスマッチ + 遅い時間ペナルティ。
        // SLv完全ミスマッチ(1.0) ≈ 5B のオーバーキル、1時間の遅れ ≈ 0.2B のオーバーキル相当。
        const W_OVER = 1.0, W_SLV = 5.0, W_TIME = 0.2;
        const scoreOf = (m, attr, rem, levelPos, hourIdx, openIdx) => {
            const dmg = m.avail[attr];
            const overkill = Math.max(0, dmg - rem);
            const slvPenalty = Math.abs((m.slvRank ?? 0.5) - levelPos);
            const timePenalty = timeAware ? (hourIdx - openIdx) : 0;
            return overkill * W_OVER + slvPenalty * W_SLV + timePenalty * W_TIME - Math.min(dmg, rem) * 0.001;
        };

        const levels = [];
        let fullyClearedThrough = startLevel - 1;  // 何レベルまで完全攻略できる想定か
        let openIdx = nowIdx;                       // このレベルの凸を開始できる時間帯
        for (let L = startLevel; L <= 3; L++) {
            const levelPos = (L - 1) / 2;  // Lv1=0, Lv2=0.5, Lv3=1
            const levelBosses = [];
            let levelCleared = true;
            let levelClearIdx = openIdx;   // このレベルの想定クリア時間帯 (最も遅い凸)
            for (const b of bosses) {
                const tierHp = HARD_LEVEL_HP_B[L]?.[b.tier] ?? ((b.total_hp_raw || 0) / 1e9);
                const targetHpB = (L === startLevel) ? ((b.remaining_hp_raw || 0) / 1e9) : tierHp;
                const attacks = [];
                let rem = targetHpB;
                let sawTimeExcluded = false;   // 火力はあるが時間で弾かれた候補がいたか
                while (rem > 0.0001) {
                    let pick = null, pickScore = Infinity, pickHour = openIdx;
                    for (const m of memberState) {
                        if (m.remainingAttacks <= 0 || !(m.avail[b.weakness] > 0)) continue;
                        // キャラ衝突チェック: 同じ人がすでに割当済みのキャラと被るプランは除外
                        // (編成データが全く無い人はチェック対象外。データ揃ってる人だけ厳密判定)
                        const team = m.teamsByAttr[b.weakness];
                        if (m.anyTeamRegistered && Array.isArray(team) && team.length > 0) {
                            const conflict = team.some(c => c && m.usedChars.has(c));
                            if (conflict) continue;
                        }
                        const hourIdx = earliestHourFor(m, openIdx);
                        if (hourIdx === null) { sawTimeExcluded = true; continue; }
                        const s = scoreOf(m, b.weakness, rem, levelPos, hourIdx, openIdx);
                        if (s < pickScore) { pickScore = s; pick = m; pickHour = hourIdx; }
                    }
                    if (!pick) break;
                    const dmg = pick.avail[b.weakness];
                    const team = pick.teamsByAttr[b.weakness] || [];
                    const teamRegistered = Array.isArray(team) && team.length > 0;
                    attacks.push({
                        memberId: pick.id, memberName: pick.name,
                        slv: pick.slv, slvEstimated: pick.slvEstimated,
                        dmgB: dmg, usedB: Math.min(dmg, rem), overflowB: Math.max(0, dmg - rem),
                        team: teamRegistered ? team : null,  // 未登録は null マークで警告表示
                        hourIdx: timeAware ? pickHour : null,
                        hourLabel: timeAware ? hourLabelOf(pickHour) : null,
                        timeUnknown: timeAware ? pick.timeUnknown : false,
                        isBottleneck: false,                 // レベル確定後に付与
                    });
                    // 採用したキャラを使用済セットへ
                    if (teamRegistered) team.forEach(c => { if (c) pick.usedChars.add(c); });
                    delete pick.avail[b.weakness];
                    pick.remainingAttacks--;
                    rem -= dmg;
                }
                const cleared = rem <= 0.0001;
                if (!cleared && targetHpB > 0) levelCleared = false;
                const bossClearIdx = (timeAware && cleared && attacks.length)
                    ? Math.max(...attacks.map(a => a.hourIdx)) : null;
                if (cleared && bossClearIdx !== null) levelClearIdx = Math.max(levelClearIdx, bossClearIdx);
                levelBosses.push({
                    bossNumber: b.boss_number, name: b.name || b.boss_code,
                    weakness: b.weakness, attribute: b.attribute, tier: b.tier,
                    targetHpB, remainingHpB: Math.max(0, rem), cleared, attacks,
                    clearHourIdx: bossClearIdx,
                    clearHourLabel: bossClearIdx !== null ? hourLabelOf(bossClearIdx) : null,
                    // 火力不足ではなく時間不足で削り切れなかったボスの区別
                    timeConstrained: timeAware && !cleared && targetHpB > 0 && sawTimeExcluded,
                });
            }
            // 律速マーク: レベルのクリア時刻を決めている凸 (最も遅い時間帯の凸)
            if (timeAware && levelCleared) {
                levelBosses.forEach(b => {
                    b.attacks.forEach(a => {
                        if (a.hourIdx === levelClearIdx && levelClearIdx > openIdx) a.isBottleneck = true;
                    });
                });
            }
            levels.push({
                level: L, levelCleared, bosses: levelBosses,
                openHourIdx: timeAware ? openIdx : null,
                openHourLabel: timeAware ? hourLabelOf(openIdx) : null,
                clearHourIdx: (timeAware && levelCleared) ? levelClearIdx : null,
                clearHourLabel: (timeAware && levelCleared) ? hourLabelOf(levelClearIdx) : null,
            });
            if (levelCleared) fullyClearedThrough = L;
            else break;  // このレベルを越えられないので以降は計画しない
            openIdx = levelClearIdx;   // 次レベルはこのレベルのクリア想定時刻から
        }

        const allAttacks = levels.flatMap(lv => lv.bosses.flatMap(b => b.attacks));
        const totalAttacks = allAttacks.length;
        const totalWaste = allAttacks.reduce((s, a) => s + a.overflowB, 0);
        const unusedAttacks = memberState.reduce((s, m) => s + m.remainingAttacks, 0);
        const membersNoData = (players || [])
            .filter(p => p.attackCount < 3)
            .filter(p => Object.values(p.damagesByAttr || {}).every(v => !v || v === 0))
            .map(p => p.name);
        const membersTimeUnknown = timeAware
            ? memberState.filter(m => m.timeUnknown && Object.keys(m.avail).length + (3 - m.remainingAttacks) > 0).map(m => m.name)
            : [];
        const anyTimeConstrained = levels.some(lv => lv.bosses.some(b => b.timeConstrained));

        const candidateCount = memberState.length;
        const lastLv = levels[levels.length - 1];
        return {
            startLevel, fullyClearedThrough, levels, totalAttacks, totalWaste,
            unusedAttacks, membersNoData, onlyAvailableNow, currentSlot, candidateCount,
            timeAware,
            nowHourLabel: timeAware ? hourLabelOf(nowIdx) : null,
            finalClearHourLabel: (timeAware && lastLv?.levelCleared) ? lastLv.clearHourLabel : null,
            membersTimeUnknown,
            anyTimeConstrained,
            hoursUntilReset: timeAware ? (LAST_IDX - nowIdx + 1) : null,
        };
    }

    root.computeOptimalPlanCore = computeOptimalPlanCore;
})(typeof window !== 'undefined' ? window : globalThis);
