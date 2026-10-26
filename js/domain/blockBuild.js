// ============================================================================
// ドメイン: 凸プランを組む (シンプル化 S2・2026-10-26 ふるりの構想・設計案 docs/シンプル化_設計案_2026-10-26.md §6)
// ----------------------------------------------------------------------------
// 「朝 5〜8時 を組む」のような大きなボタンを 6 つ並べ、押したブロックに 出られる人の模擬 を手で置く → 残りを自動で組む。
// ここは純ロジックだけ:
//   - overview: ブロックごとに「挑むレベル・ボスごとの始まりの HP・置いた凸・残り」(★ レベルはブロックの頭でしか変わらない)。
//     前のブロックで組んだ凸を「模擬どおり削れた」と仮定して盤面を進める (planChainDomain.projectBoard の levelLockInBlock)
//   - pinsPlan: 手で置いた駒 (📌 ブロックの仮置き = plan_reservations status 'pinned' / time_mode 'block') を、プランの形にする
//   - trayPieces: そのブロックに出られる人の模擬のピース。🔒 = このブロックしか出られない人 (先に置く) / ほかのブロック名 / 被り / 置いた所
// DOM 非依存。node tests/run-tests.mjs で検証
// ============================================================================
(function (root) {
    'use strict';
    const pc = () => root.planChainDomain;
    const rb = () => root.raidBlocksDomain;
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    const EPS = 0.05;   // B (表示の丸め・撃破の判定)

    /** 📌 ブロックの仮置きの行 → どのブロックか (添字)。ブロックの行でなければ / 合わなければ -1 */
    function pinBlockIdx(pin, blocks) {
        if (!pin || pin.time_mode !== 'block') return -1;
        const from = Number(pin.block_from), to = Number(pin.block_to);
        return (Array.isArray(blocks) ? blocks : []).findIndex(b => Number(b.from) === from && Number(b.to) === to);
    }
    /** 手で置いた駒 (いまの予約の行のうち 📌 で、ブロックの仮置き) */
    function blockPins(rows) {
        return (Array.isArray(rows) ? rows : []).filter(r => r && r.status === 'pinned' && r.time_mode === 'block');
    }

    /**
     * 手で置いた駒 (そのブロックの 📌) をプランの形にする。時刻はブロックの頭 (ブロックの中のいつかは算出が決める)。
     * @param {Object[]} pins   blockPins の行
     * @param {{fromIdx:number, from:number, to:number}} block
     * @param {number} level    このブロックで挑むレベル (overview)
     * @param {Object[]} bosses 盤面のボス (boss_number / weakness / name)
     * @param {Object[]} players 盤面の人 (名前を引く)
     */
    function pinsPlan(pins, block, level, bosses, players) {
        const byNum = new Map((Array.isArray(bosses) ? bosses : []).map(b => [Number(b.boss_number), b]));
        const nameOf = new Map((Array.isArray(players) ? players : []).map(p => [String(p.id), p.name]));
        const list = (Array.isArray(pins) ? pins : []).filter(r => r && Number(r.block_from) === Number(block.from) && Number(r.block_to) === Number(block.to));
        const bossRows = new Map();
        for (const r of list) {
            const n = Number(r.boss_number);
            const b = byNum.get(n);
            if (!bossRows.has(n)) bossRows.set(n, { bossNumber: n, name: b ? (b.name || b.boss_code) : `B${n}`, weakness: b ? b.weakness : null, attacks: [] });
            bossRows.get(n).attacks.push({
                memberId: r.player_id, memberName: nameOf.get(String(r.player_id)) || r.player_name || null,
                dmgB: Number(r.expected_damage_b) || 0, team: Array.isArray(r.characters_snapshot) ? r.characters_snapshot.filter(Boolean) : [],
                loadoutSlot: Number(r.loadout_slot) || 1, hourIdx: Number(block.fromIdx), hourLabel: null,
                pinned: true, reservationId: Number(r.id),
            });
        }
        const infinite = Number(level) >= 4;
        return { pinsOnly: true, startLevel: Number(level) || 1, levels: bossRows.size ? [{ level: infinite ? 4 : Number(level) || 1, infinite, bosses: [...bossRows.values()] }] : [] };
    }

    /** プランの凸のうち、このブロックの範囲・このレベルのもの (時刻の順) */
    function attacksAt(plan, block, level) {
        const all = pc() ? pc().attacksIn(plan, block) : [];
        return all.filter(a => (Number(level) >= 4 ? a.level >= 4 : Number(a.level) === Number(level)));
    }

    /**
     * ブロックごとの様子。first より前のブロックは「済み」(past)。first から順に、組んだ凸 (planOf) を実行したことにして盤面を進める。
     * ★ レベルはブロックの頭でしか変わらない: あるブロックで 5 体とも撃破したら、次のブロックが次のレベル。同じブロックの残りは使わない
     * @param {{ board:{season,bosses,players}, blocks:Object[], first?:number, planOf:(idx:number)=>Object|null, hpOf:(level:number, tier:string)=>number }} a
     * @returns {Array<{ idx:number, past:boolean, level:number, rows:Array<{bossNumber,name,weakness,tier,infinite,startB,gotB,remB,done,pieces:Object[]}>,
     *   allDone:boolean, attacks:number, people:number, startBoard:Object|null, done:Object[] }>}
     */
    function overview({ board, blocks, first = 0, planOf, hpOf } = {}) {
        const out = [];
        let cur = board ? { season: board.season, bosses: board.bosses, players: board.players } : null;
        (Array.isArray(blocks) ? blocks : []).forEach((blk, idx) => {
            if (idx < first || !cur) { out.push({ idx, past: idx < first, level: null, rows: [], allDone: false, attacks: 0, people: 0, startBoard: null, done: [] }); return; }
            const level = Number(cur.season && cur.season.current_level) || 1;
            const plan = typeof planOf === 'function' ? planOf(idx, level, cur) : null;
            const atk = plan ? attacksAt(plan, blk, level) : [];
            const rows = (Array.isArray(cur.bosses) ? cur.bosses : []).slice().sort((x, y) => Number(x.boss_number) - Number(y.boss_number))
                .filter(b => level <= 3 || Number(b.boss_number) === 5)
                .map(b => {
                    const n = Number(b.boss_number);
                    const infinite = level >= 4;
                    const startB = infinite ? 0 : Math.max(0, (Number(b.remaining_hp_raw) || 0) / 1e9);
                    const pieces = atk.filter(a => Number(a.bossNumber) === n);
                    const gotB = pieces.reduce((t, a) => t + (Number(a.dmgB) || 0), 0);
                    return { bossNumber: n, name: b.name || b.boss_code || `B${n}`, weakness: b.weakness || null, tier: b.tier || 'lord', infinite,
                        startB, gotB, remB: infinite ? 0 : Math.max(0, startB - gotB), done: !infinite && gotB >= startB - EPS, pieces };
                });
            const allDone = level <= 3 && rows.length > 0 && rows.every(r => r.done);
            const proj = (plan && pc()) ? pc().projectBoard(cur, plan, blk, { hpOf, levelLockInBlock: true }) : null;
            out.push({ idx, past: false, level, rows, allDone, attacks: atk.length, people: new Set(atk.map(a => String(a.memberId))).size,
                startBoard: cur, done: proj ? proj.done : [] });
            if (proj) cur = { season: proj.season, bosses: proj.bosses, players: proj.players };
        });
        return out;
    }

    /** その人が出られるブロック (添字)。凸数 (blockCounts) を言っていれば、凸数が 1 以上のブロックだけ。時間未登録は [] */
    function availableBlocks(p, blocks) {
        const bl = Array.isArray(blocks) ? blocks : [];
        if (!p) return [];
        if (p.flexTime) return bl.map((_, i) => i);
        const slots = Array.isArray(p.availableSlots) ? p.availableSlots : [];
        if (!slots.length) return [];
        let idxs = rb() ? rb().blocksOfSlots(bl, slots) : [];
        const counts = p.blockCounts && typeof p.blockCounts === 'object' && !Array.isArray(p.blockCounts) ? p.blockCounts : null;
        if (counts && Object.keys(counts).length && rb()) {
            const withN = idxs.filter(i => Number(counts[rb().countKey ? rb().countKey(bl[i]) : `${bl[i].from}-${bl[i].to}`]) > 0);
            if (withN.length) idxs = withN;
        }
        return idxs;
    }

    /**
     * そのブロックに置ける模擬のピース (出られる人だけ)。
     * @param {{ board:{players}, blocks:Object[], idx:number, bossOrder?:string[], placed?: Map<string, number>, pins?: Map<string, {blockIdx:number, id:number}> }} a
     *   board = そのブロックの始まりの盤面 (overview の startBoard) / placed = 鍵 'memberId:attr:slot' → 置いたブロックの添字 (組んだ全ブロック)
     *   pins = 同じ鍵 → 📌 (どのブロックの・予約の id) / bossOrder = 属性の並び (ボス 1〜5 の弱点の順)
     * @returns {Array<{ key, memberId, name, attr, slot, dmgB, team, rigid:boolean, others:string[], remaining:number, dup:boolean,
     *   placedIdx:number|null, pinId:number|null, blocked:string|null }>}  並び: 🔒 → 出られるブロックの少ない順 → ボスの順 → ダメージの大きい順
     */
    function trayPieces({ board, blocks, idx, bossOrder = null, placed = null, pins = null } = {}) {
        const bl = Array.isArray(blocks) ? blocks : [];
        const blk = bl[idx];
        if (!blk) return [];
        const order = Array.isArray(bossOrder) && bossOrder.length ? bossOrder : Object.keys(ATTR_JP);
        const placedMap = placed instanceof Map ? placed : new Map();
        const pinMap = pins instanceof Map ? pins : new Map();
        const out = [];
        for (const p of (board && Array.isArray(board.players) ? board.players : [])) {
            if (!p || p.unavailableThisSeason || p.archived) continue;
            const avail = availableBlocks(p, bl);
            if (!avail.includes(idx)) continue;
            const remaining = Math.max(0, 3 - (Number(p.attackCount) || 0));
            const lo = p.loadoutsByAttr && typeof p.loadoutsByAttr === 'object' ? p.loadoutsByAttr : {};
            const mine = [];
            for (const attr of Object.keys(lo)) for (const l of (Array.isArray(lo[attr]) ? lo[attr] : [])) {
                if (!l || !(Number(l.dmgB) > 0)) continue;
                const slot = Number(l.slot) || 1;
                const key = `${p.id}:${attr}:${slot}`;
                mine.push({ key, memberId: p.id, name: p.name, attr, slot, dmgB: Number(l.dmgB), team: Array.isArray(l.team) ? l.team.filter(Boolean).map(String) : [],
                    rigid: avail.length === 1, others: avail.filter(i => i !== idx).map(i => bl[i].name), remaining,
                    placedIdx: placedMap.has(key) ? placedMap.get(key) : null, pinId: pinMap.has(key) ? pinMap.get(key).id : null, dup: false, blocked: null });
            }
            for (const x of mine) for (const y of mine) if (x !== y && x.team.length && y.team.length && x.team.some(c => y.team.includes(c))) { x.dup = true; y.dup = true; }
            // 置いた編成と被る編成は使えない (同じキャラは 1 日 1 回)
            for (const x of mine) {
                if (x.placedIdx != null) continue;
                const mate = mine.find(y => y !== x && y.placedIdx != null && x.team.length && y.team.length && x.team.some(c => y.team.includes(c)));
                if (mate) x.blocked = 'dup';
            }
            out.push(...mine);
        }
        const rank = (a) => order.indexOf(a.attr) < 0 ? 99 : order.indexOf(a.attr);
        const nAvail = new Map(out.map(x => [String(x.memberId), x.others.length]));
        out.sort((a, b) => (Number(b.rigid) - Number(a.rigid)) || ((nAvail.get(String(a.memberId)) || 0) - (nAvail.get(String(b.memberId)) || 0))
            || (rank(a) - rank(b)) || (b.dmgB - a.dmgB) || (String(a.memberId) < String(b.memberId) ? -1 : String(a.memberId) > String(b.memberId) ? 1 : 0) || (a.slot - b.slot));
        return out;
    }

    /**
     * ピースをボスの行に置けるか (手で置く前の判定。DB の仮置きの判定 = reservationsDomain.canPin は画面が別に見る)。
     * @returns {{ ok:true }|{ ok:false, label:string }}
     */
    function canDrop({ piece, row, level, usedHere = 0 } = {}) {
        if (!piece) return { ok: false, label: '先にピースを選んでください' };
        if (!row) return { ok: false, label: 'ボスがありません' };
        if (piece.placedIdx != null) return { ok: false, label: 'このピースはもう置いてあります (置いた駒を押すと外せます)' };
        if (piece.blocked === 'dup') return { ok: false, label: `${piece.name} の別の編成とキャラが被ります (同じキャラは 1 日 1 回)` };
        if (row.weakness !== piece.attr) return { ok: false, label: `${ATTR_JP[piece.attr] || piece.attr}PT は ${row.name} (弱点 ${ATTR_JP[row.weakness] || row.weakness}) には効きません` };
        if (row.done) return { ok: false, label: `${row.name} は Lv${level} で撃破済みです (次のレベルは次のブロックから)` };
        if (Number(piece.remaining) - Number(usedHere || 0) <= 0) return { ok: false, label: `${piece.name} は 3 凸を使い切っています` };
        return { ok: true };
    }

    root.blockBuildDomain = { pinBlockIdx, blockPins, pinsPlan, attacksAt, overview, availableBlocks, trayPieces, canDrop, EPS };
})(typeof window !== 'undefined' ? window : globalThis);
