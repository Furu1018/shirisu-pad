// ============================================================================
// ドメイン: GB比較 (しりすこPAD GB のシーズン確定スナップショットとの突合せ)
// ----------------------------------------------------------------------------
// data/gb-export/<season>.json (GB リポジトリの凍結エクスポート) を入力に、
//  1) メンバー凸の「GB中央値=100%」換算
//  2) 編成の 人気/強い/強い且つ人気 絞り込み
//  3) 3凸セット最適化 (15キャラ被りなし・同属性2凸可)
// の計算だけを行う。アプリ状態 (currentData/slvRatioTable) は読まず全て引数で受ける。
//
// 単位の約束 (Codex設計監査 2026-08-05):
//  - エクスポートの中央値は「ふるり値」単位 (GB公開情報のみ)。
//  - norm (実ダメージ÷SLv係数) への換算: norm = fururi × baseDamage ÷ ratio(baseSlv)。
//    ratio は本家ローカルの slv-ratio テーブル (呼び出し側が渡す)。
//  - 3凸最適化の目的関数は Σ(fururi × baseDamage_attr) — norm合計と定数倍で同値なので
//    slv-ratio 無しで順序が正しい (ふるり値の直接合算は属性基準差で歪むため不可)。
//    ※ 中央値ベースの推定であり期待値ではない。ボス残HPの上限も考慮しない。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {Object} GbComp  エクスポート内の1編成
     *   {string[]} names  5キャラの日本語名 (name が null のメンバーは呼び出し側で除外済み想定)
     *   {number} n        採用人数 (>=5)
     *   {number} medianFururi
     */

    // ---- 換算 ----

    // ふるり値中央値 → norm (実ダメージ ÷ SLv係数)。ratioBase = ratio(GB基準SLv)
    function normFromFururi(medianFururi, baseDamage, ratioBase) {
        if (![medianFururi, baseDamage, ratioBase].every(x => Number.isFinite(x) && x > 0)) return null;
        return medianFururi * baseDamage / ratioBase;
    }

    // メンバー凸の GB中央値比% (中央値=100)。ratioPlayer = ratio(メンバーのSLv)
    function memberPct(damageRaw, ratioPlayer, normMedian) {
        if (![damageRaw, ratioPlayer, normMedian].every(x => Number.isFinite(x) && x > 0)) return null;
        return (damageRaw / ratioPlayer) / normMedian * 100;
    }

    // ---- エクスポートの検証・整形 ----

    // エクスポートJSONを検証して属性→編成リストの索引に整える。
    // bossCodeMap = {ATTR: 本家のbossCode} — 一致しない属性は捨てる (フェイルクローズ)。
    // 戻り値: { season, attrs: {ATTR: {bossCode, baseDamage, attackN, attackMedianFururi,
    //          comps: [{names, n, medianFururi, key}]}}, dropped: [警告文] }
    function buildIndex(exportJson, bossCodeMap) {
        const dropped = [];
        const out = { season: exportJson?.season ?? null, attrs: {}, dropped };
        if (!exportJson || exportJson.schemaVersion !== 1 || !exportJson.attributes) {
            dropped.push('エクスポートの形式が不明 (schemaVersion≠1)');
            return out;
        }
        for (const [attr, a] of Object.entries(exportJson.attributes)) {
            const baseA = exportJson.base?.attributes?.[attr];
            const wantCode = bossCodeMap?.[attr];
            if (!baseA || !wantCode || baseA.bossCode !== wantCode) {
                dropped.push(`${attr}: ボスコード不一致 (GB=${baseA?.bossCode ?? '?'} / 本家=${wantCode ?? '?'}) — 除外`);
                continue;
            }
            const comps = (Array.isArray(a.comps) ? a.comps : [])
                .map(c => {
                    const names = (Array.isArray(c.members) ? c.members : []).map(m => m?.name).filter(Boolean);
                    return { names, n: c.n, medianFururi: c.medianFururi, key: [...names].sort().join('|') };
                })
                .filter(c => {
                    const ok = c.names.length === 5 && new Set(c.names).size === 5 &&
                        Number.isFinite(c.n) && Number.isFinite(c.medianFururi);
                    if (!ok) dropped.push(`${attr}: 名前未解決/不正な編成を除外 (${c.names.join(',') || '?'})`);
                    return ok;
                });
            out.attrs[attr] = {
                bossCode: baseA.bossCode,
                baseDamage: baseA.baseDamage,
                attackN: a.attackBenchmark?.n ?? 0,
                attackMedianFururi: a.attackBenchmark?.medianFururi ?? null,
                compCohortN: a.compCohortN ?? 0,
                comps,
            };
        }
        return out;
    }

    // ---- 絞り込み (人気 / 強い / 強い且つ人気) ----
    // 隠し合成スコアにせず明示条件 (Codex設計監査):
    //   popular = 採用数順 / strong = 中央値順 / both = 採用10人以上 かつ 属性中央値以上を中央値順
    function filterComps(comps, mode, attackMedianFururi, minPopular = 10) {
        const list = [...(comps ?? [])];
        if (mode === 'popular') return list.sort((a, b) => b.n - a.n || b.medianFururi - a.medianFururi);
        if (mode === 'strong') return list.sort((a, b) => b.medianFururi - a.medianFururi || b.n - a.n);
        // both
        return list
            .filter(c => c.n >= minPopular &&
                (Number.isFinite(attackMedianFururi) ? c.medianFururi >= attackMedianFururi : true))
            .sort((a, b) => b.medianFururi - a.medianFururi || b.n - a.n);
    }

    // ---- 3凸セット最適化 ----
    // picks = 属性3つ (凸1→凸3の順・重複可・例 ['WATER','WATER','FIRE'])。
    // index = buildIndex の戻り値。15キャラ (日本語名) 被りなしの3編成で
    // Σ(medianFururi × baseDamage) 最大を全探索 (候補は属性ごと高々20件 → 最大8000通り)。
    // 戻り値: 上位 topK 件 [{total, comps: [{attr, names, n, medianFururi, estDamage}]}]。
    // comps[i] は picks[i] (凸i+1) に対応。total/estDamage は「基準SLv換算の推定ダメージ
    // (raw)」— 表示側で B 単位・自分SLv換算にする。
    // 凸1優先 (ユーザー要望 2026-08-05): 同属性2凸は先の凸に出力の高い編成を割り当てる。
    // 合計が同点の案は 凸1の出力 → 凸2の出力 の辞書式で高い方を優先 (合計は犠牲にしない)。
    function optimizeTriple(index, picks, { topK = 3 } = {}) {
        if (!Array.isArray(picks) || picks.length !== 3) return { error: '属性を3つ選んでください', results: [] };
        const pools = picks.map(attr => {
            const a = index?.attrs?.[attr];
            if (!a || !a.comps.length) return null;
            return a.comps.map(c => ({
                attr, names: c.names, n: c.n, medianFururi: c.medianFururi, key: c.key,
                estDamage: c.medianFururi * a.baseDamage,
            }));
        });
        const missing = picks.filter((_, i) => !pools[i]);
        if (missing.length) return { error: `${[...new Set(missing)].join('・')} の編成データがありません`, results: [] };

        // 同属性スロット間の正準順序: 先の凸の出力 >= 後の凸 (同値は key 昇順)。
        // これで「凸1に高出力側」を保証しつつ、入れ替えただけの重複列挙も消える
        const slotOrderOk = (earlier, later) => {
            if (earlier.attr !== later.attr) return true;
            if (earlier.key === later.key) return false;   // 同じ編成の2度使いは禁止
            return earlier.estDamage > later.estDamage ||
                (earlier.estDamage === later.estDamage && earlier.key < later.key);
        };

        const results = [];
        for (const c1 of pools[0]) {
            const s1 = new Set(c1.names);
            for (const c2 of pools[1]) {
                if (!slotOrderOk(c1, c2)) continue;
                if (c2.names.some(x => s1.has(x))) continue;
                const s2 = new Set([...s1, ...c2.names]);
                for (const c3 of pools[2]) {
                    if (!slotOrderOk(c1, c3) || !slotOrderOk(c2, c3)) continue;
                    if (c3.names.some(x => s2.has(x))) continue;
                    results.push({
                        total: c1.estDamage + c2.estDamage + c3.estDamage,
                        totalN: c1.n + c2.n + c3.n,
                        comps: [c1, c2, c3],
                    });
                }
            }
        }
        // 異属性の picks 順は固定なので、同属性の正準順序と合わせて重複は残らないはずだが
        // 念のための保険 (残っても最終並びは決定的)
        const seen = new Set();
        const uniq = results.filter(r => {
            const k = r.comps.map(c => c.attr + ':' + c.key).sort().join('/');
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        uniq.sort((a, b) => b.total - a.total ||
            b.comps[0].estDamage - a.comps[0].estDamage ||   // 凸1優先
            b.comps[1].estDamage - a.comps[1].estDamage ||
            b.totalN - a.totalN ||
            a.comps.map(c => c.key).join('/').localeCompare(b.comps.map(c => c.key).join('/')));
        return { error: uniq.length ? null : '15キャラ被りなしで組める組み合わせがありません', results: uniq.slice(0, topK) };
    }

    root.gbCompareDomain = { normFromFururi, memberPct, buildIndex, filterComps, optimizeTriple };
})(typeof window !== 'undefined' ? window : globalThis);
