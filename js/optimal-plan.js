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
// }
// ============================================================================
(function (root) {
    'use strict';

    // レベル別ボスHP (B単位) ※ supabase-client.js の _HARD_LEVEL_HP と一致させること
    const HARD_LEVEL_HP_B = {
        1: { tyrant: 99.8562792, lord: 150.8418136 },
        2: { tyrant: 149.7844188, lord: 226.2627204 },
        3: { tyrant: 292.44529575, lord: 349.2309015 },
    };

    function computeOptimalPlanCore(input) {
        const { season, bosses, players, currentSlot } = input || {};
        if (!season || !Array.isArray(bosses) || bosses.length === 0) return null;
        const onlyAvailableNow = !!input.onlyAvailableNow;
        const startLevel = season.current_level || 1;

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

        // メンバー状態: 残凸数 + 属性別の使い切りダメージ(>0) + SLv
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
                };
            });

        // SLv順位 (0=最低, 1=最高)。参加可能メンバー内で相対化。
        const participants = memberState.filter(m => m.remainingAttacks > 0 && Object.keys(m.avail).length > 0);
        const sortedBySlv = [...participants].sort((a, b) => a.slv - b.slv);
        const np = sortedBySlv.length;
        sortedBySlv.forEach((m, i) => { m.slvRank = np > 1 ? i / (np - 1) : 0.5; });

        // 候補スコア(小さいほど良い): オーバーキル + SLvミスマッチ。
        // SLv完全ミスマッチ(1.0) ≈ 5B のオーバーキルに相当する重み付け。
        const W_OVER = 1.0, W_SLV = 5.0;
        const scoreOf = (m, attr, rem, levelPos) => {
            const dmg = m.avail[attr];
            const overkill = Math.max(0, dmg - rem);
            const slvPenalty = Math.abs((m.slvRank ?? 0.5) - levelPos);
            return overkill * W_OVER + slvPenalty * W_SLV - Math.min(dmg, rem) * 0.001;
        };

        const levels = [];
        let fullyClearedThrough = startLevel - 1;  // 何レベルまで完全攻略できる想定か
        for (let L = startLevel; L <= 3; L++) {
            const levelPos = (L - 1) / 2;  // Lv1=0, Lv2=0.5, Lv3=1
            const levelBosses = [];
            let levelCleared = true;
            for (const b of bosses) {
                const tierHp = HARD_LEVEL_HP_B[L]?.[b.tier] ?? ((b.total_hp_raw || 0) / 1e9);
                const targetHpB = (L === startLevel) ? ((b.remaining_hp_raw || 0) / 1e9) : tierHp;
                const attacks = [];
                let rem = targetHpB;
                while (rem > 0.0001) {
                    let pick = null, pickScore = Infinity;
                    for (const m of memberState) {
                        if (m.remainingAttacks <= 0 || !(m.avail[b.weakness] > 0)) continue;
                        // キャラ衝突チェック: 同じ人がすでに割当済みのキャラと被るプランは除外
                        // (編成データが全く無い人はチェック対象外。データ揃ってる人だけ厳密判定)
                        const team = m.teamsByAttr[b.weakness];
                        if (m.anyTeamRegistered && Array.isArray(team) && team.length > 0) {
                            const conflict = team.some(c => c && m.usedChars.has(c));
                            if (conflict) continue;
                        }
                        const s = scoreOf(m, b.weakness, rem, levelPos);
                        if (s < pickScore) { pickScore = s; pick = m; }
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
                    });
                    // 採用したキャラを使用済セットへ
                    if (teamRegistered) team.forEach(c => { if (c) pick.usedChars.add(c); });
                    delete pick.avail[b.weakness];
                    pick.remainingAttacks--;
                    rem -= dmg;
                }
                const cleared = rem <= 0.0001;
                if (!cleared && targetHpB > 0) levelCleared = false;
                levelBosses.push({
                    bossNumber: b.boss_number, name: b.name || b.boss_code,
                    weakness: b.weakness, attribute: b.attribute, tier: b.tier,
                    targetHpB, remainingHpB: Math.max(0, rem), cleared, attacks,
                });
            }
            levels.push({ level: L, levelCleared, bosses: levelBosses });
            if (levelCleared) fullyClearedThrough = L;
            else break;  // このレベルを越えられないので以降は計画しない
        }

        const allAttacks = levels.flatMap(lv => lv.bosses.flatMap(b => b.attacks));
        const totalAttacks = allAttacks.length;
        const totalWaste = allAttacks.reduce((s, a) => s + a.overflowB, 0);
        const unusedAttacks = memberState.reduce((s, m) => s + m.remainingAttacks, 0);
        const membersNoData = (players || [])
            .filter(p => p.attackCount < 3)
            .filter(p => Object.values(p.damagesByAttr || {}).every(v => !v || v === 0))
            .map(p => p.name);

        const candidateCount = memberState.length;
        return { startLevel, fullyClearedThrough, levels, totalAttacks, totalWaste, unusedAttacks, membersNoData, onlyAvailableNow, currentSlot, candidateCount };
    }

    root.computeOptimalPlanCore = computeOptimalPlanCore;
})(typeof window !== 'undefined' ? window : globalThis);
