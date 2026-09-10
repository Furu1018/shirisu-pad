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
 * @property {Object<string, {dmgB:number, team:string[], slot:number, level:?number}[]>=} loadoutsByAttr
 *   1属性最大2編成 (slot=1|2)。level = 模擬で測定したボスレベル (1〜4)。
 *   null = レベル未指定 (移行前の提出) = 全レベルで使える
 * @property {{boss_number:number}[]=} attacks         本日の凸履歴 (属性消費の逆引き用)
 * @property {string[]=} availableSlots     戦闘可能時間 'h05'..'h28'
 * @property {boolean=} flexTime            ⏳隙間時間型
 * @property {string[]=} strong_attributes  得意属性 — **ソルバーでは使わない** (2026-09-08)。予約 (L2) が本人の希望を表すため。申告はコミュニティ表示だけ
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

    // フェーズ2 (ボス横断の限定分岐) の探索上限。運営ボタンの体感を壊さない範囲に収める
    // L1 安定化 (2026-09-07): 前回の約束を捨てて通常解へ動くのは「明確に損」なときだけ。
    // 相対だけだと小さい盤面で過敏になり、絶対だけだと大きい盤面で鈍る → 両方の大きい方を使う。
    // 30B の根拠: 第44回の総与ダメ 2,981B の約1% で、1人1凸ぶんに近い (ユーザー承認 2026-09-07)
    const STICKY_GAIN_RATIO = 0.05;
    const STICKY_MIN_GAIN_B = 30;
    // 拘束として受け付ける編成スロットの上限 (supabase/32 で DB の CHECK も 1|2)。
    // 範囲外は壊れた配信データなので、その行ごと捨てる
    const MOCK_SLOT_MAX_STICKY = 2;
    const MAX_BRANCH = 16;       // 1ラウンドで試す決定点の数
    const MAX_DEPTH = 3;        // 改善した分岐に重ねて分岐する深さ (1決定点だけでは弱い)
    // 解くシナリオの総数 (基準解を含む)。**実時間で打ち切ってはいけない** —
    // 同じ盤面から毎回同じプランが出ることが配信 (📤) の前提で、実行速度・GC・端末性能で
    // 内容が変わると「運営が押すたびに違う指示が出る」ことになる。
    // 代わりに人数から決まる決定的な上限で計算量を抑える (1シナリオのコストは人数に比例)
    // 閾値は実運用の人数 (NIKKE のユニオン上限は30人) より上に置く —
    // 26人と25人でプランの質が不連続に変わるのは運営から見て理解不能なため。
    // 縮小はあくまで「想定外に大きい入力でブラウザを固まらせない」保険
    const scenarioBudgetFor = (n) => (n > 60 ? 20 : n > 40 ? 40 : 60);

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
        // ===== 模擬の測定レベルによる絞り込み (ユーザー決定 2026-08-10) =====
        // 記録レベル L の編成は **対象レベル ≤ L** にだけ使う。
        // 高難度で出せた出力は低難度なら確実に出せる (下限として保証される) が、
        // 代表ダメージの計算 (levels オブジェクト → 数値)。有効値の中央値。
        // 偶数個は中央2つの平均。1件ならその値。廃止前の複数測定を畳むためだけに使う
        const representative = (levels) => {
            const vals = [];
            for (const k of ['0', '1', '2', '3', '4']) {
                const v = levels[k];
                if (Number.isFinite(v) && v > 0) vals.push(v);
            }
            if (vals.length === 0) return 0;
            vals.sort((a, b) => a - b);
            const mid = Math.floor(vals.length / 2);
            return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
        };

        // 提出の代表ダメージ。**対象レベルによらず同じ値**を返す。
        // 測定レベルで候補を絞るのはやめた (2026-09-06 ユーザー決定) — 根拠と経緯は
        // js/domain/mockLevels.js の representativeDamage を参照。
        // 複数値を持つのは廃止前の既存データだけで、その場合は中央値を採る
        // (最大値は試行のブレの上振れを固定してしまう)
        const resolveDamage = (lo) => {
            const v = representative(lo.levels);
            return v > 0 ? v : null;
        };
        const hasDamage = (lo) => resolveDamage(lo) !== null;
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
            // ★ 今期「参加が難しい」と申告した人は候補にしない。
            //   時間帯を空にするだけだと timeUnknown = 「いつでも可」として扱われ、
            //   かえって全時間帯の候補になってしまう (2026-09-07)
            .filter(p => !p.unavailableThisSeason)
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
                            // ord = 安定順序ID: undoPick で avail に戻すとき元の並びを再現するため
                            // (同ダメージの編成が入れ替わると pickFor の選択が変わってしまう)
                            .map((lo, i) => {
                                // 1〜4 の整数だけを信じる。0・NaN・範囲外は「未指定」に倒す
                                // (Lv1 に丸めると意味が正反対 = 割当対象から不当に外れる)
                                const level = (Number.isInteger(lo.level) && lo.level >= 1 && lo.level <= 4) ? lo.level : null;
                                // levels の正規化 + dmg=最大値 の防御的再計算 (不変条件を入口で閉じる)。
                                // levels が無い旧形式は (dmgB, level) の1測定として読む
                                const levels = {};
                                const raw = (lo.levels && typeof lo.levels === 'object' && !Array.isArray(lo.levels)) ? lo.levels : null;
                                if (raw) {
                                    for (const k of ['0', '1', '2', '3', '4']) {
                                        const v = Number(raw[k]);
                                        if (Number.isFinite(v) && v > 0) levels[k] = v;
                                    }
                                }
                                if (Object.keys(levels).length === 0) levels[String(level ?? 0)] = Number(lo.dmgB);
                                // ★ dmg は**代表値**にする (resolveDamage と同じ中央値)。
                                //   ここだけ最大値のままにすると、並べ替え・火力順位・
                                //   「編成未記録の完了凸を上位から消費する」推定が、実際に使う値と
                                //   食い違う (levels{1:100,2:1,3:1} の代表値は 1 なのに最大値100で
                                //   最上位に並び、先に消費されてしまう — Codex指摘)
                                const dmg = representative(levels);
                                return {
                                    dmg,
                                    team: Array.isArray(lo.team) ? lo.team : [],
                                    slot: lo.slot || 1,
                                    level,
                                    levels,
                                    ord: i,
                                };
                            })
                            // ★ フィルタは正規化の後 — dmgB が古い 0 でも levels に有効な測定が
                            //   あれば使える (dmgB 先行フィルタだと黙って捨ててしまう。Codex指摘)
                            .filter(lo => lo.dmg > 0)
                            // ★ 同ダメージのタイブレークに slot を入れる。ord は取得順そのもの
                            //   なので、DB の返却順が揺れると選ばれる編成が変わる = 非決定的になる
                            //   (取得側にも order を付けてあるが、不変条件をここでも閉じておく)
                            .sort((a, b) => b.dmg - a.dmg || a.slot - b.slot || a.ord - b.ord);
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
                            // 旧形式にレベルの概念は無い → 未指定 (全レベル可)
                            avail[k] = [{ dmg: Number(v), team, slot: 1, level: null, levels: { '0': Number(v) }, ord: 0 }];
                        }
                    }
                }
                // ★ 得意属性 (strong_attributes) はソルバーで使わない (2026-09-08 ユーザー決定)。
                //   予約 (L2) があれば本人が得意属性のカードを予約すればよく、「必ず消化」の枠予約は要らない
                //   (枠予約は「出せる属性への凸まで封じる」事故を何度も起こした — 2026-08-08 の8凸未使用 等)。
                //   申告はコミュニティの表示 (プロフィール・メンバー一覧) として残す。計算には入れない
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
                    // 模擬を1属性も出していない (未消化の理由を「未提出」と「提出属性の使い切り」で分けるため。
                    // membersNoData と同じ判定)
                    noSubmission: Object.values(p.damagesByAttr || {}).every(v => !v || v === 0),
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
                };
            });

        // SLv順位 (0=最低, 1=最高) を参加可能メンバー内で相対化して付与
        // 「火力の弱い人ほど低いレベルのボスへ」の順位付け。
        // ★ 基準は SLv ではなく**実際に提出されたダメージ**にする (ユーザー要望 2026-08-08)。
        //   SLv はあくまで育成度の目安で、同じ SLv でも編成次第で実火力は大きく違う。
        //   実測でも「平均5.4B / SLv411」の人と「平均13.0B / SLv550」の人の並びが
        //   SLv 基準では実力どおりにならなかった。
        //   火力 = 提出済み各属性のベスト編成の平均 (その人が普段出せる火力の代表値)。
        //   同点は SLv → 名前順で崩し、同じ盤面から常に同じ並びになるようにする
        const powerOf = (m) => {
            const best = Object.values(m.avail || {})
                .map(list => (list && list.length) ? Math.max(...list.map(x => x.dmg)) : 0)
                .filter(v => v > 0);
            return best.length ? best.reduce((a, b) => a + b, 0) / best.length : 0;
        };
        const assignSlvRanks = (memberState) => {
            const participants = memberState.filter(m => m.remainingAttacks > 0 && Object.keys(m.avail).length > 0);
            participants.forEach(m => { m.power = powerOf(m); });
            // 最終タイブレークは id の**コードポイント順**にする。
            // localeCompare は既定ロケール依存で、同火力・同SLvの人の並びが端末によって
            // 変わりうる = 同じ盤面から違うプランが出る (配信の前提が崩れる — Codex指摘)。
            // id は一意なので必ずどちらかに決まる
            const cpCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
            const sorted = [...participants].sort((a, b) => (a.power - b.power)
                || (a.slv - b.slv)
                || cpCmp(String(a.id), String(b.id)));
            const np = sorted.length;
            sorted.forEach((m, i) => { m.slvRank = np > 1 ? i / (np - 1) : 0.5; });
        };

        // 候補スコア(小さいほど良い): オーバーキル + 火力レベルのミスマッチ + 遅い時間ペナルティ。
        // 火力の完全ミスマッチ(1.0) ≈ 5B のオーバーキル、1時間の遅れ ≈ 0.2B のオーバーキル相当。
        // ここでいう「火力」は実際の提出ダメージの順位 (slvRank — 名前は歴史的経緯で SLv のまま)。
        // ⏳隙間割当は時刻を確約しない分の不確実性ペナルティ (2時間の遅れ相当) を課し、
        // 「時刻を確約できる人」が僅差なら優先されるようにする。
        const W_OVER = 1.0, W_SLV = 5.0, W_TIME = 0.2, FLEX_PENALTY = 2 * W_TIME, MISMATCH_PENALTY = 6 * W_TIME;
        const scoreOf = (m, attr, dmg, rem, levelPos, hourIdx, openIdx, isFlex, isMismatch) => {
            const overkill = Math.max(0, dmg - rem);
            // 火力が弱い人ほど低いレベル (levelPos: Lv1=0 / Lv2=0.5 / Lv3=1) に寄せる
            const slvPenalty = Math.abs((m.slvRank ?? 0.5) - levelPos);
            const timePenalty = timeAware ? (hourIdx - openIdx) : 0;
            // ⚠ 括弧必須: ?: は + より優先度が低いため、括弧が無いと
            // 「isFlex ? FLEX : (0 + mismatch分)」と解釈され、mismatch は常に flex=true で
            // 来るので MISMATCH_PENALTY が一度も加算されなくなる (Opus/Codex 監査で確認)。
            const flexPenalty = ((timeAware && isFlex) ? FLEX_PENALTY : 0)
                + ((timeAware && isMismatch) ? MISMATCH_PENALTY : 0);
            return overkill * W_OVER + slvPenalty * W_SLV + timePenalty * W_TIME + flexPenalty - Math.min(dmg, rem) * 0.001;
        };

        // ===== 1パスぶんの割当実行 (Lv1〜3 の有限ボス) =====
        // opts.oppCostOf(m, attr, lo): 候補スコアへの加算項 (B単位)。「この凸を有限ボスに使うと
        //   ボス5(無限) で入るはずだったダメージをいくら失うか」の機会費用 (Phase B 温存パス)。
        const runPass = (opts = {}) => {
            const memberState = buildMemberState();
            assignSlvRanks(memberState);
            const levels = [];
            let fullyClearedThrough = startLevel - 1;  // 何レベルまで完全攻略できる想定か
            let openIdx = nowIdx;                       // このレベルの凸を開始できる時間帯
            let frontierLevel = null;                   // 踏破できず吸収割当に切り替えたレベル
            for (let L = startLevel; L <= 3; L++) {
            const levelPos = (L - 1) / 2;  // Lv1=0, Lv2=0.5, Lv3=1
            // ⚠ ここで「後のレベルに約束された凸ぶんの枠を予約する」ことを試したが**やめた** (2026-09-07)。
            //   狙いは「手前のレベルの貪欲が Lv3 の約束の枠を食う」のを防ぐことだったが、
            //   安定性ベンチ (tests/bench-stability.mjs) で測ると
            //   約束が壊れた人数が 163 → 188 に**増え**、同一盤面の違反件数も変わらなかった。
            //   枠を空けて待つと、その人が手前で出せたはずの凸まで失うため。
            //   予約は L2 (承認済みの予約) の仕事で、L1 の「前回どおりを尊重する」には強すぎる
            // ===== L2: 後のレベルに予約がある人は、その分の凸・編成・キャラをこのレベルで使わない (2026-09-08) =====
            // 予約は「そのレベルで・その編成で」の約束。手前のレベルの貪欲がその人の残り凸や
            // 予約した編成 (とそのキャラ) を先に使うと、予約のレベルに来たときには置けない
            // (実際に起きた: 残り1凸の人の Lv2 の予約が、Lv1 の貪欲に使われて「置けない」になった)。
            // ★ L1 (前回どおり) では同じ「枠を空けて待つ」を試して**やめた** (上の注記) が、
            //   予約は運営が承認した約束なので「手前で出せたはずの凸を失う」より約束が優先。
            //   レベルごとの定数なので、吸収モードのスナップショット復元の影響を受けない
            memberState.forEach(m => {
                m.reservedLater = 0;
                m.reservedLaterSlots = new Set();
                m.reservedLaterChars = new Set();
            });
            for (const r of (opts.reservations || [])) {
                if (!(Number(r.level) > L)) continue;   // Lv4 (ボス5) の予約ぶんも手前では使わない
                const m = memberState.find(x => String(x.id) === String(r.memberId));
                if (!m) continue;
                m.reservedLater++;
                const w = bossWeaknessByNum.get(Number(r.bossNumber));
                if (w) m.reservedLaterSlots.add(`${w}|${Number(r.loadoutSlot) || 1}`);
                (Array.isArray(r.team) ? r.team : []).forEach(c => addUsedChar(m.reservedLaterChars, c));
            }
            // メンバー状態のスナップショット — 踏破モードで失敗したら吸収モードでやり直すため
            const snapshot = memberState.map(m => ({
                remainingAttacks: m.remainingAttacks,
                avail: Object.fromEntries(Object.entries(m.avail).map(([k, v]) => [k, [...v]])),
                usedChars: new Set(m.usedChars),
            }));
            const restoreSnapshot = () => memberState.forEach((m, i) => {
                const s = snapshot[i];
                m.remainingAttacks = s.remainingAttacks;
                m.avail = Object.fromEntries(Object.entries(s.avail).map(([k, v]) => [k, [...v]]));
                m.usedChars = new Set(s.usedChars);
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
                        // L2: 後のレベルの予約ぶんの凸は残す (編成・キャラは候補ごとに下で見る)
                        if ((m.remainingAttacks - (m.reservedLater || 0)) <= 0) continue;
                        const slot = earliestHourFor(m, openIdx);
                        if (slot === null) { t.sawTimeExcluded = true; continue; }
                        // キャラ衝突しないロードアウトを全て候補としてスコアリングする。
                        // 残HPが小さいボスには 2編成目 (低火力) の方がオーバーキルが小さい・
                        // 温存の機会費用が安いことがある (編成データが全く無い人は衝突チェック対象外)
                        for (const cand of list) {
                            const dmg = resolveDamage(cand);
                            if (dmg === null) continue;
                            if (m.anyTeamRegistered && cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.usedChars, c))) continue;
                            // L2: 後のレベルで予約した編成と、そのキャラを含む編成はここでは使わない
                            if ((m.reservedLater || 0) > 0 && (m.reservedLaterSlots.has(`${t.b.weakness}|${Number(cand.slot) || 1}`)
                                || (cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.reservedLaterChars, c))))) continue;
                            let s = scoreOf(m, t.b.weakness, dmg, t.rem, levelPos, slot.idx, openIdx, slot.flex, slot.mismatch);
                            // 温存パス: ボス5で入るはずの与ダメを失う機会費用 (B) を加算。
                            // オーバーキルと同じ単位なので W_OVER=1.0 と自然に比較される
                            if (opts.oppCostOf) s += opts.oppCostOf(m, t.b.weakness, cand);
                            if (absorbMode) {
                                // 吸収モードの目的は credited 最大化そのもの。SLv 公平性や時間の
                                // ペナルティを何Bもの与ダメと交換しない — オーバーキル最小・
                                // 与ダメ大を主項にし、通常スコアはタイブレークに格下げする
                                s = Math.max(0, dmg - t.rem) - Math.min(dmg, t.rem) * 0.01 + s * 0.001;
                            }
                            out.push({ pick: m, pickScore: s, pickHour: slot.idx, pickFlex: slot.flex, pickLo: cand, pickDmg: dmg, pickSlot: slot });
                        }
                    }
                    // 安定ソート: スコア昇順 → 同点は列挙順 (メンバー順 × ロードアウトの ord) を維持。
                    // 旧実装は「s < pickScore」で最初の最小値を採ったので、この並びの先頭と一致する
                    return out.map((c, i) => ({ c, i }))
                        .sort((x, y) => (x.c.pickScore - y.c.pickScore) || (x.i - y.i))
                        .map(x => x.c);
                };
                // 分岐ポリシー: 「この決定点では2番手(指定の候補)を選べ」という指示。
                // フェーズ2 (ボス横断) が「Aを温存してBを使う」案を試すために使う。
                // 指定が無い/候補が消えている場合は通常どおり先頭 (最小スコア) を採る
                // 決定点キー: レベル・モードを含めないと Lv1〜Lv3 で同じボスの同じ何凸目が衝突し、
                // 「1決定点だけ分岐」の前提が壊れる (別レベルでも同じ分岐が再発火する)
                const decisionKey = (t, isAbsorb) => `${L}|${isAbsorb ? 'C' : 'A'}|${t.b.boss_number}|${t.attacks.length}`;
                // 全レベル一括の分岐キー。貴重な人材の取り合いはレベルをまたいで連鎖するので、
                // 「このボスの何凸目は代替可能な人に回す」を全レベルに同時適用する候補も要る
                // (レベル別キーの1点分岐だけでは、Lv1〜Lv3 で一貫した振り替えに到達できない)
                const wildKey = (t) => `*|*|${t.b.boss_number}|${t.attacks.length}`;
                const pickFor = (t, preList) => {
                    const list = preList || listCandidatesFor(t);
                    if (list.length === 0) return null;
                    const policy = opts.decisionPolicy;
                    if (policy) {
                        const want = policy.get(decisionKey(t, absorbMode)) || policy.get(wildKey(t));
                        if (want) {
                            const alt = list.find(c => c.pick.id === want.memberId
                                && (c.pickLo.slot || 1) === want.slot && (c.pickLo.ord ?? 0) === want.ord);
                            if (alt) return alt;   // 合法なら指定候補を採用 (消えていれば通常選択)
                        }
                    }
                    return list[0];
                };
                // 決定点の記録 (分岐候補の抽出用): 上位2件のスコア差が小さい所を後で試す
                const noteDecision = (t, list, chosenCand, isAbsorb) => {
                    if (!opts.trace || list.length < 2) return;
                    // 分岐先は「別のメンバー」を選ぶ。同一人物の別ロードアウトに振り替えても
                    // その人を消費する事実は変わらず、ボス横断の取りこぼし (貴重な人材を
                    // 代替可能なボスで使い切る) は解消しないため
                    const second = list.find(c => c.pick.id !== chosenCand.pick.id);
                    if (!second) return;
                    opts.trace.push({
                        key: decisionKey(t, isAbsorb),
                        wildKey: wildKey(t),
                        weakness: t.b.weakness,
                        gap: second.pickScore - chosenCand.pickScore,
                        chosenId: chosenCand.pick.id,
                        alt: { memberId: second.pick.id, slot: second.pickLo.slot || 1, ord: second.pickLo.ord ?? 0 },
                        altMemberAttrs: Object.keys(second.pick.avail || {}).length,
                        chosenMemberAttrs: Object.keys(chosenCand.pick.avail || {}).length,
                    });
                };
                // 候補を採用: 凸行を追加し、メンバー状態とボス残HPを更新する
                // 割当の内部メタ (出力に混ぜないため WeakMap/WeakSet で外部管理):
                //   loMeta = 使用したロードアウト参照 (undo で ord ごと avail へ戻す)
                const loMeta = new WeakMap();
                // ★ L1: 前回の約束として先に置いた凸。trimOverkill が参照するので**そこより前で宣言する**
                //   (後ろで宣言すると呼び出し順しだいで TDZ の ReferenceError になる。
                //    2026-08-08 に同じ形で「カードをタップすると落ちる」事故を起こしている)
                const stickyPlaced = new Set();
                const applyPick = (t, c) => {
                    const { pick, pickHour, pickFlex, pickLo, pickSlot } = c;
                    // pickDmg = 対象レベルで解決した測定値 (レベル別測定の使い分け)。
                    // 分岐ポリシー経由などで無ければ従来どおり最大値
                    const dmg = c.pickDmg ?? pickLo.dmg;
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
                    // 使用したロードアウトを除去 (同属性の別編成が残っていれば2凸目も提案可)。
                    // ★ 配列が無いことがある — 予約を**承認時のスナップショット**で置く経路は、
                    //   本人が現在その属性の編成を持っていなくても割り当てる (L2 / Codex指摘 2026-09-07)
                    const loArr = pick.avail[t.b.weakness];
                    if (loArr) {
                        const loIdx = loArr.indexOf(pickLo);
                        if (loIdx >= 0) loArr.splice(loIdx, 1);
                        if (loArr.length === 0) delete pick.avail[t.b.weakness];
                    }
                    pick.remainingAttacks--;
                    // 得意属性の消化管理: 必須を消化したら予約も1つ解放
                    // (自由枠の消費は remainingAttacks の減少で自然に反映される)
                    const justPushed = t.attacks[t.attacks.length - 1];
                    // 復元情報は WeakMap に置く: 凸オブジェクトに直接生やすと
                    // 📤配信の JSONB に内部メタが混入して配信データが膨らむ (Codex指摘)
                    loMeta.set(justPushed, pickLo);
                    t.rem -= dmg;
                };
                // 割当を1件取り消して、消費した状態 (キャラ・編成・残凸) を戻す。
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
                    // 元のロードアウト要素をそのまま戻し dmg降順 → slot昇順 → ord昇順 で並べ直す。
                    // ★ 並べ方は初期化時 (buildMemberState) と同一にすること。
                    //   片方だけ slot を見ると、undo した瞬間に並びが変わって別の編成が選ばれる
                    m.avail[w].push(loMeta.get(atk)
                        || { dmg: atk.dmgB, team: atk.team || [], slot: atk.loadoutSlot || 1,
                             levels: { '0': atk.dmgB }, ord: 0 });
                    m.avail[w].sort((a, b) => b.dmg - a.dmg
                        || (a.slot ?? 1) - (b.slot ?? 1) || (a.ord ?? 0) - (b.ord ?? 0));
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
                            // ★ L1: 前回の約束として先に置いた凸は外さない。
                            //   外すと「安定させるために置いたのに、オーバーキル圧縮で消える」
                            //   = その人だけ割当が消えて振り回すことになる (L1 の目的と正面から矛盾)
                            if (stickyPlaced.has(atk)) continue;
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
                // ===== L2: 承認済みの予約を**いちばん先に**置く =====
                // 予約は「運営が承認した約束」なので、L1 の sticky (前回の割当) より強い。
                // 置き方は sticky と同じ (applyPick を通す) が、違いが3つある:
                //   1. **時刻を尊重する** — 予約は時刻まで固定した約束。sticky は earliestHourFor に任せるが、
                //      予約は指定された枠にそのまま置く (⏳隙間型の予約は時刻を約束しないので従来どおり)
                //   2. **置けなかったことを黙って飲み込まない** — 実現できない予約は運営が解除する必要があるので、
                //      最終的なプランと突き合わせて `unmetReservations` として返す (下の集計)
                //   3. **温存 (Phase B) より優先される** — 先に置いてしまうので、Lv4 に回される余地がない。
                //      「ボス5に回した方が得」でも、約束を破ってよい理由にはならない (ユーザー方針)
                const placeReservation = (s) => {
                    if (Number(s.level) !== L) return;
                    const m = memberState.find(x => String(x.id) === String(s.memberId));
                    if (!m || m.remainingAttacks <= 0) return;
                    const t = targets.find(x => Number(x.b.boss_number) === Number(s.bossNumber));
                    if (!t || t.rem <= 0.0001) return;
                    const w = t.b.weakness;
                    const list = m.avail[w] || [];
                    const real = list.find(c => Number(c.slot) === Number(s.loadoutSlot)) || null;
                    // ★ 承認時のスナップショットが正 (ユーザー決定 2026-09-07)。
                    //   予約後に本人が編成を変えても、消しても、約束した編成とダメージで計画する。
                    //   スナップショットを持たない旧データだけ、現在の編成に落ちる
                    const hasSnap = Array.isArray(s.team) && s.team.length > 0 && Number(s.expectedB) > 0;
                    const cand = hasSnap
                        ? { dmg: Number(s.expectedB), team: s.team.slice(), slot: Number(s.loadoutSlot),
                            level: null, levels: { '0': Number(s.expectedB) }, ord: 0, fromReservation: true }
                        : real;
                    if (!cand) return;
                    const dmg = resolveDamage(cand);
                    if (dmg === null) return;
                    // ⚠ キャラ被りは候補列挙と同じ式。予約でもここは曲げない —
                    //   同じキャラを1日2回使う指示は物理的に実行できない
                    if (m.anyTeamRegistered && cand.team.length > 0
                        && cand.team.some(c => hasUsedChar(m.usedChars, c))) return;
                    // ★ 時刻: 約束した枠に置く。レベルが開く前の時刻は実行できないので置かない
                    //   (運営が解除して組み直す。ソルバーが勝手に後ろへずらすと約束の意味が消える)
                    let slot;
                    if (s.flex) {
                        slot = { idx: openIdx, flex: true };
                    } else {
                        const want = (s.timeSlot != null) ? IDX_BY_KEY.get(s.timeSlot) : undefined;
                        if (want == null) slot = earliestHourFor(m, openIdx);
                        else if (want < openIdx) return;   // 開放より前 = 実行できない
                        else slot = { idx: want, flex: false };
                    }
                    if (!slot) return;
                    // ★ スナップショットで置くときは、現在の同じ枠の編成を手で外す。
                    //   applyPick は渡した候補を avail から探して外すが、合成した候補は
                    //   その配列に居ないので外れない → 同じ枠が別のボスにもう一度使われる
                    if (hasSnap && real) {
                        const i = list.indexOf(real);
                        if (i >= 0) list.splice(i, 1);
                        if (list.length === 0) delete m.avail[w];
                    }
                    applyPick(t, {
                        pick: m, pickScore: 0, pickHour: slot.idx, pickFlex: slot.flex,
                        pickLo: cand, pickDmg: dmg, pickSlot: slot,
                    });
                    const placed = t.attacks[t.attacks.length - 1];
                    stickyPlaced.add(placed);   // 圧縮で外させない
                    // ★ 画面が「🔒予約」ピンを出すための印。予約で置いた凸にだけ付ける —
                    //   全凸に null で付けると配信 JSON と指紋テストの出力が変わる
                    placed.fromReservation = true;
                    placed.reservationId = s.reservationId ?? null;
                };
                if (Array.isArray(opts.reservations) && opts.reservations.length > 0) {
                    for (const s of opts.reservations) placeReservation(s);
                }
                // ===== L1: 前回配信で約束した割当を先に置く (sticky) =====
                // 「変えないと実現不能でない限り前回どおり」を実現する土台 (2026-09-07)。
                // ★ 置くのは **通常の凸とまったく同じ経路 (applyPick)**。残凸数・キャラ消費・
                //   編成消費・残HP・必須枠の扱いが貪欲の結果と1つもズレないようにするため。
                //   ここを独自実装にすると、後段の候補列挙やスコアと食い違って壊れる。
                // ★ 置けなかったもの (本人が3凸済み・撃破済みボス・キャラ被り・編成が消えた 等) は
                //   **黙って諦める**。約束は「守れるなら守る」であって、守れない形に歪めることではない。
                //   諦めた枠は後段の貪欲がそのまま埋める
                // ★ 時刻は earliestHourFor に任せる (貪欲と同じ)。盤面が動いていなければ前回と同じ枠が返るので
                //   実質的に時刻も保たれる。動いていれば現実に合わせる方が正しい
                if (Array.isArray(opts.sticky) && opts.sticky.length > 0) {
                    for (const s of opts.sticky) {
                        if (Number(s.level) !== L) continue;
                        const m = memberState.find(x => String(x.id) === String(s.memberId));
                        if (!m || m.remainingAttacks <= 0) continue;
                        const t = targets.find(x => Number(x.b.boss_number) === Number(s.bossNumber));
                        if (!t || t.rem <= 0.0001) continue;
                        const w = t.b.weakness;
                        const list = m.avail[w];
                        if (!list || list.length === 0) continue;
                        // 編成はスロットで特定する (同属性の別編成に化けさせない)
                        const cand = list.find(c => Number(c.slot) === Number(s.loadoutSlot));
                        if (!cand) continue;
                        const dmg = resolveDamage(cand);
                        if (dmg === null) continue;
                        // ⚠ キャラ被りの条件は listCandidatesFor と同じ式にすること
                        //   (片方だけ変えると「候補にならないのに置かれる」不整合になる)
                        if (m.anyTeamRegistered && cand.team.length > 0
                            && cand.team.some(c => hasUsedChar(m.usedChars, c))) continue;
                        // L2: 後のレベルの予約ぶんは前回どおり (sticky) でも使わない — 予約の方が強い
                        if ((m.remainingAttacks - (m.reservedLater || 0)) <= 0) continue;
                        if ((m.reservedLater || 0) > 0 && (m.reservedLaterSlots.has(`${w}|${Number(cand.slot) || 1}`)
                            || (cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.reservedLaterChars, c))))) continue;
                        const slot = earliestHourFor(m, openIdx);
                        if (!slot) continue;
                        applyPick(t, {
                            pick: m, pickScore: 0, pickHour: slot.idx, pickFlex: slot.flex,
                            pickLo: cand, pickDmg: dmg, pickSlot: slot,
                        });
                        stickyPlaced.add(t.attacks[t.attacks.length - 1]);
                    }
                }
                if (!absorbMode) {
                    // 踏破モード: ボスごとに残HPを削り切るまで投入
                    for (const t of targets) {
                        while (t.rem > 0.0001) {
                            const list = listCandidatesFor(t);
                            if (list.length === 0) break;
                            const c = pickFor(t, list);   // 列挙済みを渡す (二重列挙を避ける)
                            if (!c) break;
                            noteDecision(t, list, c, false);
                            applyPick(t, c);
                            // ★ 撃破時だけでなく毎回数え直す — 凸を1つ採るたびに usedChars が増え、
                            //   得意属性が「出せない」状態に変わりうる (上のコメント参照)
                        }
                        trimOverkill(t);   // 撃破を保ったまま不要な凸を外す (損失圧縮・凸を浮かせる)
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
                // trace は巻き戻さない: 破棄したのは「割当」であって「決定点」ではない。
                // 分岐は最初から解き直すので、同じ decisionKey (L|A|ボス|何凸目) には再び到達する。
                // むしろ踏破に失敗したレベルの決定点こそ横断分岐で救える本命 (テスト:
                // 「貴重な人材を代替可能なボスで使い切らない」はこの trace がないと解けない)
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
        // Lv4 (ボス5) に解決された予約。reservationList の確定後に入る (assignLv4 はその後にしか呼ばれない)
        let lv4Reservations = [];
        const assignLv4 = (pass) => {
            const lv4Weak = boss5.weakness;
            const lv4OpenIdx = pass.openIdx;   // ループ後の openIdx = Lv3 クリア想定時刻
            const memberState = pass.memberState;
            const lv4Attacks = [];
            for (const m of memberState) {
                // ===== L2: ボス5 (Lv4) の予約を先に置く (Codex指摘 2026-09-08) =====
                // 時刻が Lv3 踏破後の予約は Lv4 に解決される。ここで置かないと下の argmax が別の編成を先に使い、
                // 約束した編成が余ったまま未達にもならない (黙って壊れる)。置き方は有限レベルの placeReservation と同じ
                for (const r of lv4Reservations) {
                    if (String(r.memberId) !== String(m.id) || m.remainingAttacks <= 0) continue;
                    const list = m.avail[lv4Weak] || [];
                    const real = list.find(c => Number(c.slot) === Number(r.loadoutSlot)) || null;
                    const hasSnap = Array.isArray(r.team) && r.team.length > 0 && Number(r.expectedB) > 0;
                    const cand = hasSnap
                        ? { dmg: Number(r.expectedB), team: r.team.slice(), slot: Number(r.loadoutSlot),
                            level: null, levels: { '0': Number(r.expectedB) }, ord: 0, fromReservation: true }
                        : real;
                    if (!cand) continue;
                    const dmg = resolveDamage(cand);
                    if (dmg === null) continue;
                    if (m.anyTeamRegistered && cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.usedChars, c))) continue;
                    let slot;
                    if (!timeAware) slot = { idx: lv4OpenIdx, flex: false };
                    else if (r.flex) slot = { idx: lv4OpenIdx, flex: true };
                    else {
                        const want = (r.timeSlot != null) ? IDX_BY_KEY.get(r.timeSlot) : undefined;
                        if (want == null) slot = earliestHourFor(m, lv4OpenIdx);
                        else if (want < lv4OpenIdx) continue;   // 開放より前 = 置かない (unmetOf が before_open にする)
                        else slot = { idx: want, flex: false };
                    }
                    if (!slot) continue;
                    const teamRegistered = cand.team.length > 0;
                    lv4Attacks.push({
                        memberId: m.id, memberName: m.name,
                        slv: m.slv, slvEstimated: m.slvEstimated,
                        dmgB: dmg, usedB: dmg, overflowB: 0,   // 無限HP: 全額計上
                        team: teamRegistered ? cand.team : null,
                        hourIdx: timeAware ? slot.idx : null,
                        hourLabel: (timeAware && !slot.flex) ? hourLabelOf(slot.idx) : null,
                        flex: timeAware ? !!slot.flex : false,
                        timeUnknown: timeAware ? m.timeUnknown : false,
                        timeMismatch: false,
                        nearestHourLabel: null,
                        loadoutSlot: Number(r.loadoutSlot) || 1,
                        isBottleneck: false,
                        fromReservation: true,
                        reservationId: r.reservationId ?? null,
                    });
                    if (teamRegistered) cand.team.forEach(c => addUsedChar(m.usedChars, c));
                    if (real) {
                        const i = list.indexOf(real);
                        if (i >= 0) list.splice(i, 1);
                        if (list.length === 0) delete m.avail[lv4Weak];
                    }
                    m.remainingAttacks--;
                }
                // 同一人物でも別編成 (loadout slot) なら同属性に複数凸できる — 残凸数まで dmg 降順で割当。
                while (m.remainingAttacks > 0) {
                    const list = m.avail[lv4Weak];
                    if (!list || list.length === 0) break;
                    let lo = null, loDmg = null;
                    for (const cand of list) {
                        // ★ list の並びは静的 dmg 降順だが、代表値 (中央値) は順序が変わりうるので
                        //   先頭採用ではなく代表値の argmax を採る
                        const dmg = resolveDamage(cand);
                        if (dmg === null) continue;
                        if (m.anyTeamRegistered && cand.team.length > 0 && cand.team.some(c => hasUsedChar(m.usedChars, c))) continue;
                        if (!lo || dmg > loDmg) { lo = cand; loDmg = dmg; }
                    }
                    if (!lo) break;   // キャラ被りで出せる編成なし
                    // 開放時刻に出られない人も除外せずベストエフォート ⏳ で組み込む (有限ボスと同じ哲学)
                    const slot = earliestHourFor(m, lv4OpenIdx);
                    const teamRegistered = lo.team.length > 0;
                    lv4Attacks.push({
                        memberId: m.id, memberName: m.name,
                        slv: m.slv, slvEstimated: m.slvEstimated,
                        dmgB: loDmg, usedB: loDmg, overflowB: 0,   // 無限HP: 全額計上
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
        // 実現可能性の劣化量: 時刻を確約できない凸 (⚠時間外 / ⏳隙間) の重みつき本数。
        // 数字上 credited が増えても、これが増えた案は「実際には出せないかもしれない凸」で
        // 稼いでいるだけなので運用では改悪。ボス横断分岐と L1 の両方が同じ物差しを使う
        const riskOfPass = (pass) => pass.levels.flatMap(lv => lv.bosses.flatMap(x => x.attacks))
            .reduce((t, x) => t + (x.timeMismatch ? 2 : 0) + (x.flex ? 1 : 0), 0);

        // ===== L2: 承認済みの予約を正規化する =====
        // 入力は js/domain/reservations.js の toSolverConstraints が作った形
        // ({ reservationId, memberId, level, bossNumber, loadoutSlot, flex, timeSlot })。
        // ★ ここでも**安定ソート**する (投入順が入力の配列順に依存すると同じ盤面で違う指示が出る)
        const normalizeReservations = (list) => {
            const out = [];
            const seenIds = new Set();   // 同じ予約が二重に渡されても1回だけ置く (Codex指摘 2026-09-08)
            (Array.isArray(list) ? list : []).forEach(r => {
                if (!r || r.memberId == null) return;
                if (r.reservationId != null) {
                    if (seenIds.has(String(r.reservationId))) return;
                    seenIds.add(String(r.reservationId));
                }
                // ★ level null = メンバー発の予約 (2026-09-08)。どのレベルに置くかは resolveReservationLevels が時間軸から決める
                const level = (r.level == null) ? null : Number(r.level);
                const bossNumber = Number(r.bossNumber), loadoutSlot = Number(r.loadoutSlot);
                if (level !== null && (!Number.isInteger(level) || level < 1 || level > 3)) return;   // Lv4 は無限ボスなので拘束しない
                if (!Number.isInteger(bossNumber) || bossNumber < 1 || bossNumber > 5) return;
                if (!Number.isInteger(loadoutSlot) || loadoutSlot < 1 || loadoutSlot > MOCK_SLOT_MAX_STICKY) return;
                out.push({
                    reservationId: r.reservationId ?? null,
                    memberId: r.memberId, level, bossNumber, loadoutSlot,
                    flex: !!r.flex,
                    timeSlot: r.flex ? null : (r.timeSlot || null),
                    // ★ 承認時のスナップショット。**捨ててはいけない** (Codex指摘 2026-09-07)。
                    //   捨てて現在の模擬を見ると、予約後に本人が編成を変えたときに
                    //   「約束と違う編成で計画される」「編成を消したら予約が実行不能になる」が起きる。
                    //   ユーザー決定は「予約は守り、残り2凸を本人が調整する」
                    team: Array.isArray(r.team) ? r.team.filter(Boolean) : [],
                    expectedB: Number(r.expectedB) > 0 ? Number(r.expectedB) : 0,
                });
            });
            const idKey = (v) => String(v);
            out.sort((x, y) => ((x.level ?? 0) - (y.level ?? 0))
                || (x.bossNumber - y.bossNumber)
                || (idKey(x.memberId) < idKey(y.memberId) ? -1 : idKey(x.memberId) > idKey(y.memberId) ? 1 : 0)
                || (x.loadoutSlot - y.loadoutSlot));
            return out;
        };

        // 採用したプランに、予約が実際に入っているかを突き合わせる。
        // ★ 入らなかった予約は**運営が解除しないと枠を押さえたまま**になるので、必ず表に出す。
        //   理由は盤面から引き直す (置けなかった時点の理由をパスをまたいで持ち回るより、
        //   最終結果に対して1回判定する方が、どのパスが採用されても一貫する)
        const unmetOf = (chosen, list) => {
            if (!list || list.length === 0) return [];
            // ★ 突き合わせには**時刻も含める**。予約は時刻まで固定した約束なので、
            //   同じ人が同じボスに入っていても別の時刻なら「守れていない」。
            //   時間を見ないモード (timeAware=false) のときだけ時刻を無視する
            const tKeyOfAttack = (a) => !timeAware ? '-'
                : (a.flex ? 'flex' : (a.hourIdx == null ? '-' : String(a.hourIdx)));
            const tKeyOfRes = (r) => {
                if (!timeAware) return '-';
                if (r.flex) return 'flex';
                const want = (r.timeSlot != null) ? IDX_BY_KEY.get(r.timeSlot) : undefined;
                return want == null ? '-' : String(want);
            };
            const have = new Map();
            (chosen.levels || []).forEach(lv => {
                const level = Number(lv && lv.level) || 0;
                (lv.bosses || []).forEach(b => (b.attacks || []).forEach(a => {
                    const k = `${level}|${Number(b.bossNumber)}|${a.memberId}|${Number(a.loadoutSlot) || 1}|${tKeyOfAttack(a)}`;
                    have.set(k, (have.get(k) || 0) + 1);
                }));
            });
            const bossByNum = new Map((bosses || []).map(b => [Number(b.boss_number), b]));
            const playerById = new Map((players || []).map(p => [String(p.id), p]));
            const out = [];
            for (const r of list) {
                // Lv4 (ボス5) に解決した予約も突き合わせる — assignLv4 が約束の編成・時刻で置く (Codex指摘 2026-09-08)
                const k = `${r.level}|${r.bossNumber}|${r.memberId}|${r.loadoutSlot}|${tKeyOfRes(r)}`;
                const n = have.get(k) || 0;
                if (n > 0) { have.set(k, n - 1); continue; }
                // 入らなかった理由を盤面から引く (運営が次に何をすればいいかが分かる粒度で)。
                // ★ 理由はコード。日本語にするのは reservationsDomain.unmetText (画面で必ず通す — ユーザー決定 D)
                const p = playerById.get(String(r.memberId));
                const b = bossByNum.get(r.bossNumber);
                let reason = 'conflict';                       // キャラ被り・枠の取り合い
                let detail = null;
                const wantIdx = (!r.flex && r.timeSlot != null) ? IDX_BY_KEY.get(r.timeSlot) : null;
                const hasSnap = Array.isArray(r.team) && r.team.length > 0 && Number(r.expectedB) > 0;
                const lvOpenIdx = (L) => {
                    const lv = (chosen.levels || []).find(x => Number(x.level) === L);
                    return (lv && lv.openHourIdx != null) ? lv.openHourIdx : null;
                };
                if (!p) reason = 'member_gone';                // 参加対象から外れた (退会・今回は難しい)
                else if ((p.attackCount || 0) >= 3) reason = 'attacks_done';
                else if (!b) reason = 'boss_gone';
                else if (r.level == null) {                    // 時間軸のどのレベルにもそのボスがいない見込み (resolveReservationLevels)
                    reason = r.unresolvedReason || 'no_boss_at_time';
                    detail = r.unresolvedDetail || null;
                }
                else if (r.level < startLevel) reason = 'level_passed';
                else if (r.level === startLevel && ((b.remaining_hp_raw || 0) / 1e9) <= 0.0001) reason = 'boss_defeated';
                else if (r.level > startLevel && !(chosen.levels || []).some(lv => Number(lv.level) === r.level)) {
                    reason = 'level_unreached';                // そのレベルまで計画が届かない見込み
                }
                else if (timeAware && wantIdx != null && wantIdx < nowIdx) reason = 'time_passed';   // 約束の時刻を過ぎている
                else if (timeAware && wantIdx != null && lvOpenIdx(r.level) != null && lvOpenIdx(r.level) > wantIdx) {
                    reason = 'before_open';                    // 置く先のレベルが約束の時刻より後に開く見込み
                    detail = { level: r.level, openLabel: hourLabelOf(lvOpenIdx(r.level)) };
                }
                else if (!hasSnap && !(p.loadoutsByAttr && p.loadoutsByAttr[b.weakness]
                           && p.loadoutsByAttr[b.weakness].some(lo => Number(lo.slot) === r.loadoutSlot))) {
                    reason = 'loadout_gone';                   // 模擬の編成が消えた/差し替わった (写しも無い旧予約)
                }
                out.push({ reservationId: r.reservationId, memberId: r.memberId, memberName: p ? p.name : null,
                           level: r.level, bossNumber: r.bossNumber, loadoutSlot: r.loadoutSlot, reason, detail });
            }
            return out;
        };

        // ===== L2: レベルを持たない予約に、時間軸からレベルを与える (2026-09-08 ユーザー決定) =====
        // メンバーの約束は「この時刻に・この弱点のボスへ・この編成で」で、レベルは本人が選ばない
        // (ボスは全レベル共通で HP だけ違う)。レベルを選ばせると「どう計算しても13時に Lv3 へ届かないのに
        // 10時に Lv3 のボスを予約」= 計画が破綻するだけの予約が作れてしまう。
        //   ① レベル付きの予約 (締め凸依頼の了承) だけで1回解き、各レベルの「開放〜踏破」の見込み時刻を得る
        //   ② 固定時刻 T の予約は、T にそのボスがいるレベル (open(L) ≤ T < clear(L)) に置く。
        //      レベルの窓は連続している (次の開放 = 前の踏破) ので、T が現在以降なら必ずどこかの窓に入る。
        //      入らないのは 時刻を過ぎている / 有限レベルを全部踏破したあと (ボス5以外) /
        //      いまのレベルでそのボスがもう倒れていて、次のレベルは T には開かない見込み — のいずれか
        //   ③ ⏳隙間型は、いま開いているレベルでそのボスが生きていればそこ、倒れていれば次のレベル
        //   ④ 予約を置くと時間軸が少しずれるので、②③の結果を入れて解き直し、もう1回だけ引き直す。
        //      収束を待つより、それでもずれたら未達として運営に見せる方が正直
        // ★ 「置けない」は黙らせない: レベルが決まらない予約は level=null のまま残し、unmetOf が理由つきで返す。
        //   コストは runPass 2回 (ボス横断分岐に比べれば小さい)。レベル無しの予約が無ければ何もしない
        const resolveReservationLevels = (list) => {
            const free = list.filter(r => r.level === null);
            if (free.length === 0) return list;
            const leveled = list.filter(r => r.level !== null);
            const idKey = (v) => String(v);
            const sortKey = (arr) => arr.slice().sort((x, y) => ((x.level ?? 0) - (y.level ?? 0)) || (x.bossNumber - y.bossNumber)
                || (idKey(x.memberId) < idKey(y.memberId) ? -1 : idKey(x.memberId) > idKey(y.memberId) ? 1 : 0)
                || (x.loadoutSlot - y.loadoutSlot));
            const bossAliveNow = (bn) => {
                const b = (bosses || []).find(x => Number(x.boss_number) === Number(bn));
                return !!b && ((b.remaining_hp_raw || 0) / 1e9) > 0.0001;
            };
            const nextLevelFor = (bn) => (bossAliveNow(bn) ? startLevel : startLevel + 1);
            const windowsOf = (pass) => (pass.levels || []).filter(lv => !lv.infinite).map(lv => ({
                level: Number(lv.level),
                open: timeAware ? (lv.openHourIdx ?? nowIdx) : nowIdx,
                clear: (timeAware && lv.levelCleared && lv.clearHourIdx != null) ? lv.clearHourIdx : (LAST_IDX + 1),
                cleared: !!lv.levelCleared,
            }));
            const assign = (wins) => free.map(r => {
                const out = { ...r };
                delete out.unresolvedReason; delete out.unresolvedDetail;
                const T = (!r.flex && r.timeSlot != null) ? IDX_BY_KEY.get(r.timeSlot) : null;
                if (r.flex || T == null || !timeAware) {
                    // 時刻を約束しない (⏳) / 時刻が読めない / 時間を見ないモード: いま出てくる最初のレベルへ
                    const L = nextLevelFor(r.bossNumber);
                    if (L > 3) { out.level = null; out.unresolvedReason = 'boss_defeated'; }
                    else out.level = L;
                    return out;
                }
                if (T < nowIdx) { out.level = null; out.unresolvedReason = 'time_passed'; return out; }
                const w = wins.find(x => T >= x.open && T < x.clear) || null;
                if (!w) {
                    // 有限レベルを全部踏破したあと = ボス5 (Lv4・無限) しかいない
                    const last = wins.length ? wins[wins.length - 1] : null;
                    if (Number(r.bossNumber) === 5 && last && last.cleared) { out.level = 4; return out; }   // 拘束にはしない
                    out.level = null; out.unresolvedReason = 'no_boss_at_time';
                    out.unresolvedDetail = last ? { level: last.level, killedLabel: last.cleared ? hourLabelOf(last.clear) : null } : null;
                    return out;
                }
                if (w.level === startLevel && !bossAliveNow(r.bossNumber)) {
                    // いまのレベルではもう倒れていて、次のレベルは T には開かない見込み
                    out.level = null; out.unresolvedReason = 'no_boss_at_time';
                    out.unresolvedDetail = { level: w.level, killed: true, nextOpenLabel: w.cleared ? hourLabelOf(w.clear) : null };
                    return out;
                }
                out.level = w.level;
                return out;
            });
            const usable = (rs) => sortKey(rs.filter(r => r.level !== null && r.level >= 1 && r.level <= 3));
            let pass = runPass(leveled.length ? { reservations: sortKey(leveled) } : {});
            let resolved = assign(windowsOf(pass));
            try {
                pass = runPass({ reservations: usable([...leveled, ...resolved]) });
                resolved = assign(windowsOf(pass));
            } catch { /* 1回目の割当で進む */ }
            return sortKey([...leveled, ...resolved]);
        };

        // ===== 本人のホームの空き枠に出す「なぜ選ばれなかったか」 (2026-09-08・ユーザー決定 D) =====
        // 残り凸があるのに割当が無い人ごとに理由を1つ。日本語にするのは reservationsDomain.UNASSIGNED_JP。
        // ★ 目安であって判定ではない (貪欲の途中経過までは追わない)。「なぜ2枚しか無いのか」が本人に伝わればよい
        const leftoverReasonOf = (m, pass) => {
            if (m.noSubmission) return 'no_loadout';
            const lists = Object.values(m.avail || {}).filter(l => Array.isArray(l) && l.length > 0);
            if (lists.length === 0) return 'cards_used_up';
            const usable = lists.flat().filter(c => hasDamage(c)
                && !(m.anyTeamRegistered && c.team.length > 0 && c.team.some(x => hasUsedChar(m.usedChars, x))));
            if (usable.length === 0) return 'char_conflict';
            const attrs = new Set(Object.keys(m.avail || {}).filter(k => (m.avail[k] || []).some(c => usable.includes(c))));
            const frontier = pass.frontierLevel;
            const lv4 = (pass.levels || []).some(lv => lv.infinite);
            const targetsLeft = (frontier != null) || (lv4 && !!boss5 && attrs.has(boss5.weakness));
            if (!targetsLeft) return 'not_needed';
            if (timeAware && m.hourIdxs !== null && !m.flexTime) {
                const fl = frontier != null ? (pass.levels || []).find(lv => Number(lv.level) === frontier) : null;
                const openOf = fl && fl.openHourIdx != null ? fl.openHourIdx : (pass.openIdx ?? nowIdx);
                if (!m.hourIdxs.some(i => i >= openOf)) return 'time';
            }
            return 'not_needed';
        };

        // ===== L1: 前回プランを「拘束」に正規化する =====
        // 配信済みプラン (published_plans.plan) から、人ごとの約束を取り出す。
        // ★ 投入順は **仕様化したキーで安定ソート** する。DB の返却順や配列順に依存させると
        //   「同じ盤面でも押すたびに違う指示」になり、配信の前提が崩れる (Codex指摘 2026-09-07)
        const normalizeSticky = (prev) => {
            const out = [];
            const levels = Array.isArray(prev && prev.levels) ? prev.levels : [];
            levels.forEach(lv => {
                const level = Number(lv && lv.level);
                if (!Number.isInteger(level) || level < 1 || level > 3) return;   // Lv4 は無限ボスなので拘束しない
                (Array.isArray(lv.bosses) ? lv.bosses : []).forEach(b => {
                    const bossNumber = Number(b && b.bossNumber);
                    if (!Number.isInteger(bossNumber)) return;
                    (Array.isArray(b.attacks) ? b.attacks : []).forEach(a => {
                        if (!a || a.memberId == null) return;
                        // ★ スロットは「欠けている」ときだけ 1 に補う (Codex指摘 2026-09-07)。
                        //   `Number(x) || 1` だと 0 や "bad" まで 1 に化け、本来無効な行が
                        //   別の人の編成①を拘束して正しい割当を妨げる
                        let loadoutSlot = 1;
                        if (a.loadoutSlot != null && a.loadoutSlot !== '') {
                            const n = Number(a.loadoutSlot);
                            if (!Number.isInteger(n) || n < 1 || n > MOCK_SLOT_MAX_STICKY) return;   // 壊れた行は捨てる
                            loadoutSlot = n;
                        }
                        out.push({ memberId: a.memberId, level, bossNumber, loadoutSlot });
                    });
                });
            });
            // ★ 並べ替えは**ロケール非依存**にする (Codex指摘 2026-09-07)。
            //   localeCompare は端末の言語設定で順序が変わり、"z" と "ä" のような ID で
            //   投入順が変わる = 同じ盤面でも端末ごとに違う指示が出る
            const idKey = (v) => String(v);
            out.sort((x, y) => (x.level - y.level)
                || (x.bossNumber - y.bossNumber)
                || (idKey(x.memberId) < idKey(y.memberId) ? -1 : idKey(x.memberId) > idKey(y.memberId) ? 1 : 0)
                || (x.loadoutSlot - y.loadoutSlot));
            return out;
        };

        // 解の中で「約束が実際に守られた本数」を数える。
        // ★ 拘束解が常に約束を多く守るとは限らない — 約束を先に置くと貪欲の途中状態がずれ、
        //   別の約束が置けなくなることがある (圧縮で戻るはずの枠が戻らない・温存パスの判断が変わる)。
        //   通常解のほうが多く守れているなら、拘束解を採る理由は無い
        const countStickyKept = (chosen, list) => {
            const have = new Map();   // "level|boss|memberId|slot" -> 件数
            (chosen.levels || []).forEach(lv => {
                const level = Number(lv && lv.level) || 0;
                (lv.bosses || []).forEach(b => (b.attacks || []).forEach(a => {
                    const k = `${level}|${Number(b.bossNumber)}|${a.memberId}|${Number(a.loadoutSlot) || 1}`;
                    have.set(k, (have.get(k) || 0) + 1);
                }));
            });
            let kept = 0;
            for (const s of list) {
                const k = `${s.level}|${s.bossNumber}|${s.memberId}|${s.loadoutSlot}`;
                const n = have.get(k) || 0;
                if (n > 0) { have.set(k, n - 1); kept++; }
            }
            return kept;
        };

        // ===== L1: 拘束解と通常解のどちらを採るか =====
        // 辞書順で判定する (既存のボス横断分岐と同じ序列に合わせてある):
        //   ① 通常解の方が踏破レベルが上 → 無条件で通常解 (約束より攻略を優先)
        //   ② 拘束解の方が時刻を確約できない凸が多い → 通常解 (出られない凸で約束しても意味がない)
        //   ③ 通常解の credited 改善が閾値以上 → 通常解
        //   ④ それ以外 → 拘束解 (= 前回の約束を守る)
        // ★ 比較対象は「前回プラン」ではなく **同じ盤面を拘束なしで解いた通常解**。
        //   前回からHPも実凸も進んでいるので、前回の数字とは比べられない
        // ★ 判定は人ごとではなく全体で行う。「A を動かして B を守る」価値は個別火力では測れない
        const preferNormalOver = (stickyChosen, normalChosen, list) => {
            const cn = sumCreditedOf(normalChosen), cs = sumCreditedOf(stickyChosen);
            const gapB = cn - cs;
            const thresholdB = Math.max(STICKY_GAIN_RATIO * cn, STICKY_MIN_GAIN_B);
            if (normalChosen.fullyClearedThrough > stickyChosen.fullyClearedThrough) {
                return { normal: true, reason: 'clearLevel', gapB, thresholdB };
            }
            if (riskOfPass(stickyChosen) > riskOfPass(normalChosen)) {
                return { normal: true, reason: 'timeRisk', gapB, thresholdB };
            }
            // ★ 拘束解が約束を守れていないなら採る意味がない。
            //   盤面が1つも動いていないとき通常解は前回そのものなので、ここで必ず通常解が選ばれ、
            //   「同じ盤面で組み直したら人が入れ替わった」が起きなくなる (安定性ベンチ ①)
            if (countStickyKept(stickyChosen, list) < countStickyKept(normalChosen, list)) {
                return { normal: true, reason: 'lessKept', gapB, thresholdB };
            }
            if (gapB >= thresholdB - 1e-9) {
                return { normal: true, reason: 'creditedGain', gapB, thresholdB };
            }
            return { normal: false, reason: 'kept', gapB, thresholdB };
        };

        // ===== シナリオ実行: probe (温存なし) → 温存パス (Lv4 が見える時のみ) =====
        // policy を渡すと指定の決定点だけ2番手を採る = ボス横断の分岐 (フェーズ2)。
        // 分岐は最終結果を部分修正せず「最初から全パスを再実行」する — 温存の機会費用・
        // Lv4開放時刻の収束・時間伝播・必須予約をすべて同じ規則で評価し直すため
        // passOpts: 全パスに素通しで渡す追加オプション (L1 の sticky など)。
        // ここで受けて runPass へ広げることで、「拘束あり/なし」を同じパイプラインで2回解ける
        const solveScenario = (policy, traceOut, passOpts = null) => {
        // trace はパスごとに独立させ、最後に「採用したパス」の分だけを呼び出し元へ返す。
        // probe 固定だと、温存パスが採用されたとき別パスの決定点を分岐候補にしてしまう
        const probeTrace = traceOut ? [] : null;
        const probe = runPass({ ...(passOpts || {}), decisionPolicy: policy, trace: probeTrace });
        const lv4Open = probe.fullyClearedThrough >= 3 && !!(boss5 && boss5.weakness);
        let chosen = probe;
        let chosenTrace = probeTrace;
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
            // ボス5で見込める与ダメ: 弱点属性の残ロードアウトの **Lv4解決値** 降順
            // 上位 min(残凸, 編成数) 件の合計。キャラ被りは概算では無視する (厳密には Lv4 割当時に判定)
            const potentialOf = (vals, slots) => {
                if (!vals || slots <= 0) return 0;
                let s = 0;
                const n = Math.min(slots, vals.length);
                for (let i = 0; i < n; i++) s += vals[i];
                return s;
            };
            // 機会費用 = この凸を有限ボスに使うことで減る「ボス5で入るはずだった与ダメ」。
            // 弱点属性の凸は編成そのものを失い、他属性の凸もスロット逼迫時
            // (残凸数 <= 弱点属性の編成数) にはボス5に入れる回数を1つ失う。
            // どちらも potential の差分として1つの式で正しく出る
            const lv4ValsOf = (list) => list
                .map(x => resolveDamage(x))
                .filter(v => v !== null)
                .sort((a, b) => b - a);
            const oppCostOf = (m, attr, lo) => {
                if (!canAttackAfterT3(m)) return 0;
                const list = m.avail[lv4Weak] || [];
                const before = potentialOf(lv4ValsOf(list), m.remainingAttacks);
                const after = (attr === lv4Weak)
                    ? potentialOf(lv4ValsOf(list.filter(x => x !== lo)), m.remainingAttacks - 1)
                    : potentialOf(lv4ValsOf(list), m.remainingAttacks - 1);
                return Math.max(0, before - after);
            };
            // 温存で大火力を踏破から外すと Lv3 クリア時刻が後ろにずれることがある。
            // 前提にした T3 より実際の開放が遅いと「開放時刻に出られない人」を誤って温存して
            // しまうため、実クリア時刻が前提以下に収まるまで T3 を引き上げて引き直す
            // (T3 は単調増加・時間帯は有限なので必ず止まるが、安全のため3回で打ち切り)
            let reserved = null, reserveTrace = null, reservedTrace = null;
            for (let iter = 0; iter < 3; iter++) {
                if (traceOut) reserveTrace = [];
                const attempt = runPass({
                    ...(passOpts || {}),
                    oppCostOf,
                    decisionPolicy: policy,
                    trace: reserveTrace,
                });
                if (attempt.fullyClearedThrough < 3) { reserved = null; break; }   // 温存で踏破が崩れた
                if (attempt.openIdx <= T3) { reserved = attempt; reservedTrace = reserveTrace; break; }   // 前提どおり → 採用候補
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
                    chosenTrace = reservedTrace;   // 採用したパスの決定点を分岐候補にする
                }
            }
        }
            // 候補は「採用したパス」を優先しつつ probe の決定点も残す。
            // policy はキーで決定点を指すだけなので、出所が別パスでも再計算時に有効に効く。
            // 非悪化ガードが最終防波堤なので、候補は多いほど拾える改善が増える
            if (traceOut) {
                const seen = new Set();
                for (const d of [...(chosenTrace || []), ...(probeTrace || [])]) {
                    const k = `${d.key}|${d.alt}`;
                    if (seen.has(k)) continue;
                    seen.add(k);
                    traceOut.push(d);
                }
            }
            return { probe, chosen, lv4Open, reservePassUsed };
        };

        // ===== 解法パイプライン一式 (基準解 + ボス横断分岐) =====
        // L1 (2026-09-07) で **同じ盤面を「拘束あり」と「拘束なし」で2回解く** ようになったため、
        // インラインだったこの一連を関数にした。passOpts 以外は以前と同じ処理。
        // ★ passOpts を渡さなければ従来と1ビットも変わらない出力になること
        //   (tests/solver-fingerprint.mjs で固定してある)
        const solveWhole = (passOpts = null) => {
        // --- 基準解 (現行アルゴリズム) ---
        const baseTrace = [];
        const baseScenario = solveScenario(null, baseTrace, passOpts);   // 現行アルゴリズムの解 (下限として守る)
        let scenario = baseScenario;
        let optimization = { explored: 0, improvedB: 0, applied: false };

        // --- フェーズ2: ボス横断の限定分岐 ---
        // 貪欲は「そのボスで最良」を選ぶため、別ボスでしか使えない人材を先に消費してしまう
        // (例: 両属性に出せる残1凸の人を、代替がいるボスで使い切り、別ボスが倒せない)。
        // 僅差だった決定点で2番手を採るシナリオを少数だけ試し、全体が良くなる案があれば採用する。
        if (input.crossBoss !== false && baseTrace.length > 0) {
            // 実現可能性の劣化を数える: 時刻を確約できない凸 (⚠時間外 / ⏳隙間) が増えた案は、
            // 数字上 credited が増えても「実際には出せないかもしれない凸」で稼いでいるだけ。
            // 運用では改悪なので、まず実現可能性で足切りしてから credited を比べる
            const riskOf = (r) => riskOfPass(r.chosen);
            // 同じリスク量でも「確約できない凸を先に置く」案は避ける。
            // 先の凸ほどレベル開放を律速するので、実際に出られないと後続が全部ずれる
            const riskOrderOf = (r) => {
                let penalty = 0, i = 0;
                r.chosen.levels.forEach(lv => lv.bosses.forEach(b => b.attacks.forEach(x => {
                    i++;
                    if (x.timeMismatch || x.flex) penalty += 1 / i;   // 早い凸ほど重い
                })));
                return penalty;
            };
            const cmp = (a, b) => {
                // 採否は辞書順: 踏破レベル → 実現可能性 → 総与ダメ → 損失の少なさ
                if (a.chosen.fullyClearedThrough !== b.chosen.fullyClearedThrough) {
                    return b.chosen.fullyClearedThrough - a.chosen.fullyClearedThrough;
                }
                const ra = riskOf(a), rb = riskOf(b);
                if (ra !== rb) return ra - rb;
                const ca = sumCreditedOf(a.chosen), cb = sumCreditedOf(b.chosen);
                if (Math.abs(ca - cb) > 1e-9) return cb - ca;
                // ここから下は credited が同点のときのタイブレーク。
                // 確約できない凸を「先に」置く案は避ける (早い凸ほどレベル開放を律速するため)
                const oa = riskOrderOf(a), ob = riskOrderOf(b);
                if (Math.abs(oa - ob) > 1e-9) return oa - ob;
                const wasteOf = (r) => r.chosen.levels.flatMap(lv => lv.bosses.flatMap(x => x.attacks))
                    .reduce((t, x) => t + x.overflowB, 0);
                return wasteOf(a) - wasteOf(b);
            };
            // 分岐候補: 「僅差」かつ「選ばれた人の方が出せる属性が多い(=希少)」決定点を優先。
            // 貴重な人材を代替可能なボスで使ってしまった疑いが濃い順
            const candsOf = (trace, fixed) => {
                const out = [], seen = new Set();
                // pickFor の候補判定と同じ厳密比較にそろえる (文字列化すると 1 と '1' を同一視する)
                const sameAlt = (a, b) => !!a && !!b
                    && a.memberId === b.memberId && a.slot === b.slot && a.ord === b.ord;
                for (const d of trace) {
                    if (d.gap >= 8 || d.altMemberAttrs <= 0) continue;
                    const regret = (d.chosenMemberAttrs - d.altMemberAttrs) * 10 - d.gap;
                    // 同じ決定点について「このレベルだけ」と「全レベル一括」の2案を出す。
                    // 一括の方をわずかに優先する (連鎖する取り合いはまとめて直る方が効く)
                    for (const [k, bonus] of [[d.wildKey, 0.5], [d.key, 0]]) {
                        if (!k || fixed.has(k) || seen.has(k)) continue;
                        // レベル別キーは一括キーの「別名」でもある: 一括を同じ代替で固定済みなら
                        // レベル別を重ねても解が変わらない (pickFor はレベル別を優先するが指す先が同じ)。
                        // 空振りのシナリオで探索枠を使わないよう除外する。
                        // 代替が違うなら「一括の上でこのレベルだけ別の人に回す」有効な絞り込みなので残す。
                        // ※これは純粋な効率化で結果は変わらない (乱数2500盤面で差分0を確認済み)。
                        //   挙動テストは書けないので、変えるときは tests/bench-crossboss.mjs の
                        //   改善件数が落ちないことで見ること
                        const wildFixed = k !== d.wildKey ? fixed.get(d.wildKey) : null;
                        if (sameAlt(wildFixed, d.alt)) continue;
                        seen.add(k);
                        out.push({ key: k, alt: d.alt, regret: regret + bonus });
                    }
                }
                return out.sort((x, y) => y.regret - x.regret).slice(0, MAX_BRANCH);
            };
            // 1決定点だけの分岐では弱い (貴重な人材の取り合いは複数のボスに連鎖するため)。
            // 改善した分岐の上にさらに分岐を重ねる = 深さ MAX_DEPTH の貪欲な反復深化。
            // 各ラウンドは「その時点の最良解」の決定点から選び直すので、
            // 前のラウンドで解消された決定点を無駄に試さない
            const MAX_SCENARIOS = scenarioBudgetFor((players || []).length);
            let policy = new Map();
            let bestTrace = baseTrace;
            for (let depth = 0; depth < MAX_DEPTH; depth++) {
                let best = null, bestPolicy = null, bestNextTrace = null;
                for (const d of candsOf(bestTrace, policy)) {
                    // MAX_SCENARIOS は「解いたシナリオ総数」の上限。基準解も1つ数える
                    if (optimization.explored + 1 >= MAX_SCENARIOS) break;
                    optimization.explored++;
                    const p2 = new Map(policy).set(d.key, d.alt);
                    const t2 = [];
                    let alt;
                    try { alt = solveScenario(p2, t2, passOpts); } catch { continue; }
                    // 不変条件: 分岐は「基準解より総与ダメを減らさない」ものだけ採用する。
                    // 実現可能性 (⚠時間外/⏳隙間) を優先しすぎると credited が大きく落ちる案を
                    // 選んでしまうため、まず credited の非悪化を絶対条件にする
                    if (sumCreditedOf(alt.chosen) < sumCreditedOf(baseScenario.chosen) - 1e-9) continue;
                    // 実現可能性を犠牲にした案は採らない: 確約できない凸 (⚠時間外/⏳隙間) が
                    // 基準解より増えるなら、数字が伸びても運用では改悪 (当日出られない人に賭ける形)。
                    // 「予期せぬことが起きても再算出で回る」ことを優先する
                    if (riskOf(alt) > riskOf(baseScenario)) continue;
                    // 同じリスク量でも「確約できない凸をより早い順番に置く」案は採らない。
                    // 早い凸ほどレベル開放を律速するので、出られなかったとき後続が全部ずれる
                    if (riskOrderOf(alt) > riskOrderOf(baseScenario) + 1e-9) continue;
                    if (cmp(alt, scenario) < 0 && (!best || cmp(alt, best) < 0)) {
                        best = alt; bestPolicy = p2; bestNextTrace = t2;
                    }
                }
                if (!best) break;   // このラウンドで改善なし → これ以上深くしても無駄
                optimization.improvedB = sumCreditedOf(best.chosen) - sumCreditedOf(baseScenario.chosen);
                optimization.applied = true;
                optimization.depth = depth + 1;
                scenario = best; policy = bestPolicy; bestTrace = bestNextTrace;
                if (optimization.explored + 1 >= MAX_SCENARIOS) break;
            }
        }
        return { scenario, optimization };
        };

        // ===== L1: 前回配信で約束した割当を守る (安定化・2026-09-07) =====
        // 第44回の反省は「当日のプラン再生成でメンバーを振り回した」こと。ソルバーは毎回ゼロから
        // 組み直すので、盤面が少し動くだけで無関係な人の割当まで入れ替わっていた。
        // **同じ盤面を「前回どおりを先に置いた解」と「拘束なしの通常解」で2回解き、辞書順で選ぶ**。
        // ★ input.previousPlan を渡さなければ従来と1ビットも変わらない出力になること
        //   (tests/solver-fingerprint.mjs が固定している)
        // ===== L2: 承認済みの予約 (ソルバーを拘束する唯一の層) =====
        // ★ 予約は**通常解にも拘束解にも同じように効く**。L1 の二者比較は
        //   「前回の割当を尊重するか」だけを比べるものなので、予約は両方に入れる
        // ★ レベルの無い予約は先に時間軸からレベルを決める (2026-09-08)。決まらなかったものは level=null のまま
        //   unmetOf へ回り、拘束には入れない (Lv4 に解決したものも拘束にしない = ボス5は無限で全員入る)
        const reservationList = resolveReservationLevels(normalizeReservations(input.reservations));
        // Lv1〜3 は runLevel の先置き、Lv4 (ボス5) は assignLv4 の先置きで守る。
        // ★ 取り置き (reservedLater) は Lv4 の予約ぶんも見るので、拘束リストには Lv4 も入れる
        const constraintList = reservationList.filter(r => r.level !== null && r.level >= 1 && r.level <= 4);
        lv4Reservations = reservationList.filter(r => r.level === 4);
        const passBase = constraintList.length > 0 ? { reservations: constraintList } : null;

        const stickyList = normalizeSticky(input.previousPlan);
        const solvedNormal = solveWhole(passBase);
        let scenario = solvedNormal.scenario;
        let optimization = solvedNormal.optimization;
        let stability = null;
        if (stickyList.length > 0) {
            let solvedSticky = null;
            // 拘束解で例外が出ても通常解で配信できる方が安全 (安定化は「あれば嬉しい」もの)
            try { solvedSticky = solveWhole({ ...(passBase || {}), sticky: stickyList }); } catch { solvedSticky = null; }
            if (solvedSticky) {
                const verdict = preferNormalOver(solvedSticky.scenario.chosen, scenario.chosen, stickyList);
                stability = {
                    applied: !verdict.normal,
                    reason: verdict.reason,
                    stickyCount: stickyList.length,
                    creditedGapB: Math.round(verdict.gapB * 1000) / 1000,
                    thresholdB: Math.round(verdict.thresholdB * 1000) / 1000,
                };
                if (!verdict.normal) {
                    scenario = solvedSticky.scenario;
                    optimization = solvedSticky.optimization;
                }
            } else {
                stability = { applied: false, reason: 'error', stickyCount: stickyList.length, creditedGapB: 0, thresholdB: 0 };
            }
        }
        const { probe, chosen, lv4Open, reservePassUsed } = scenario;
        const unmetReservations = unmetOf(chosen, reservationList);
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
        // 残り凸があるのに割当が無い人 → 本人のホームの空き枠に理由を出す (2026-09-08)
        // 置けなかった予約のために取り置いた凸は「予約のために残しています」(取り置きはレベル付きの予約だけ)
        const heldFor = new Set(unmetReservations.filter(u => u.level != null).map(u => String(u.memberId)));
        const unassigned = memberState.filter(m => m.remainingAttacks > 0).map(m => ({
            memberId: m.id, memberName: m.name, remaining: m.remainingAttacks,
            reason: heldFor.has(String(m.id)) ? 'reserved' : leftoverReasonOf(m, chosen),
        }));

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
        // key = 集計用の分類 / label = その短い表示名 (reason は人向けの説明文のまま)
        const UNUSED_LABELS = {
            noSubmission: '模擬未提出',
            attrsExhausted: '出せる属性なし',
            lv4NoLoadout: 'ボス5弱点の編成なし',
            lv4NoWeak: 'ボス5弱点が未提出',
            conflict: 'キャラ被り',
            level: '測定Lv不足',
            surplus: '余剰戦力',
            time: '時間帯なし',
            noAliveAttr: '生存ボスの属性が未提出',
            hpExhausted: 'ボスHP尽き',
        };
        const lastPlanned = levels[levels.length - 1];
        const lastAliveWeak = new Set(
            (lastPlanned?.bosses || []).filter(b => b.targetHpB > 0.0001).map(b => b.weakness)
        );
        const planFullyCleared = fullyClearedThrough >= 3;
        const unusedDetail = memberState
            .filter(m => m.remainingAttacks > 0)
            .map(m => {
                const attrs = Object.keys(m.avail);
                let reason, key;
                if (m.noSubmission) {
                    key = 'noSubmission';
                    reason = '模擬未提出 (提出があれば候補に入る)';
                } else if (attrs.length === 0) {
                    key = lv4Open ? 'lv4NoLoadout' : 'attrsExhausted';
                    reason = lv4Open
                        ? 'ボス5(無限)の弱点属性の編成が残っていない (未提出 or 使い切り)'
                        : '出せる属性の残りなし (提出属性を使い切り)';
                } else if (lv4Open) {
                    // Lv4 割当後も凸が残る = 弱点属性は avail に有るが出せなかった。
                    // 「キャラ被り」と「測定レベル不足」は打ち手が全く違う (前者は編成を足す /
                    // 後者は Lv4 で測り直す) ので、運営が読んで動けるよう区別する
                    const b5 = m.avail[boss5.weakness];
                    if (!attrs.includes(boss5.weakness)) {
                        key = 'lv4NoWeak';
                        reason = 'ボス5(無限)の弱点属性が未提出 (提出すれば全額スコアに入る)';
                    } else if ((b5 || []).some(lo => hasDamage(lo))) {
                        key = 'conflict';
                        reason = 'キャラ被り (同キャラは1日1回) でボス5に出せる編成なし';
                    } else {
                        key = 'level';
                        reason = 'ボス5(無限)の編成が Lv4 未満で測定されている (Lv4で測り直すと出せる)';
                    }
                } else if (planFullyCleared) {
                    key = 'surplus';
                    reason = 'Lv3まで完走想定のため出番なし (余剰戦力)';
                } else if (timeAware && earliestHourFor(m, openIdx) === null) {
                    key = 'time';
                    reason = '停止レベルの開放時刻以降に戦闘可能時間がない';
                } else {
                    // 停止レベルの生存ボスに対して実際に出せるか判定
                    const lastLv = Number(lastPlanned?.level) || 1;
                    let conflictOnly = true;
                    let anyAliveAttr = false;
                    // ★ 「レベル不足」と言えるのは、生存ボスの属性の**どれも**そのレベルで
                    //   出せないときだけ。1属性でも在庫があれば本当の原因はキャラ被りの側。
                    //   属性ごとのフラグにすると「A属性はレベル不足・B属性は被り」で
                    //   レベル不足と誤診断する (Codex指摘 2026-08-10)
                    let anyInLevel = false;
                    for (const k of attrs) {
                        if (!lastAliveWeak.has(k)) continue;
                        anyAliveAttr = true;
                        const inLevel = m.avail[k].filter(lo => hasDamage(lo));
                        if (inLevel.length === 0) continue;
                        anyInLevel = true;
                        const usable = inLevel.some(lo =>
                            !(m.anyTeamRegistered && lo.team.length > 0 && lo.team.some(c => hasUsedChar(m.usedChars, c))));
                        if (usable) { conflictOnly = false; break; }
                    }
                    if (!anyAliveAttr) { key = 'noAliveAttr'; reason = '残っている生存ボスの属性を未提出'; }
                    else if (!anyInLevel) { key = 'level'; reason = `編成の測定レベルが Lv${lastLv} に届かない (Lv${lastLv}以上で測り直すと出せる)`; }
                    else if (conflictOnly) { key = 'conflict'; reason = 'キャラ被り (同キャラは1日1回) で出せる編成なし'; }
                    else { key = 'hpExhausted'; reason = 'ボスHPが尽きた (割当先なし)'; }
                }
                return { name: m.name, remaining: m.remainingAttacks, reason, key, label: UNUSED_LABELS[key] || key };
            });
        // 理由別の合計 (留意点の1行目に「未消化 25凸 — 模擬未提出 12 · キャラ被り 7 …」と出す用)。
        // 人単位の unusedDetail は残し、運営が「何を先に手当てするか」を開かずに読めるようにする (2026-09-05)
        const unusedSummary = (() => {
            const groups = new Map();
            for (const d of unusedDetail) {
                const g = groups.get(d.key) || { key: d.key, label: d.label, attacks: 0, members: [] };
                g.attacks += d.remaining;
                g.members.push({ name: d.name, remaining: d.remaining });
                groups.set(d.key, g);
            }
            // 凸数の多い順 → キー順で決定的に
            return [...groups.values()].sort((a, b) => (b.attacks - a.attacks) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        })();

        const candidateCount = memberState.length;
        // 「完了想定時刻」は最後の有限レベルから取る (Lv4 は無限なのでクリア時刻を持たない)
        const lastFinite = [...levels].reverse().find(lv => !lv.infinite);
        // 総与ダメ想定 (credited): 有限ボスは min(dmg, 残HP)、ボス5(無限) は全額
        const totalCreditedB = allAttacks.reduce((s, a) => s + a.usedB, 0);
        const lv4Level = levels.find(lv => lv.infinite);
        const lv4CreditedB = lv4Level ? lv4Level.bosses[0].creditedB : 0;
        return {
            startLevel, fullyClearedThrough, levels, totalAttacks, totalWaste,
            unusedAttacks, unusedSummary, membersNoData, onlyAvailableNow, currentSlot, candidateCount,
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
            // L2: 承認済みの予約のうち、このプランに入らなかったもの。
            // **運営が解除しないとその人の枠を押さえたまま**になるので必ず出す
            unmetReservations,
            reservationCount: reservationList.length,
            // 残り凸があるのに割当が無い人と、その理由 (コード。画面は reservationsDomain.UNASSIGNED_JP で日本語に)
            unassigned,
            // L1 安定化の結果 (previousPlan を渡したときだけ非 null)。
            // applied=true = 前回の約束を守った / false = 守るより明確に良かったので組み直した。
            // reason: clearLevel=踏破が上がる / timeRisk=確約できない凸が増える /
            //         creditedGain=与ダメ改善が閾値超 / kept=約束を守った / error=拘束解で例外
            stability,
        };
    }

    /**
     * 済んだ凸を時間割の軸 (hourIdx) に載せる (2026-09-11 ユーザー要望
     * 「すでに凸報告があった終わった凸が表示された方が全体の流れが追えていい」)。
     *
     * ★ プランに焼き込まない — 配信済みプランに混ぜると、配信した時点の凸で固定されてしまう。
     *   描くときに毎回いまの凸記録から作る。
     * ★ 時刻が読めない凸は捨てない。hourIdx=null で返し、呼び出し側が「時間不明」として扱う
     *   (捨てると「報告したのに出てこない」になる)
     *
     * @param {Object[]} attacks   凸記録 (reported_at / boss_number / player_id / damage_raw / level)
     * @param {number[]} hourOrder 時間割の並び (HOUR_ORDER)
     * @param {(iso:string)=>number|null} hourOf ISO → その日の「時」(JST)。呼び出し側が渡す
     * @returns {{byHourBoss: Map<string, Object[]>, unknownTime: Object[], total: number}}
     *   byHourBoss のキーは `${hourIdx}:${bossNumber}`
     */
    function doneAttacksByHour(attacks, hourOrder, hourOf) {
        const byHourBoss = new Map();
        const unknownTime = [];
        let total = 0;
        for (const a of Array.isArray(attacks) ? attacks : []) {
            if (!a || a.boss_number == null) continue;
            total += 1;
            const boss = Number(a.boss_number);
            // ★ 空の時刻を hourOf に渡さない。new Date(null) は 1970-01-01 として通ってしまい、
            //   「時刻が無い凸」が表の 9 時に紛れ込む (2026-09-11 に実際に踏んだ)
            const at = typeof a.reported_at === 'string' ? a.reported_at.trim() : '';
            const h = (at && typeof hourOf === 'function') ? hourOf(at) : null;
            const idx = (h == null || !Array.isArray(hourOrder)) ? -1 : hourOrder.indexOf(h);
            if (idx < 0) { unknownTime.push(a); continue; }
            const k = `${idx}:${boss}`;
            if (!byHourBoss.has(k)) byHourBoss.set(k, []);
            byHourBoss.get(k).push(a);
        }
        return { byHourBoss, unknownTime, total };
    }

    root.doneAttacksByHour = doneAttacksByHour;
    root.computeOptimalPlanCore = computeOptimalPlanCore;
})(typeof window !== 'undefined' ? window : globalThis);
