// ============================================================================
// ドメイン: 属性 (リアーキ ステップ1 — ARCHITECTURE-AUDIT.md §4-1)
// ----------------------------------------------------------------------------
// このアプリには意味の違う「属性」が3つあり、全て裸文字列で混同事故を起こしてきた:
//   boss.attribute = ボス自身の属性 (表示の基準。色・アイコンはこれ)
//   boss.weakness  = 弱点 = 持っていくPT属性 (凸・編成・採用率はこれ)
//   BOSS_ATTRIBUTES[code].attribute = 旧月次JSON用の「PT想定属性」(大文字。weakness と同義)
// このモジュールが変換の唯一の置き場所。画面側で相性表を持って逆算することを禁じる。
// (DB書き込み側の発生源は supabase-client.js の supabaseCreateSeason — そちらが正)
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {'fire'|'water'|'electric'|'iron'|'wind'} AttrKey
     *   アプリ内の属性キーの正規形 (小文字)。比較タブ系の旧定数は大文字 ('WATER') を
     *   使うため、境界では必ず normalizeAttrKey() を通すこと。
     * @typedef {Object} BossLike
     * @property {string=} attribute ボス自身の属性 (表示基準)
     * @property {string=} weakness  弱点 = 持っていくPT属性 (凸・編成基準)
     */

    /** @type {AttrKey[]} 属性キーの正規リスト (小文字・この順が表示順) */
    const ATTR_KEYS = ['fire', 'water', 'electric', 'iron', 'wind'];

    // ゲームの相性 (2周期): ボス属性 → そのボスに持っていくPT属性 (=弱点)
    const WEAKNESS_BY_BOSS_ATTR = { wind: 'fire', fire: 'water', water: 'electric', electric: 'iron', iron: 'wind' };
    // 逆写像: PT属性 → そのPTが刺さるボスの属性
    const BOSS_ATTR_BY_WEAKNESS = { fire: 'wind', water: 'fire', electric: 'water', iron: 'electric', wind: 'iron' };

    /**
     * 任意の属性表記を正規形 (小文字 AttrKey) に。未知の値は null。
     * 大文字ドメイン (BOSS_ATTRIBUTES / 比較タブ) との境界では必ずこれを通す。
     * @param {unknown} v
     * @returns {AttrKey|null}
     */
    function normalizeAttrKey(v) {
        if (typeof v !== 'string') return null;
        const k = v.trim().toLowerCase();
        return ATTR_KEYS.includes(k) ? /** @type {AttrKey} */ (k) : null;
    }

    /**
     * ボス行 → 持っていくPT属性 (弱点)。
     * DB に保存済みの weakness が正。無い行 (旧データ等) だけ attribute から相性で導出する。
     * 画面側はこの関数だけを使い、相性表を直接持たないこと。
     * @param {BossLike|null|undefined} boss
     * @returns {AttrKey|null}
     */
    function weaknessPtOf(boss) {
        if (!boss) return null;
        return normalizeAttrKey(boss.weakness)
            || WEAKNESS_BY_BOSS_ATTR[normalizeAttrKey(boss.attribute)]
            || null;
    }

    /**
     * ボス行 → ボス自身の属性 (表示基準)。attribute が正、無ければ weakness から逆算。
     * @param {BossLike|null|undefined} boss
     * @returns {AttrKey|null}
     */
    function bossAttributeOf(boss) {
        if (!boss) return null;
        return normalizeAttrKey(boss.attribute)
            || BOSS_ATTR_BY_WEAKNESS[normalizeAttrKey(boss.weakness)]
            || null;
    }

    root.ATTR_KEYS = ATTR_KEYS;
    root.normalizeAttrKey = normalizeAttrKey;
    root.weaknessPtOf = weaknessPtOf;
    root.bossAttributeOf = bossAttributeOf;
})(typeof window !== 'undefined' ? window : globalThis);
