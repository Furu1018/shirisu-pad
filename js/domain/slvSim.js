// ============================================================================
// ドメイン: SLv シミュレーター (分析タブ › シミュレーター › ダメージ予測)
// ----------------------------------------------------------------------------
// SLv 補正テーブル (data/slv-ratio.json の data: { "1": 738, ... }) を使った 2 つの計算。
//   predictDamage : いまの SLv → 目標 SLv にしたときの予測ダメージ (比例: damage × ratio(目標) / ratio(いま))
//   requiredSlv   : 目標ダメージに届く**最小の SLv** (逆引き・2026-09-13 ユーザー要望「〇〇ダメージ上げるのに必要な SLv」)
// テーブルは単調増加なので二分探索 (★ 存在するキーの列の上で探す — 欠番を「未達」と読むと述語が単調でなくなる: Codex指摘)。
// 目標が最大 SLv でも届かなければ unreachable。
// アプリ状態は読まず全て引数で受ける (optimal-plan.js と同じ規約: IIFE + root 直付け)。
// ============================================================================
(function (root) {
    'use strict';
    const ratioOf = (table, slv) => {
        const v = table && table[String(slv)];
        return Number.isFinite(v) && v > 0 ? v : null;
    };
    /** @returns {number|null} 予測ダメージ (raw)。テーブルに無い SLv なら null */
    function predictDamage({ damage, curSlv, targetSlv, table } = {}) {
        const cur = ratioOf(table, curSlv), tgt = ratioOf(table, targetSlv);
        if (!(Number.isFinite(damage) && damage > 0) || cur == null || tgt == null) return null;
        return damage * (tgt / cur);
    }
    /**
     * 目標ダメージに届く最小の SLv。
     * @returns {{ok:true, slv:number, delta:number, predicted:number} | {ok:false, reason:'unreachable', maxSlv:number, maxPredicted:number} | null}
     *   null = 計算できない (材料が無い)。delta = 目標 SLv − いまの SLv (下げても届くなら負)
     */
    function requiredSlv({ damage, curSlv, targetDamage, table, maxSlv } = {}) {
        const cur = ratioOf(table, curSlv);
        if (!(Number.isFinite(damage) && damage > 0) || !(Number.isFinite(targetDamage) && targetDamage > 0) || cur == null) return null;
        const max = Number.isInteger(maxSlv) && maxSlv >= 1 ? maxSlv : Math.max(...Object.keys(table || {}).map(Number).filter(Number.isFinite));
        if (!Number.isFinite(max) || max < 1) return null;
        const pred = (slv) => { const r = ratioOf(table, slv); return r == null ? null : damage * (r / cur); };
        // 存在する SLv (1..max) の昇順の列。欠番はそもそも候補にしない
        const keys = Object.keys(table || {}).map(Number).filter(k => Number.isInteger(k) && k >= 1 && k <= max && ratioOf(table, k) != null).sort((a, b) => a - b);
        if (keys.length === 0) return null;
        const topSlv = keys[keys.length - 1], top = pred(topSlv);
        if (top < targetDamage) return { ok: false, reason: 'unreachable', maxSlv: topSlv, maxPredicted: top };
        // 二分探索: pred(keys[i]) >= target となる最小の i (テーブルは単調増加)
        let lo = 0, hi = keys.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (pred(keys[mid]) >= targetDamage) hi = mid; else lo = mid + 1;
        }
        const slv = keys[lo];
        return { ok: true, slv, delta: slv - Number(curSlv), predicted: pred(slv) };
    }
    root.slvSimDomain = { predictDamage, requiredSlv };
})(typeof window !== 'undefined' ? window : globalThis);
