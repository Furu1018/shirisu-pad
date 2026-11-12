// ============================================================================
// ドメイン: 凸プランを組む (シンプル化 S2・2026-10-26 ふるりの構想・設計案 docs/シンプル化_設計案_2026-10-26.md §6)
// ----------------------------------------------------------------------------
// 「朝 5〜8時 を組む」のような大きなボタンを 6 つ並べ、押したブロックに 出られる人の模擬 を手で置く → 残りを自動で組む。
// ここは純ロジックだけ:
//   - overview: ブロックごとに「挑むレベル・ボスごとの始まりの HP・置いた凸・残り」(★ レベルはブロックの頭でしか変わらない)。
//     前のブロックで組んだ凸を「模擬どおり削れた」と仮定して盤面を進める (planChainDomain.projectBoard の levelLockInBlock)
//   - pinsPlan: 手で置いた駒 (📌 ブロックの仮置き = plan_reservations status 'pinned' / time_mode 'block') を、プランの形にする
//   - trayPieces: そのブロックに出られる人の模擬のピース。「このブロックのみ」「このブロックで最後」(lockKind・先に置く) / ほかのブロック名 / 被り / 置いた所
//   - lockOutlook / bossState: 「このブロックのみ / 最後」の人の凸が置けるかの見込み (第46回の反省 ②・2026-11-02 ふるり)。見せるだけ — 🧮 に「必ず置く」は入れない
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
    /**
     * ブロックに置かれている駒 (いまの予約の行のうちブロックのもの): 📌 手で置いた駒 (status 'pinned') と、
     * 拘束になる約束 (isFixed = 承認済みの 🔒 予約・9b で運営が登録した予約。外せない) — どちらもそのブロックの凸として数える (レビュー: 約束を数えないと 4 凸目を置けた)
     */
    function blockPins(rows, isFixed) {
        const fixed = typeof isFixed === 'function' ? isFixed : () => false;
        return (Array.isArray(rows) ? rows : []).filter(r => r && r.time_mode === 'block' && (r.status === 'pinned' || fixed(r)));
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
                pinned: r.status === 'pinned', fromReservation: r.status !== 'pinned', reservationId: Number(r.id),
            });
        }
        const infinite = Number(level) >= 4;
        return { pinsOnly: true, startLevel: Number(level) || 1, levels: bossRows.size ? [{ level: infinite ? 4 : Number(level) || 1, infinite, bosses: [...bossRows.values()] }] : [] };
    }

    /**
     * ブロックの駒 (📌・約束) の指紋。pinsPlan と自動で組むときの拘束が読む値をすべて含む
     * (人・ボス・編成の番号・状態・ダメージ・キャラ)。自動で組んだときの指紋と違えば、その自動の結果は古い。
     */
    function pinsFingerprint(pins, blocks, idx) {
        return (Array.isArray(pins) ? pins : []).filter(r => r && pinBlockIdx(r, blocks) === idx)
            .map(r => JSON.stringify([Number(r.id), String(r.status), String(r.player_id), Number(r.boss_number), Number(r.loadout_slot) || 1,
                Number(r.expected_damage_b) || 0, Array.isArray(r.characters_snapshot) ? r.characters_snapshot.map(String) : []]))
            .sort().join('|');
    }

    /**
     * 🔄 ほかの運営が駒を置いた・外した の差分 (2026-11-12 ふるり「運営が複数人で組むとき、ほかの運営が組んだ結果が反映されるとうれしい」)。
     * 前に読んだ予約の行と、いま読んだ行の「ブロックの駒」(blockPins) を id で突き合わせる。見せるだけ (どの結果を捨てるかは指紋 _obPinsFp のまま)。
     * ★ 呼ぶ側は ✓ で実行済みになった駒を実行前に戻した行 (_obFpRows) を渡す — ✓ を付けただけで「外れた」と言わない
     * @returns {Array<{ kind:'placed'|'moved'|'changed'|'removed', id:number, playerId, bossNumber:number, slot:number, dmgB:number, blockIdx:number, by:string|null, fixed:boolean,
     *   fromBlockIdx?:number, fromBossNumber?:number }>}  by = 置いた人 (pinned_by)。removed の by は外した人 (released_by・分からなければ null)
     */
    function pinChanges(prevRows, nextRows, blocks, isFixed) {
        const idx = (rows) => new Map(blockPins(rows, isFixed).map(r => [Number(r.id), r]));
        const a = idx(prevRows), b = idx(nextRows);
        const view = (r) => ({ id: Number(r.id), playerId: r.player_id, bossNumber: Number(r.boss_number), slot: Number(r.loadout_slot) || 1,
            dmgB: Number(r.expected_damage_b) || 0, blockIdx: pinBlockIdx(r, blocks), by: r.pinned_by || null, fixed: r.status !== 'pinned' });
        const body = (r) => JSON.stringify([String(r.status), String(r.player_id), Number(r.loadout_slot) || 1, Number(r.expected_damage_b) || 0,
            Array.isArray(r.characters_snapshot) ? r.characters_snapshot.map(String) : []]);
        const out = [];
        for (const [id, r] of b) {
            const p = a.get(id);
            if (!p) out.push({ kind: 'placed', ...view(r) });
            else if (pinBlockIdx(p, blocks) !== pinBlockIdx(r, blocks) || Number(p.boss_number) !== Number(r.boss_number))
                out.push({ kind: 'moved', ...view(r), fromBlockIdx: pinBlockIdx(p, blocks), fromBossNumber: Number(p.boss_number) });
            else if (body(p) !== body(r)) out.push({ kind: 'changed', ...view(r) });
        }
        // 外した人は、いまの行 (status 'released') の released_by に残る (行ごと消えていれば分からない = null)
        const now = new Map((Array.isArray(nextRows) ? nextRows : []).filter(Boolean).map(r => [Number(r.id), r]));
        for (const [id, r] of a) if (!b.has(id)) out.push({ kind: 'removed', ...view(r), by: (now.get(id) && now.get(id).released_by) || null });
        return out;
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
        // Lv3 を倒した盤面は Lv4 (ボス 5 だけ・HP 無限) として読む (S4 レビュー [1]: そのままだと全ブロックが「Lv3 撃破済み」で何も置けない)
        let cur = board ? ((pc() && pc().liveBoard) ? pc().liveBoard({ season: board.season, bosses: board.bosses, players: board.players }) : { season: board.season, bosses: board.bosses, players: board.players }) : null;
        (Array.isArray(blocks) ? blocks : []).forEach((blk, idx) => {
            if (idx < first || !cur) { out.push({ idx, past: idx < first, level: null, rows: [], allDone: false, attacks: 0, people: 0, startBoard: null, done: [], skipped: [] }); return; }
            const level = Number(cur.season && cur.season.current_level) || 1;
            const plan = typeof planOf === 'function' ? planOf(idx, level, cur) : null;
            const proj = (plan && pc()) ? pc().projectBoard(cur, plan, blk, { hpOf, levelLockInBlock: true }) : null;
            // ★ 数えるのは実行したことになる凸だけ (projectBoard が 3 凸済み・キャラ被り・踏破のあと・Lv4 のボス 5 以外 を飛ばす)。飛ばした駒は skipped に分けて見せる (レビュー)
            const pool = new Map();
            for (const d of (proj ? proj.done : [])) { const k = `${d.memberId}|${d.bossNumber}|${d.loadoutSlot}`; pool.set(k, (pool.get(k) || 0) + 1); }
            const all = plan && pc() ? pc().attacksIn(plan, blk) : [];
            const atk = [], skipped = [];
            for (const a of all) {
                const k = `${a.memberId}|${a.bossNumber}|${Number(a.loadoutSlot) || 1}`;
                if ((pool.get(k) || 0) > 0) { pool.set(k, pool.get(k) - 1); atk.push(a); } else skipped.push(a);
            }
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
            out.push({ idx, past: false, level, rows, allDone, attacks: atk.length, people: new Set(atk.map(a => String(a.memberId))).size,
                startBoard: cur, done: proj ? proj.done : [], skipped });
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
     * @returns {Array<{ key, memberId, name, attr, slot, dmgB, team, rigid:boolean, kind:('only'|'lastOnly'|'last'|null), avail:number[], others:string[] (short), othersPast:boolean, remaining:number, dup:boolean,
     *   placedIdx:number|null, pinId:number|null, blocked:string|null }>}  並び: このブロックのみ (と実質このブロックだけ) → このブロックで最後 → 出られるブロックの少ない順 → ボスの順 → ダメージの大きい順。
     *   first = いまのブロック (lockKind の「ほかは済」に使う。省略は 0)
     */
    /** ISO の時刻 → レイド日の時間帯の添字 (5 時 = 0・JST)。読めなければ null */
    function hourIdxOfIso(iso) {
        const t = Date.parse(typeof iso === 'string' ? iso : '');
        if (!Number.isFinite(t)) return null;
        const h = new Date(t + 9 * 3600000).getUTCHours();
        return (h - 5 + 24) % 24;
    }
    /**
     * 済んだ凸がこのブロックのものか。✓ 凸しました の行 (plan_key あり) は鍵の先頭 'from-to' で決める — reported_at は ✓ を押した時刻で、
     * 遅れて押した ✓・運営があとで付けた ✓ が次のブロックの凸数を食う (S4 レビュー [11][17])。それ以外は報告の時刻
     */
    function inBlockOf(a, blk) {
        if (!a || !blk) return false;
        const pk = typeof a.plan_key === 'string' ? a.plan_key : '';
        if (pk) return pk.split('|')[0] === `${Number(blk.from)}-${Number(blk.to)}`;
        const h = hourIdxOfIso(a.reported_at);
        return h != null && h >= blk.fromIdx && h <= blk.toIdx;
    }
    /**
     * 「このブロックのみ」「このブロックで最後」(第46回の反省 ②・2026-11-02 ふるり Q3: 🔒 の印をやめて文字で)。
     *   only = 出られるブロックが 1 つ / last = 後ろに出られるブロックが無い (ほかにもある) / lastOnly = last のうち、ほかのブロックがもう過ぎた (first より前) = 実質このブロックだけ
     * @param {number[]} avail その人が出られるブロック (availableBlocks) / idx = 見ているブロック / first = いまのブロック (それより前は過ぎた)
     * @returns {'only'|'lastOnly'|'last'|null}
     */
    function lockKind(avail, idx, first = 0) {
        const a = Array.isArray(avail) ? avail.map(Number) : [];
        if (!a.includes(Number(idx))) return null;
        if (a.length === 1) return 'only';
        if (!a.every(i => i <= Number(idx))) return null;
        return a.every(i => i === Number(idx) || i < Number(first)) ? 'lastOnly' : 'last';
    }

    /**
     * そのブロックで、その属性の相手ボスに置けるか (overview の結果で)。
     *   atStart = true: ブロックの始まりの盤面で見る (見込み: このブロックの駒は入れ替えられるので数えない) / false: このブロックに置いた駒も入れて見る (いま置けるか = canDrop と同じ)
     * @returns {{ ok:true, row, level }|{ ok:false, why:'lv4'|'none'|'killed'|'killedHere', row?, level, killedIn?:number|null }|null}  null = 過ぎた・無いブロック
     *   killedIn = 撃破の見込みのブロック (同じレベルで、そのボスの行が撃破になった最初のブロック)。null = 組む前から撃破済み (実際の凸)
     */
    function bossState({ ov, idx, first = 0, attr, atStart = false } = {}) {
        const list = Array.isArray(ov) ? ov : [];
        const o = list[idx];
        if (!o || o.past) return null;
        const row = (o.rows || []).find(r => r.weakness === attr) || null;
        if (!row) return { ok: false, why: Number(o.level) >= 4 ? 'lv4' : 'none', level: o.level };
        if (row.infinite) return { ok: true, row, level: o.level };
        const deadAtStart = !(Number(row.startB) > EPS);
        if (!deadAtStart && (atStart || !row.done)) return { ok: true, row, level: o.level };
        if (!deadAtStart) return { ok: false, why: 'killedHere', row, level: o.level, killedIn: idx };
        let killedIn = null;
        for (let j = Math.max(0, Number(first) || 0); j < idx; j++) {
            const x = list[j];
            if (!x || x.past || Number(x.level) !== Number(o.level)) continue;
            const r = (x.rows || []).find(y => Number(y.bossNumber) === Number(row.bossNumber));
            // ★ そのブロックの始まりに生きていて、そのブロックで倒れた行だけ (始まりから HP 0 の行も done になる — 組む前から撃破済みのボスを
            //   「いまのブロックで撃破する見込み」と言っていた: Codex + レビュー 2026-11-02)
            if (r && Number(r.startB) > EPS && r.done) { killedIn = j; break; }
        }
        return { ok: false, why: 'killed', row, level: o.level, killedIn };
    }

    /**
     * ブロックごとの「このブロックのみ / このブロックで最後 (ほかは済)」の人と、その人の凸が置けるかの見込み (第46回の反省 ②・2026-11-02 ふるり)。
     * ★ 見せるだけ (止めない・🧮 に「必ず置く」は入れない: Q2「そのルールに引っ張られて総合スコアが減るときもある」)。
     * 見込みはブロックの始まりの盤面 (overview = 前のブロックまでを組んだとおりに実行した盤面) で、その人の模擬の相手ボスが残っているか。
     *   残っていなければ、どのブロックで撃破の見込みか と、そのレベルで残っているボス (= 5 体倒すと次のブロックから次のレベル)
     * 載せるのは only と lastOnly だけ (last = 後ろが無いだけの人は、手前のブロックにも出られる — 全員の最後のブロックに名前が並ぶのを避ける。ピース置き場には文字で出す)
     * @param {{ ov:Object[], blocks:Object[], first?:number, trayOf:(idx:number)=>Object[] }} a  trayOf = そのブロックのピース (trayPieces と同じ判定)
     * @returns {Array<{ idx:number, past:boolean, only:number, lastOnly:number, ng:number,
     *   people:Array<{ memberId, name, kind:'only'|'lastOnly', others:string[], attrs:Array<{attr,dmgB,slot}>, state:'placed'|'none'|'ok'|'ng',
     *     placed:Array<{bossNumber,dmgB}>, best:{attr,bossNumber,dmgB,remB:number|null,infinite:boolean}|null,
     *     reasons:Array<{attr, why:'killed'|'killedHere'|'lv4'|'none'|'placedElsewhere'|'blocked', bossNumber?, name?, killedIn?, placedIdx?, past?:boolean}> }>,
     *   level:number|null, left:number[] }>}  left = ブロックの始まりにそのレベルで残っているボス (無限は除く)
     */
    function lockOutlook({ ov, blocks, first = 0, trayOf } = {}) {
        const bl = Array.isArray(blocks) ? blocks : [];
        const list = Array.isArray(ov) ? ov : [];
        return bl.map((blk, idx) => {
            const o = list[idx] || null;
            if (!o || o.past || typeof trayOf !== 'function') return { idx, past: !!(o && o.past), only: 0, lastOnly: 0, ng: 0, people: [], level: o ? o.level : null, left: [] };
            const byMember = new Map();
            for (const p of (trayOf(idx) || [])) {
                if (!p || (p.kind !== 'only' && p.kind !== 'lastOnly')) continue;
                const k = String(p.memberId);
                if (!byMember.has(k)) byMember.set(k, { memberId: p.memberId, name: p.name, kind: p.kind, others: Array.isArray(p.others) ? p.others : [], pieces: [] });
                byMember.get(k).pieces.push(p);
            }
            const left = (o.rows || []).filter(r => !r.infinite && Number(r.startB) > EPS).map(r => Number(r.bossNumber));
            const people = [...byMember.values()].map(m => {
                const placed = [];
                for (const r of (o.rows || [])) for (const a of (r.pieces || [])) if (String(a.memberId) === String(m.memberId)) placed.push({ bossNumber: Number(r.bossNumber), dmgB: Number(a.dmgB) || 0 });
                const attrs = m.pieces.map(p => ({ attr: p.attr, dmgB: Number(p.dmgB) || 0, slot: Number(p.slot) || 1 }));
                const remaining = Math.max(...m.pieces.map(p => Number(p.remaining) || 0), 0);
                const base = { memberId: m.memberId, name: m.name, kind: m.kind, others: m.others, attrs, placed, best: null, reasons: [] };
                if (placed.length) return { ...base, state: 'placed' };
                if (remaining <= 0) return { ...base, state: 'none' };
                const cands = m.pieces.filter(p => !p.blocked && p.placedIdx == null);
                // このブロックに置いたのに実行されない駒 (前のブロックで相手が倒れた など — overview の skipped) と、別のブロックに置いたままの駒も理由に入れる
                //   (入れないと「キャラ使用済み・被り」と言い、この機能がいちばん見せたい「前のブロックで撃破」が出なかった: レビュー 2026-11-02)
                const stuck = m.pieces.filter(p => !p.blocked && p.placedIdx === idx);
                const elsewhere = m.pieces.filter(p => !p.blocked && p.placedIdx != null && p.placedIdx !== idx);
                let best = null;
                const reasons = [];
                for (const p of [...cands, ...stuck]) {
                    // 実行されない駒 (stuck) はいまの盤 (このブロックの駒も入れる) で見る — 始まりに生きていた相手を、このブロックの別の駒が先に倒した (killedHere) を言う (再レビュー)
                    const st = bossState({ ov: list, idx, first, attr: p.attr, atStart: !stuck.includes(p) });
                    if (st && st.ok) {
                        if (cands.includes(p) && (!best || p.dmgB > best.dmgB)) best = { attr: p.attr, bossNumber: Number(st.row.bossNumber), dmgB: Number(p.dmgB) || 0, remB: st.row.infinite ? null : Number(st.row.startB), infinite: !!st.row.infinite };
                    } else if (st && !reasons.some(x => x.attr === p.attr)) {
                        reasons.push({ attr: p.attr, why: st.why, ...(st.row ? { bossNumber: Number(st.row.bossNumber), name: st.row.name } : {}), ...(st.why === 'killed' ? { killedIn: st.killedIn } : {}) });
                    }
                }
                if (best) return { ...base, state: 'ok', best };
                // 別のブロックに置いたままの駒: 相手のボスがこのブロックの始まりにいなければ、そちらが理由 (外しても置けない: 再レビュー)。past = 置き先が過ぎたブロック (開けない)
                for (const p of elsewhere) if (!reasons.some(x => x.attr === p.attr)) {
                    const st = bossState({ ov: list, idx, first, attr: p.attr, atStart: true });
                    reasons.push(st && !st.ok
                        ? { attr: p.attr, why: st.why, ...(st.row ? { bossNumber: Number(st.row.bossNumber), name: st.row.name } : {}), ...(st.why === 'killed' ? { killedIn: st.killedIn } : {}) }
                        : { attr: p.attr, why: 'placedElsewhere', placedIdx: p.placedIdx, past: !!(list[p.placedIdx] && list[p.placedIdx].past) });
                }
                return { ...base, state: 'ng', reasons: reasons.length ? reasons : [{ attr: null, why: 'blocked' }] };
            });
            return { idx, past: false, level: o.level, left, people,
                only: people.filter(p => p.kind === 'only').length, lastOnly: people.filter(p => p.kind === 'lastOnly').length, ng: people.filter(p => p.state === 'ng').length };
        });
    }

    function trayPieces({ board, blocks, idx, bossOrder = null, placed = null, pins = null, laterUse = null, first = 0 } = {}) {
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
            // 残り凸 = 1 日の残り (始まりの盤面 = 前のブロックの凸は済んだこと) − 後ろのブロックに置いた数。凸数を言った人は、このブロックの凸数 − このブロックで済んだ数 まで (レビュー)
            const later = laterUse instanceof Map ? (Number(laterUse.get(String(p.id))) || 0) : 0;
            let remaining = Math.max(0, 3 - (Number(p.attackCount) || 0) - later);
            const counts = p.blockCounts && typeof p.blockCounts === 'object' && !Array.isArray(p.blockCounts) ? p.blockCounts : null;
            const ck = rb() && rb().countKey ? rb().countKey(blk) : `${blk.from}-${blk.to}`;
            if (counts && Object.keys(counts).length && Number(counts[ck]) > 0) {
                const doneHere = (Array.isArray(p.attacks) ? p.attacks : []).filter(a => inBlockOf(a, blk)).length;
                remaining = Math.min(remaining, Math.max(0, Number(counts[ck]) - doneHere));
            }
            // きょう使ったキャラ (実際の凸 + 前のブロックで済んだことにした凸) を含む編成は使えない (同じキャラは 1 日 1 回: レビュー高)
            const usedChars = new Set((Array.isArray(p.attacks) ? p.attacks : []).flatMap(a => Array.isArray(a && a.characters) ? a.characters : []).map(String));
            const lo = p.loadoutsByAttr && typeof p.loadoutsByAttr === 'object' ? p.loadoutsByAttr : {};
            // 「このブロックのみ / このブロックで最後」(Q3)。ほかのブロックは時計の言い方の短い名前 (short = 「A 朝」・名前は任意なので name から組まない: 2026-10-30)
            const kind = lockKind(avail, idx, first);
            const others = avail.filter(i => i !== idx).map(i => bl[i].short || bl[i].name || bl[i].letter || '');
            const othersPast = avail.filter(i => i !== idx).every(i => i < Number(first));
            const mine = [];
            for (const attr of Object.keys(lo)) for (const l of (Array.isArray(lo[attr]) ? lo[attr] : [])) {
                if (!l || !(Number(l.dmgB) > 0)) continue;
                const slot = Number(l.slot) || 1;
                const key = `${p.id}:${attr}:${slot}`;
                mine.push({ key, memberId: p.id, name: p.name, attr, slot, dmgB: Number(l.dmgB), team: Array.isArray(l.team) ? l.team.filter(Boolean).map(String) : [],
                    rigid: avail.length === 1, kind, avail: avail.slice(), others, othersPast, remaining,
                    placedIdx: placedMap.has(key) ? placedMap.get(key) : null, pinId: pinMap.has(key) ? pinMap.get(key).id : null, dup: false, blocked: null });
            }
            for (const x of mine) for (const y of mine) if (x !== y && x.team.length && y.team.length && x.team.some(c => y.team.includes(c))) { x.dup = true; y.dup = true; }
            // 置いた編成と被る編成は使えない (同じキャラは 1 日 1 回)
            for (const x of mine) {
                if (x.placedIdx != null) continue;
                if (x.team.some(c => usedChars.has(c))) { x.blocked = 'used'; continue; }
                const mate = mine.find(y => y !== x && y.placedIdx != null && x.team.length && y.team.length && x.team.some(c => y.team.includes(c)));
                if (mate) x.blocked = 'dup';
            }
            out.push(...mine);
        }
        const rank = (a) => order.indexOf(a.attr) < 0 ? 99 : order.indexOf(a.attr);
        const nAvail = new Map(out.map(x => [String(x.memberId), x.others.length]));
        // 並び: このブロックのみ・実質このブロックだけ (lastOnly) → このブロックで最後 → ほかにも出られる人 (出られるブロックの少ない順)
        const pri = (x) => (x.kind === 'only' || x.kind === 'lastOnly') ? 0 : (x.kind === 'last' ? 1 : 2);
        out.sort((a, b) => (pri(a) - pri(b)) || ((nAvail.get(String(a.memberId)) || 0) - (nAvail.get(String(b.memberId)) || 0))
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
        if (piece.blocked === 'used') return { ok: false, label: `${piece.name} のこの編成のキャラは、きょうもう使っています (同じキャラは 1 日 1 回)` };
        if (row.weakness !== piece.attr) return { ok: false, label: `${ATTR_JP[piece.attr] || piece.attr}PT は ${row.name} (弱点 ${ATTR_JP[row.weakness] || row.weakness}) には効きません` };
        if (row.done) return { ok: false, label: `${row.name} は Lv${level} で撃破済みです (次のレベルは次のブロックから)` };
        if (Number(piece.remaining) - Number(usedHere || 0) <= 0) return { ok: false, label: `${piece.name} はこのブロックで置ける凸がありません (3 凸 / 凸数の希望 / 後ろのブロックに置いた分)` };
        return { ok: true };
    }

    /**
     * 🧭 ピースのガイド (2026-11-12 ふるり「ピースを握ったとき・ポイントしたときに、そのメンバーのほかに凸できる時間・編成・ダメージ、
     *   この編成を使うことでほかの編成にどう影響するかを見たい」)。見せるだけ (置けるかの判定は canDrop / bossState のまま・増やさない)。
     * @param {{ piece:Object, tray:Object[], ov:Object[], idx:number, first?:number }} a  piece / tray = trayPieces の結果 (同じブロック)
     * @returns {null|{ piece:Object,
     *   mates:Array<{ key, attr, slot, dmgB, team:string[], hit:string[], state:'placed'|'used'|'dup'|'clash'|'free', placedIdx:number|null }>,
     *     state: placed = もう置いてある / used = きょう使ったキャラを含む / dup = 置いた別の編成と被ってもう使えない / clash = この編成を使うと使えなくなる / free = 残る
     *   drop: null (もう置いてある) | { ok:true, bossNumber, name, infinite:boolean, remB:number|null, afterB:number|null, kill:boolean, overB:number } | { ok:false, st:Object (bossState) },
     *   total: null | { n:number, best:{ sumB:number, picks:Array<{attr,slot,dmgB}> }, withThis:{ sumB:number, picks:Array<{attr,slot,dmgB}> }, diffB:number } }}
     *   total = その人の残り n 凸 (このブロックで置ける数) で出せる合計 (模擬どおり・同じキャラは 1 日 1 回)。その人だけの数字 — ボスの残り HP・ほかの人は見ない
     */
    function pieceGuide({ piece, tray, ov, idx, first = 0 } = {}) {
        if (!piece) return null;
        const mine = (Array.isArray(tray) ? tray : []).filter(p => p && String(p.memberId) === String(piece.memberId));
        const teamOf = (p) => (Array.isArray(p.team) ? p.team : []);
        const shared = (a, b) => teamOf(a).filter(c => teamOf(b).includes(c));
        const mates = mine.filter(p => p.key !== piece.key).map(p => {
            const hit = shared(p, piece);
            const state = p.placedIdx != null ? 'placed' : (p.blocked === 'used' ? 'used' : (p.blocked === 'dup' ? 'dup' : (hit.length ? 'clash' : 'free')));
            return { key: p.key, attr: p.attr, slot: Number(p.slot) || 1, dmgB: Number(p.dmgB) || 0, team: teamOf(p).slice(), hit, state, placedIdx: p.placedIdx != null ? p.placedIdx : null };
        });
        let drop = null;
        if (piece.placedIdx == null) {
            const st = bossState({ ov, idx, first, attr: piece.attr });
            if (st && st.ok) {
                const row = st.row, inf = !!row.infinite;
                const after = inf ? null : Number(row.remB) - (Number(piece.dmgB) || 0);
                drop = { ok: true, bossNumber: Number(row.bossNumber), name: row.name, infinite: inf, remB: inf ? null : Number(row.remB),
                    afterB: inf ? null : Math.max(0, after), kill: !inf && after <= EPS, overB: inf ? 0 : Math.max(0, -after) };
            } else if (st) drop = { ok: false, st };
        }
        // その人の残り凸で出せる合計: まだ置いていない・使える編成から、キャラが被らない組を全部試す (編成は多くて十数個・凸は 3 つまで)
        let total = null;
        const n = Math.max(0, Math.min(3, Number(piece.remaining) || 0));
        const usable = (p) => p.placedIdx == null && !p.blocked && Number(p.dmgB) > 0;
        if (n > 0 && usable(piece)) {
            const pool = mine.filter(usable);
            const search = (must) => {
                let top = { sumB: must ? Number(must.dmgB) : 0, picks: must ? [must] : [] };
                const go = (i, picks, sum) => {
                    if (sum > top.sumB + 1e-9) top = { sumB: sum, picks: picks.slice() };
                    if (picks.length >= n) return;
                    for (let k = i; k < pool.length; k++) {
                        const p = pool[k];
                        if (picks.includes(p) || picks.some(q => shared(p, q).length)) continue;
                        picks.push(p); go(k + 1, picks, sum + Number(p.dmgB)); picks.pop();
                    }
                };
                go(0, must ? [must] : [], must ? Number(must.dmgB) : 0);
                return { sumB: top.sumB, picks: top.picks.map(p => ({ attr: p.attr, slot: Number(p.slot) || 1, dmgB: Number(p.dmgB) })) };
            };
            const best = search(null), withThis = search(piece);
            total = { n, best, withThis, diffB: withThis.sumB - best.sumB };
        }
        return { piece, mates, drop, total };
    }

    /**
     * 組んだプランから駒を 1 個だけ外す (元のプランは変えない・2026-10-31 ふるり「ピースは 1 つずつ外したい」)。
     * 同じカード (人 × ボス × 編成) はきょう 1 回なので、これで 1 個に決まる。fromIdx / toIdx = そのブロックの時間 (決定から読み戻したプランは全ブロックの凸を持つ)
     * @returns {{ plan:Object, removed:Object|null }}
     */
    function dropPiece(plan, { memberId, bossNumber, loadoutSlot, fromIdx = null, toIdx = null } = {}) {
        let removed = null;
        const inBlock = (a) => !Number.isInteger(a.hourIdx) || fromIdx == null || toIdx == null || (a.hourIdx >= fromIdx && a.hourIdx <= toIdx);
        const levels = (plan && Array.isArray(plan.levels) ? plan.levels : []).map(lv => {
            if (removed || !lv || !Array.isArray(lv.bosses)) return lv;
            return { ...lv, bosses: lv.bosses.map(b => {
                if (removed || !b || Number(b.bossNumber) !== Number(bossNumber) || !Array.isArray(b.attacks)) return b;
                const i = b.attacks.findIndex(a => a && String(a.memberId) === String(memberId) && (Number(a.loadoutSlot) || 1) === (Number(loadoutSlot) || 1) && inBlock(a));
                if (i < 0) return b;
                removed = b.attacks[i];
                return { ...b, attacks: b.attacks.filter((_, k) => k !== i) };
            }) };
        });
        return removed ? { plan: { ...plan, levels }, removed } : { plan, removed: null };
    }
    /** 盤面から模擬のカードを除く (鍵 'memberId:attr:slot')。🧮 に「外した駒」を使わせないため。元の盤面は変えない */
    function withoutPieces(board, keys) {
        const set = keys instanceof Set ? keys : new Set(Array.isArray(keys) ? keys : []);
        if (!board || !set.size) return board;
        return { ...board, players: (Array.isArray(board.players) ? board.players : []).map(p => {
            const lo = p && p.loadoutsByAttr;
            if (!lo || typeof lo !== 'object') return p;
            let changed = false;
            const nextLo = {}, nextD = { ...(p.damagesByAttr || {}) };
            for (const attr of Object.keys(lo)) {
                const list = Array.isArray(lo[attr]) ? lo[attr] : [];
                const kept = list.filter(l => !set.has(`${p.id}:${attr}:${Number(l && l.slot) || 1}`));
                if (kept.length !== list.length) changed = true;
                if (kept.length) nextLo[attr] = kept; else delete nextD[attr];   // その属性の編成が無くなったら旧形式のダメージからも落とす (ソルバーの予備の読み方で戻らないように)
            }
            return changed ? { ...p, loadoutsByAttr: nextLo, damagesByAttr: nextD } : p;
        }) };
    }

    root.blockBuildDomain = { pinBlockIdx, blockPins, pinsPlan, pinsFingerprint, attacksAt, overview, availableBlocks, inBlockOf, trayPieces, canDrop, hourIdxOfIso, dropPiece, withoutPieces, lockKind, bossState, lockOutlook, pieceGuide, pinChanges, EPS };
})(typeof window !== 'undefined' ? window : globalThis);
