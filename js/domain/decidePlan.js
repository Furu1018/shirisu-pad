// ============================================================================
// 決定 (シンプル化 S4・2026-10-27): 組めたブロックまでを 1 つの配信 (published_plans の 1 行) にまとめる。
//   ・plan.decided = { upTo, at, blocks: [{ key, idx, name, label, from, to, level, kept, attacks }] }
//     kept = 今回は組み直さず、前の決定の行から写したブロック (時間の過ぎたブロック・組み直していないブロック)
//   ・メンバーは 1 枚の時間割 (timetable) で見る。決まっていないブロックは「まだ決まっていません」
//   ・通知は人ごとに 1 通 (notices)。前の決定にあったブロックの割当が変わった人だけ「変わりました」
//   ・✓ 凸しました の鍵 (planKey) = ブロック・レベル・ボス・人・編成 (同じ凸を二重に付けない)
// 純ロジック (DOM・DB を触らない)。planChainDomain.attacksIn を使う
// ============================================================================
(function (root) {
    'use strict';
    const pc = () => root.planChainDomain;
    const SLOT_JP = { 1: '①', 2: '②', 3: '③' };
    const keyOf = (b) => `${Number(b.from)}-${Number(b.to)}`;
    const isDecided = (plan) => !!(plan && plan.decided && Array.isArray(plan.decided.blocks));

    /** 配信の行 (id 降順でも昇順でもよい) のうち、決定の行の最新。無ければ null */
    function latestDecided(rows) {
        let best = null;
        for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r || !isDecided(r.plan)) continue;
            if (!best || Number(r.id) > Number(best.id)) best = r;
        }
        return best;
    }
    /** 配信の行のうち最新 (id 最大) が決定の行なら、その行。従来の配信 (ブロックごと・1 日ぶん) が後にあれば null */
    function currentDecided(rows) {
        let top = null;
        for (const r of (Array.isArray(rows) ? rows : [])) if (r && (!top || Number(r.id) > Number(top.id))) top = r;
        return top && isDecided(top.plan) ? top : null;
    }

    /** 決定のブロックの印 (key → 決定の中のブロック) */
    function decidedBlocks(plan) {
        const m = new Map();
        if (isDecided(plan)) for (const b of plan.decided.blocks) if (b && b.key) m.set(String(b.key), b);
        return m;
    }

    /**
     * 決定のプランを作る。
     * @param {{ blocks:Object[], ov:Object[], newIdxs:number[], prevPlan?:Object|null, bosses?:Object[], at?:string }} a
     *   blocks = シーズンのブロック / ov = blockBuildDomain.overview の結果 (いまのブロックから先) / newIdxs = 今回決めるブロック (組めたもの)
     *   prevPlan = 前の決定のプラン (時間の過ぎたブロック・今回組み直していないブロックをそのまま写す)
     * @returns {Object} levels[].bosses[].attacks[] の形 (ソルバーの出力と同じ読み方ができる) + decided
     */
    function build({ blocks, ov, newIdxs, prevPlan = null, bosses = [], at = null } = {}) {
        const bl = Array.isArray(blocks) ? blocks : [];
        const newSet = new Set((Array.isArray(newIdxs) ? newIdxs : []).map(Number));
        const prevBlocks = decidedBlocks(prevPlan);
        const bossOf = new Map((Array.isArray(bosses) ? bosses : []).map(b => [Number(b.boss_number), b]));
        const byLevel = new Map();   // level → Map(bossNumber → { meta, attacks })
        const entries = [];
        const put = (level, bossNumber, meta, a) => {
            if (!byLevel.has(level)) byLevel.set(level, new Map());
            const m = byLevel.get(level);
            if (!m.has(bossNumber)) {
                const b = bossOf.get(bossNumber) || {};
                m.set(bossNumber, { bossNumber, name: meta.name || b.name || b.boss_code || `B${bossNumber}`, weakness: meta.weakness || b.weakness || null,
                    attribute: b.attribute || null, tier: meta.tier || b.tier || null, ...(level >= 4 ? { infinite: true } : {}), attacks: [] });
            }
            m.get(bossNumber).attacks.push(a);
        };
        bl.forEach((blk, idx) => {
            const key = keyOf(blk);
            let level = null, atks = [], kept = false;
            if (newSet.has(idx)) {
                const o = (Array.isArray(ov) ? ov : []).find(x => x && x.idx === idx);
                if (!o || o.past || o.level == null) return;
                level = Number(o.level);
                for (const r of (o.rows || [])) for (const p of (r.pieces || [])) atks.push({ ...p, level, bossNumber: Number(r.bossNumber), _meta: { name: r.name, weakness: r.weakness, tier: r.tier } });
            } else if (prevBlocks.has(key) && pc()) {
                level = Number(prevBlocks.get(key).level) || null;
                atks = pc().attacksIn(prevPlan, blk).map(a => ({ ...a, _meta: {} }));
                kept = true;
            } else return;
            entries.push({ key, idx, name: blk.name || null, label: blk.label || key, from: Number(blk.from), to: Number(blk.to), level, kept, attacks: atks.length });
            for (const a of atks) {
                const lv = Number(a.level) || level || 1;
                const { _meta, level: _l, bossNumber, infinite: _i, ...rest } = a;
                const hourIdx = Number.isInteger(rest.hourIdx) && rest.hourIdx >= blk.fromIdx && rest.hourIdx <= blk.toIdx ? rest.hourIdx : blk.fromIdx;
                put(lv, Number(bossNumber), _meta || {}, { ...rest, hourIdx, block: key, blockLabel: blk.label || key });
            }
        });
        const levels = [...byLevel.keys()].sort((x, y) => x - y).map(level => ({
            level, ...(level >= 4 ? { infinite: true, levelCleared: true } : {}),
            bosses: [...byLevel.get(level).values()].sort((x, y) => x.bossNumber - y.bossNumber)
                .map(b => ({ ...b, attacks: b.attacks.slice().sort((x, y) => (x.hourIdx - y.hourIdx) || String(x.memberId).localeCompare(String(y.memberId), 'en', { numeric: true })) })),
        }));
        return {
            timeAware: true, merged: true,
            startLevel: levels.length ? levels[0].level : null,
            levels,
            decided: { upTo: entries.length ? Math.max(...entries.map(e => e.idx)) : null, at, blocks: entries },
        };
    }

    /**
     * 決めるブロック: いまのブロック (first) から、組めた (built) ブロックが続くところまで。途中に組んでいないブロックがあればそこで止める
     * @returns {number[]}
     */
    function rangeToDecide({ first = 0, count = 0, built } = {}) {
        const out = [];
        for (let i = Math.max(0, first); i < count; i++) {
            if (!(typeof built === 'function' && built(i))) break;
            out.push(i);
        }
        return out;
    }

    /** ✓ 凸しました の鍵 (同じ凸を二重に付けない)。ブロック・レベル・ボス・人・編成 */
    const planKey = (a) => `${a.block || ''}|L${Number(a.level) || 1}|B${Number(a.bossNumber)}|${a.memberId}|S${Number(a.loadoutSlot) || 1}`;

    /** プランの凸を 1 列に (level・bossNumber・ボスの名前・弱点つき) */
    function flat(plan) {
        const out = [];
        for (const lv of (plan && Array.isArray(plan.levels) ? plan.levels : [])) {
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                for (const a of (Array.isArray(b.attacks) ? b.attacks : [])) {
                    if (!a || a.memberId == null) continue;
                    out.push({ ...a, level: lv.infinite ? 4 : Number(lv.level), bossNumber: Number(b.bossNumber), bossName: b.name || null, weakness: b.weakness || null });
                }
            }
        }
        return out;
    }

    /**
     * メンバーの時間割 (1 枚)。ブロックごとに 決まった / まだ。決まったブロックは全員の凸 (自分の行は mine)
     * @param {{ blocks:Object[], plan:Object|null, viewerId?:any, nowIdx?:number, done?:Set<string> }} a  done = ✓ を付けた凸の planKey
     */
    function timetable({ blocks, plan, viewerId = null, nowIdx = -1, done = null } = {}) {
        const bl = Array.isArray(blocks) ? blocks : [];
        const dec = decidedBlocks(plan);
        const all = flat(plan);
        const doneSet = done instanceof Set ? done : new Set();
        return bl.map((blk, idx) => {
            const key = keyOf(blk);
            const d = dec.get(key) || null;
            const state = nowIdx < 0 ? 'later' : idx < nowIdx ? 'past' : idx === nowIdx ? 'now' : 'later';
            const entries = d ? all.filter(a => (a.block ? a.block === key : (a.hourIdx >= blk.fromIdx && a.hourIdx <= blk.toIdx)))
                .sort((x, y) => (x.level - y.level) || (x.bossNumber - y.bossNumber) || (x.hourIdx - y.hourIdx))
                .map(a => {
                    const k = planKey({ ...a, block: key });
                    return { planKey: k, level: a.level, bossNumber: a.bossNumber, bossName: a.bossName, weakness: a.weakness, memberId: a.memberId,
                        memberName: a.memberName || null, loadoutSlot: Number(a.loadoutSlot) || 1, team: Array.isArray(a.team) ? a.team : null,
                        dmgB: Number(a.dmgB) || 0, reservationId: a.reservationId ?? null, mine: viewerId != null && String(a.memberId) === String(viewerId), done: doneSet.has(k) };
                }) : [];
            return { idx, key, name: blk.name || null, label: blk.label || key, state, decided: !!d, level: d ? d.level : null, entries,
                mine: entries.filter(e => e.mine) };
        });
    }

    /** 人ごとの割当 (ブロックの順)。sig = 比べるための中身 (ブロック・レベル・ボス・編成・キャラ) */
    function rowsOf(plan, blocks) {
        const order = new Map((Array.isArray(blocks) ? blocks : []).map((b, i) => [keyOf(b), i]));
        const m = new Map();
        for (const a of flat(plan)) {
            const k = String(a.memberId);
            if (!m.has(k)) m.set(k, []);
            const team = Array.isArray(a.team) ? a.team.map(String).slice().sort().join(',') : '';
            m.get(k).push({ block: a.block || '', blockLabel: a.blockLabel || a.block || '', order: order.has(a.block) ? order.get(a.block) : 99,
                level: a.level, bossNumber: a.bossNumber, weakness: a.weakness, slot: Number(a.loadoutSlot) || 1,
                sig: `${a.block || ''}|L${a.level}|B${a.bossNumber}|S${Number(a.loadoutSlot) || 1}|${team}` });
        }
        for (const v of m.values()) v.sort((x, y) => (x.order - y.order) || (x.level - y.level) || (x.bossNumber - y.bossNumber));
        return m;
    }

    /**
     * 決定の通知 (人ごとに 1 通)。
     *   ・前の決定にあったブロックの割当が変わった人 → 🔄 変わりました (✅ を押していたかで文を分ける)
     *   ・新しく決まったブロックだけ増えた人・初めての人 → 🧱 決まりました
     *   ・前は割当があって今回は無い人 → 🔄 外れました
     *   ・何も変わらない人 → 送らない (unchanged に入れる = ✅ を引き継ぐ)
     * @returns {{ notices: Array<{memberId,title,body,lines,changed,gone?,sig}>, unchanged: any[] }}
     */
    function notices({ prevPlan = null, nextPlan, blocks, ackedIds = null, ptName = null } = {}) {
        const prev = rowsOf(prevPlan, blocks), next = rowsOf(nextPlan, blocks);
        const prevKeys = new Set(decidedBlocks(prevPlan).keys());
        const acked = ackedIds instanceof Set ? ackedIds : null;
        const has = (set, id) => set.has(Number(id)) || set.has(String(id));
        const pt = (w) => (typeof ptName === 'function' && w) ? (ptName(w) || '') : '';
        const lineOf = (r) => `${r.blockLabel} B${r.bossNumber}${pt(r.weakness) ? ` ${pt(r.weakness)}PT` : ''} 編成${SLOT_JP[r.slot] || r.slot}`;
        const tailOf = (changed, id) => !changed || !acked ? 'ホームの時間割で確認してください'
            : has(acked, id) ? '✅ 確認したあとにプランが変わりました。ホームの時間割で新しい凸を確認してください'
            : 'まだ確認していませんが、プランが変わりました。ホームの時間割で新しい凸を確認してください';
        const out = [], unchanged = [];
        const ids = [...new Set([...prev.keys(), ...next.keys()])].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
        for (const id of ids) {
            const p = prev.get(id) || [], n = next.get(id) || [];
            const sigAll = (rows) => rows.map(r => r.sig).join(' / ');
            const memberId = Number.isFinite(Number(id)) ? Number(id) : id;
            if (sigAll(p) === sigAll(n)) { if (n.length) unchanged.push(memberId); continue; }
            if (!n.length) {
                out.push({ memberId, lines: ['割当なし'], gone: true, changed: true, sig: 'gone',
                    title: '🔄 あなたの凸が外れました',
                    body: !acked ? '組み直しで、あなたの割当は無くなりました。ホームの時間割で確認してください'
                        : has(acked, memberId) ? '✅ 確認したあとに組み直され、あなたの割当は無くなりました。ホームの時間割で確認してください'
                        : 'まだ確認していませんが、組み直しであなたの割当は無くなりました。ホームの時間割で確認してください' });
                continue;
            }
            // 前の決定にあったブロックだけを比べる (新しく決まったブロックが増えただけなら「決まりました」)
            const inPrev = (rows) => rows.filter(r => prevKeys.has(r.block));
            const changed = p.length > 0 && prevKeys.size > 0 && sigAll(inPrev(p)) !== sigAll(inPrev(n));
            const lines = n.map(lineOf);
            out.push({ memberId, lines, changed, sig: sigAll(n),
                title: changed ? '🔄 あなたの凸が変わりました' : '🧱 あなたの凸が決まりました',
                body: `${lines.join(' / ')} — ${tailOf(changed, memberId)}` });
        }
        return { notices: out, unchanged };
    }

    root.decidePlanDomain = { keyOf, isDecided, latestDecided, currentDecided, decidedBlocks, build, rangeToDecide, planKey, flat, timetable, rowsOf, notices, SLOT_JP };
})(typeof window !== 'undefined' ? window : globalThis);
