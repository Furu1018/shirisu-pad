// ============================================================================
// ドメイン: 模擬スロットのレベル別測定値 (levels JSONB — 31_player_damages_levels.sql)
// ----------------------------------------------------------------------------
// 「1スロット = 1編成」で、スロットの中にレベル別の測定値を複数持つ (2026-08-12 再設計)。
//   levels = { "0": 14.2, "4": 12.5 }   キー: "0"=レベル未指定(全レベルで使える)〜"4"
//                                       値: B単位ダメージ (正の有限数のみ)
// 不変条件 (書き込み側 = supabase-client.js の _upsertPlayerDamages が唯一の維持点):
//   damage_b   = levels の最大値 (レベル無視の従来表示・ランキング等の互換)
//   boss_level = その最大値を出した測定のキー ("0"→null)。互換ミラー —
//                31 未適用環境や旧クライアントは「ベスト測定1件」として現行どおり動く
// 使用ルール (30_player_damages_level.sql のユーザー決定と同じ):
//   記録レベル L の測定は対象レベル ≤ L でのみ使える。"0" は全レベルで使える。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM/Supabase 非依存で node からテスト可:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    // キャラ照合キー / 編成同一判定は optimal-plan.js:188/224 と同一実装。
    // (両モジュールとも依存ゼロの IIFE のため二重化を許容 — 乖離は run-tests.mjs の
    //  一致フィクスチャテストで検知する。変更するときは必ず両方同時に)
    const charKey = (c) => (typeof c === 'string' ? c : '')
        .normalize('NFKC').trim().toLowerCase();
    const sameTeam = (a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return false;
        const sa = a.map(charKey).sort(), sb = b.map(charKey).sort();
        return sa.every((v, i) => v === sb[i]);
    };

    /** レベル値 (int|null|undefined|不正) → levels のキー文字列 '0'〜'4'。不正は '0' に倒す */
    function levelKey(v) {
        // Number(true)===1 で真偽値が Lv1 に化けるため型を先に見る (30 実装時の教訓)
        if (typeof v !== 'number' && typeof v !== 'string') return '0';
        const n = Number(v);
        return (Number.isInteger(n) && n >= 1 && n <= 4) ? String(n) : '0';
    }

    /**
     * levels の正規化。キー '0'〜'4'・正の有限数の値だけを通す。
     * levels が無い/空/全滅なら (damageB, bossLevel) の1測定として読む (移行互換)。
     * 有効な測定が1つも無ければ null。
     * @returns {Object<string, number>|null}
     */
    function normLevels(levels, damageB, bossLevel) {
        const out = {};
        if (levels && typeof levels === 'object' && !Array.isArray(levels)) {
            for (const k of ['0', '1', '2', '3', '4']) {
                const v = Number(levels[k]);
                if (Number.isFinite(v) && v > 0) out[k] = v;
            }
        }
        if (Object.keys(out).length > 0) return out;
        const d = Number(damageB);
        if (Number.isFinite(d) && d > 0) return { [levelKey(bossLevel)]: d };
        return null;
    }

    /**
     * 互換ミラーの計算: 最大値の測定 (= damage_b / boss_level に写す)。
     * 同値タイは '0' (全レベル可) > 高レベル の順で選ぶ — より広く使える側に倒す
     * (ミラーしか読めない環境で「使えるのに使えない」を作らないため)。
     * @returns {{level: number|null, value: number}|null}
     */
    function maxEntry(levels) {
        if (!levels) return null;
        let best = null;
        for (const k of ['0', '4', '3', '2', '1']) {   // タイブレーク優先順に走査
            const v = levels[k];
            if (!(Number.isFinite(v) && v > 0)) continue;
            if (best === null || v > best.value) {
                best = { level: k === '0' ? null : Number(k), value: v };
            }
        }
        return best;
    }

    /**
     * 提出の**代表ダメージ**。測定ボスレベルの概念は廃止した (2026-09-06 ユーザー決定)。
     *
     * ★ 廃止の根拠: 「Lv1で測った値をLv3に流用すると過大評価」という想定を実データが否定した。
     *   同一編成でレベル違いを測った提出6件すべてが Lv1比 96〜105% (風圧 55.1→56.6→56.2→56.9B /
     *   電撃 33.4→33.4→33.4B)、実凸90件のSLv補正集計でもレベル上昇による低下傾向なし。
     *   この想定でソルバーが候補を絞った結果、第44回は未消化49凸になった。
     *
     * ★ 複数値の代表は**中央値**。最大値だと試行のブレの上振れを固定してしまう。
     *   新規保存は単一値なので、複数キーを持つのは廃止前の既存データだけ。
     *   (既存の levels は書き換えず読み取りだけで畳む — 移行の巻き戻し余地を残すため)
     * @param {Object<string,number>|null} levels 正規化済み levels
     * @returns {number|null} 有効な値が無ければ null
     */
    function representativeDamage(levels) {
        if (!levels) return null;
        const vals = Object.keys(levels)
            .map(k => Number(levels[k]))
            .filter(v => Number.isFinite(v) && v > 0)
            .sort((a, b) => a - b);
        if (vals.length === 0) return null;
        const mid = Math.floor(vals.length / 2);
        // 偶数個は中央2つの平均。1件ならその値がそのまま返る
        return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    }

    /**
     * 対象レベル L で使える最良値。使える測定 = キー '0' または キー ≥ L。
     * @deprecated 測定レベルの概念は廃止 (2026-09-06)。新しい経路は representativeDamage を使う。
     *   バックアップ復元など、廃止前のデータをそのまま読む必要がある箇所のためだけに残している
     * @param {Object<string,number>|null} levels 正規化済み levels
     * @param {number} targetLevel 1〜4
     * @returns {number|null} 使える値が無ければ null
     */
    function bestAtLevel(levels, targetLevel) {
        if (!levels) return null;
        let best = null;
        for (const k of Object.keys(levels)) {
            const kn = Number(k);
            if (kn !== 0 && kn < targetLevel) continue;
            const v = levels[k];
            if (Number.isFinite(v) && v > 0 && (best === null || v > best)) best = v;
        }
        return best;
    }

    /**
     * 測定の取り込み: 既存行 (levels/damage_b/boss_level/characters) に
     * 新しい測定 {damageB, level, characters?} をマージし、保存すべき行の形を返す。
     * - incoming.characters があり既存編成と別編成なら levels をリセット
     *   (編成が変わったら過去の測定は無効 — 古いレベルタグの残留バグを構造的に防ぐ)
     * - 既存行に編成が無い (出所不明の測定) 場合も、編成付きの提出が来たら仕切り直す —
     *   別編成の値を新しい編成に相続させない (Codexレビュー指摘)
     * - 同一編成 (または characters 未指定 = 編成不変) なら該当レベルキーだけ更新
     * @returns {{levels: Object<string,number>, damage_b: number, boss_level: number|null, teamChanged: boolean}|null}
     */
    function mergeMeasurement(existing, incoming) {
        const d = Number(incoming && incoming.damageB);
        if (!(Number.isFinite(d) && d > 0)) return null;
        const exChars = Array.isArray(existing && existing.characters) ? existing.characters : [];
        const inChars = Array.isArray(incoming && incoming.characters) ? incoming.characters : null;
        const teamChanged = !!(inChars && inChars.length > 0
            && (exChars.length === 0 || !sameTeam(inChars, exChars)));
        const base = teamChanged
            ? {}
            : (normLevels(existing && existing.levels, existing && existing.damage_b, existing && existing.boss_level) || {});
        const levels = { ...base, [levelKey(incoming.level)]: d };
        const m = maxEntry(levels);
        return { levels, damage_b: m.value, boss_level: m.level, teamChanged };
    }

    /**
     * 複数レベルの測定をまとめて取り込む (Lv1〜Lv4 を一度に登録するフォーム用)。
     * ★ entries は「保存後に残っていてほしい測定の全体」。フォームが空欄にしたレベルは
     *   消える = 画面に見えているものがそのまま保存結果になる、という素直な意味にする。
     *   1件ずつの mergeMeasurement と違い、既存の levels とはマージしない。
     * - 編成が変わった場合は既存を捨てる点だけ mergeMeasurement と同じ
     * - 有効な値が1件も無ければ null (呼び出し側で「測定なし」として扱う)
     * @param {Object} existing 既存行 {levels, damage_b, boss_level, characters}
     * @param {{entries: Object<string|number, number>, characters?: string[]}} incoming
     * @returns {{levels: Object<string,number>, damage_b: number, boss_level: number|null, teamChanged: boolean}|null}
     */
    function mergeMeasurements(existing, incoming) {
        const src = (incoming && incoming.entries) || {};
        const levels = {};
        Object.keys(src).forEach(k => {
            // ★ 範囲外のキーは**捨てる** (levelKey に通さない)。
            //   levelKey は不明な値を '0' = 「未指定 = 全レベルで使える」に倒すので、
            //   フォームの打ち間違いが一番緩い設定に化けてしまう
            const key = String(k);
            if (!['0', '1', '2', '3', '4'].includes(key)) return;
            const d = Number(src[k]);
            if (Number.isFinite(d) && d > 0) levels[key] = d;
        });
        if (Object.keys(levels).length === 0) return null;
        const exChars = Array.isArray(existing && existing.characters) ? existing.characters : [];
        const inChars = Array.isArray(incoming && incoming.characters) ? incoming.characters : null;
        const teamChanged = !!(inChars && inChars.length > 0
            && (exChars.length === 0 || !sameTeam(inChars, exChars)));
        const m = maxEntry(levels);
        return { levels, damage_b: m.value, boss_level: m.level, teamChanged };
    }

    root.mockLevelsDomain = {
        charKey,
        sameTeam,
        levelKey,
        normLevels,
        maxEntry,
        representativeDamage,
        bestAtLevel,
        mergeMeasurement,
        mergeMeasurements,
    };
})(typeof window !== 'undefined' ? window : globalThis);
