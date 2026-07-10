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
//               damagesByAttr, teamsByAttr, attacks, availableSlots,
//               strong_attributes }],   // 得意属性: 1-3個=必ず消化 / 4個=その中からのみ / 0・5個=制約なし
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
    // lord (B1/B2/B4) が低HP、tyrant (B3/B5) が高HP。
    // ※ 過去に lord/tyrant の値が逆に定義されていた事故があるため、変更時は本番の実測と照合すること
    const HARD_LEVEL_HP_B = {
        1: { lord: 99.8562792, tyrant: 150.8418136 },
        2: { lord: 149.7844188, tyrant: 226.2627204 },
        3: { lord: 292.44529575, tyrant: 349.2309015 },
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

        // ボス番号 → 弱点(PT属性) のマップ。各メンバーの属性別凸回数は attacks から逆引きする。
        const bossWeaknessByNum = new Map();
        bosses.forEach(b => { if (b.weakness) bossWeaknessByNum.set(b.boss_number, b.weakness); });
        const usedCountFor = (p) => {
            const map = new Map();
            (p.attacks || []).forEach(a => {
                const w = bossWeaknessByNum.get(a.boss_number);
                if (w) map.set(w, (map.get(w) || 0) + 1);
            });
            return map;
        };

        // メンバー状態: 残凸数 + 属性別の使い切りダメージ(>0) + SLv + 凸可能時間
        // 「現在凸可能のみ」モードでは availability に現スロットを含む人だけを対象にする。
        // 既に[attr]PT で凸済みの属性は avail から除外 (二重割当防止)
        const memberState = (players || [])
            .filter(p => p.attackCount < 3)
            .filter(p => !onlyAvailableNow || (p.availableSlots || []).includes(currentSlot))
            .map(p => {
                const usedCount = usedCountFor(p);
                // avail: 属性 -> 使用可能な編成 (ロードアウト) リスト、ダメージ降順。
                // 1属性2編成 (player_damages.slot) に対応し、別編成なら同属性2凸を提案できる。
                // 既にその属性へ凸した回数ぶん、上位ロードアウトから消費済みとして除外。
                const avail = {};
                const loadouts = (p.loadoutsByAttr && Object.keys(p.loadoutsByAttr).length > 0) ? p.loadoutsByAttr : null;
                if (loadouts) {
                    for (const [k, list] of Object.entries(loadouts)) {
                        const clean = (list || [])
                            .filter(lo => Number(lo.dmgB) > 0)
                            .map(lo => ({ dmg: Number(lo.dmgB), team: Array.isArray(lo.team) ? lo.team : [], slot: lo.slot || 1 }))
                            .sort((a, b) => b.dmg - a.dmg)
                            .slice(usedCount.get(k) || 0);
                        if (clean.length > 0) avail[k] = clean;
                    }
                } else {
                    // 旧入力形式 (damagesByAttr のみ) のフォールバック: 1属性1編成
                    for (const [k, v] of Object.entries(p.damagesByAttr || {})) {
                        if (Number(v) > 0 && !(usedCount.get(k) > 0)) {
                            avail[k] = [{ dmg: Number(v), team: (p.teamsByAttr || {})[k] || [], slot: 1 }];
                        }
                    }
                }
                // 得意属性 (strong_attributes) の選出制約:
                //   1〜3個選択 → その属性は必ず消化 (残りの凸枠だけ自由選出)
                //   4個選択   → その4属性の中からのみ選出
                //   0個 / 5個 → 制約なし (従来どおり)
                // ※ ダメージ未提出・凸済みの得意属性は強制対象から外す (avail に無いものは選べない)
                const strong = Array.isArray(p.strong_attributes)
                    ? p.strong_attributes.filter(k => typeof k === 'string' && k.length > 0)
                    : [];
                if (strong.length === 4) {
                    for (const k of Object.keys(avail)) {
                        if (!strong.includes(k)) delete avail[k];
                    }
                }
                // 「必ず消化」は最低1回の意味 — 既に凸済みの得意属性は満足済みとして除外する
                // (2編成対応後は凸済みでも編成②が avail に残るため、avail 存在だけで判定すると
                //  同属性2凸目を強制して自由枠を不当に奪ってしまう)
                const mandatory = (strong.length >= 1 && strong.length <= 3)
                    ? new Set(strong.filter(k => (avail[k] || []).length > 0 && !(usedCount.get(k) > 0)))
                    : new Set();
                // 凸可能時間 → 現在以降の時間帯インデックス集合 (昇順)。未登録は「いつでも可」
                const allSlots = (p.availableSlots || [])
                    .map(k => IDX_BY_KEY.get(k))
                    .filter(i => i != null)
                    .sort((a, b) => a - b);
                const rawSlots = allSlots.filter(i => i >= nowIdx);
                // ⏳ 隙間時間型: 時間は約束できないが3凸はする人。時間未登録(データ不足)とは区別する。
                // 時間も登録している隙間型 = ハイブリッド:
                //   登録時間内は「確約」として通常割当、時間外は ⏳隙間 (ベストエフォート) 扱い。
                const flexTime = !!p.flexTime;
                const timeUnknown = !flexTime && (p.availableSlots || []).length === 0;
                return {
                    id: p.id,
                    name: p.name,
                    slv: p.syncLevel || 0,
                    slvEstimated: !!p.syncLevelEstimated,
                    remainingAttacks: 3 - p.attackCount,
                    avail,
                    usedChars: new Set(),               // すでに割当済みのキャラ
                    anyTeamRegistered: Object.values(avail).some(list => list.some(lo => lo.team.length > 0))
                        || Object.values(p.teamsByAttr || {}).some(arr => Array.isArray(arr) && arr.length > 0),
                    hourIdxs: (timeUnknown || (flexTime && rawSlots.length === 0)) ? null : rawSlots,   // null = いつでも可
                    allHourIdxs: allSlots,   // 未フィルタの宣言時間 (ミスマッチ時の「最寄り時刻」表示用)
                    timeUnknown,
                    flexTime,
                    mandatory,      // 未消化の必須得意属性
                    lockedNow: 0,   // このレベルで実際に予約する枠数 (レベルごとに再計算)
                };
            });

        // openIdx 以降でそのメンバーが凸できる最も早い時間帯を返す。
        // 戻り値: { idx, flex } / null = 時間的に不可。
        //   flex=true は「時刻を約束しない ⏳隙間 割当」(純粋な隙間型、またはハイブリッドの登録時間外)
        const earliestHourFor = (m, openIdx) => {
            if (!timeAware) return { idx: openIdx, flex: false };
            if (m.hourIdxs === null) return { idx: openIdx, flex: m.flexTime };   // 時間不明/純隙間型
            for (const i of m.hourIdxs) if (i >= openIdx) return { idx: i, flex: false };   // 登録時間内 = 確約
            if (m.flexTime) return { idx: openIdx, flex: true };   // ハイブリッド: 時間外は隙間でやる
            // 戦闘可能時間がレベル開放と合わない人も除外はせず、
            // 「希望時間に一番近い形 (ベストエフォート)」として必ず計画に組み込む。
            // 時刻は確約できないので ⏳扱い + mismatch マーク。ペナルティで正規の時間の人を優先。
            // 最寄り = 開放時刻に一番近い宣言時間 (残っていれば直前の枠、全て過去なら宣言の最終枠)
            const pool = m.hourIdxs.length > 0 ? m.hourIdxs : (m.allHourIdxs || []);
            const nearest = pool.length > 0 ? pool[pool.length - 1] : openIdx;
            return { idx: openIdx, flex: true, mismatch: true, nearestIdx: nearest };
        };

        // SLv順位 (0=最低, 1=最高)。参加可能メンバー内で相対化。
        const participants = memberState.filter(m => m.remainingAttacks > 0 && Object.keys(m.avail).length > 0);
        const sortedBySlv = [...participants].sort((a, b) => a.slv - b.slv);
        const np = sortedBySlv.length;
        sortedBySlv.forEach((m, i) => { m.slvRank = np > 1 ? i / (np - 1) : 0.5; });

        // 候補スコア(小さいほど良い): オーバーキル + SLvミスマッチ + 遅い時間ペナルティ。
        // SLv完全ミスマッチ(1.0) ≈ 5B のオーバーキル、1時間の遅れ ≈ 0.2B のオーバーキル相当。
        // ⏳隙間割当は時刻を確約しない分の不確実性ペナルティ (2時間の遅れ相当) を課し、
        // 「時刻を確約できる人」が僅差なら優先されるようにする。
        const W_OVER = 1.0, W_SLV = 5.0, W_TIME = 0.2, FLEX_PENALTY = 2 * W_TIME, MISMATCH_PENALTY = 6 * W_TIME, W_STRONG = 2.5;
        const scoreOf = (m, attr, dmg, rem, levelPos, hourIdx, openIdx, isFlex, isMismatch) => {
            const overkill = Math.max(0, dmg - rem);
            const slvPenalty = Math.abs((m.slvRank ?? 0.5) - levelPos);
            const timePenalty = timeAware ? (hourIdx - openIdx) : 0;
            const flexPenalty = (timeAware && isFlex) ? FLEX_PENALTY : 0
                + ((timeAware && isMismatch) ? MISMATCH_PENALTY : 0);
            // 必須得意属性は早めに消化 (ボス撃破後に強制枠が余って無駄になるのを防ぐ)
            const strongBonus = m.mandatory.has(attr) ? W_STRONG : 0;
            return overkill * W_OVER + slvPenalty * W_SLV + timePenalty * W_TIME + flexPenalty - strongBonus - Math.min(dmg, rem) * 0.001;
        };

        const levels = [];
        let fullyClearedThrough = startLevel - 1;  // 何レベルまで完全攻略できる想定か
        let openIdx = nowIdx;                       // このレベルの凸を開始できる時間帯
        for (let L = startLevel; L <= 3; L++) {
            const levelPos = (L - 1) / 2;  // Lv1=0, Lv2=0.5, Lv3=1
            const levelBosses = [];
            let levelCleared = true;
            let levelClearIdx = openIdx;   // このレベルの想定クリア時間帯 (最も遅い凸)
            // 必須得意属性の枠予約は「このレベルで生きているボスの弱点」に限る。
            // 撃破済みボスの属性まで予約すると、得意属性が全滅済みのメンバーが
            // 自由枠0で他ボスにも出せず、模擬提出があるのに一切使われなくなる。
            const aliveWeakThisLevel = new Set();
            for (const b of bosses) {
                const t = (L === startLevel) ? ((b.remaining_hp_raw || 0) / 1e9)
                    : (HARD_LEVEL_HP_B[L]?.[b.tier] ?? ((b.total_hp_raw || 0) / 1e9));
                if (t > 0.0001 && b.weakness) aliveWeakThisLevel.add(b.weakness);
            }
            memberState.forEach(m => {
                m.lockedNow = [...m.mandatory].filter(k => aliveWeakThisLevel.has(k)).length;
            });
            for (const b of bosses) {
                const tierHp = HARD_LEVEL_HP_B[L]?.[b.tier] ?? ((b.total_hp_raw || 0) / 1e9);
                const targetHpB = (L === startLevel) ? ((b.remaining_hp_raw || 0) / 1e9) : tierHp;
                const attacks = [];
                let rem = targetHpB;
                let sawTimeExcluded = false;   // 火力はあるが時間で弾かれた候補がいたか
                while (rem > 0.0001) {
                    let pick = null, pickScore = Infinity, pickHour = openIdx, pickFlex = false, pickLo = null, pickSlot = null;
                    for (const m of memberState) {
                        const list = m.avail[b.weakness];
                        if (m.remainingAttacks <= 0 || !list || list.length === 0) continue;
                        // 得意属性の必須消化: 予約枠 (このレベルで消化可能な必須) を除いた
                        // 自由枠が尽きたら、必須属性以外には出さない
                        if (m.mandatory.size > 0 && !m.mandatory.has(b.weakness)
                            && (m.remainingAttacks - m.lockedNow) <= 0) continue;
                        // キャラ衝突チェック: 割当済みキャラと被らない最初 (=最大ダメージ) のロードアウトを選ぶ
                        // (編成データが全く無い人はチェック対象外。データ揃ってる人だけ厳密判定)
                        let lo = null;
                        for (const cand of list) {
                            if (m.anyTeamRegistered && cand.team.length > 0 && cand.team.some(c => c && m.usedChars.has(c))) continue;
                            lo = cand;
                            break;
                        }
                        if (!lo) continue;
                        const slot = earliestHourFor(m, openIdx);
                        if (slot === null) { sawTimeExcluded = true; continue; }
                        const s = scoreOf(m, b.weakness, lo.dmg, rem, levelPos, slot.idx, openIdx, slot.flex, slot.mismatch);
                        if (s < pickScore) { pickScore = s; pick = m; pickHour = slot.idx; pickFlex = slot.flex; pickLo = lo; pickSlot = slot; }
                    }
                    if (!pick) break;
                    const dmg = pickLo.dmg;
                    const team = pickLo.team;
                    const teamRegistered = team.length > 0;
                    attacks.push({
                        memberId: pick.id, memberName: pick.name,
                        slv: pick.slv, slvEstimated: pick.slvEstimated,
                        dmgB: dmg, usedB: Math.min(dmg, rem), overflowB: Math.max(0, dmg - rem),
                        team: teamRegistered ? team : null,  // 未登録は null マークで警告表示
                        hourIdx: timeAware ? pickHour : null,
                        // ⏳隙間割当 (純隙間型 or ハイブリッドの登録時間外) は時刻を約束しない:
                        // hourLabel は付けず flex マークで表示。登録時間内なら通常の時刻付き割当
                        hourLabel: (timeAware && !pickFlex) ? hourLabelOf(pickHour) : null,
                        flex: timeAware ? pickFlex : false,
                        timeUnknown: timeAware ? pick.timeUnknown : false,
                        // 戦闘可能時間がレベル開放と合わないベストエフォート割当
                        timeMismatch: !!(timeAware && pickSlot?.mismatch),
                        nearestHourLabel: (timeAware && pickSlot?.mismatch && pickSlot.nearestIdx != null) ? hourLabelOf(pickSlot.nearestIdx) : null,
                        loadoutSlot: pickLo.slot,            // 2編成目なら 2 (表示用)
                        isBottleneck: false,                 // レベル確定後に付与
                    });
                    // 採用したキャラを使用済セットへ
                    if (teamRegistered) team.forEach(c => { if (c) pick.usedChars.add(c); });
                    // 使用したロードアウトを除去 (同属性の別編成が残っていれば2凸目も提案可)
                    const loIdx = pick.avail[b.weakness].indexOf(pickLo);
                    if (loIdx >= 0) pick.avail[b.weakness].splice(loIdx, 1);
                    if (pick.avail[b.weakness].length === 0) delete pick.avail[b.weakness];
                    pick.remainingAttacks--;
                    // 得意属性の消化管理: 必須を消化したら予約も1つ解放
                    // (自由枠の消費は remainingAttacks の減少で自然に反映される)
                    if (pick.mandatory.has(b.weakness)) {
                        pick.mandatory.delete(b.weakness);
                        pick.lockedNow = Math.max(0, pick.lockedNow - 1);
                    }
                    rem -= dmg;
                }
                const cleared = rem <= 0.0001;
                if (!cleared && targetHpB > 0) levelCleared = false;
                // クリア想定時刻は「時刻が読める凸」だけから算出。⏳隙間凸しか無いボスは
                // 開放時刻扱いにしつつ hasFlex で不確実さを表示側へ伝える
                const timedIdxs = attacks.filter(a => !a.flex).map(a => a.hourIdx);
                const bossClearIdx = (timeAware && cleared && attacks.length)
                    ? (timedIdxs.length ? Math.max(...timedIdxs) : openIdx) : null;
                const hasFlex = attacks.some(a => a.flex);
                if (cleared && bossClearIdx !== null) levelClearIdx = Math.max(levelClearIdx, bossClearIdx);
                levelBosses.push({
                    bossNumber: b.boss_number, name: b.name || b.boss_code,
                    weakness: b.weakness, attribute: b.attribute, tier: b.tier,
                    targetHpB, remainingHpB: Math.max(0, rem), cleared, attacks,
                    clearHourIdx: bossClearIdx,
                    clearHourLabel: bossClearIdx !== null ? hourLabelOf(bossClearIdx) : null,
                    hasFlex,
                    // 火力不足ではなく時間不足で削り切れなかったボスの区別
                    timeConstrained: timeAware && !cleared && targetHpB > 0 && sawTimeExcluded,
                });
            }
            // 律速マーク: レベルのクリア時刻を決めている凸 (最も遅い時間帯の凸)。
            // ⏳隙間凸は時刻を約束していないので律速にしない
            if (timeAware && levelCleared) {
                levelBosses.forEach(b => {
                    b.attacks.forEach(a => {
                        if (!a.flex && a.hourIdx === levelClearIdx && levelClearIdx > openIdx) a.isBottleneck = true;
                    });
                });
            }
            levels.push({
                level: L, levelCleared, bosses: levelBosses,
                openHourIdx: timeAware ? openIdx : null,
                openHourLabel: timeAware ? hourLabelOf(openIdx) : null,
                clearHourIdx: (timeAware && levelCleared) ? levelClearIdx : null,
                clearHourLabel: (timeAware && levelCleared) ? hourLabelOf(levelClearIdx) : null,
                hasFlex: levelBosses.some(b => b.hasFlex),   // ⏳隙間凸を含む (クリア時刻は目安)
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
        // ⏳隙間時間型は意図的な選択なので「時間未登録」の注意対象から外す
        const membersTimeUnknown = timeAware
            ? memberState.filter(m => m.timeUnknown && !m.flexTime && Object.keys(m.avail).length + (3 - m.remainingAttacks) > 0).map(m => m.name)
            : [];
        const membersFlex = timeAware ? memberState.filter(m => m.flexTime).map(m => m.name) : [];
        const anyTimeConstrained = levels.some(lv => lv.bosses.some(b => b.timeConstrained));

        // ===== 未使用凸の理由診断 =====
        // 「63凸あるのに50凸しか使われない」の内訳を可視化する。
        // 判定は最後に計画したレベルの状態に対して行う (優先度順に1つ)。
        const lastPlanned = levels[levels.length - 1];
        const lastAliveWeak = new Set(
            (lastPlanned?.bosses || []).filter(b => b.targetHpB > 0.0001).map(b => b.weakness)
        );
        const planFullyCleared = fullyClearedThrough >= 3;
        const unusedDetail = memberState
            .filter(m => m.remainingAttacks > 0)
            .map(m => {
                const attrs = Object.keys(m.avail);
                let reason;
                if (attrs.length === 0) {
                    reason = '出せる属性の残りなし (提出属性を使い切り)';
                } else if (planFullyCleared) {
                    reason = 'Lv3まで完走想定のため出番なし (余剰戦力)';
                } else if (timeAware && earliestHourFor(m, openIdx) === null) {
                    reason = '停止レベルの開放時刻以降に戦闘可能時間がない';
                } else {
                    // 停止レベルの生存ボスに対して実際に出せるか判定
                    let conflictOnly = true;
                    let anyAliveAttr = false;
                    for (const k of attrs) {
                        if (!lastAliveWeak.has(k)) continue;
                        anyAliveAttr = true;
                        const usable = m.avail[k].some(lo =>
                            !(m.anyTeamRegistered && lo.team.length > 0 && lo.team.some(c => c && m.usedChars.has(c))));
                        if (usable) { conflictOnly = false; break; }
                    }
                    if (!anyAliveAttr) reason = '残っている生存ボスの属性を未提出';
                    else if (conflictOnly) reason = 'キャラ被り (同キャラは1日1回) で出せる編成なし';
                    else if (m.mandatory.size > 0 && (m.remainingAttacks - m.lockedNow) <= 0) reason = '得意属性の必須枠を温存中';
                    else reason = 'ボスHPが尽きた (割当先なし)';
                }
                return { name: m.name, remaining: m.remainingAttacks, reason };
            });

        const candidateCount = memberState.length;
        const lastLv = levels[levels.length - 1];
        return {
            startLevel, fullyClearedThrough, levels, totalAttacks, totalWaste,
            unusedAttacks, membersNoData, onlyAvailableNow, currentSlot, candidateCount,
            timeAware,
            nowHourLabel: timeAware ? hourLabelOf(nowIdx) : null,
            finalClearHourLabel: (timeAware && lastLv?.levelCleared) ? lastLv.clearHourLabel : null,
            membersTimeUnknown,
            membersFlex,
            anyTimeConstrained,
            unusedDetail,
            hoursUntilReset: timeAware ? (LAST_IDX - nowIdx + 1) : null,
        };
    }

    root.computeOptimalPlanCore = computeOptimalPlanCore;
})(typeof window !== 'undefined' ? window : globalThis);
