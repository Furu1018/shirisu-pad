// ============================================================================
// ドメイン: ダメージ数値の変換・整形 (リアーキ ステップ2 — ARCHITECTURE-AUDIT.md §4-2)
// ----------------------------------------------------------------------------
// raw値 (1B = 1e9) と B単位表示の変換を一元化する。
// index.html には `Number(x)/1e9` や `.toFixed(2).replace(/\.?0+$/,'')` のインライン
// 変換が多数散在している — 既存箇所は触った機会に置き換え、新規コードは必ずこちらを使う。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /** raw値 (1e9 = 1B) → B単位の数値。数値化できなければ 0 */
    function rawToB(raw) {
        const n = Number(raw);
        return Number.isFinite(n) ? n / 1e9 : 0;
    }

    /** raw値 → 'XX.XXB' 表示 (旧 formatDamage と同一挙動: null/NaN は '-'、負値は符号つき) */
    function formatDamageRaw(v) {
        if (v == null || isNaN(v)) return '-';
        const sign = v < 0 ? '-' : '';
        return sign + (Math.abs(v) / 1e9).toFixed(2) + 'B';
    }

    /** B単位の数値 → 末尾ゼロを落とした文字列 ('22.50'→'22.5', '5.00'→'5')。入力欄の初期値用 */
    function trimZeroB(b) {
        if (b == null || isNaN(b)) return '';
        return Number(b).toFixed(2).replace(/\.?0+$/, '');
    }

    root.formatDomain = { rawToB, formatDamageRaw, trimZeroB };
})(typeof window !== 'undefined' ? window : globalThis);
