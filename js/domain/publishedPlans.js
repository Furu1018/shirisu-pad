// ============================================================================
// ドメイン: 配信 (published_plans) を「ブロックごとの最新」で読む (🧱 段階 7・2026-10-23 ユーザー決定「配信はブロック別に見れるようにしたい」)
// ----------------------------------------------------------------------------
// 配信の行は消さずに積む (38)。これまでは「シーズンの最新の 1 行」を全員が見ていたので、運営 A が「夕方」を配信すると
// 運営 B が先に出していた「夜」の予定はメンバーの画面から消えた (全体監査 2026-10-23 の再監査で指摘)。
// ここでは行を**ブロックの鍵** (`from-to` の時) でまとめ、ブロックごとに id 最大の行を「いまの配信」とする。
// ★ 1 日ぶんの配信 (blockScope なし) は鍵 'all' = どのブロックにも効く。ブロックの行と 'all' の行のうち新しいほう (id 大) が勝つ
// ★ 順序は id だけで決める (published_at は端末の時計に依らないが同値になり得る — L3 と同じ理由)
// 純関数・引数渡し。画面は選ぶだけで、ここに判定を書き足さない
(function (root) {
    'use strict';
    const idOf = (r) => Number(r && r.id) || 0;
    // ★ null / '' / true を Number() が 0 にするのを通さない (Codex 再監査 A: from が欠けた範囲が '0-8' になり、どのブロックにも効かない行になっていた)
    const hourNum = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean') ? NaN : Number(v);
    const scopeKey = (s) => (s && Number.isInteger(hourNum(s.from)) && Number.isInteger(hourNum(s.to))) ? `${hourNum(s.from)}-${hourNum(s.to)}` : 'all';
    /** ブロック ({ from, to } の時) の鍵 */
    const keyOfBlock = (blk) => (blk ? scopeKey(blk) : 'all');
    /** プラン (plan.blockScope) の鍵。無ければ 'all' */
    const keyOfPlan = (plan) => scopeKey(plan && plan.blockScope);
    /** 配信の行 (pub.plan.blockScope) の鍵 */
    const keyOf = (pub) => keyOfPlan(pub && pub.plan);
    /** 行のうち id 最大 (無ければ null) */
    function latest(rows) {
        let best = null;
        for (const r of (Array.isArray(rows) ? rows : [])) if (r && (!best || idOf(r) > idOf(best))) best = r;
        return best;
    }
    /** その鍵のブロックに効いている配信 = その鍵の行と 'all' の行のうち id 最大。key が 'all' なら全体の最新 */
    function effectiveFor(rows, key) {
        if (!key || key === 'all') return latest(rows);
        let best = null;
        for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r) continue;
            const k = keyOf(r);
            if (k !== key && k !== 'all') continue;
            if (!best || idOf(r) > idOf(best)) best = r;
        }
        return best;
    }
    /**
     * pub の 1 つ前 — 本人の「前回から変わったか」の材料。**見ているブロック (viewKey) に効いていた 1 つ前** = その鍵か 'all' で、pub より小さい id のうち最大。
     * ★ viewKey を渡す (Codex 再監査 A): 今回が 1 日ぶん (all) のとき、鍵を pub から取ると全体の 1 つ前 (別のブロックの行かもしれない) と比べてしまう。
     *   viewKey が無ければ pub の鍵で (pub が all なら全体の 1 つ前)
     */
    function previousFor(rows, pub, viewKey = null) {
        if (!pub) return null;
        const key = (viewKey && viewKey !== 'all') ? String(viewKey) : keyOf(pub), cur = idOf(pub);
        let best = null;
        for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r || idOf(r) >= cur) continue;
            const k = keyOf(r);
            if (key !== 'all' && k !== key && k !== 'all') continue;
            if (!best || idOf(r) > idOf(best)) best = r;
        }
        return best;
    }
    /**
     * シーズンのブロック (raidBlocksDomain.blocksOfSeason) ごとに、効いている配信を並べる。配信の無いブロックは入らない。
     * @returns {Array<{ block: Object, key: string, pub: Object }>} ブロックの順
     */
    function byBlocks(rows, blocks) {
        const out = [];
        for (const b of (Array.isArray(blocks) ? blocks : [])) {
            const key = keyOfBlock(b);
            const pub = effectiveFor(rows, key);
            if (pub) out.push({ block: b, key, pub });
        }
        return out;
    }
    /**
     * ブロックごとに効いている配信を、そのブロックの範囲に絞ったプランで (撃破の通知の宛先など「全ブロックの約束」を見る所)。配信の無いブロック・plan の無い行は入らない。
     * @param {(plan:Object, block:Object) => Object} scopeFn  raidBlocksDomain.scopePlan
     */
    function effectivePlans(rows, blocks, scopeFn) {
        return byBlocks(rows, blocks).map(x => (x.pub && x.pub.plan) ? (typeof scopeFn === 'function' ? scopeFn(x.pub.plan, x.block) : x.pub.plan) : null).filter(Boolean);
    }
    /** 違う配信 (id) がいくつあるか — 1 つなら切り替えのチップは要らない */
    const distinctCount = (list) => new Set((Array.isArray(list) ? list : []).map(x => idOf(x.pub))).size;
    /**
     * 既定で見せるブロック: いまの時刻のブロック (配信があれば) → それより後で配信のある最初のブロック → いちばん新しい配信のブロック
     * @param {Array} list  byBlocks の結果
     * @param {number} nowIdx  いまの時刻の行番号 (HOUR_ORDER の添字)
     */
    function pickDefault(list, nowIdx) {
        const l = Array.isArray(list) ? list : [];
        if (l.length === 0) return null;
        if (Number.isInteger(nowIdx)) {
            const cur = l.find(x => nowIdx >= x.block.fromIdx && nowIdx <= x.block.toIdx);
            if (cur) return cur;
            const next = l.filter(x => x.block.fromIdx > nowIdx).sort((a, b) => a.block.fromIdx - b.block.fromIdx)[0];
            if (next) return next;
        }
        return l.slice().sort((a, b) => idOf(b.pub) - idOf(a.pub))[0];
    }
    root.publishedPlansDomain = { keyOf, keyOfPlan, keyOfBlock, latest, effectiveFor, previousFor, byBlocks, effectivePlans, distinctCount, pickDefault };
})(typeof window !== 'undefined' ? window : globalThis);
