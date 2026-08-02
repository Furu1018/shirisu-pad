// ============================================================================
// 最適凸プラン ソルバー (純関数)
// ----------------------------------------------------------------------------
// index.html の computeOptimalPlan から切り出した中核ロジック。
// DOM・Supabase・グローバル状態に依存しないため node で単体テストできる:
//   node tests/run-tests.mjs
//
// 入出力の形は下記 typedef が正 (リアーキ ステップ1 — ARCHITECTURE-AUDIT.md §4-1)。
// フィールドを足し引きしたら typedef も必ず更新し、tests/run-tests.mjs で固定すること。
//
/**
 * @typedef {Object} BossRow                DB bosses 行 (supabaseLoadActiveSeasonWithBosses が供給)
 * @property {number} boss_number           1..5
 * @property {string} boss_code
 * @property {string=} name
 * @property {string} attribute             ボス自身の属性 (表示基準 — js/domain/attributes.js 参照)
 * @property {string} weakness              弱点 = 持っていくPT属性 (凸・編成基準)
 * @property {'lord'|'tyrant'} tier         lord=低HP(B1/B2/B4) / tyrant=高HP(B3/B5)。heretic は呼び出し側で tyrant に正規化済み
 * @property {number} total_hp_raw          raw値 (1B = 1e9)
 * @property {number} remaining_hp_raw
 *
 * @typedef {Object} PlayerInput
 * @property {*} id
 * @property {string} name
 * @property {number} attackCount           本日の消化済み凸数 (0..3)
 * @property {number=} syncLevel
 * @property {boolean=} syncLevelEstimated  SLv が近傍推定値なら true
 * @property {Object<string, number>} damagesByAttr    PT属性→ベストダメージ(B)。旧形式フォールバック
 * @property {Object<string, string[]>=} teamsByAttr   PT属性→編成5キャラ名
 * @property {Object<string, {dmgB:number, team:string[], slot:number}[]>=} loadoutsByAttr  1属性2編成 (slot=1|2)
 * @property {{boss_number:number}[]=} attacks         本日の凸履歴 (属性消費の逆引き用)
 * @property {string[]=} availableSlots     戦闘可能時間 'h05'..'h28'
 * @property {boolean=} flexTime            ⏳隙間時間型
 * @property {string[]=} strong_attributes  得意属性: 1-3個=必ず消化 / 4個=その中からのみ / 0・5個=制約なし
 *
 * @typedef {Object} PlanInput
 * @property {{current_level:number}} season
 * @property {BossRow[]} bosses
 * @property {PlayerInput[]} players
 * @property {string=} currentSlot          'h21' など (時間起点 / onlyAvailableNow のフィルタ)
 * @property {boolean=} onlyAvailableNow
 * @property {boolean=} timeAware
 *
 * @typedef {Object} PlanAttack             プラン内の1凸 (出力)
 * @property {*} memberId
 * @property {string} memberName
 * @property {number} slv
 * @property {boolean} slvEstimated
 * @property {number} dmgB                  この編成のベストダメージ (B)
 * @property {number} usedB                 実際にスコアへ入る分 = min(dmgB, 残HP)。無限ボスは dmgB 全額
 * @property {number} overflowB             オーバーキル (usedB との差)
 * @property {string[]|null} team           編成5キャラ (未登録なら null = 衝突未検出の警告表示)
 * @property {number|null} hourIdx          凸予定の時間帯 index (timeAware時)
 * @property {string|null} hourLabel        '21時' 等。⏳flex は時刻を約束しないので null
 * @property {boolean} flex                 ⏳隙間割当 (時刻未確約)
 * @property {boolean} timeUnknown          戦闘可能時間 未登録
 * @property {boolean} timeMismatch         開放時刻に出られずベストエフォート組み込み
 * @property {string|null} nearestHourLabel timeMismatch 時の最寄り希望時刻
 * @property {number} loadoutSlot           使用編成 (1|2)
 * @property {boolean} isBottleneck         レベルのクリア時刻を決める律速凸
 * @property {boolean=} reserved            🔒温存 (踏破に使わずボス5(無限)へ回した)
 *
 * @typedef {Object} PlanBoss
 * @property {number} bossNumber
 * @property {string} name
 * @property {string} weakness
 * @property {string} attribute
 * @property {string} tier
 * @property {boolean=} infinite            Lv4 ボス5 (HP無限・全額計上)
 * @property {number} targetHpB             目標HP (B)。infinite は 0 (Infinity は📤配信のJSONBで壊れるため使わない)
 * @property {number} remainingHpB          割当後の残 (B)
 * @property {boolean} cleared
 * @property {number=} creditedB            infinite: 入る与ダメ合計
 * @property {number=} absorbedB            フロンティア吸収レベル: 削った量 (撃破は狙わない)
 * @property {PlanAttack[]} attacks
 * @property {number|null} clearHourIdx
 * @property {string|null} clearHourLabel
 * @property {boolean} hasFlex
 * @property {boolean} timeConstrained      火力はあるが時間内に凸できる人がいない
 *
 * @typedef {Object} PlanLevel
 * @property {number} level                 1..3 / 4=ボス5無限
 * @property {boolean=} infinite
 * @property {boolean} levelCleared
 * @property {PlanBoss[]} bosses
 * @property {number|null} openHourIdx      このレベルが開く想定時間帯
 * @property {string|null} openHourLabel
 * @property {number|null} clearHourIdx
 * @property {string|null} clearHourLabel
 * @property {boolean} hasFlex
 *
 * @typedef {Object} Plan                   computeOptimalPlanCore の戻り値 (📤配信でJSONBにそのまま保存される
 *                                          — 数値は必ず有限に保つこと。他フィールドは末尾 return 文を参照)
 * @property {number} startLevel
 * @property {number} fullyClearedThrough   何レベルまで完全攻略想定か (最大3 — Lv4 は lv4Open で表現)
 * @property {PlanLevel[]} levels
 * @property {boolean} lv4Open              Lv3踏破 → ボス5(無限) が開く想定
 * @property {string|null} lv4Weakness
 * @property {number|null} frontierLevel    踏破できず吸収割当に切替えたレベル
 * @property {number} totalCreditedB        総与ダメ想定 (credited)
 * @property {number} lv4CreditedB
 * @property {number|null} baselineCreditedB 温存なし(probe)の credited
 * @property {number} reserveGainB          温存で増えた分
 * @property {boolean} reservePassUsed
 */
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

        // ===== 完了凸のキャラ消費 (同キャラは1日1回) =====
        // NIKKE は同じキャラを1日に1回しか使えない。朝に鉄甲PTでラピを使ったら、
        // その日は灼熱PTのラピ入り編成は出せない。運用上は「朝1凸だけ済ませて
        // 残りは運営指示にお任せ」が多いため、完了凸のキャラを除外しないと
        // 実行不能なプラン (使用済みキャラ入り) を提案してしまう。
        //
        // 前提: attacks[].characters は「その凸で実際に使った5キャラ」のスナップショット。
        // 未記録 (代理凸・一括登録の characters: []) の場合は best-effort —
        // 候補から外さず、unknownCompletedTeam フラグで運営に「要確認」と伝える
        // (内輪運用なので Discord で本人に確認できる。ブロックより名指しが有用)。
        // キャラ照合キー: 表記揺れ (前後空白 / 全角半角 / 大小文字) を吸収する。
        // 実データに「アニス:スター」(半角コロン) と「ドロシー：セレンディピティ」(全角コロン) が
        // 混在するため、生値の比較では seed 除外も編成一致もすり抜ける。
        // ※ 表示用の名前は元の値を保持し、比較のときだけこのキーを使う
        const charKey = (c) => (typeof c === 'string' ? c : '')
            .normalize('NFKC').trim().toLowerCase();
        // usedChars の出し入れは必ずこの2つを通す。生値の truthy 判定 (c &&) だと
        // 空白だけの項目 ' ' が truthy → charKey で '' になり、'' を Set に入れて
        // 後続の空白項目と「偽のキャラ被り」を作ってしまう
        const hasUsedChar = (set, c) => { const k = charKey(c); return k.length > 0 && set.has(k); };
        const addUsedChar = (set, c) => { const k = charKey(c); if (k) set.add(k); };
        const teamCharsOf = (a) => (Array.isArray(a && a.characters) ? a.characters : [])
            .map(charKey)
            .filter(c => c.length > 0);
        const usedCharsFor = (p) => {
            const set = new Set();
            (p.attacks || []).forEach(a => teamCharsOf(a).forEach(c => set.add(c)));
            return set;
        };
        // 完了凸の編成記録が「完全」と言えるのは 有効キャラ5人・重複なし のときだけ。
        // 部分記録 (['ラピ'] だけ / 画像パス除去後に4人になった 等) は残りのキャラが不明なので
        // 被り判定は不完全 = 要確認マーク。判明している分は seed に使う (best-effort)
        const TEAM_SIZE = 5;
        const hasUnknownCompletedTeam = (p) => (p.attacks || []).some(a => {
            const t = teamCharsOf(a);
            return t.length !== TEAM_SIZE || new Set(t).size !== t.length;
        });
        // 完了凸が「どのロードアウトを消費したか」の確定:
        //   優先1 = 記録キャラとの完全一致 (順不同) / 優先2 = 旧来のダメージ順 slice (推定)
        // 旧実装は「完了凸 = その属性の最高火力編成を使った」と決め打ちしていたため、
        // 実際は低火力の編成②で凸した場合に、合法な編成①まで消してしまう近似バグがあった。
        // 編成の同一判定 (順不同)。表記揺れを吸収するため charKey で比較する
        const sameTeam = (a, b) => {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return false;
            const sa = a.map(charKey).sort(), sb = b.map(charKey).sort();
            return sa.every((v, i) => v === sb[i]);
        };

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

        // メンバー状態: 残凸数 + 属性別の使い切りダメージ(>0) + SLv + 凸可能時間
        // 「現在凸可能のみ」モードでは availability に現スロットを含む人だけを対象にする。
        // 既に[attr]PT で凸済みの属性は avail から除外 (二重割当防止)
        // ※ 温存パス (Phase B) がまっさらな状態からやり直せるよう関数化してある —
        //    パス間で avail/usedChars/remainingAttacks の消費を持ち越さないこと
        const buildMemberState = () => (players || [])
            .filter(p => p.attackCount < 3)
            .filter(p => !onlyAvailableNow || (p.availableSlots || []).includes(currentSlot))
            .map(p => {
                const usedCount = usedCountFor(p);
                // 完了凸で消費済みのキャラ (属性をまたいで効く。空 = 未記録 or 凸なし)
                const seedChars = usedCharsFor(p);
                // その属性へ完了した凸のうち、記録キャラが判明しているものの一覧
                const doneTeamsByAttr = new Map();
                (p.attacks || []).forEach(a => {
                    const w = bossWeaknessByNum.get(a.boss_number);
                    const t = teamCharsOf(a);
                    if (!w || t.length === 0) return;
                    if (!doneTeamsByAttr.has(w)) doneTeamsByAttr.set(w, []);
                    doneTeamsByAttr.get(w).push(t);
                });
                // avail: 属性 -> 使用可能な編成 (ロードアウト) リスト、ダメージ降順。
                // 1属性2編成 (player_damages.slot) に対応し、別編成なら同属性2凸を提案できる。
                // 消費の確定は「記録キャラと完全一致する編成を消す」を優先し、
                // 一致が取れない分だけ従来のダメージ順 slice (推定) で補う。
                const avail = {};
                const loadouts = (p.loadoutsByAttr && Object.keys(p.loadoutsByAttr).length > 0) ? p.loadoutsByAttr : null;
                if (loadouts) {
                    for (const [k, list] of Object.entries(loadouts)) {
                        let clean = (list || [])
                            .filter(lo => Number(lo.dmgB) > 0)
                            // ord = 安定順序ID: undoPick で avail に戻すとき元の並びを再現するため
                            // (同ダメージの編成が入れ替わると pickFor の選択が変わってしまう)
                            .map((lo, i) => ({ dmg: Number(lo.dmgB), team: Array.isArray(lo.team) ? lo.team : [], slot: lo.slot || 1, ord: i }))
                            .sort((a, b) => b.dmg - a.dmg || a.ord - b.ord);
                        // ① 実際に使った編成 (記録キャラと完全一致) を優先的に消す
                        let unresolved = usedCount.get(k) || 0;
                        for (const doneTeam of (doneTeamsByAttr.get(k) || [])) {
                            const hit = clean.findIndex(lo => sameTeam(lo.team, doneTeam));
                            if (hit >= 0) { clean.splice(hit, 1); unresolved--; }
                        }
                        // ② 一致が取れなかった凸 (未記録・編成更新でズレた等) は従来どおり上位から推定消費
                        if (unresolved > 0) clean = clean.slice(unresolved);
                        // ③ 完了凸のキャラと被る編成は出せない (同キャラ1日1回)
                        if (seedChars.size > 0) {
                            clean = clean.filter(lo => !(lo.team.length > 0 && lo.team.some(c => hasUsedChar(seedChars, c))));
                        }
                        if (clean.length > 0) avail[k] = clean;
                    }
                } else {
                    // 旧入力形式 (damagesByAttr のみ) のフォールバック: 1属性1編成
                    for (const [k, v] of Object.entries(p.damagesByAttr || {})) {
                        if (Number(v) > 0 && !(usedCount.get(k) > 0)) {
                            const team = (p.teamsByAttr || {})[k] || [];
                            if (seedChars.size > 0 && team.length > 0 && team.some(c => hasUsedChar(seedChars, c))) continue;
                            avail[k] = [{ dmg: Number(v), team, slot: 1, ord: 0 }];
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
                    // 完了凸で使ったキャラを初期値に入れる (同キャラ1日1回)。
                    // ここで seed すると通常割当(:375)・Lv4割当(:537)・未使用診断(:722) の
                    // 全経路と、温存/吸収の各パス (buildMemberState が唯一の入口) に一貫して効く
                    usedChars: new Set(seedChars),
                    // 完了凸由来の使用済みキャラ (割当の取り消し undoPick で「戻してはいけない分」の判定に使う)
                    seedChars: new Set(seedChars),
                    // 完了凸に編成未記録がある = 被り判定が不完全 (best-effort)。運営に要確認を伝える
                    unknownCompletedTeam: hasUnknownCompletedTeam(p),
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

        // SLv順位 (0=最低, 1=最高) を参加可能メンバー内で相対化して付与
        const assignSlvRanks = (memberState) => {
            const participants = memberState.filter(m => m.remainingAttacks > 0 && Object.keys(m.avail).length > 0);
            const sortedBySlv = [...participants].sort((a, b) => a.slv - b.slv);
            const np = sortedBySlv.length;
            sortedBySlv.forEach((m, i) => { m.slvRank = np > 1 ? i / (np - 1) : 0.5; });
        };

        // 候補スコア(小さいほど良い): オーバーキル + SLvミスマッチ + 遅い時間ペナルティ。
        // SLv完全ミスマッチ(1.0) ≈ 5B のオーバーキル、1時間の遅れ ≈ 0.2B のオーバーキル相当。
        // ⏳隙間割当は時刻を確約しない分の不確実性ペナルティ (2時間の遅れ相当) を課し、
        // 「時刻を確約できる人」が僅差なら優先されるようにする。
        const W_OVER = 1.0, W_SLV = 5.0, W_TIME = 0.2, FLEX_PENALTY = 2 * W_TIME, MISMATCH_PENALTY = 6 * W_TIME, W_STRONG = 2.5;
        const scoreOf = (m, attr, dmg, rem, levelPos, hourIdx, openIdx, isFlex, isMismatch) => {
            const overkill = Math.max(0, dmg - rem);
            const slvPenalty = Math.abs((m.slvRank ?? 0.5) - levelPos);
            const timePenalty = timeAware ? (hourIdx - openIdx) : 0;
            // ⚠ 括弧必須: ?: は + より優先度が低いため、括弧が無いと
            // 「isFlex ? FLEX : (0 + mismatch分)」と解釈され、mismatch は常に flex=true で
            // 来るので MISMATCH_PENALTY が一度も加算されなくなる (Opus/Codex 監査で確認)。
            const flexPenalty = ((timeAware && isFlex) ? FLEX_PENALTY : 0)
                + ((timeAware && isMismatch) ? MISMATCH_PENALTY : 0);
            // 必須得意属性は早めに消化 (ボス撃破後に強制枠が余って無駄になるのを防ぐ)
            const strongBonus = m.mandatory.has(attr) ? W_STRONG : 0;
            return overkill * W_OVER + slvPenalty * W_SLV + timePenalty * W_TIME + flexPenalty - strongBonus - Math.min(dmg, rem) * 0.001;
        };

        // ===== 1パスぶんの割当実行 (Lv1〜3 の有限ボス) =====
        // opts.oppCostOf(m, attr, lo): 候補スコアへの加算項 (B単位)。「この凸を有限ボスに使うと
        //   ボス5(無限) で入るはずだったダメージをいくら失うか」の機会費用 (Phase B 温存パス)。
        // opts.lv4Mandatory: { attr, canAfter(m) } — この属性の必須消化は Lv4 で満たせる前提で
        //   枠予約 (lockedNow) から除外する (canAfter な人のみ)。
        const runPass = (opts = {}) => {
            const memberState = buildMemberState();
            assignSlvRanks(memberState);
            const levels = [];
            let fullyClearedThrough = startLevel - 1;  // 何レベルまで完全攻略できる想定か
            let openIdx = nowIdx;                       // このレベルの凸を開始できる時間帯
            let frontierLevel = null;                   // 踏破できず吸収割当に切り替えたレベル
            for (let L = startLevel; L <= 3; L++) {
            const levelPos = (L - 1) / 2;  // Lv1=0, Lv2=0.5, Lv3=1
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
                m.lockedNow = [...m.mandatory].filter(k => aliveWeakThisLevel.has(k)
                    // 温存パス: ボス5弱点が得意属性の人は Lv4 で消化できる (全額計上で本人にも最良) ため
                    // 有限レベルでは枠予約しない。ただし Lv4 開放時刻に出られない人は従来どおり予約する
                    && !(opts.lv4Mandatory && k === opts.lv4Mandatory.attr && opts.lv4Mandatory.canAfter(m))).length;
            });
            // メンバー状態のスナップショット — 踏破モードで失敗したら吸収モードでやり直すため
            const snapshot = memberState.map(m => ({
                remainingAttacks: m.remainingAttacks,
                avail: Object.fromEntries(Object.entries(m.avail).map(([k, v]) => [k, [...v]])),
                usedChars: new Set(m.usedChars),
                mandatory: new Set(m.mandatory),
                lockedNow: m.lockedNow,
            }));
            const restoreSnapshot = () => memberState.forEach((m, i) => {
                const s = snapshot[i];
                m.remainingAttacks = s.remainingAttacks;
                m.avail = Object.fromEntries(Object.entries(s.avail).map(([k, v]) => [k, [...v]]));
                m.usedChars = new Set(s.usedChars);
                m.mandatory = new Set(s.mandatory);
                m.lockedNow = s.lockedNow;
            });

            // このレベルの割当を1回実行する。
            // absorbMode=false: 従来どおりボスごとに削り切りを狙う (踏破モード)
            // absorbMode=true : 踏破できないレベル (フロンティア) 用。全ボスを横断して
            //   スコア最小の凸を選び続ける。撃破は狙わない — 次レベルが開かない以上
            //   撃破しても与ダメは増えず、残HP < ダメージ のボスへの凸はオーバーキルで
            //   credited を減らすだけ。オーバーキル項が「残HPに収まるボス優先」を自然に選ぶ
            const runLevel = (absorbMode) => {
                const targets = bosses.map(b => {
                    const tierHp = HARD_LEVEL_HP_B[L]?.[b.tier] ?? ((b.total_hp_raw || 0) / 1e9);
                    const targetHpB = (L === startLevel) ? ((b.remaining_hp_raw || 0) / 1e9) : tierHp;
                    return { b, targetHpB, rem: targetHpB, attacks: [], sawTimeExcluded: false };
                });
                // === 必須予約(mandatory)の途中解放 (Opus/Codex 監査 #4) ===
                // lockedNow をレベル開始時点で固定すると、必須属性のボスがレベル途中で
                // 他メンバーに撃破されても枠が握られたままになり、当該メンバーの1凸が
                // 丸ごと未使用になる。ボスが撃破されるたびに生存弱点を数え直して解放する。
                // targets は未処理ボスも満タン残HPで持つので、1回の走査で生存判定できる。
                // 温存パス (lv4Mandatory) の除外条件も同じ式に含める — 含めないと
                // レベル開始時に外した予約が途中の数え直しで復活してしまう
                const recountLocked = () => {
                    const aliveWeakLeft = new Set();
                    targets.forEach(t => { if (t.rem > 0.0001 && t.b.weakness) aliveWeakLeft.add(t.b.weakness); });
                    memberState.forEach(m => {
                        if (m.mandatory.size === 0) { m.lockedNow = 0; return; }
                        m.lockedNow = [...m.mandatory].filter(k => aliveWeakLeft.has(k)
                            && !(opts.lv4Mandatory && k === opts.lv4Mandatory.attr && opts.lv4Mandatory.canAfter(m))).length;
                    });
                };
                // t のボスに出せる最良 (スコア最小) の候補を探す
                // 候補を全列挙する (スコア昇順・同点は走査順で安定)。
                // pickFor は「先頭を採る」だけの薄いラッパにしてある — フェーズ2 (ボス横断の
                // 限定分岐) で「2番手をあえて選ぶ」分岐を作れるようにするための分離。
                // ⚠ 列挙条件は選択と同一でなければならない (被り・必須枠・時間の判定を二重化しない)
                const listCandidatesFor = (t) => {
                    const out = [];
                    for (const m of memberState) {
                        const list = m.avail[t.b.weakness];
                        if (m.remainingAttacks <= 0 || !list || list.length === 0) continue;
                        // 得意属性の必須消化: 予約枠 (このレベルで消化可能な必須) を除いた
                        // 自由枠が尽きたら、必須属性以外には出さない
                        if (m.mandatory.size > 0 && !m.mandatory.has(t.b.weakness)
                            && (m.remainingAttacks - m.lockedNow) <= 0) continue;
                        const slot = earliestHourFor(m, openIdx);
                        if (slot === null) { t.sawTimeExcluded = true; continue; }
                        // キャラ衝突しないロードアウトを全て候補としてスコアリングする。
                        // 残HPが小さいボスには 2編成目 (低火力) の方がオーバーキルが小さい・
                        // 温存の機会費用が安いことがある (編成データが全く無い人は衝突チェック対象外)
                        for (const cand of list) {
                            if (m.anyTeamRegistered && cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.usedChars, c))) continue;
                            let s = scoreOf(m, t.b.weakness, cand.dmg, t.rem, levelPos, slot.idx, openIdx, slot.flex, slot.mismatch);
                            // 温存パス: ボス5で入るはずの与ダメを失う機会費用 (B) を加算。
                            // オーバーキルと同じ単位なので W_OVER=1.0 と自然に比較される
                            if (opts.oppCostOf) s += opts.oppCostOf(m, t.b.weakness, cand);
                            if (absorbMode) {
                                // 吸収モードの目的は credited 最大化そのもの。SLv 公平性や時間の
                                // ペナルティを何Bもの与ダメと交換しない — オーバーキル最小・
                                // 与ダメ大を主項にし、通常スコアはタイブレークに格下げする
                                s = Math.max(0, cand.dmg - t.rem) - Math.min(cand.dmg, t.rem) * 0.01 + s * 0.001;
                            }
                            out.push({ pick: m, pickScore: s, pickHour: slot.idx, pickFlex: slot.flex, pickLo: cand, pickSlot: slot });
                        }
                    }
                    // 安定ソート: スコア昇順 → 同点は列挙順 (メンバー順 × ロードアウトの ord) を維持。
                    // 旧実装は「s < pickScore」で最初の最小値を採ったので、この並びの先頭と一致する
                    return out.map((c, i) => ({ c, i }))
                        .sort((x, y) => (x.c.pickScore - y.c.pickScore) || (x.i - y.i))
                        .map(x => x.c);
                };
                const pickFor = (t) => {
                    const list = listCandidatesFor(t);
                    return list.length > 0 ? list[0] : null;
                };
                // 候補を採用: 凸行を追加し、メンバー状態とボス残HPを更新する
                // 割当の内部メタ (出力に混ぜないため WeakMap/WeakSet で外部管理):
                //   loMeta = 使用したロードアウト参照 (undo で ord ごと avail へ戻す)
                //   consumedMandatory = その凸が必須属性を消化したか (undo で予約を戻す)
                const loMeta = new WeakMap();
                const consumedMandatory = new WeakSet();
                const applyPick = (t, c) => {
                    const { pick, pickHour, pickFlex, pickLo, pickSlot } = c;
                    const dmg = pickLo.dmg;
                    const team = pickLo.team;
                    const teamRegistered = team.length > 0;
                    t.attacks.push({
                        memberId: pick.id, memberName: pick.name,
                        slv: pick.slv, slvEstimated: pick.slvEstimated,
                        dmgB: dmg, usedB: Math.min(dmg, t.rem), overflowB: Math.max(0, dmg - t.rem),
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
                    if (teamRegistered) team.forEach(ch => addUsedChar(pick.usedChars, ch));
                    // 使用したロードアウトを除去 (同属性の別編成が残っていれば2凸目も提案可)
                    const loIdx = pick.avail[t.b.weakness].indexOf(pickLo);
                    if (loIdx >= 0) pick.avail[t.b.weakness].splice(loIdx, 1);
                    if (pick.avail[t.b.weakness].length === 0) delete pick.avail[t.b.weakness];
                    pick.remainingAttacks--;
                    // 得意属性の消化管理: 必須を消化したら予約も1つ解放
                    // (自由枠の消費は remainingAttacks の減少で自然に反映される)
                    const justPushed = t.attacks[t.attacks.length - 1];
                    if (pick.mandatory.has(t.b.weakness)) {
                        pick.mandatory.delete(t.b.weakness);
                        pick.lockedNow = Math.max(0, pick.lockedNow - 1);
                        consumedMandatory.add(justPushed);
                    }
                    // 復元情報は WeakMap に置く: 凸オブジェクトに直接生やすと
                    // 📤配信の JSONB に内部メタが混入して配信データが膨らむ (Codex指摘)
                    loMeta.set(justPushed, pickLo);
                    t.rem -= dmg;
                };
                // 割当を1件取り消して、消費した状態 (キャラ・編成・残凸・必須予約) を戻す。
                // trimOverkill 用 — applyPick の逆操作なので、applyPick を変えたらここも直すこと
                const undoPick = (t, atk) => {
                    const m = memberState.find(x => x.id === atk.memberId);
                    if (!m) return false;
                    const idx = t.attacks.indexOf(atk);
                    if (idx < 0) return false;
                    t.attacks.splice(idx, 1);
                    t.rem += atk.dmgB;
                    m.remainingAttacks++;
                    // 編成を avail へ戻す (ダメージ降順を維持)
                    const w = t.b.weakness;
                    if (!m.avail[w]) m.avail[w] = [];
                    // 元のロードアウト要素をそのまま戻し dmg降順 → ord昇順 で並べ直す
                    m.avail[w].push(loMeta.get(atk) || { dmg: atk.dmgB, team: atk.team || [], slot: atk.loadoutSlot || 1, ord: 0 });
                    m.avail[w].sort((a, b) => b.dmg - a.dmg || (a.ord ?? 0) - (b.ord ?? 0));
                    // 必須属性を消化した凸なら予約も戻す (後続の recountLocked で最終整合)
                    if (consumedMandatory.has(atk)) { m.mandatory.add(w); m.lockedNow++; }
                    // usedChars は「この凸で初めて使ったキャラ」だけ戻す。
                    // 完了凸の seed や他の割当が同じキャラを持つ場合は消してはいけない
                    if (Array.isArray(atk.team) && atk.team.length > 0) {
                        const stillUsed = new Set();
                        (m.seedChars || []).forEach(c => stillUsed.add(c));
                        targets.forEach(tt => tt.attacks.forEach(a2 => {
                            if (a2.memberId !== m.id) return;
                            (a2.team || []).forEach(c => stillUsed.add(charKey(c)));
                        }));
                        atk.team.forEach(c => { const k = charKey(c); if (k && !stillUsed.has(k)) m.usedChars.delete(k); });
                    }
                    return true;
                };
                // ===== オーバーキルの後処理 (フェーズ2a) =====
                // 貪欲法は1凸ずつ「その時点の残HP」で選ぶため、残HPが十分ある序盤は
                // どれを入れても overkill=0 になり、オーバーキル評価が効かない。
                // 結果「最後の1凸で大きく超過するが、振り返れば途中の小さい凸は不要だった」
                // という組合せになる (例: 目標61.2Bに 5.5+12.2+14.3+22.5+15.1=69.6B 投入、
                // 5.5Bを抜いても64.1Bで倒せた = 8.4B→2.9Bに損失圧縮 + 1凸が浮く)。
                // 撃破を維持したまま外せる凸をダメージの小さい順に外し、損失と凸消費を減らす。
                // 浮いた凸は他ボスや Lv4 (無限ボス) に回るので総与ダメも増える。
                const trimOverkill = (t) => {
                    if (t.rem > 0.0001) return;              // 倒せていないボスは削らない
                    let changed = true, removed = false;
                    while (changed) {
                        changed = false;
                        // 小さい凸から試す = 残す凸の合計が目標をギリギリ上回る形に寄せる
                        const order = [...t.attacks].sort((a, b) => a.dmgB - b.dmgB);
                        for (const atk of order) {
                            if (t.attacks.length <= 1) break;
                            if (t.rem + atk.dmgB > 0.0001) continue;   // 抜くと倒せなくなる
                            if (undoPick(t, atk)) { changed = true; removed = true; break; }
                        }
                    }
                    if (!removed) return;
                    // 凸を外したら usedB/overflowB を投入順に再計算する。
                    // 放置すると「外す前の残HP」で計算された値が残り、totalWaste・totalCreditedB・
                    // 温存パスの採否判定・画面の超過表示がすべて誤る (例: 5.5Bを外しても
                    // 最後の凸が usedB=6.7/overflow=8.4 のままで、実際は usedB=12.2/overflow=2.9)
                    let rem = t.targetHpB;
                    for (const a of t.attacks) {
                        a.usedB = Math.min(a.dmgB, Math.max(0, rem));
                        a.overflowB = Math.max(0, a.dmgB - Math.max(0, rem));
                        rem -= a.dmgB;
                    }
                    t.rem = rem;
                };
                if (!absorbMode) {
                    // 踏破モード: ボスごとに残HPを削り切るまで投入
                    for (const t of targets) {
                        while (t.rem > 0.0001) {
                            const c = pickFor(t);
                            if (!c) break;
                            applyPick(t, c);
                        }
                        trimOverkill(t);   // 撃破を保ったまま不要な凸を外す (損失圧縮・凸を浮かせる)
                        recountLocked();   // このボスが撃破されたら必須予約を解放 (#4)
                    }
                } else {
                    // 吸収モード: 生きている全ボスを横断して、常に全体スコア最小の凸を選ぶ
                    while (true) {
                        let best = null, bestT = null;
                        for (const t of targets) {
                            if (t.rem <= 0.0001) continue;   // 削り切ったボスに足すのはオーバーキル純増
                            const c = pickFor(t);
                            if (c && (!best || c.pickScore < best.pickScore)) { best = c; bestT = t; }
                        }
                        if (!best) break;
                        applyPick(bestT, best);
                        if (bestT.rem <= 0.0001) {
                            trimOverkill(bestT);   // 撃破したボスの不要な凸を外し、他ボスへ回す
                            recountLocked();       // 撃破が起きたら必須予約を解放 (#4)
                        }
                    }
                }
                // 集計: ボスごとの結果を組み立てる
                const levelBosses = [];
                let levelCleared = true;
                let levelClearIdx = openIdx;
                for (const t of targets) {
                    const { b, targetHpB, attacks } = t;
                    const rem = t.rem;
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
                        timeConstrained: timeAware && !cleared && targetHpB > 0 && t.sawTimeExcluded,
                        // 吸収モードでは「削った量」が成果 (撃破は目的ではない)
                        ...(absorbMode ? { absorbedB: Math.max(0, targetHpB - Math.max(0, rem)) } : {}),
                    });
                }
                return { levelBosses, levelCleared, levelClearIdx };
            };

            let levelResult = runLevel(false);
            if (!levelResult.levelCleared) {
                // フロンティア (踏破できないレベル): 撃破狙いをやめて吸収割当でやり直す
                restoreSnapshot();
                levelResult = runLevel(true);
                if (!levelResult.levelCleared) frontierLevel = L;
            }
            const { levelBosses, levelCleared, levelClearIdx } = levelResult;
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
            return { memberState, levels, fullyClearedThrough, openIdx, frontierLevel };
        };

        // ===== Lv4: ボス5のみ・HP無限 (Lv3踏破で即日開放) =====
        // ランキングは累計与ダメージで、無限ボスへの凸は全額計上される (オーバーキルが無い)。
        // Lv3 まで踏破できる想定なら、残っている凸のうちボス5の弱点属性で出せるものを全て割り当てる。
        // 数値は Infinity を使わず 0 + infinite フラグで表現する — 📤配信は JSONB 保存であり、
        // JSON.stringify(Infinity) は null になって旧クライアントの .toFixed() を壊すため。
        const boss5 = bosses.find(b => b.boss_number === 5);
        const assignLv4 = (pass) => {
            const lv4Weak = boss5.weakness;
            const lv4OpenIdx = pass.openIdx;   // ループ後の openIdx = Lv3 クリア想定時刻
            const memberState = pass.memberState;
            const lv4Attacks = [];
            for (const m of memberState) {
                // 同一人物でも別編成 (loadout slot) なら同属性に複数凸できる — 残凸数まで dmg 降順で割当。
                // 有限ボスはもう残っていないので、得意属性の枠予約 (lockedNow) はここでは考慮しない
                // (温存する先が存在しない。凸を余らせるより全額入るボス5へ出す方が常に良い)
                while (m.remainingAttacks > 0) {
                    const list = m.avail[lv4Weak];
                    if (!list || list.length === 0) break;
                    let lo = null;
                    for (const cand of list) {
                        if (m.anyTeamRegistered && cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.usedChars, c))) continue;
                        lo = cand;
                        break;
                    }
                    if (!lo) break;   // キャラ被りで出せる編成なし
                    // 開放時刻に出られない人も除外せずベストエフォート ⏳ で組み込む (有限ボスと同じ哲学)
                    const slot = earliestHourFor(m, lv4OpenIdx);
                    const teamRegistered = lo.team.length > 0;
                    lv4Attacks.push({
                        memberId: m.id, memberName: m.name,
                        slv: m.slv, slvEstimated: m.slvEstimated,
                        dmgB: lo.dmg, usedB: lo.dmg, overflowB: 0,   // 無限HP: 全額計上
                        team: teamRegistered ? lo.team : null,
                        hourIdx: timeAware ? slot.idx : null,
                        hourLabel: (timeAware && !slot.flex) ? hourLabelOf(slot.idx) : null,
                        flex: timeAware ? slot.flex : false,
                        timeUnknown: timeAware ? m.timeUnknown : false,
                        timeMismatch: !!(timeAware && slot.mismatch),
                        nearestHourLabel: (timeAware && slot.mismatch && slot.nearestIdx != null) ? hourLabelOf(slot.nearestIdx) : null,
                        loadoutSlot: lo.slot,
                        isBottleneck: false,
                    });
                    if (teamRegistered) lo.team.forEach(c => addUsedChar(m.usedChars, c));
                    const loIdx = list.indexOf(lo);
                    if (loIdx >= 0) list.splice(loIdx, 1);
                    if (list.length === 0) delete m.avail[lv4Weak];
                    m.remainingAttacks--;
                    if (m.mandatory.has(lv4Weak)) {
                        m.mandatory.delete(lv4Weak);
                        m.lockedNow = Math.max(0, m.lockedNow - 1);
                    }
                }
            }
            const lv4HasFlex = lv4Attacks.some(a => a.flex);
            pass.levels.push({
                level: 4, infinite: true,
                levelCleared: true,   // 旧クライアントの表示分岐で無害な値に倒す
                bosses: [{
                    bossNumber: boss5.boss_number, name: boss5.name || boss5.boss_code,
                    weakness: lv4Weak, attribute: boss5.attribute, tier: boss5.tier,
                    infinite: true, targetHpB: 0, remainingHpB: 0, cleared: true,
                    creditedB: lv4Attacks.reduce((s, a) => s + a.usedB, 0),
                    attacks: lv4Attacks,
                    clearHourIdx: null, clearHourLabel: null,
                    hasFlex: lv4HasFlex, timeConstrained: false,
                }],
                openHourIdx: timeAware ? lv4OpenIdx : null,
                openHourLabel: timeAware ? hourLabelOf(lv4OpenIdx) : null,
                clearHourIdx: null, clearHourLabel: null,   // 無限ボスに「クリア」は無い
                hasFlex: lv4HasFlex,
            });
        };
        const sumCreditedOf = (pass) =>
            pass.levels.reduce((s, lv) => s + lv.bosses.reduce((t, b) => t + b.attacks.reduce((u, a) => u + a.usedB, 0), 0), 0);

        // ===== パス実行: probe (温存なし・現行アルゴリズム) → 温存パス (Lv4 が見える時のみ) =====
        const probe = runPass();
        const lv4Open = probe.fullyClearedThrough >= 3 && !!(boss5 && boss5.weakness);
        let chosen = probe;
        let reservePassUsed = false;
        if (lv4Open) {
            const lv4Weak = boss5.weakness;
            let T3 = probe.openIdx;   // Lv3 クリア想定時刻 (温存可否の判断に使う)。収束ループで更新される
            // T3 以降に「確約」で出られる人だけ温存させる。時間未登録/純⏳隙間型はいつでも可、
            // ハイブリッドは時間外を隙間で対応できるので可。mismatch になる人は温存させない
            // (Lv4 開放時刻に実際は出られず、約束できない凸に大火力を賭けることになるため)
            const canAttackAfterT3 = (m) => {
                if (!timeAware) return true;
                if (m.hourIdxs === null) return true;
                if (m.hourIdxs.some(i => i >= T3)) return true;
                return !!m.flexTime;
            };
            // ボス5で見込める与ダメ: 弱点属性の残ロードアウト (dmg降順) 上位 min(残凸, 編成数) 件の合計。
            // キャラ被りは概算では無視する (厳密には Lv4 割当時に判定される)
            const potentialOf = (list, slots) => {
                if (!list || slots <= 0) return 0;
                let s = 0;
                const n = Math.min(slots, list.length);
                for (let i = 0; i < n; i++) s += list[i].dmg;
                return s;
            };
            // 機会費用 = この凸を有限ボスに使うことで減る「ボス5で入るはずだった与ダメ」。
            // 弱点属性の凸は編成そのものを失い、他属性の凸もスロット逼迫時
            // (残凸数 <= 弱点属性の編成数) にはボス5に入れる回数を1つ失う。
            // どちらも potential の差分として1つの式で正しく出る
            const oppCostOf = (m, attr, lo) => {
                if (!canAttackAfterT3(m)) return 0;
                const list = m.avail[lv4Weak];
                const before = potentialOf(list, m.remainingAttacks);
                const after = (attr === lv4Weak)
                    ? potentialOf((list || []).filter(x => x !== lo), m.remainingAttacks - 1)
                    : potentialOf(list, m.remainingAttacks - 1);
                return Math.max(0, before - after);
            };
            // 温存で大火力を踏破から外すと Lv3 クリア時刻が後ろにずれることがある。
            // 前提にした T3 より実際の開放が遅いと「開放時刻に出られない人」を誤って温存して
            // しまうため、実クリア時刻が前提以下に収まるまで T3 を引き上げて引き直す
            // (T3 は単調増加・時間帯は有限なので必ず止まるが、安全のため3回で打ち切り)
            let reserved = null;
            for (let iter = 0; iter < 3; iter++) {
                const attempt = runPass({
                    oppCostOf,
                    lv4Mandatory: { attr: lv4Weak, canAfter: canAttackAfterT3 },
                });
                if (attempt.fullyClearedThrough < 3) { reserved = null; break; }   // 温存で踏破が崩れた
                if (attempt.openIdx <= T3) { reserved = attempt; break; }          // 前提どおり → 採用候補
                T3 = attempt.openIdx;   // 実際の開放が遅い → 前提を更新して引き直し
            }
            assignLv4(probe);
            // 温存パスは「踏破が崩れない」かつ「credited が実際に増える」ときだけ採用する。
            // 貪欲近似なので、機会費用を入れた方が悪化するケースは probe に倒す (安全側)
            if (reserved) {
                assignLv4(reserved);
                if (sumCreditedOf(reserved) > sumCreditedOf(probe) + 1e-9) {
                    chosen = reserved;
                    reservePassUsed = true;
                }
            }
        }
        const baselineCreditedB = lv4Open ? sumCreditedOf(probe) : null;   // 温存なしの credited
        // 温存マーク: probe では有限ボスに使われていた凸 (人+編成) が、温存パスでボス5に回ったもの。
        // memberId だけで判定すると、2編成持ちの「元からボス5行きだった方の編成」にも
        // 誤って 🔒 が付くため、loadoutSlot 込みで特定する
        if (reservePassUsed) {
            const loKey = (a) => `${a.memberId}|${a.loadoutSlot}`;
            const probeFiniteX = new Set(probe.levels
                .filter(lv => !lv.infinite)
                .flatMap(lv => lv.bosses.filter(b => b.weakness === boss5.weakness).flatMap(b => b.attacks.map(loKey))));
            chosen.levels.filter(lv => lv.infinite).forEach(lv =>
                lv.bosses.forEach(b => b.attacks.forEach(a => {
                    if (probeFiniteX.has(loKey(a))) a.reserved = true;
                })));
        }
        const { memberState, levels, fullyClearedThrough } = chosen;
        const openIdx = chosen.openIdx;

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
        // 完了凸の編成が未記録 = キャラ被り判定が不完全なメンバー (best-effort で候補には残す)。
        // 運営は Discord 等で「この編成で出せるか」を本人に確認できるので、除外せず名指しする
        const membersUnknownCompletedTeam = memberState
            .filter(m => m.unknownCompletedTeam && m.remainingAttacks > 0)
            .map(m => m.name);
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
                    reason = lv4Open
                        ? 'ボス5(無限)の弱点属性の編成が残っていない (未提出 or 使い切り)'
                        : '出せる属性の残りなし (提出属性を使い切り)';
                } else if (lv4Open) {
                    // Lv4 割当後も凸が残る = 弱点属性は avail に有るがキャラ被りで出せなかった
                    reason = attrs.includes(boss5.weakness)
                        ? 'キャラ被り (同キャラは1日1回) でボス5に出せる編成なし'
                        : 'ボス5(無限)の弱点属性が未提出 (提出すれば全額スコアに入る)';
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
                            !(m.anyTeamRegistered && lo.team.length > 0 && lo.team.some(c => hasUsedChar(m.usedChars, c))));
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
        // 「完了想定時刻」は最後の有限レベルから取る (Lv4 は無限なのでクリア時刻を持たない)
        const lastFinite = [...levels].reverse().find(lv => !lv.infinite);
        // 総与ダメ想定 (credited): 有限ボスは min(dmg, 残HP)、ボス5(無限) は全額
        const totalCreditedB = allAttacks.reduce((s, a) => s + a.usedB, 0);
        const lv4Level = levels.find(lv => lv.infinite);
        const lv4CreditedB = lv4Level ? lv4Level.bosses[0].creditedB : 0;
        return {
            startLevel, fullyClearedThrough, levels, totalAttacks, totalWaste,
            unusedAttacks, membersNoData, onlyAvailableNow, currentSlot, candidateCount,
            timeAware,
            nowHourLabel: timeAware ? hourLabelOf(nowIdx) : null,
            finalClearHourLabel: (timeAware && lastFinite?.levelCleared) ? lastFinite.clearHourLabel : null,
            membersTimeUnknown,
            membersFlex,
            membersUnknownCompletedTeam,
            anyTimeConstrained,
            unusedDetail,
            hoursUntilReset: timeAware ? (LAST_IDX - nowIdx + 1) : null,
            lv4Open,
            lv4Weakness: lv4Open ? boss5.weakness : null,
            frontierLevel: chosen.frontierLevel,   // 踏破できず吸収割当に切り替えたレベル (null = 全踏破)
            totalCreditedB,
            lv4CreditedB,
            // 温存の効果測定: baseline = 温存なし (probe) の credited。gain = 温存で増えた分
            baselineCreditedB,
            reserveGainB: baselineCreditedB != null ? Math.max(0, totalCreditedB - baselineCreditedB) : 0,
            reservePassUsed,
        };
    }

    root.computeOptimalPlanCore = computeOptimalPlanCore;
})(typeof window !== 'undefined' ? window : globalThis);
