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
            // ★ raid_level が無い行は判定しない (Codex指摘 2026-09-07)。Number(null) は 0 なので
            //   何もしないと「Lv0 < 現在レベル」= 通過扱いで外してしまう。
            //   DB (39) では NOT NULL だが、旧データや復元漏れに備えて明示的に除く
            if (r.raid_level == null) return;
            const lv = Number(r.raid_level);
            if (!Number.isInteger(lv) || lv < 1) return;
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

    // ===== ⑧ 申請UI 用 ==========================================================

    /**
     * 配信プランの1行 (自分の割当) を、予約の申請内容に変換する。
     * ★ ここが「配信で言われたこと」と「予約として固定されること」を突き合わせる唯一の場所。
     *   画面側で組み立てると、時刻や編成の取り違えが起きても気づけない。
     * @param {{level:number, bossNumber:number, loadoutSlot:number, team:string[]|null,
     *          dmgB:number, flex:boolean, hourIdx:number|null}} row 配信プランの行
     * @param {(idx:number)=>string|null} hourKeyOf hourIdx → 'hXX' の変換 (画面側の HOUR_ORDER を使う)
     * @returns {{ok:boolean, reason?:string, draft?:object}}
     */
    function planRowToDraft(row, hourKeyOf) {
        if (!row) return { ok: false, reason: 'no_row' };
        const level = Number(row.level), bossNumber = Number(row.bossNumber);
        const loadoutSlot = Number(row.loadoutSlot) || 1;
        if (!Number.isInteger(level) || level < 1 || level > 4) return { ok: false, reason: 'bad_level' };
        if (!Number.isInteger(bossNumber) || bossNumber < 1 || bossNumber > 5) return { ok: false, reason: 'bad_boss' };
        if (loadoutSlot !== 1 && loadoutSlot !== 2) return { ok: false, reason: 'bad_slot' };
        const flex = !!row.flex;
        // ★ 時刻は「約束できる形」でだけ固定する。⏳隙間型は時刻を約束しない (flex)。
        //   時刻不明を fixed のまま出すと DB の CHECK で弾かれる = 押しても何も起きない
        let timeSlot = null;
        if (!flex) {
            timeSlot = (row.hourIdx == null) ? null : (typeof hourKeyOf === 'function' ? hourKeyOf(row.hourIdx) : null);
            if (!timeSlot) return { ok: false, reason: 'no_time' };
        }
        const team = Array.isArray(row.team) ? row.team.filter(Boolean) : [];
        return {
            ok: true,
            draft: {
                raidLevel: level, bossNumber, loadoutSlot,
                flex, timeSlot,
                // ★ 承認時点で固定する写し。あとから模擬を編集しても動かさない
                characters: team,
                expectedDamageB: Number(row.dmgB) > 0 ? Number(row.dmgB) : null,
                sourceType: 'plan',
            },
        };
    }

    /**
     * その割当に対応する「生きている予約」を探す。
     * ★ 突き合わせは 誰が・レベル・ボス・編成枠 の4つ。時刻は含めない —
     *   時刻だけ違う予約を「別物」にすると、同じ枠に二重に申請できてしまう
     *   (DB の部分一意索引も同じ4つで張ってある)
     */
    function findActiveFor(rows, { playerId, level, bossNumber, loadoutSlot }) {
        const list = Array.isArray(rows) ? rows : [];
        return list.find(r => r && isActive(r)
            && String(r.player_id) === String(playerId)
            && Number(r.raid_level) === Number(level)
            && Number(r.boss_number) === Number(bossNumber)
            && Number(r.loadout_slot) === Number(loadoutSlot)) || null;
    }

    /**
     * 申請してよいか。残凸を超える申請は DB のトリガーが弾くが、
     * 押せるボタンを出しておいて弾かれるのは体験が悪いので画面側でも見る
     */
    function canRequest(rows, { playerId, level, bossNumber, loadoutSlot, doneAttacks }) {
        if (findActiveFor(rows, { playerId, level, bossNumber, loadoutSlot })) {
            return { ok: false, reason: 'already', label: '申請済み' };
        }
        const left = capacityLeft(rows, playerId, doneAttacks);
        if (left <= 0) return { ok: false, reason: 'no_capacity', label: '残り凸がありません' };
        return { ok: true, left };
    }

    /**
     * 凸報告に紐づける「承認済みの予約」を1件だけ選ぶ。
     * ★ 曖昧なときは**紐づけない** (Codex指摘 2026-09-07)。
     *   間違った予約を消し込むと、本当に守るべき約束が消えて残凸だけ減る。
     *   同じレベル・同じボスに承認済みが2件 (編成①②) あるときは、編成で絞れたときだけ確定する。
     * @returns {{id:number|null, reason:'none'|'one'|'by_team'|'ambiguous'}}
     */
    function matchForAttack(rows, { playerId, level, bossNumber, characters }) {
        const cand = (Array.isArray(rows) ? rows : []).filter(r => r
            && r.status === 'approved'
            && String(r.player_id) === String(playerId)
            && Number(r.boss_number) === Number(bossNumber)
            // レベルは進行とずれることがあるので、指定が無ければ見ない
            && (level == null || Number(r.raid_level) === Number(level)));
        if (cand.length === 0) return { id: null, reason: 'none' };
        if (cand.length === 1) return { id: cand[0].id, reason: 'one' };
        // 編成で絞る (順不同で一致するものだけ)
        const key = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map(String).slice().sort().join('\u0001') : '');
        const mine = key(characters);
        if (mine) {
            const hit = cand.filter(r => key(r.characters_snapshot) === mine);
            if (hit.length === 1) return { id: hit[0].id, reason: 'by_team' };
        }
        return { id: null, reason: 'ambiguous' };
    }

    /**
     * 「自分から申請する」フォームの入力を、予約の申請内容に変換する (モック②)。
     * ★ 画面はチップの選択状態しか持たない。何が足りないかの判定はここに集める —
     *   画面側に散らすと「押せるのに弾かれる」「押せないのに理由が出ない」が起きる
     * @param {{boss:object|null, level:number|null, timeSlot:string|null, flex:boolean,
     *          loadout:{slot:number,characters:string[],dmgB:number}|null, currentLevel:number}} f
     * @returns {{ok:boolean, missing:string[], draft?:object, note?:string}}
     */
    function buildRequestDraft(f = {}) {
        const missing = [];
        const boss = f.boss || null;
        const bossNumber = Number(boss && boss.boss_number);
        if (!Number.isInteger(bossNumber) || bossNumber < 1 || bossNumber > 5) missing.push('boss');
        else if (Number(boss.remaining_hp_raw) <= 0) missing.push('boss_defeated');
        const level = Number(f.level);
        if (!Number.isInteger(level) || level < 1 || level > 4) missing.push('level');
        const flex = !!f.flex;
        const timeSlot = flex ? null : (f.timeSlot || null);
        if (!flex && !/^h(0[0-9]|1[0-9]|2[0-3])$/.test(String(timeSlot || ''))) missing.push('time');
        const lo = f.loadout || null;
        const slot = Number(lo && lo.slot);
        if (!lo || (slot !== 1 && slot !== 2) || !(Number(lo.dmgB) > 0)) missing.push('loadout');
        if (missing.length) return { ok: false, missing };
        const cur = Number(f.currentLevel) || 0;
        // 先のレベルは申請できる (「先に出しておける」のが目的)。ただし本人に分かるように注記する
        const note = (cur && level > cur) ? `Lv${level} はまだ開いていません。開くまでは予定として扱われます。` : '';
        return {
            ok: true, missing: [], note,
            draft: {
                raidLevel: level, bossNumber, loadoutSlot: slot,
                flex, timeSlot,
                characters: Array.isArray(lo.characters) ? lo.characters.filter(Boolean) : [],
                expectedDamageB: Number(lo.dmgB),
                sourceType: 'self',
            },
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
        planRowToDraft, findActiveFor, canRequest, matchForAttack, buildRequestDraft,
    };
})(typeof window !== 'undefined' ? window : globalThis);
