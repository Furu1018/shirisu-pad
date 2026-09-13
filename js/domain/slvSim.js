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
    /**
     * 締め凸の置き換え (2026-09-13 ユーザー要望): 撃破した凸 (isKill) は残HP分しか記録されないので、その凸だけ
     * 「3分間戦闘した結果」(模擬の提出 / 手入力) に置き換えた合計を出す。
     * @param {Object} a
     * @param {Object[]} a.attacks            その人の凸 ({damage, bossCode, isKill})
     * @param {(attack:Object)=>number|null} a.valueFor  置き換える raw ダメージ (無ければ null = 記録のまま)
     * @param {(attack:Object)=>boolean=} a.isKill 締め凸の判定 (既定: isKill === true)
     * @returns {{ delta:number, kills:number, replaced:number, subs:[{index:number, bossCode:*, recorded:number, used:number, replaced:boolean}] }}
     *   delta = Σ(置き換えた値 − 記録) — 合計 (totalDamage) に足すぶん。締め凸でない凸は触らない
     */
    function totalWithKillSubs({ attacks, valueFor, isKill } = {}) {
        const kill = typeof isKill === 'function' ? isKill : (a) => !!(a && a.isKill === true);
        const val = typeof valueFor === 'function' ? valueFor : () => null;
        const subs = []; let delta = 0, kills = 0, replaced = 0;
        (Array.isArray(attacks) ? attacks : []).forEach((a, index) => {
            if (!a || !kill(a)) return;
            kills += 1;
            const recorded = Number(a.damage) || 0;
            const v = val(a);
            const ok = Number.isFinite(v) && v > 0;
            if (ok) { replaced += 1; delta += v - recorded; }
            subs.push({ index, bossCode: a.bossCode, recorded, used: ok ? v : recorded, replaced: ok });
        });
        return { delta, kills, replaced, subs };
    }
    root.slvSimDomain = { predictDamage, requiredSlv, totalWithKillSubs };
})(typeof window !== 'undefined' ? window : globalThis);
