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

    // 残凸の枠を押さえている状態 (DB のトリガーと同じ集合にすること)
    const ACTIVE = ['requested', 'approved', 'cancel_requested'];
    const STATUS_JP = {
        requested: '承認待ち',
        approved: '予約済み',
        cancel_requested: '取り消し希望',
        fulfilled: '実行済み',
        released: '解除',
        rejected: '見送り',
        pinned: '運営の仮置き',
    };

    const isActive = (r) => !!r && ACTIVE.includes(r.status);
    const isPin = (r) => !!r && r.status === 'pinned';

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
            if (!Number.isInteger(loadoutSlot) || loadoutSlot < 1 || loadoutSlot > SLOT_MAX) return;
            if (r.player_id == null) return;
            out.push({
                reservationId: r.id ?? null,
                memberId: r.player_id,
                level,
                bossNumber,
                loadoutSlot,
                // flex は時刻を約束しない予約 (⏳隙間型)。fixed は 'hXX'。🧱 block は窓 (時刻はソルバーが窓の中で決める)
                flex: r.time_mode === 'flex',
                timeSlot: (r.time_mode === 'flex' || r.time_mode === 'block') ? null : (r.time_slot || null),
                ...(blockWindowOf(r) ? { window: blockWindowOf(r) } : {}),
                team: Array.isArray(r.characters_snapshot) ? r.characters_snapshot.filter(Boolean) : [],
                expectedB: Number(r.expected_damage_b) || 0,
                pinned: isPin(r),   // 📌 画面で 🔒 (予約) と見分けるため。ソルバーの置き方は同じ
            });
        });
        const idKey = (v) => String(v);
        out.sort((x, y) => ((x.level ?? 0) - (y.level ?? 0))
            || (x.bossNumber - y.bossNumber)
            || (idKey(x.memberId) < idKey(y.memberId) ? -1 : idKey(x.memberId) > idKey(y.memberId) ? 1 : 0)
            || (x.loadoutSlot - y.loadoutSlot));
        return out;
    }

    // ===== 🧱 段階 3 (2026-10-22 ユーザー決定「予約はブロックだけ選ぶ・時刻は運営がブロックの中で決める」) =====
    // plan_reservations.time_mode = 'block' + block_from / block_to (時・含む・SQL 54)。時刻 (time_slot) は持たない
    const idxOfHourB = (h) => { const n = Number(h); return (h != null && h !== '' && Number.isInteger(n) && n >= 0 && n <= 23) ? ((n - 5 + 24) % 24) : null; };
    const SLOT_MAX = 3;   // 編成の枠の上限 (SQL 55・supabase-client の MOCK_SLOT_MAX と同じ)
    /** ブロックの予約の窓 (時間帯インデックス・5時始まり)。ブロックの予約でなければ / 読めなければ null */
    function blockWindowOf(r) {
        if (!r || r.time_mode !== 'block') return null;
        const f = idxOfHourB(r.block_from), t = idxOfHourB(r.block_to);
        return (f == null || t == null || f > t) ? null : { fromIdx: f, toIdx: t };
    }
    /** 「17〜21時」(時計の言い方 = 終わりは時刻・block_to は含む時のまま。翌4 の次は「翌5」・2026-10-30)。ブロックの予約でなければ '' */
    /** 予約の時刻の言い方: 「21時」/「18〜20時のどこか」/「⏳隙間」/「時刻未定」 */

    /** 1件を人が読める1行に。「Lv2 B3 21時 編成②」 */

    // ===== ⑧ 申請UI 用 ==========================================================

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
            return { ok: false, reason: 'promise_exists', label: '本人の予約があります' };
        }
        const held = list.filter(r => isPromise(r) || isPin(r)).length;
        if (held + (Number(doneAttacks) || 0) >= 3) return { ok: false, reason: 'no_capacity', label: '残り凸がありません' };
        const mine = new Set(_charKeys(characters));
        const clash = mine.size ? list.find(r => (isActive(r) || isPin(r)) && _charKeys(r.characters_snapshot).some(k => mine.has(k))) : null;
        if (clash) return { ok: false, reason: 'char_conflict', label: '同じキャラを使う予約・仮置きがあります', with: clash };
        return { ok: true, left: 3 - held - (Number(doneAttacks) || 0) };
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

    // ===== 本人のホーム = 3枠 (2026-09-08 ユーザーのイメージ) ==================
    // 「予約したカードは固定で置かれ、予約しなかった枠は運営の算出が埋め、埋まらなかった枠には
    //  なぜ選ばれなかったかが日本語で書いてある」を1つの純関数で組み立てる。
    // 画面は並べるだけ。ここで組まないと、ヒーローと「わたしの凸」で違う枠が出る。

    /** 配信プランから本人の行を時系列で取り出す (画面の _myPlanRows と同じ規約) */

    /** 🧱 ブロックのぶんの配信 (plan.blockScope.slots) の時間の中か。⏳隙間型・時刻の読めない行は中 (raidBlocksDomain.scopeReservations と同じ読み方)。1 日ぶんの配信は全部中 */

    root.reservationsDomain = {
        ACTIVE, STATUS_JP, blockWindowOf, isActive, isFixed, isPromise, isPin, canPin,
        toSolverConstraints, conflictingReservation, matchForAttack,
    };
})(typeof window !== 'undefined' ? window : globalThis);
