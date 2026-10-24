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
    /** 効いている配信の行 (id で重複なし・ブロックの並び) */
    function distinctEffective(rows, blocks) {
        const seen = new Set(); const out = [];
        for (const x of byBlocks(rows, blocks)) { const id = idOf(x.pub); if (seen.has(id)) continue; seen.add(id); out.push(x.pub); }
        return out;
    }
    /** 時刻の無い約束の鍵 (同じ約束が複数の行にあっても 1 回だけ数えるため) */
    const timelessKey = (level, bossNumber, a) => `${Number(level)}|${Number(bossNumber)}|${String(a.memberId)}|${(a.loadoutSlot != null && a.loadoutSlot !== '') ? Number(a.loadoutSlot) : 1}`;
    /**
     * 時刻の無い凸 (⏳ flex・hourIdx 無し) だけを残したプラン (無ければ null)。ブロックの範囲で絞ると落ちるので、全ブロックの約束を見るときは行ごとに 1 回だけ別に足す (Codex 再監査 F)。
     * ★ seen (Set) を渡すと、同じ約束 (レベル・ボス・人・編成枠) は最初の行のものだけ残す — 1 日ぶんの行と夜の行の両方に同じ flex の凸があると、束ねた基準に 2 本入って
     *   L5 / L4 の差分が「2 本 → 1 本」の誤りになる・撃破の宛先の割当数が 2 になる (Codex 再監査 3 回目)
     */
    function timelessOnly(plan, seen = null) {
        const levels = (plan && Array.isArray(plan.levels) ? plan.levels : [])
            .map(lv => ({ ...lv, bosses: (Array.isArray(lv.bosses) ? lv.bosses : []).map(b => ({ ...b, attacks: (Array.isArray(b.attacks) ? b.attacks : []).filter(a => {
                if (!a || Number.isInteger(a.hourIdx)) return false;
                if (!seen) return true;
                const k = timelessKey(lv.infinite ? 4 : lv.level, b.bossNumber, a);
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            }) })) }))
            .filter(lv => lv.bosses.some(b => b.attacks.length > 0));
        return levels.length ? { ...plan, levels, timeless: true } : null;
    }
    /**
     * ブロックごとに効いている配信を、そのブロックの範囲に絞ったプランで (撃破の通知の宛先・1 日ぶんの算出の基準など「全ブロックの約束」を見る所)。配信の無いブロック・plan の無い行は入らない。
     * 時刻の無い凸は範囲で絞ると落ちるので、効いている行ごとに末尾に足す — 同じ約束 (レベル・ボス・人・編成枠) は 1 回だけ (`timeless: true` の印。opts.timeless = false で外す)
     * @param {(plan:Object, block:Object) => Object} scopeFn  raidBlocksDomain.scopePlan
     */
    function effectivePlans(rows, blocks, scopeFn, opts = {}) {
        const scoped = byBlocks(rows, blocks).map(x => (x.pub && x.pub.plan) ? (typeof scopeFn === 'function' ? scopeFn(x.pub.plan, x.block) : x.pub.plan) : null).filter(Boolean);
        if (opts.timeless === false) return scoped;
        const seen = new Set();
        return scoped.concat(distinctEffective(rows, blocks).map(p => timelessOnly(p.plan, seen)).filter(Boolean));
    }
    /**
     * 複数のプラン (effectivePlans の結果) を 1 つに束ねる — 1 日ぶん (全員 / 今動ける人) の算出で「前回どおり」に渡す基準 (Codex 再監査 C2:
     * 1 行だけを渡すと、別のブロックでまだ有効な約束を尊重できず、全体配信で上書きしてしまう)。レベル → ボスで合わせ、凸は並べる。ボスのほかの項目は最初のものを残す
     */
    function mergedPlan(plans) {
        const list = (Array.isArray(plans) ? plans : []).filter(Boolean);
        if (!list.length) return null;
        const levels = new Map();
        for (const p of list) for (const lv of (Array.isArray(p.levels) ? p.levels : [])) {
            const L = Number(lv.level);
            if (!Number.isInteger(L)) continue;
            if (!levels.has(L)) levels.set(L, { level: L, infinite: !!lv.infinite, bosses: new Map() });
            const e = levels.get(L);
            if (lv.infinite) e.infinite = true;
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                const n = Number(b.bossNumber);
                if (!e.bosses.has(n)) e.bosses.set(n, { ...b, attacks: [] });
                e.bosses.get(n).attacks.push(...(Array.isArray(b.attacks) ? b.attacks : []));
            }
        }
        return { merged: true, levels: [...levels.values()].sort((a, b) => a.level - b.level).map(e => ({ level: e.level, infinite: e.infinite, bosses: [...e.bosses.values()].sort((a, b) => Number(a.bossNumber) - Number(b.bossNumber)) })) };
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
    /**
     * 🧱 区切りを変えたあとに残る「どのブロックにも効かない配信」 (blockScope の鍵がいまのブロックのどれとも一致しない行・1 日ぶん (all) は除く)。
     *   既定を 7 つ → 6 つに変えた 2026-10-24 のため: 旧い 18-20 の配信は新しい 17-20 のブロックに効かず、黙って消えると約束を失う → 運営に「組み直して配信し直す」と知らせる (Codex 監査 §10 B)
     * @returns {Array<{ row: Object, key: string, label: string }>} id の順
     */
    function strayRows(rows, blocks) {
        const keys = new Set((Array.isArray(blocks) ? blocks : []).map(b => keyOfBlock(b)).filter(Boolean));
        const out = [];
        for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r) continue;
            const k = keyOf(r);
            if (k === 'all' || keys.has(k)) continue;
            const sc = r.plan && r.plan.blockScope ? r.plan.blockScope : {};
            out.push({ row: r, key: k, label: sc.label || sc.name || k });
        }
        return out.sort((a, b) => idOf(a.row) - idOf(b.row));
    }

    root.publishedPlansDomain = { keyOf, keyOfPlan, keyOfBlock, latest, effectiveFor, previousFor, byBlocks, distinctEffective, timelessOnly, effectivePlans, mergedPlan, distinctCount, pickDefault, strayRows };
})(typeof window !== 'undefined' ? window : globalThis);
