// ============================================================================
// ドメイン: 凸の予約 (L2 / 課題E — 39_plan_reservations.sql)
// ----------------------------------------------------------------------------
// 「本人が引き受け、運営が承認した凸は動かさない」を成立させるための純ロジック。
// 第44回 (2026-09-05) の反省「当日のプラン再生成でメンバーを振り回した」への本命。
// L1 (ソルバーの安定化) は理由があれば割当を動かすが、**承認済みの予約は原則動かさない**。
//
// ユーザー決定 (2026-09-07):
//   固定する範囲 = 誰が・レベル・ボス・時刻・編成の全部
//   承認は運営の誰か1人 / 承認しても自動配信しない / 締め凸依頼の了承は即予約 /
//   無断欠席は猶予なし運営判断 / 本人の取り消しは希望を出す→運営が承認して解除
//
// 状態: requested → approved | rejected | cancel_requested
//       approved  → cancel_requested | fulfilled | released
//       cancel_requested → released | approved
// **ソルバーを拘束するのは approved だけ**。requested と cancel_requested は
// 「提案層」として表示するだけで、計算には効かせない。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM/Supabase 非依存で node からテスト可:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const STATUS = ['requested', 'approved', 'cancel_requested', 'fulfilled', 'released', 'rejected'];
    // 残凸の枠を押さえている状態 (DB のトリガーと同じ集合にすること)
    const ACTIVE = ['requested', 'approved', 'cancel_requested'];
    const STATUS_JP = {
        requested: '承認待ち',
        approved: '予約済み',
        cancel_requested: '取り消し希望',
        fulfilled: '実行済み',
        released: '解除',
        rejected: '見送り',
    };
    const RELEASE_JP = {
        fulfilled: '凸が入った',
        boss_defeated: 'ボスが倒された',
        level_passed: 'レベルが進んだ',
        no_show: '時間になっても凸がなかった',
        member_request: '本人の希望',
        ops: '運営の判断',
        infeasible: '実行できなくなった',
    };
    // 許可する遷移。DB の reservation_set_status と**同じ表**にすること
    // (片方だけ変えると、画面では押せるのにサーバで弾かれる)
    const TRANSITIONS = {
        requested: ['approved', 'rejected', 'cancel_requested'],
        approved: ['cancel_requested', 'fulfilled', 'released'],
        cancel_requested: ['released', 'approved'],
        fulfilled: [],
        released: [],
        rejected: [],
    };

    const isActive = (r) => !!r && ACTIVE.includes(r.status);
    const isApproved = (r) => !!r && r.status === 'approved';
    const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

    /**
     * 承認済みの予約を、ソルバーが読む拘束の形に畳む。
     * ★ 並びは仕様化したキーで安定ソートする — DB の返却順に依存させると
     *   「同じ盤面でも押すたびに違う指示」になり、配信の前提が崩れる (L1 と同じ理由)。
     * @param {Object[]} rows plan_reservations の行
     * @returns {Object[]} { reservationId, memberId, level, bossNumber, loadoutSlot, timeSlot, flex, team, expectedB }
     */
    function toSolverConstraints(rows) {
        const out = [];
        (Array.isArray(rows) ? rows : []).forEach(r => {
            if (!r || r.status !== 'approved') return;
            const level = Number(r.raid_level);
            const bossNumber = Number(r.boss_number);
            const loadoutSlot = Number(r.loadout_slot);
            if (!Number.isInteger(level) || level < 1 || level > 4) return;
            if (!Number.isInteger(bossNumber) || bossNumber < 1 || bossNumber > 5) return;
            if (!Number.isInteger(loadoutSlot) || loadoutSlot < 1 || loadoutSlot > 2) return;
            if (r.player_id == null) return;
            out.push({
                reservationId: r.id ?? null,
                memberId: r.player_id,
                level,
                bossNumber,
                loadoutSlot,
                // flex は時刻を約束しない予約 (⏳隙間型)。fixed は 'hXX'
                flex: r.time_mode === 'flex',
                timeSlot: r.time_mode === 'flex' ? null : (r.time_slot || null),
                team: Array.isArray(r.characters_snapshot) ? r.characters_snapshot.filter(Boolean) : [],
                expectedB: Number(r.expected_damage_b) || 0,
            });
        });
        const idKey = (v) => String(v);
        out.sort((x, y) => (x.level - y.level)
            || (x.bossNumber - y.bossNumber)
            || (idKey(x.memberId) < idKey(y.memberId) ? -1 : idKey(x.memberId) > idKey(y.memberId) ? 1 : 0)
            || (x.loadoutSlot - y.loadoutSlot));
        return out;
    }

    /**
     * 盤面を見て「もう実現できない予約」を洗い出す。
     * ★ 撃破・レベル通過は**盤面の事実**なので自動で解除してよい。
     *   時間切れ (no_show) はここでは出さない — ユーザー決定により運営判断で取り下げる
     *   (ブラウザが開いている保証がないので、時刻到来だけの自動解除はしない)。
     * @param {Object[]} rows plan_reservations の行 (approved のみ見る)
     * @param {Object} board { currentLevel, bosses: [{boss_number, remaining_hp_raw}] }
     * @returns {Object[]} { id, reason, row }
     */
    function findInfeasible(rows, board) {
        const cur = Number(board && board.currentLevel) || 1;
        const hpByBoss = new Map();
        (Array.isArray(board && board.bosses) ? board.bosses : [])
            .forEach(b => hpByBoss.set(Number(b.boss_number), Number(b.remaining_hp_raw) || 0));
        const out = [];
        (Array.isArray(rows) ? rows : []).forEach(r => {
            if (!isApproved(r)) return;
            const lv = Number(r.raid_level);
            // そのレベルを通過した = もうそのボスは出てこない
            if (Number.isInteger(lv) && lv < cur) { out.push({ id: r.id, reason: 'level_passed', row: r }); return; }
            // いまのレベルで対象ボスが倒れている
            if (lv === cur && hpByBoss.has(Number(r.boss_number)) && hpByBoss.get(Number(r.boss_number)) <= 0) {
                out.push({ id: r.id, reason: 'boss_defeated', row: r });
            }
        });
        return out;
    }

    /**
     * 予約が残凸を超えていないか (保存前の検査)。DB のトリガーと同じ式。
     * ★ 画面側でも見るのは「押せてしまってからエラーで弾かれる」のを避けるため。
     *   正は DB 側 (複数端末が同時に書くとクライアントの検査は破れる)
     */
    function capacityLeft(rows, playerId, doneAttacks) {
        const active = (Array.isArray(rows) ? rows : [])
            .filter(r => isActive(r) && String(r.player_id) === String(playerId)).length;
        return Math.max(0, 3 - active - (Number(doneAttacks) || 0));
    }

    /** 1件を人が読める1行に。「Lv2 B3 21時 編成②」 */
    function describe(r, bossNameByNumber) {
        if (!r) return '';
        const t = r.time_mode === 'flex' ? '⏳隙間' : (r.time_slot ? `${String(r.time_slot).replace(/^h/, '')}時` : '時刻未定');
        const name = bossNameByNumber && bossNameByNumber.get
            ? (bossNameByNumber.get(Number(r.boss_number)) || `B${r.boss_number}`)
            : `B${r.boss_number}`;
        return `Lv${r.raid_level} ${name} ${t} 編成${Number(r.loadout_slot) === 2 ? '②' : '①'}`;
    }

    /**
     * 承認前に運営へ見せる「固定した場合の影響」。
     * 2つの解 (いまの承認済みだけ / +この候補) を突き合わせる。
     * ★ 主指標はユーザー決定の2つ (Lv3完全攻略の見込み・未消化の凸数) だが、
     *   それだけだと「この予約が他人の選択肢をどれだけ削ったか」が見えないので、
     *   割当が変わる人数と総与ダメの差も添える (Codex 設計レビュー 2026-09-07)
     * @param {Object} basePlan 既存の承認済みだけで解いたプラン
     * @param {Object} withPlan それに候補を足して解いたプラン
     * @param {Object=} diffDomain planDiffDomain (割当変更人数の算出に使う)
     */
    function approvalImpact(basePlan, withPlan, diffDomain) {
        if (!basePlan || !withPlan) return null;
        const clearBefore = Number(basePlan.fullyClearedThrough) || 0;
        const clearAfter = Number(withPlan.fullyClearedThrough) || 0;
        const unusedBefore = Number(basePlan.unusedAttacks) || 0;
        const unusedAfter = Number(withPlan.unusedAttacks) || 0;
        const creditedBefore = Number(basePlan.totalCreditedB) || 0;
        const creditedAfter = Number(withPlan.totalCreditedB) || 0;
        const risk = (p) => (p.levels || []).flatMap(lv => (lv.bosses || []).flatMap(b => b.attacks || []))
            .reduce((t, a) => t + (a.timeMismatch ? 2 : 0) + (a.flex ? 1 : 0), 0);
        let movedCount = null;
        try {
            if (diffDomain) movedCount = diffDomain.diffPlans(basePlan, withPlan).changed.length;
        } catch { movedCount = null; }
        // 承認を鈍らせる条件 (押せなくはしない — 運営が例外を通せる余地は残す)
        const warnings = [];
        if (clearAfter < clearBefore) warnings.push(`Lv${clearBefore} 完全攻略の見込みが消えます`);
        if (unusedAfter > unusedBefore) warnings.push(`未消化の凸が ${unusedBefore} → ${unusedAfter} に増えます`);
        if (risk(withPlan) > risk(basePlan)) warnings.push('時刻を確約できない凸が増えます');
        return {
            clearBefore, clearAfter,
            unusedBefore, unusedAfter,
            creditedBefore, creditedAfter,
            creditedDiffB: Math.round((creditedAfter - creditedBefore) * 1000) / 1000,
            movedCount,
            warnings,
            blocking: clearAfter < clearBefore,   // 踏破の見込みが消えるのが一番重い
        };
    }

    root.reservationsDomain = {
        STATUS, ACTIVE, STATUS_JP, RELEASE_JP, TRANSITIONS,
        isActive, isApproved, canTransition,
        toSolverConstraints,
        findInfeasible,
        capacityLeft,
        describe,
        approvalImpact,
    };
})(typeof window !== 'undefined' ? window : globalThis);
