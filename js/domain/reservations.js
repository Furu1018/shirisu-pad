// ============================================================================
// ドメイン: 凸の予約 (L2 / 課題E — 39_plan_reservations.sql)
// ----------------------------------------------------------------------------
// 「本人が引き受け、運営が承認した凸は動かさない」を成立させるための純ロジック。
// 第44回 (2026-09-05) の反省「当日のプラン再生成でメンバーを振り回した」への本命。
// L1 (ソルバーの安定化) は理由があれば割当を動かすが、**承認済みの予約は原則動かさない**。
//
// ユーザー決定 (2026-09-07 / 2026-09-08 改訂):
//   固定する範囲 = 誰が・ボス・時刻・編成。**レベルは本人が選ばない** (2026-09-08)
//   ボスは全レベル共通で HP だけが違う。「この時刻にこの弱点のボスへこの編成で」が約束で、
//   どのレベルに置くかは時間軸からソルバーが決める。締め凸依頼の了承だけ運営がレベル付きで作る
//   承認は運営の誰か1人 / 承認しても自動配信しない / 締め凸依頼の了承は即予約 /
//   無断欠席は猶予なし運営判断 / 本人の取り消しは希望を出す→運営が承認して解除
//
// 状態: requested → approved | rejected | cancel_requested
//       approved  → cancel_requested | fulfilled | released
//       cancel_requested → released | approved
// **ソルバーを拘束するのは isFixed = approved と「承認済み起点の cancel_requested」**。
// requested と未承認の取り下げは「提案層」として表示するだけで、計算には効かせない (2026-09-08 更新)。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM/Supabase 非依存で node からテスト可:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    // pinned = 📌 運営の固定 (パズル盤 ③・2026-09-11)。運営が時間割に置いた**下書き**で、本人はまだ引き受けていない。
    //   ソルバーは approved と同じく先に置く (isFixed) が、残凸の枠 (ACTIVE) には数えない — 約束ではない下書きが
    //   本人の実凸や申請を塞いではいけない。「📣 お願い」(asked_at) で本人に届き、引き受けると approved
    const STATUS = ['requested', 'approved', 'cancel_requested', 'fulfilled', 'released', 'rejected', 'pinned'];
    // 残凸の枠を押さえている状態 (DB のトリガーと同じ集合にすること)
    const ACTIVE = ['requested', 'approved', 'cancel_requested'];
    const STATUS_JP = {
        requested: '承認待ち',
        approved: '予約済み',
        cancel_requested: '取り消し希望',
        fulfilled: '実行済み',
        released: '解除',
        rejected: '見送り',
        pinned: '運営の固定',
    };
    const RELEASE_JP = {
        fulfilled: '凸が入った',
        boss_defeated: 'ボスが倒された',
        level_passed: 'レベルが進んだ',
        no_show: '時間になっても凸がなかった',
        member_request: '本人の希望',
        ops: '運営の判断',
        infeasible: '実行できなくなった',
        member_declined: '本人が「難しい」と返事',
        superseded: '本人の申請・予約に置き換わった',
    };
    // 許可する遷移。DB の reservation_set_status と**同じ表**にすること
    // (片方だけ変えると、画面では押せるのにサーバで弾かれる)
    const TRANSITIONS = {
        requested: ['approved', 'rejected', 'cancel_requested'],
        approved: ['cancel_requested', 'fulfilled', 'released'],
        cancel_requested: ['released', 'approved'],
        pinned: ['approved', 'released'],   // 本人が引き受けた / 運営が外した・本人が難しいと返事
        fulfilled: [],
        released: [],
        rejected: [],
    };

    // ソルバーが「置けなかった」理由 → 日本語。運営にもメンバーにも**コードのまま出さない** (ユーザー決定 D)
    const UNMET_JP = {
        member_gone: '参加対象から外れています',
        attacks_done: '本人がもう3凸しています',
        boss_gone: 'そのボスが見つかりません',
        boss_defeated: 'そのボスはもう倒れています',
        level_passed: 'そのレベルはもう終わっています',
        loadout_gone: '予約した編成が模擬から消えています',
        time_passed: '約束の時刻を過ぎています',
        before_open: '約束の時刻には、そのレベルがまだ開いていない見込みです',
        no_boss_at_time: '約束の時刻には、そのボスがいない見込みです',
        level_unreached: 'そのレベルまで届かない見込みです',
        conflict: 'ほかの凸とキャラが被るため置けません',
    };
    // ソルバーが「その人の残り凸を使わなかった」理由 → 日本語 (本人のホームの空き枠に出す)
    const UNASSIGNED_JP = {
        no_loadout: '模擬の提出がありません',
        cards_used_up: '提出した編成をすべて使いました (3凸ぶんの編成が足りません)',
        char_conflict: 'ほかの凸とキャラが被って、使える編成が残っていません',
        no_target: '出せる属性のボスが残っていない見込みです',
        time: '戦闘可能時間に合う枠がありません',
        not_needed: 'いまのプランでは出番がありません (残HPは足りる見込みです)',
        reserved: '予約のために残しています (その予約はまだ置けていません)',
    };

    /**
     * 未達の1件を日本語の1文に。ソルバーが detail (撃破見込み・開放見込みの時刻) を添えていれば含める
     * @param {{reason:string, detail?:{level?:number, killedLabel?:string, nextOpenLabel?:string, openLabel?:string}}} u
     */
    function unmetText(u) {
        if (!u) return '';
        const base = UNMET_JP[u.reason] || '置けませんでした';
        const d = u.detail || null;
        if (!d) return base;
        if (u.reason === 'no_boss_at_time') {
            const parts = [];
            if (d.level && d.killed) parts.push(`Lv${d.level} ではもう倒れています`);
            else if (d.level && d.killedLabel) parts.push(`Lv${d.level} は ${d.killedLabel}に撃破の見込み`);
            if (d.level && d.nextOpenLabel) parts.push(`Lv${d.level + 1} の開放は ${d.nextOpenLabel}`);
            return parts.length ? `${base} (${parts.join('、')})` : base;
        }
        if (u.reason === 'before_open' && d.level && d.openLabel) {
            return `${base} (Lv${d.level} の開放は ${d.openLabel})`;
        }
        return base;
    }

    const isActive = (r) => !!r && ACTIVE.includes(r.status);
    const isApproved = (r) => !!r && r.status === 'approved';
    const isPin = (r) => !!r && r.status === 'pinned';
    const isAskedPin = (r) => isPin(r) && r.asked_at != null;   // 📣 本人に届いている下書き
    const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

    /**
     * 承認済みの予約を、ソルバーが読む拘束の形に畳む。
     * ★ 並びは仕様化したキーで安定ソートする — DB の返却順に依存させると
     *   「同じ盤面でも押すたびに違う指示」になり、配信の前提が崩れる (L1 と同じ理由)。
     * @param {Object[]} rows plan_reservations の行
     * @returns {Object[]} { reservationId, memberId, level, bossNumber, loadoutSlot, timeSlot, flex, team, expectedB }
     */
    // ソルバーを拘束する状態 (= 運営が承認済みで、まだ解除されていない)。
    // ★ cancel_requested は「承認済みからの取り消し希望」だけ固定 (Codex指摘 2026-09-07)。
    //   requested → cancel_requested (未承認の申請を本人が引っ込めた) も同じ状態名なので、
    //   approved_at の有無で区別する。未承認の申請が突然ソルバーの拘束になってはいけない
    // 約束 (本人が引き受け、運営が承認した) — 凸報告の消し込みや本人の3枠はこちらを見る
    function isPromise(r) {
        if (!r) return false;
        if (r.status === 'approved') return true;
        return r.status === 'cancel_requested' && r.approved_at != null;
    }
    // ソルバーを拘束するもの = 約束 + 📌 運営の固定 (下書き)。配信直前の指紋もこの集合
    function isFixed(r) {
        return isPromise(r) || isPin(r);
    }

    /**
     * 算出時の予約集合の指紋。配信直前に取り直した集合と比べ、違えば配信を止める
     * (別端末で承認・解除が入ったプランをそのまま出すと約束が破れる — Codex指摘 2026-09-07)。
     * 拘束に効く行 (isFixed) だけを見る。申請 (requested) が増えてもプランは変わらないので含めない
     */
    function fingerprint(rows) {
        return (Array.isArray(rows) ? rows : [])
            .filter(isFixed)
            // ★ 📌 は置き直せる (約束と違って中身が動く) ので、ボス・時刻・編成枠も指紋に入れる (Codex指摘 2026-09-11)。
            //   入れないと、置き直しても指紋が変わらず、置き直す前の算出結果を配信できてしまう
            .map(r => `${r.id}:${r.status}` + (isPin(r)
                ? `:${r.boss_number}:${r.time_mode || 'fixed'}:${r.time_slot || ''}:${r.loadout_slot}`
                    // 編成・火力も置き直せる (supabaseMovePin) ので、同じマスのまま中身だけ変えても指紋が変わるように (Codex再指摘)
                    + `:${r.expected_damage_b ?? ''}:${(Array.isArray(r.characters_snapshot) ? r.characters_snapshot : []).filter(c => typeof c === 'string').join(',')}`
                : ''))
            .sort()
            .join('|');
    }

    function toSolverConstraints(rows) {
        const out = [];
        (Array.isArray(rows) ? rows : []).forEach(r => {
            // ★ 固定するのは approved と **cancel_requested** (2026-09-07)。
            //   取り消しは「希望を出すだけで、解除には運営の承認が要る」(ユーザー決定)。
            //   希望を出した瞬間に固定が外れると、運営が判断する前にプランが動いてしまう
            if (!r || !isFixed(r)) return;
            // ★ レベルは任意 (2026-09-08)。NULL = 「約束の時刻にそのボスがいるレベル」をソルバーが決める
            const level = (r.raid_level == null) ? null : Number(r.raid_level);
            const bossNumber = Number(r.boss_number);
            const loadoutSlot = Number(r.loadout_slot);
            if (level !== null && (!Number.isInteger(level) || level < 1 || level > 4)) return;
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
                pinned: isPin(r),   // 📌 画面で 🔒 (約束) と見分けるため。ソルバーの置き方は同じ
            });
        });
        const idKey = (v) => String(v);
        out.sort((x, y) => ((x.level ?? 0) - (y.level ?? 0))
            || (x.bossNumber - y.bossNumber)
            || (idKey(x.memberId) < idKey(y.memberId) ? -1 : idKey(x.memberId) > idKey(y.memberId) ? 1 : 0)
            || (x.loadoutSlot - y.loadoutSlot));
        return out;
    }

    /**
     * 盤面を見て「もう実現できない予約」を洗い出す。
     * ★ レベルを持たない予約 (メンバー発) はここでは外さない — ボスは次のレベルにもいるので、
     *   「倒れた」「レベルが進んだ」は実現不能を意味しない。置けるかはソルバーが時間軸で判定し、
     *   `unmetReservations` として理由つきで出す (運営が2択で処理する — ユーザー決定 C)
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
            // ★ 固定されている行はすべて対象 (承認済み起点の取り消し希望も含む — Codex指摘)。
            //   approved だけだと、取り消し希望中に対象ボスが倒れても固定のまま残り、
            //   残凸・同一枠の一意制約・ソルバーを塞ぎ続ける
            if (!isFixed(r)) return;
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
        const lv = (r.raid_level != null) ? `Lv${r.raid_level} ` : '';
        return `${lv}${name} ${t} 編成${Number(r.loadout_slot) === 2 ? '②' : '①'}`;
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
    function approvalImpact(basePlan, withPlan, diffDomain, candidateId = null, candidateMemberId = null) {
        if (!basePlan || !withPlan) return null;
        // ★ 候補そのものが置けなかったら、それが最初の警告で、承認は止める (ユーザー決定 C の置き換え)。
        //   「10時にはそのボスがいない見込み」は予測なので自動では何もしないが、承認の時点では止めてよい
        const cand = (candidateId != null && Array.isArray(withPlan.unmetReservations))
            ? withPlan.unmetReservations.find(u => String(u.reservationId) === String(candidateId)) || null
            : null;
        // ★ 承認すると**固定済みの予約が置けなくなる**なら、それも止める (2026-09-08 実機で発覚)。
        //   同じ人の予約が置けなくなるのはキャラ被り = 物理的に両方できない → 承認不可。
        //   他人の予約が置けなくなるのは枠の取り合い → 強く警告 (運営が判断)
        const baseUnmet = new Set((Array.isArray(basePlan.unmetReservations) ? basePlan.unmetReservations : []).map(u => String(u.reservationId)));
        const breaks = (Array.isArray(withPlan.unmetReservations) ? withPlan.unmetReservations : [])
            .filter(u => String(u.reservationId) !== String(candidateId) && !baseUnmet.has(String(u.reservationId)))
            .map(u => ({ ...u, sameMember: candidateMemberId != null && String(u.memberId) === String(candidateMemberId) }));
        const breaksText = breaks.map(b => `${b.memberName || '#' + b.memberId} の予約 (B${b.bossNumber} 編成${Number(b.loadoutSlot) === 2 ? '②' : '①'}) が置けなくなります: ${unmetText(b)}`).join('\n');
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
        if (cand) warnings.push(`この予約は置けません: ${unmetText(cand)}`);
        breaks.forEach(b => warnings.push(`承認すると固定済みの予約が置けなくなります: ${b.memberName || '#' + b.memberId} B${b.bossNumber} 編成${Number(b.loadoutSlot) === 2 ? '②' : '①'} (${unmetText(b)})`));
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
            blocking: !!cand || clearAfter < clearBefore || breaks.length > 0,   // 置けない / 踏破の見込みが消える / 固定済みが壊れる
            cannotPlace: !!cand,
            cannotPlaceText: cand ? unmetText(cand) : '',
            breaks,
            breaksText,
            blockingHard: breaks.some(b => b.sameMember),   // 同じ人のキャラ被り = 承認不可
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
        // 行のレベルは形式だけ見る (壊れた行を弾く)。予約には**載せない** — レベルは本人が選ばない
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
                raidLevel: null, bossNumber, loadoutSlot,
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
     * ★ 突き合わせは 誰が・ボス・編成枠 の3つ (2026-09-08)。時刻もレベルも含めない —
     *   同じカード (編成) は1日1回しか使えないので、時刻やレベルだけ違う予約は「別物」ではない。
     *   別物にすると同じ枠に二重に申請できてしまう (DB の部分一意索引 uq_plan_reservations_active_card も同じ3つ)
     */
    function findActiveFor(rows, { playerId, bossNumber, loadoutSlot }) {
        const list = Array.isArray(rows) ? rows : [];
        return list.find(r => r && isActive(r)
            && String(r.player_id) === String(playerId)
            && Number(r.boss_number) === Number(bossNumber)
            && Number(r.loadout_slot) === Number(loadoutSlot)) || null;
    }

    /**
     * 申請してよいか。残凸を超える申請は DB のトリガーが弾くが、
     * 押せるボタンを出しておいて弾かれるのは体験が悪いので画面側でも見る
     */
    // 同じ人の生きている予約と、編成のキャラが被っているか (同じキャラは1日1回しか使えない — 2026-09-08 実機で発覚:
    // PT1 を予約したあと、同じキャラを含む PT2 を申請でき、承認もでき、PT1 が置けなくなった)
    // 文字列だけを見る — 壊れた写し (オブジェクト・空白だけ) を "[object Object]" や '' として一致させない (Codex指摘)
    const _charKeys = (list) => (Array.isArray(list) ? list : [])
        .filter(c => typeof c === 'string')
        .map(c => c.normalize('NFKC').trim().toLowerCase())
        .filter(Boolean);
    function conflictingReservation(rows, { playerId, characters, excludeId }) {
        const mine = new Set(_charKeys(characters));
        if (mine.size === 0) return null;
        return (Array.isArray(rows) ? rows : []).find(r => r && isActive(r)
            && String(r.player_id) === String(playerId)
            && (excludeId == null || String(r.id) !== String(excludeId))
            && _charKeys(r.characters_snapshot).some(k => mine.has(k))) || null;
    }

    /** その人・そのボス・その編成枠の 📌 (下書き) があれば返す */
    function pinFor(rows, { playerId, bossNumber, loadoutSlot }) {
        return (Array.isArray(rows) ? rows : []).find(r => isPin(r)
            && String(r.player_id) === String(playerId)
            && Number(r.boss_number) === Number(bossNumber)
            && Number(r.loadout_slot) === Number(loadoutSlot)) || null;
    }

    /**
     * 運営が 📌 を置いてよいか (パズル盤 ③)。置き直し (excludeId) は自分自身を数えない。
     *   promise_exists = 本人の申請・予約がそのカードにある (下書きで上書きしない)
     *   no_capacity    = 約束 + 固定 + 実凸 で 3 を超える
     *   char_conflict  = 同じ人の生きている予約・固定と同じキャラを使う (1日1回)
     */
    function canPin(rows, { playerId, bossNumber, loadoutSlot, doneAttacks, characters, excludeId }) {
        const list = (Array.isArray(rows) ? rows : []).filter(r => r && String(r.player_id) === String(playerId)
            && (excludeId == null || String(r.id) !== String(excludeId)));
        if (list.some(r => isActive(r) && Number(r.boss_number) === Number(bossNumber) && Number(r.loadout_slot) === Number(loadoutSlot))) {
            return { ok: false, reason: 'promise_exists', label: '本人の申請・予約があります' };
        }
        const held = list.filter(r => isPromise(r) || isPin(r)).length;
        if (held + (Number(doneAttacks) || 0) >= 3) return { ok: false, reason: 'no_capacity', label: '残り凸がありません' };
        const mine = new Set(_charKeys(characters));
        const clash = mine.size ? list.find(r => (isActive(r) || isPin(r)) && _charKeys(r.characters_snapshot).some(k => mine.has(k))) : null;
        if (clash) return { ok: false, reason: 'char_conflict', label: '同じキャラを使う予約・固定があります', with: clash };
        return { ok: true, left: 3 - held - (Number(doneAttacks) || 0) };
    }

    function canRequest(rows, { playerId, bossNumber, loadoutSlot, doneAttacks, characters }) {
        if (findActiveFor(rows, { playerId, bossNumber, loadoutSlot })) {
            return { ok: false, reason: 'already', label: '申請済み' };
        }
        const left = capacityLeft(rows, playerId, doneAttacks);
        if (left <= 0) return { ok: false, reason: 'no_capacity', label: '残り凸がありません' };
        // ★ 予約中の編成とキャラが被る編成は申請できない (物理的に両方は実行できない)
        const clash = conflictingReservation(rows, { playerId, characters });
        if (clash) return { ok: false, reason: 'char_conflict', label: '予約中の編成とキャラが被っています', with: clash };
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
            && isPromise(r)   // approved / 承認済み起点の cancel_requested (取り消し希望中に本人が凸したら消し込む)。📌 は約束でないので紐づけない (RPC も弾く)
            && String(r.player_id) === String(playerId)
            && Number(r.boss_number) === Number(bossNumber)
            // レベルは進行とずれることがあるので、指定が無ければ見ない。
            // 予約側がレベルを持たない (メンバー発) ときも見ない
            && (level == null || r.raid_level == null || Number(r.raid_level) === Number(level)));
        if (cand.length === 0) return { id: null, reason: 'none' };
        // 編成で絞る (順不同で一致するものだけ)。
        // ★ 候補が1件でも、編成が分かっていて約束の編成と違うなら紐づけない (Codex指摘 2026-09-08)。
        //   レベルを持たない予約は「そのボスへの凸」なら何でも候補になるので、
        //   21時に編成①で約束した予約が、9時の編成②の凸で消し込まれてしまう。
        //   写しの無い旧予約だけは編成で判定できないので従来どおり
        // ★ 部分一致で見る (Codex指摘 2026-09-08): OCR は5人のうち3人しか読めなくても凸を登録する。
        //   完全一致だと、その3人が約束の編成に含まれていても「別の編成」と判定して予約が消し込まれない。
        //   「凸で分かっているキャラが全員、約束の編成に入っている」なら同じ編成とみなす
        const setOf = (arr) => new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String));
        const mineSet = setOf(characters);
        if (mineSet.size > 0) {
            const same = cand.filter(r => {
                const snap = setOf(r.characters_snapshot);
                if (snap.size === 0) return true;                 // 写しの無い旧予約は編成で判定できない
                return [...mineSet].every(c => snap.has(c));
            });
            if (same.length === 1) return { id: same[0].id, reason: cand.length === 1 ? 'one' : 'by_team' };
            if (same.length === 0) return { id: null, reason: 'team_mismatch' };
            return { id: null, reason: 'ambiguous' };
        }
        if (cand.length === 1) return { id: cand[0].id, reason: 'one' };
        return { id: null, reason: 'ambiguous' };
    }

    /**
     * 「自分から申請する」フォームの入力を、予約の申請内容に変換する (モック②)。
     * ★ 画面はチップの選択状態しか持たない。何が足りないかの判定はここに集める —
     *   画面側に散らすと「押せるのに弾かれる」「押せないのに理由が出ない」が起きる
     * ★ レベルは聞かない (2026-09-08)。ボスは次のレベルにもいるので「倒れている」も止めない —
     *   いまのレベルで倒れていても、時刻によっては次のレベルのそのボスに置ける
     * @param {{boss:object|null, timeSlot:string|null, flex:boolean,
     *          loadout:{slot:number,characters:string[],dmgB:number}|null}} f
     * @returns {{ok:boolean, missing:string[], draft?:object, note?:string}}
     */
    function buildRequestDraft(f = {}) {
        const missing = [];
        const boss = f.boss || null;
        const bossNumber = Number(boss && boss.boss_number);
        if (!Number.isInteger(bossNumber) || bossNumber < 1 || bossNumber > 5) missing.push('boss');
        const flex = !!f.flex;
        const timeSlot = flex ? null : (f.timeSlot || null);
        if (!flex && !/^h(0[0-9]|1[0-9]|2[0-3])$/.test(String(timeSlot || ''))) missing.push('time');
        const lo = f.loadout || null;
        const slot = Number(lo && lo.slot);
        if (!lo || (slot !== 1 && slot !== 2) || !(Number(lo.dmgB) > 0)) missing.push('loadout');
        if (missing.length) return { ok: false, missing };
        // いまのレベルでそのボスが倒れていれば、次のレベルのそのボスに置かれることを本人に伝える
        const note = (boss && Number(boss.remaining_hp_raw) <= 0)
            ? 'このボスはいまのレベルでは倒れています。約束の時刻に次のレベルで出てきていれば、そこに置かれます。' : '';
        return {
            ok: true, missing: [], note,
            draft: {
                raidLevel: null, bossNumber, loadoutSlot: slot,
                flex, timeSlot,
                characters: Array.isArray(lo.characters) ? lo.characters.filter(Boolean) : [],
                expectedDamageB: Number(lo.dmgB),
                sourceType: 'self',
            },
        };
    }

    // ===== 本人のホーム = 3枠 (2026-09-08 ユーザーのイメージ) ==================
    // 「予約したカードは固定で置かれ、予約しなかった枠は運営の算出が埋め、埋まらなかった枠には
    //  なぜ選ばれなかったかが日本語で書いてある」を1つの純関数で組み立てる。
    // 画面は並べるだけ。ここで組まないと、ヒーローと「わたしの凸」で違う枠が出る。

    // 'hXX' → ソルバーの時間帯インデックス (HOUR_ORDER は 5時始まり: 5..23, 0..4)。読めなければ null
    function slotIdxOf(timeSlot) {
        const m = /^h(\d\d)$/.exec(String(timeSlot || ''));
        if (!m) return null;
        const h = Number(m[1]);
        return (h >= 0 && h <= 23) ? ((h - 5 + 24) % 24) : null;
    }
    // 配信の行が、その予約の「時刻」まで満たしているか (reservationId が無い古い配信との突き合わせ用)。
    // ★ 誰が・ボス・編成枠 だけで突き合わせると、9時の古い割当が 21時の予約を「入っている」ことにしてしまう
    //   (Codex指摘 2026-09-08)。予約は時刻まで約束なので、時刻も見る
    function rowHonorsTime(a, r) {
        if (!a || !r) return false;
        if (r.time_mode === 'flex') return !!a.flex;
        const want = slotIdxOf(r.time_slot);
        if (want == null) return true;                 // 時刻が読めない旧データは編成枠まででよしとする
        return !a.flex && a.hourIdx != null && Number(a.hourIdx) === want;
    }

    /** 配信プランから本人の行を時系列で取り出す (画面の _myPlanRows と同じ規約) */
    function planRowsOf(plan, viewerId, doneCounts) {
        const mine = [];
        (Array.isArray(plan && plan.levels) ? plan.levels : []).forEach(lv => {
            (Array.isArray(lv.bosses) ? lv.bosses : []).forEach(b => {
                (Array.isArray(b.attacks) ? b.attacks : []).forEach(a => {
                    if (String(a.memberId) !== String(viewerId)) return;
                    mine.push({ ...a, level: Number(lv.level) || 1, bossNumber: Number(b.bossNumber),
                                bossName: b.name, attribute: b.attribute, weakness: b.weakness });
                });
            });
        });
        mine.sort((a, b) => ((a.hourIdx ?? 99) - (b.hourIdx ?? 99)));
        const remain = new Map(doneCounts || []);
        mine.forEach(a => {
            const key = `${a.level}:${Number(a.bossNumber)}`;
            const rem = remain.get(key) || 0;
            a.done = rem > 0;
            if (a.done) remain.set(key, rem - 1);
        });
        return mine;
    }

    /**
     * @param {Object} o
     * @param {Object|null} o.plan 配信中のプラン (無ければ null)
     * @param {*} o.viewerId
     * @param {Object[]} o.reservations 本人の予約 (plan_reservations の行)
     * @param {Map=} o.doneCounts 配信後に報告した「level:boss」→件数
     * @param {number=} o.todayAttacks 当日の実凸総数
     * @returns {{slots:Object[], stale:boolean, fixedCount:number}}
     *   slot.kind = 'fixed' (予約で固定) | 'plan' (配信の割当) | 'done' (プラン外の実凸) | 'empty' (理由つき)
     *   stale = 配信が予約より古い (固定した予約が配信に入っていない) → 「運営が組み直し中」を出す
     */
    function homeSlots({ plan, viewerId, reservations, doneCounts, todayAttacks } = {}) {
        // 本人に見せるのは 約束 と、📣 お願いされた運営の固定 (asked_at あり)。まだ下書きの 📌 は出さない
        const fixed = (Array.isArray(reservations) ? reservations : []).filter(r => isPromise(r) || isAskedPin(r))
            .slice().sort((a, b) => {
                const ta = a.time_mode === 'flex' ? 'zz' : String(a.time_slot || 'zz');
                const tb = b.time_mode === 'flex' ? 'zz' : String(b.time_slot || 'zz');
                return ta < tb ? -1 : ta > tb ? 1 : (Number(a.id) - Number(b.id));
            });
        const rows = plan ? planRowsOf(plan, viewerId, doneCounts) : [];
        // 配信プランが「置けなかった」予約 (キャラ被り等)。組み直し待ちではなく、置けていないことを本人に出す
        const unmetById = new Map((Array.isArray(plan && plan.unmetReservations) ? plan.unmetReservations : [])
            .map(u => [String(u.reservationId), u]));
        const usedRow = new Set();
        const slots = [];
        let stale = false;
        // ① 固定した予約。配信に同じカードが入っていればその行を「予約の時刻」で出す
        for (const r of fixed) {
            const idx = rows.findIndex((a, i) => !usedRow.has(i) && (
                (a.reservationId != null && String(a.reservationId) === String(r.id))
                || (a.reservationId == null
                    && Number(a.bossNumber) === Number(r.boss_number) && (Number(a.loadoutSlot) || 1) === Number(r.loadout_slot)
                    && rowHonorsTime(a, r))));
            const a = idx >= 0 ? rows[idx] : null;
            const um = unmetById.get(String(r.id)) || null;
            if (a) usedRow.add(idx); else if (plan && !um) stale = true;   // 配信がこの予約を知らない (置けなかったのは別)
            slots.push({
                kind: 'fixed', reservationId: r.id, status: r.status,
                bossNumber: Number(r.boss_number), loadoutSlot: Number(r.loadout_slot) || 1,
                team: Array.isArray(r.characters_snapshot) ? r.characters_snapshot.filter(Boolean) : (a && a.team) || [],
                dmgB: Number(r.expected_damage_b) || (a ? Number(a.dmgB) || 0 : 0),
                flex: r.time_mode === 'flex', timeSlot: r.time_mode === 'flex' ? null : (r.time_slot || null),
                level: a ? a.level : null, inPlan: !!a, done: !!(a && a.done),
                bossName: a ? a.bossName : null, weakness: a ? a.weakness : null, attribute: a ? a.attribute : null,
                approvedBy: r.approved_by || null,
                pinnedBy: r.pinned_by || null, askDeadlineAt: r.ask_deadline_at || null,   // 📣 運営からのお願い (status = 'pinned')
                unmet: um ? um.reason : null, unmetText: um ? unmetText(um) : '',
            });
        }
        // ② 配信の割当 (予約と重ならないもの)。3枠を超える分は配信が古い証拠 = 出さない
        rows.forEach((a, i) => {
            if (usedRow.has(i)) return;
            if (slots.length >= 3) { stale = true; return; }
            slots.push({ kind: 'plan', ...a, loadoutSlot: Number(a.loadoutSlot) || 1, level: a.level, inPlan: true });
        });
        // ③ プラン外の実凸 (配信に無いボスへ凸した分) は枠を消費する
        const doneInRows = slots.filter(s => s.done).length;
        const extraDone = Math.max(0, (Number(todayAttacks) || 0) - doneInRows);
        for (let i = 0; i < extraDone && slots.length < 3; i++) slots.push({ kind: 'done' });
        // ④ 空き枠 = 理由つき
        const mine = Array.isArray(plan && plan.unassigned)
            ? plan.unassigned.find(u => String(u.memberId) === String(viewerId)) || null : null;
        while (slots.length < 3) {
            const reason = !plan ? 'no_plan' : (mine ? mine.reason : 'not_needed');
            slots.push({ kind: 'empty', reason,
                         text: reason === 'no_plan' ? '運営の算出待ちです' : (UNASSIGNED_JP[reason] || UNASSIGNED_JP.not_needed) });
        }
        return { slots: slots.slice(0, 3), stale, fixedCount: fixed.length };
    }

    /**
     * 配信のあとに固定された (= 配信に入っていない) 予約。運営のホームで「配信後の予約があります」を出す根拠
     * @returns {{count:number, items:Object[]}}
     */
    function pendingRepublish(rows, plan) {
        const fixed = (Array.isArray(rows) ? rows : []).filter(isFixed);
        if (fixed.length === 0) return { count: 0, items: [] };
        const inPlan = new Set();
        // 配信が「置けなかった」と知っている予約は、配信後の予約には数えない (組み直しても置けない)
        const unmet = new Set((Array.isArray(plan && plan.unmetReservations) ? plan.unmetReservations : []).map(u => String(u.reservationId)));
        const planRows = [];
        (Array.isArray(plan && plan.levels) ? plan.levels : []).forEach(lv =>
            (lv.bosses || []).forEach(b => (b.attacks || []).forEach(a => {
                if (a.reservationId != null) inPlan.add(String(a.reservationId));
                else planRows.push({ ...a, bossNumber: Number(b.bossNumber) });
            })));
        // reservationId が無い古い配信は、誰が・ボス・編成枠・**時刻** が揃うときだけ「入っている」とみなす
        const items = fixed.filter(r => !inPlan.has(String(r.id)) && !unmet.has(String(r.id))
            && !planRows.some(a => String(a.memberId) === String(r.player_id)
                && Number(a.bossNumber) === Number(r.boss_number)
                && (Number(a.loadoutSlot) || 1) === Number(r.loadout_slot)
                && rowHonorsTime(a, r)));
        return { count: items.length, items };
    }

    root.reservationsDomain = {
        STATUS, ACTIVE, STATUS_JP, RELEASE_JP, TRANSITIONS, UNMET_JP, UNASSIGNED_JP,
        unmetText, planRowsOf, homeSlots, pendingRepublish, slotIdxOf, rowHonorsTime,
        isActive, isApproved, isFixed, isPromise, isPin, isAskedPin, pinFor, canPin, fingerprint, canTransition,
        toSolverConstraints,
        findInfeasible,
        capacityLeft,
        describe,
        approvalImpact,
        planRowToDraft, findActiveFor, canRequest, conflictingReservation, matchForAttack, buildRequestDraft,
    };
})(typeof window !== 'undefined' ? window : globalThis);
