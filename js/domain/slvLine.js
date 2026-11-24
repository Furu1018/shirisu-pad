// ============================================================================
// ドメイン: SLv 順のグラフの「中央値の線」(分析 › 📊 実績・2026-11-25 ふるり)
// ----------------------------------------------------------------------------
// 「その SLv の“ふつう”(中央値) の人なら 3 凸でこれくらい」を SLv ごとに出す。
//   線の値 = 凸数 (3) × 1 凸の中央値の norm × ratio(SLv)
//   norm = ダメージ ÷ ratio(その人の SLv) (SLv の係数で割った値 = SLv をそろえた 1 凸の強さ)。ratio は本家の slv-ratio テーブル (呼び出し側が渡す)
// ・ユニオン: 各メンバーの 属性ごとのベストの 1 凸 (締め凸を除く) の norm → 属性ごとの中央値 → 属性で平均
//   (しりすこPAD GB の書き出しの集め方 = 1 端末 1 票の属性ごとのベスト・締め凸を除く、に合わせる)
// ・GB: 書き出しの属性ごとの 1 凸の中央値 (gbCompareDomain.buildIndex の attackMedianFururi・baseDamage) を
//   GB比較と同じ換算 normFromFururi で norm に → 属性で平均
// ★ 中央値からの見積もりで、期待値ではない (属性の組み合わせ・締め凸・ボスの残り HP は見ない)。
// アプリ状態は読まず全て引数で受ける。DOM 非依存で node からテストできる (tests/run-tests.mjs)。
// ============================================================================
(function (root) {
    'use strict';

    const ratioOf = (table, slv) => { const r = Number(table?.[String(slv)]); return Number.isFinite(r) && r > 0 ? r : null; };
    const median = (xs) => {
        const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
        if (!a.length) return null;
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

    // ユニオンの 1 凸の中央値 (norm)。players = [{ slv, attacks: [{ attr, damage, kill }] }] (呼び出し側で整える: attr は PT 属性の大文字・damage は生の値)。
    //   minN = 属性ごとに数える人数の下限 (少なすぎる属性は平均に入れない)。
    //   戻り値: { norm, attrs: { ATTR: { median, n } } } (平均に使った属性だけ) / 材料が無ければ null
    function unionNorm({ players, ratioTable, minN = 3 }) {
        const by = {};
        for (const p of players || []) {
            const r = ratioOf(ratioTable, p?.slv);
            if (!r) continue;
            const best = {};
            for (const a of p.attacks || []) {
                const d = Number(a?.damage);
                if (!a?.attr || a.kill || !(d > 0)) continue;
                const n = d / r;
                if (!(best[a.attr] >= n)) best[a.attr] = n;
            }
            for (const [attr, n] of Object.entries(best)) (by[attr] = by[attr] || []).push(n);
        }
        const attrs = {};
        for (const [attr, xs] of Object.entries(by)) if (xs.length >= minN) attrs[attr] = { median: median(xs), n: xs.length };
        const meds = Object.values(attrs).map(x => x.median);
        return meds.length ? { norm: mean(meds), attrs } : null;
    }

    // GB の 1 凸の中央値 (norm)。index = gbCompareDomain.buildIndex の戻り値 / baseSlv = 書き出しの base.baseSlv / normFromFururi = gbCompareDomain.normFromFururi。
    //   戻り値: { norm, attrs: { ATTR: { median, n } } } / 材料が無ければ null
    function gbNorm({ index, ratioTable, baseSlv, normFromFururi }) {
        const rb = ratioOf(ratioTable, baseSlv);
        if (!rb || typeof normFromFururi !== 'function') return null;
        const attrs = {};
        for (const [attr, a] of Object.entries(index?.attrs || {})) {
            const v = normFromFururi(Number(a?.attackMedianFururi), Number(a?.baseDamage), rb);
            if (Number.isFinite(v) && v > 0) attrs[attr] = { median: v, n: Number(a?.attackN) || 0 };
        }
        const meds = Object.values(attrs).map(x => x.median);
        return meds.length ? { norm: mean(meds), attrs } : null;
    }

    // その SLv の線の値 (生の値)。SLv が表に無ければ null (線を切る)
    function lineAt(norm, ratioTable, slv, attacks = 3) {
        const r = ratioOf(ratioTable, slv);
        return (Number.isFinite(norm) && norm > 0 && r) ? attacks * norm * r : null;
    }

    root.slvLineDomain = { unionNorm, gbNorm, lineAt, median };
})(typeof window !== 'undefined' ? window : globalThis);
