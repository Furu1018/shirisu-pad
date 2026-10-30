// ============================================================================
// 決定 (シンプル化 S4・2026-10-27): 組めたブロックまでを 1 つの配信 (published_plans の 1 行) にまとめる。
//   ・plan.decided = { upTo, at, blocks: [{ key, idx, name, label, from, to, level, kept, attacks, hp? }] }
//     hp = そのブロックの始まりのボスの残り HP ({ ボス番号: B }・決定したときの見積もり)。盤の見え方 (boardView) の幅と「あと ◯B」に使う (2026-10-28)
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
    // 配信の行は anon で書ける — blocks に null などが混ざった行は決定として読まない (画面が落ちる: S4 レビュー [7][13])
    //   ブロックが 1 つも無い / 鍵が 'from-to' の文字列でない行も決定として読まない (時間割に何も出ないのに「決定あり」として従来の配信を止める: S4 Codex 監査 E)。
    //   DB (supabase/56 の published_plan_decided_ok) と同じ物差し — 食い違うと以後の決定が「別の運営が先に決定しました」で止まり続ける
    const isDecided = (plan) => !!(plan && plan.decided && Array.isArray(plan.decided.blocks) && plan.decided.blocks.length > 0
        && plan.decided.blocks.every(b => b && typeof b === 'object' && typeof b.key === 'string' && /^\d{1,2}-\d{1,2}$/.test(b.key))
        && (plan.levels == null || Array.isArray(plan.levels)));

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
        if (isDecided(plan)) for (const b of plan.decided.blocks) if (b && typeof b === 'object' && b.key != null) m.set(String(b.key), b);
        return m;
    }

    /**
     * 前の決定の凸のうち済んだもの (ブロックの鍵 → 凸の配列)。✓ (planKey) を先に・数字の報告は ブロックの順に 人|レベル|ボス の数で消し込む
     */
    /** 数字の報告の鍵 (人|レベル|ボス)。Lv4 (ボス 5) は Lv3 の鍵も (DB の level が 3 のため) — 先に Lv4 */
    function looseKeysOf(a) {
        const lv = Number(a.level) || 1, bn = Number(a.bossNumber);
        const ks = [`${a.memberId}|${lv}|${bn}`];
        if (lv >= 4 && bn === 5) ks.push(`${a.memberId}|3|5`);
        return ks;
    }
    function doneInPrev(bl, prevBlocks, prevPlan, done) {
        const out = new Map();
        if (!prevPlan || !pc() || !done) return out;
        const keys = new Set([...(done.keys || [])].map(String));
        const loose = new Map(done.loose instanceof Map ? [...done.loose] : Object.entries(done.loose || {}));
        if (!keys.size && !loose.size) return out;
        const perBlock = [];
        for (const blk of bl) {
            const key = keyOf(blk);
            if (!prevBlocks.has(key)) continue;
            perBlock.push({ key, atks: pc().attacksIn(prevPlan, blk).map(a => ({ a, done: keys.has(planKey({ ...a, block: key })) })) });
        }
        for (const b of perBlock) for (const x of b.atks) {
            if (x.done) continue;
            // Lv4 (ボス 5) の凸の数字の報告は DB の level が 3 (Lv4 の間も current_level は 3: S4 レビュー [10]) → Lv4 の鍵が無ければ Lv3 の鍵でも消し込む
            for (const lk of looseKeysOf(x.a)) {
                if ((Number(loose.get(lk)) || 0) > 0) { loose.set(lk, Number(loose.get(lk)) - 1); x.done = true; break; }
            }
        }
        for (const b of perBlock) out.set(b.key, b.atks.filter(x => x.done).map(x => x.a));
        return out;
    }

    /**
     * 決定のプランを作る。
     * @param {{ blocks:Object[], ov:Object[], newIdxs:number[], prevPlan?:Object|null, bosses?:Object[], at?:string,
     *           done?:{ keys:Set<string>|string[], loose:Map<string,number>|Object }|null, fpOf?:(idx:number)=>string|null }} a
     *   blocks = シーズンのブロック / ov = blockBuildDomain.overview の結果 (いまのブロックから先) / newIdxs = 今回決めるブロック (組めたもの)
     *   prevPlan = 前の決定のプラン (時間の過ぎたブロック・今回組み直していないブロックをそのまま写す)
     *   done = 済んだ凸。keys = ✓ の planKey / loose = 数字の報告の数 (鍵 `人|レベル|ボス`)。組み直したブロックでも、前の決定の済んだ凸は残す (S4 引き継ぎ 1)
     *   fpOf = ブロックの駒の指紋 (決定したときのもの)。decided.blocks[].fp に残し、読み戻しはそれを使う (S4 引き継ぎ 3)
     * @returns {Object} levels[].bosses[].attacks[] の形 (ソルバーの出力と同じ読み方ができる) + decided
     */
    function build({ blocks, ov, newIdxs, prevPlan = null, bosses = [], at = null, done = null, fpOf = null, hpOf = null } = {}) {
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
        // ★ 済んだ凸は決定し直しても残す (S4 引き継ぎ 1)。組み直したブロックの自動の結果は「まだの凸」だけなので、前の決定の済んだ凸を足す。
        //   ✓ は planKey で先に全部見てから、数字の報告 (planKey なし) を 人・レベル・ボス の数でブロックの順 (前のブロックから) に消し込む
        const doneOf = doneInPrev(bl, prevBlocks, prevPlan, done);
        bl.forEach((blk, idx) => {
            const key = keyOf(blk);
            let level = null, atks = [], kept = false, hp = null;
            if (newSet.has(idx)) {
                const o = (Array.isArray(ov) ? ov : []).find(x => x && x.idx === idx);
                if (!o || o.past || o.level == null) return;
                level = Number(o.level);
                for (const r of (o.rows || [])) for (const p of (r.pieces || [])) atks.push({ ...p, level, bossNumber: Number(r.bossNumber), _meta: { name: r.name, weakness: r.weakness, tier: r.tier } });
                const have = new Set(atks.map(a => planKey({ ...a, block: key })));
                const readd = [];
                for (const a of (doneOf.get(key) || [])) if (!have.has(planKey({ ...a, block: key }))) { atks.push({ ...a, _meta: {} }); readd.push(a); }   // 自動の結果に同じ凸があれば足さない
                // ブロックの始まりの HP (盤の見え方)。始まりの盤面は済んだ凸を入れたあと (_obStripDone と同じ前提) なので、足し戻した済んだ凸のダメージも足す。
                //   ★ 足すのはこのブロックのレベルの凸だけ (ブロックの途中でレベルが上がってから組み直すと、前のレベルの凸を新しいレベルの HP に足していた: 盤のレビュー BD-1)。
                //   ★ そのレベルの最大 HP で頭打ち (✓ は HP を動かさないので、🎯 で合わせる前に組み直すと最大を超えた: BD-6)。0.01B で残す (0.1B に丸めると 撃破 ✓ が「あと 0.1B」になった: BD-7)
                hp = {};
                for (const r of (o.rows || [])) {
                    if (r.infinite || !Number.isFinite(Number(r.startB))) continue;
                    const back = readd.filter(a => Number(a.bossNumber) === Number(r.bossNumber) && Number(a.level) === level).reduce((t, a) => t + (Number(a.dmgB) || 0), 0);
                    let v = Number(r.startB) + back;
                    const cap = typeof hpOf === 'function' ? Number(hpOf(level, r.tier || (bossOf.get(Number(r.bossNumber)) || {}).tier || 'lord')) : 0;
                    if (cap > 0 && v > cap) v = cap;
                    hp[Number(r.bossNumber)] = Math.round(v * 100) / 100;
                }
            } else if (prevBlocks.has(key) && pc()) {
                level = Number(prevBlocks.get(key).level) || null;
                atks = pc().attacksIn(prevPlan, blk).map(a => ({ ...a, _meta: {} }));
                kept = true;
                hp = cleanHp(prevBlocks.get(key).hp);   // 前の決定の見積もりをそのまま (無い古い行は無し)
            } else return;
            const fp0 = !kept ? (typeof fpOf === 'function' ? fpOf(idx) : null) : prevBlocks.get(key).fp;
            entries.push({ key, idx, letter: blk.letter || null, name: blk.name || null, short: blk.short || blk.name || null, range: blk.range || null, label: blk.label || key, from: Number(blk.from), to: Number(blk.to), level, kept, attacks: atks.length,
                ...(typeof fp0 === 'string' ? { fp: fp0 } : {}), ...(hp && Object.keys(hp).length ? { hp } : {}) });
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

    /** 決定の hp ({ ボス番号: B }) を読む。配信の行は anon で書ける — 数でないもの・負の値・ボス番号でない鍵は捨てる */
    function cleanHp(hp) {
        if (!hp || typeof hp !== 'object' || Array.isArray(hp)) return null;
        const out = {};
        for (const k of Object.keys(hp)) {
            const n = Number(k), v = Number(hp[k]);
            if (Number.isInteger(n) && n >= 1 && n <= 5 && Number.isFinite(v) && v >= 0) out[n] = v;
        }
        return Object.keys(out).length ? out : null;
    }

    /**
     * 決定を「凸プランを組む」と同じ盤の形にする (⚔️ ✓ 凸の記録・📅 レイド予定表・2026-10-28 ふるり「組むの見え方の方が分かりやすい」)。
     *   ブロックごとに、そのレベルのボスの行 (Lv4 はボス 5 だけ) と、行に置かれた凸 (駒・幅 = ダメージ)。✓ と自分の駒の印は timetable と同じ。
     *   幅の物差し startB は 決定したときのブロックの始まりの HP (decided.blocks[].hp)。無い古い行は そのレベルの最大 HP (hpOf) で、hpExact = false
     * @param {{ blocks:Object[], plan:Object, nowIdx?:number, done?:Set<string>, viewerId?:*, bosses?:Object[], hpOf?:(level:number, tier:string)=>number }} a
     * @returns {Array<{ idx, key, name, label, state, decided, level, hpExact:boolean, rows:Array<{ bossNumber, name, weakness, tier, infinite, exact, startB, gotB, remB, killed, pieces:Object[] }>,
     *   entries:Object[], others:Object[], allKilled:boolean, doneN:number, mineN:number }>}
     */
    function boardView({ blocks, plan, nowIdx = -1, done = null, viewerId = null, bosses = [], hpOf = null } = {}) {
        const tt = timetable({ blocks, plan, viewerId, nowIdx, done });
        const dec = decidedBlocks(plan);
        const bossList = (Array.isArray(bosses) ? bosses : []).filter(b => b && typeof b === 'object' && Number.isInteger(Number(b.boss_number)))
            .slice().sort((x, y) => Number(x.boss_number) - Number(y.boss_number));
        return tt.map(r => {
            const d = dec.get(r.key) || null;
            const hp = d ? cleanHp(d.hp) : null;
            const level = r.level;
            let rows = [];
            if (r.decided && level != null) {
                const infinite = level >= 4;
                // 行はそのレベルのボス (盤の行の並び)。シーズンのボスが読めないときは 凸のあるボスだけ
                const nums = bossList.length ? bossList.map(b => Number(b.boss_number)) : [...new Set(r.entries.map(e => Number(e.bossNumber)))].sort((x, y) => x - y);
                // ★ 行に載せるのはこのブロックのレベルの凸だけ (Lv4 はボス 5 の Lv4)。ブロックの途中でレベルが上がってから組み直したブロックには、前のレベルの済んだ凸が入る —
                //   それを今のレベルの行に混ぜると幅と「あと ◯B」が狂い、Lv4 では盤のどこにも出ず ✓ を取り消せなかった (盤のレビュー BD-1 / BD-2) → others で別に返す
                const onBoard = (e) => infinite ? (Number(e.level) >= 4 && Number(e.bossNumber) === 5) : Number(e.level) === level;
                rows = nums.filter(n => !infinite || n === 5).map(n => {
                    const b = bossList.find(x => Number(x.boss_number) === n) || null;
                    const pieces = r.entries.filter(e => Number(e.bossNumber) === n && onBoard(e));
                    const tier = (b && b.tier) || 'lord';
                    const exact = !!(hp && hp[n] != null);
                    const startB = infinite ? 0 : (exact ? hp[n] : (typeof hpOf === 'function' ? Number(hpOf(level, tier)) || 0 : 0));
                    const gotB = pieces.reduce((t, e) => t + (Number(e.dmgB) || 0), 0);
                    // 始まりで倒れている (hp 0) ボスも撃破 (組むの overview と同じ: BD-3)。物差しが分からない (最大 HP も 0) ときだけ撃破にしない
                    const killed = !infinite && (exact || startB > 0) && gotB >= startB - 0.05;
                    return { bossNumber: n, name: (b && (b.name || b.boss_code)) || (pieces[0] && pieces[0].bossName) || `B${n}`, weakness: (b && b.weakness) || (pieces[0] && pieces[0].weakness) || null,
                        tier, infinite, exact, startB, gotB, remB: infinite ? 0 : Math.max(0, startB - gotB), killed, pieces };
                });
            }
            const placed = new Set(rows.flatMap(x => x.pieces.map(e => e.planKey)));
            return { idx: r.idx, key: r.key, letter: r.letter, name: r.name, short: r.short, range: r.range, label: r.label, state: r.state, decided: r.decided, level,
                hpExact: rows.length > 0 && rows.every(x => x.infinite || x.exact), rows, entries: r.entries,
                others: r.entries.filter(e => !placed.has(e.planKey)),   // 盤の行に載らない凸 (別のレベル・Lv4 のボス 1〜4)。数 (doneN・entries) には入れたまま、別に見せる
                // 撃破 (緑の Lv) は HP のある行だけで見る (無限の行を撃破に数えていた: BD-5)
                allKilled: rows.some(x => !x.infinite) && rows.every(x => x.infinite || x.killed),
                doneN: r.entries.filter(e => e.done).length, mineN: r.mine.length };
        });
    }

    /** ✓ 凸しました の鍵 (同じ凸を二重に付けない)。ブロック・レベル・ボス・人・編成 */
    const planKey = (a) => `${a.block || ''}|L${Number(a.level) || 1}|B${Number(a.bossNumber)}|${a.memberId}|S${Number(a.loadoutSlot) || 1}`;

    /** プランの凸を 1 列に (level・bossNumber・ボスの名前・弱点つき) */
    function flat(plan) {
        const out = [];
        for (const lv of (plan && Array.isArray(plan.levels) ? plan.levels : [])) {
            if (!lv || typeof lv !== 'object') continue;
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                if (!b || typeof b !== 'object') continue;
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
            const lv = d ? Number(d.level) : NaN;
            return { idx, key, letter: blk.letter || null, name: blk.name || null, short: blk.short || blk.name || null, range: blk.range || null, label: blk.label || key, state, decided: !!d, level: Number.isInteger(lv) && lv >= 1 && lv <= 4 ? lv : null, entries,   // 数でなければ null (S4 引き継ぎ 2: XSS)
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
        for (const v of m.values()) v.sort((x, y) => (x.order - y.order) || (x.level - y.level) || (x.bossNumber - y.bossNumber) || (x.sig < y.sig ? -1 : x.sig > y.sig ? 1 : 0));   // 最後に sig (S4 引き継ぎ 11)
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
        const lineOf = (r) => `${r.blockLabel} Lv${Number(r.level) >= 4 ? 4 : Number(r.level) || 1} B${r.bossNumber}${pt(r.weakness) ? ` ${pt(r.weakness)}PT` : ''} 編成${SLOT_JP[r.slot] || r.slot}`;
        const tailOf = (changed, id) => !changed || !acked ? 'レイド予定表で確認してください'
            : has(acked, id) ? '✅ 確認したあとにプランが変わりました。レイド予定表で新しい凸を確認してください'
            : 'まだ確認していませんが、プランが変わりました。レイド予定表で新しい凸を確認してください';
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
                    body: !acked ? '組み直しで、あなたの割当は無くなりました。レイド予定表で確認してください'
                        : has(acked, memberId) ? '✅ 確認したあとに組み直され、あなたの割当は無くなりました。レイド予定表で確認してください'
                        : 'まだ確認していませんが、組み直しであなたの割当は無くなりました。レイド予定表で確認してください' });
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

    /**
     * 決定の中身を人ごとに確かめる: 1 人 3 凸を超える / 同じキャラを 2 回使う。
     * 手前のブロックだけ 🧮 し直すと、ソルバーは後ろの決定 (kept) を知らないので起こり得る (Codex 監査 2026-10-31)。
     * 決定は止めない (後ろまで組み直すとメンバーを振り回す) — 確認で運営に言うための材料
     * @returns {{ memberId:any, name:string, attacks:number, dupChars:string[] }[]}
     */
    function conflictsOf(plan) {
        const by = new Map();
        for (const lv of (plan && Array.isArray(plan.levels) ? plan.levels : [])) {
            for (const b of (lv && Array.isArray(lv.bosses) ? lv.bosses : [])) {
                for (const a of (b && Array.isArray(b.attacks) ? b.attacks : [])) {
                    if (!a || a.memberId == null) continue;
                    const k = String(a.memberId);
                    if (!by.has(k)) by.set(k, { memberId: a.memberId, name: a.memberName || '', attacks: 0, chars: new Map() });
                    const m = by.get(k);
                    m.attacks += 1;
                    for (const c of (Array.isArray(a.team) ? a.team.filter(Boolean) : [])) m.chars.set(String(c), (m.chars.get(String(c)) || 0) + 1);
                }
            }
        }
        return [...by.values()].map(m => ({ memberId: m.memberId, name: m.name, attacks: m.attacks, dupChars: [...m.chars].filter(([, n]) => n > 1).map(([c]) => c) }))
            .filter(m => m.attacks > 3 || m.dupChars.length);
    }

    root.decidePlanDomain = { conflictsOf, keyOf, isDecided, latestDecided, currentDecided, decidedBlocks, looseKeysOf, doneInPrev, build, rangeToDecide, planKey, flat, timetable, boardView, cleanHp, rowsOf, notices, SLOT_JP };
})(typeof window !== 'undefined' ? window : globalThis);
