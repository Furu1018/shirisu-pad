// ============================================================================
// ドメイン: 📈 消化のペース / 🔁 直近の動き (運営ボード 当日・段階4・2026-09-11)
// ----------------------------------------------------------------------------
// 当日の運営は交代しながら見る (ROADMAP「Q. 当日どう動いているか」)。引き継いだ人が
// 画面を開いて 10 秒で「いまどこまで消化していて、誰に何を頼んでいて、誰の返事を
// 待っているか」が読めるようにするための2枚。
//   📈 消化のペース … 時間帯ごとの凸数 + 「このペースなら何時に使い切るか」
//   🔁 直近の動き   … 締め凸の打診の状態 (主役) + 直近の凸 (添え)
// ★ 運営の交代そのもの (誰が当番か) は扱わない (ユーザー決定 2026-09-11)。
//
// ここは純ロジックだけ: 材料 (盤面の凸・締め凸依頼) → 描画用のモデル。DOM は index.html。
// 時刻は JST の「時」を返す hourOf(iso) を呼び出し側が渡す (Intl をここで持たない —
// optimal-plan.js の doneAttacksByHour と同じ作法)。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const MAX_ATTACKS = 3;
    const HOUR_MS = 3600 * 1000;

    const ms = (v) => { const t = Date.parse(typeof v === 'string' ? v.trim() : ''); return Number.isFinite(t) ? t : null; };

    /**
     * 📈 消化のペース。
     * @param {Object} args
     * @param {Object[]} args.attacks   当日の凸 ({reported_at, boss_number, ...}。盤面の players[].attacks を平らにしたもの)
     * @param {Object[]} args.players   盤面の players ({unavailableThisSeason})。定員 = 今回参加できる人 × 3
     * @param {number[]} args.hourOrder 5時始まりの並び (HOUR_ORDER)
     * @param {(iso:string)=>number|null} args.hourOf  ISO → JST の時 (読めなければ null)
     * @param {number} args.now         ms
     * @param {number=} args.windowMs   ペースを測る直近の幅 (既定 2 時間)
     * @param {number|null=} args.endMs レイド日の終わり (翌 5 時) の ms。null なら「使い切れない」判定をしない
     * @returns {{
     *   byHour: {hour:number, count:number, now:boolean, future:boolean}[],
     *   done:number, capacity:number, remaining:number, unknownTime:number,
     *   recentCount:number, windowHours:number, perHour:number,
     *   etaMs:number|null, exhausted:boolean, overrun:boolean
     * }}
     */
    function paceModel({ attacks, players, hourOrder, hourOf, now, windowMs = 2 * HOUR_MS, endMs = null } = {}) {
        const list = (Array.isArray(attacks) ? attacks : []).filter(a => a && a.boss_number != null);
        const ps = Array.isArray(players) ? players : [];
        const order = Array.isArray(hourOrder) ? hourOrder : [];
        const nowMs = Number.isFinite(now) ? now : Date.now();
        const hourFn = typeof hourOf === 'function' ? hourOf : () => null;

        // 定員 = 「今回は難しい」でない人 × 3。★ 凸が定員を超えていたら定員のほうを合わせる
        //   (難しいと申告した人が結局凸した — 数字が 34/33 のようにならないように)
        const done = list.length;
        const capacity = Math.max(done, ps.filter(p => p && !p.unavailableThisSeason).length * MAX_ATTACKS);
        const remaining = Math.max(0, capacity - done);

        // 時間帯ごとの本数
        const counts = new Map(order.map(h => [h, 0]));
        let unknownTime = 0;
        for (const a of list) {
            const at = typeof a.reported_at === 'string' ? a.reported_at.trim() : '';
            const h = at ? hourFn(at) : null;
            if (h == null || !counts.has(h)) { unknownTime += 1; continue; }
            counts.set(h, counts.get(h) + 1);
        }
        const nowHour = hourFn(new Date(nowMs).toISOString());
        const nowIdx = nowHour == null ? -1 : order.indexOf(nowHour);
        const byHour = order.map((h, i) => ({
            hour: h, count: counts.get(h),
            now: i === nowIdx,
            future: nowIdx >= 0 && i > nowIdx,
        }));

        // 直近のペース。★ 窓の始まりは「最初の凸」より前に遡らない —
        //   開始 30 分でも 2 時間で割ると実態の 1/4 に見える
        const times = list.map(a => ms(a.reported_at)).filter(t => t != null);
        const firstAt = times.length ? Math.min(...times) : null;
        const winStart = Math.max(nowMs - windowMs, firstAt == null ? nowMs - windowMs : firstAt);
        const windowHours = Math.max(0.25, (nowMs - winStart) / HOUR_MS);   // 15 分未満は 15 分として割る (0 割り・過大よけ)
        const recentCount = times.filter(t => t >= winStart && t <= nowMs).length;
        const perHour = recentCount / windowHours;

        const exhausted = remaining === 0 && capacity > 0;
        const etaMs = (!exhausted && perHour > 0) ? nowMs + (remaining / perHour) * HOUR_MS : null;
        const overrun = etaMs != null && Number.isFinite(endMs) && etaMs > endMs;
        return { byHour, done, capacity, remaining, unknownTime, recentCount, windowHours, perHour, etaMs, exhausted, overrun };
    }

    const STATUS_RANK = { declined: 3, accepted: 2, pending: 1 };

    /**
     * 🔁 直近の動き。主役は締め凸の打診の状態 (引き継いだ人が「誰に何を頼んでいて、誰の返事を
     * 待っているか」を読む)。添えとして直近の凸を出す。
     * @param {Object} args
     * @param {Object[]} args.finishRequests  finish_requests の行 (現在レベルのぶん。{id, boss_number, player_id, name, status, requested_at, responded_at, offer_id, plan_key, deadline_at, raid_level})
     * @param {Object[]} args.attacks         当日の凸 ({reported_at, boss_number, level, damage_raw, name})
     * @param {number} args.now
     * @param {number=} args.limit            添える凸の件数 (既定 5)
     * @param {number=} args.askLimit         打診の件数 (既定 6)
     * @returns {{
     *   asks: {key:string, boss:number, level:number|null, offer:boolean,
     *          members:{id:any, name:string, status:string}[], waiting:number, accepted:number, declined:number,
     *          state:'waiting'|'expired'|'ready'|'dead', deadlineMs:number|null, requestedMs:number|null}[],
     *   asksTotal:number, waiting:number,
     *   attacks: {atMs:number|null, name:string, boss:number, level:number|null, damageRaw:number}[],
     *   unknownTime:number
     * }}
     */
    function recentModel({ finishRequests, attacks, now, limit = 5, askLimit = 6 } = {}) {
        const nowMs = Number.isFinite(now) ? now : Date.now();
        const rows = (Array.isArray(finishRequests) ? finishRequests : []).filter(r => r && r.boss_number != null);

        // 同時打診 (44) は offer_id + plan_key が1案。1案ずつの依頼は「同じボス・同じレベル」で1組にする
        const groups = new Map();
        for (const r of rows) {
            const key = r.offer_id != null
                ? `o:${r.offer_id}:${r.plan_key == null ? '' : r.plan_key}`
                : `s:${r.boss_number}:${r.raid_level == null ? '' : r.raid_level}`;
            if (!groups.has(key)) groups.set(key, { key, boss: Number(r.boss_number), level: r.raid_level == null ? null : Number(r.raid_level), offer: r.offer_id != null, rows: [] });
            groups.get(key).rows.push(r);
        }
        const asks = [...groups.values()].map(g => {
            // ★ 同じ人が2行あっても1人 (finishDomain.offerProgress と同じ: より進んだ返事を採る)
            const byPlayer = new Map();
            for (const r of g.rows) {
                const pk = String(r.player_id);
                const cur = byPlayer.get(pk);
                if (!cur || (STATUS_RANK[r.status] || 0) > (STATUS_RANK[cur.status] || 0)) byPlayer.set(pk, r);
            }
            const members = [...byPlayer.values()].map(r => ({
                id: r.player_id,
                name: r.name || (r.players && r.players.name) || String(r.player_id),
                status: r.status === 'accepted' || r.status === 'declined' ? r.status : 'pending',
            }));
            const waiting = members.filter(m => m.status === 'pending').length;
            const accepted = members.filter(m => m.status === 'accepted').length;
            const declined = members.filter(m => m.status === 'declined').length;
            const deadlines = g.rows.map(r => ms(r.deadline_at)).filter(t => t != null);
            const deadlineMs = deadlines.length ? Math.min(...deadlines) : null;
            const requested = g.rows.map(r => ms(r.requested_at)).filter(t => t != null);
            const requestedMs = requested.length ? Math.min(...requested) : null;
            const state = declined > 0 ? 'dead'
                : (waiting > 0 && deadlineMs != null && nowMs > deadlineMs) ? 'expired'
                : waiting > 0 ? 'waiting'
                : 'ready';
            return { key: g.key, boss: g.boss, level: g.level, offer: g.offer, members, waiting, accepted, declined, state, deadlineMs, requestedMs };
        });
        // 手を打つべきもの (返事待ち・期限切れ) を上に。同じ状態なら新しい順
        const ORDER = { waiting: 0, expired: 0, ready: 1, dead: 2 };
        asks.sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || ((b.requestedMs || 0) - (a.requestedMs || 0)));

        const atk = (Array.isArray(attacks) ? attacks : []).filter(a => a && a.boss_number != null);
        let unknownTime = 0;
        const withTime = atk.map(a => {
            const t = ms(a.reported_at);
            if (t == null) unknownTime += 1;
            return {
                atMs: t,
                name: a.name || (a.players && a.players.name) || '—',
                boss: Number(a.boss_number),
                level: Number.isInteger(Number(a.level)) && Number(a.level) > 0 ? Number(a.level) : null,
                damageRaw: Number(a.damage_raw) || 0,
            };
        }).filter(a => a.atMs != null);
        withTime.sort((a, b) => b.atMs - a.atMs);

        return {
            asks: asks.slice(0, Math.max(0, askLimit)),
            asksTotal: asks.length,
            waiting: asks.reduce((s, a) => s + a.waiting, 0),
            attacks: withTime.slice(0, Math.max(0, limit)),
            unknownTime,
        };
    }

    root.paceDomain = { paceModel, recentModel, MAX_ATTACKS };
})(typeof window !== 'undefined' ? window : globalThis);
