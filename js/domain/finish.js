// ============================================================================
// ドメイン: 締め凸候補の選別 (リアーキ ステップ2 — ARCHITECTURE-AUDIT.md §4-2)
// ----------------------------------------------------------------------------
// index.html の computeFinishPlans / _buildFinishTimeline から純ロジックを抽出。
// 「残HPを誰の凸で削り切るか」の組合せ探索と、時間帯別ベスト候補の変化点検出。
// DOM・現在時刻・アプリ状態には依存しない (時刻も引数で受ける)。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {{name:string, dmg:number, availableSlots?:string[]}} FinishCandidate
     *   dmg は B単位。candidates は呼び出し側で dmg降順ソート済みが前提
     *   (3凸探索の「トップ12のみ」の意味がソート順に依存するため)。
     */

    /**
     * 残HPを倒すための最適な1〜3凸の組合せを2パターン算出する。
     * tight = オーバーキル最小、safe = 残HPの10%以上の余裕がある中で凸数最少。
     * 3凸は 1/2凸で削り切れない場合のみ探索 (パフォーマンス配慮: 上位12名に限定)。
     * @param {FinishCandidate[]} candidates
     * @param {number} remHP  残HP (B)
     */
    function computeFinishPlans(candidates, remHP, opts = {}) {
        // opts.shots = 何人で締めるか (1/2/3)。指定があればその人数の組合せだけを探す (2026-09-08 ユーザー要望)。
        //   無ければ従来どおり 1→2 を探し、削れないときだけ 3 を探す
        const shots = [1, 2, 3].includes(Number(opts.shots)) ? Number(opts.shots) : null;
        if (remHP <= 0 || candidates.length === 0) return { tight: null, safe: null, cannotKill: false };
        const all = [];
        const N = candidates.length;
        if (shots === null || shots === 1) {
            for (let i = 0; i < N; i++) {
                if (candidates[i].dmg >= remHP) {
                    all.push({ members: [candidates[i]], total: candidates[i].dmg, overkill: candidates[i].dmg - remHP, shots: 1 });
                }
            }
        }
        if (shots === null || shots === 2) {
            for (let i = 0; i < N; i++) {
                for (let j = i + 1; j < N; j++) {
                    const s = candidates[i].dmg + candidates[j].dmg;
                    if (s >= remHP) all.push({ members: [candidates[i], candidates[j]], total: s, overkill: s - remHP, shots: 2 });
                }
            }
        }
        // 1/2凸で削れない時のみ3凸を探索 (パフォーマンス配慮: 候補多い場合はトップ12のみ)。人数指定が 3 なら常に探す
        if (shots === 3 || (shots === null && all.length === 0)) {
            const top = candidates.slice(0, Math.min(12, N));
            for (let i = 0; i < top.length; i++) {
                for (let j = i + 1; j < top.length; j++) {
                    for (let k = j + 1; k < top.length; k++) {
                        const s = top[i].dmg + top[j].dmg + top[k].dmg;
                        if (s >= remHP) all.push({ members: [top[i], top[j], top[k]], total: s, overkill: s - remHP, shots: 3 });
                    }
                }
            }
        }
        if (all.length === 0) return { tight: null, safe: null, cannotKill: true };

        // ギリギリ: オーバーキル昇順 → 凸数少ない順
        const tight = [...all].sort((a, b) => a.overkill - b.overkill || a.shots - b.shots)[0];
        // 余裕: 10%以上の余裕がある中で 凸数少ない → オーバーキル少ない
        const margin = remHP * 0.10;
        const safeCands = all.filter(p => p.overkill >= margin);
        const safe = safeCands.length > 0
            ? safeCands.sort((a, b) => a.shots - b.shots || a.overkill - b.overkill)[0]
            : null;
        return { tight, safe: (safe && safe !== tight) ? safe : null, cannotKill: false };
    }

    /**
     * 時間帯別の「一番ダメージを出せる候補」とリーダー変化点を算出する
     * (旧 _buildFinishTimeline の計算部分。HTML化は呼び出し側)。
     * @param {Object} args
     * @param {FinishCandidate[]} args.candidates  凸残ありの候補 (dmg>0 前提)
     * @param {number} args.curHour                現在時 (0-23, JST)。ここから24時間を順に走査
     * @returns {{rows: {hour:number, best:FinishCandidate|null, count:number, isLeaderChange?:boolean}[], leaderChanges:number}}
     */
    function buildFinishLeaderTimeline({ candidates, curHour }) {
        const sequence = [];
        for (let i = 0; i < 24; i++) sequence.push((curHour + i) % 24);
        const slotKey = (h) => `h${String(h).padStart(2, '0')}`;
        // availableSlots が空の人は「常時可」と扱う旧仕様だったが、明示的に未設定=未参加で除外
        const rows = sequence.map(h => {
            const sk = slotKey(h);
            const avail = candidates.filter(p => (p.availableSlots || []).includes(sk));
            if (avail.length === 0) return { hour: h, best: null, count: 0 };
            const best = avail.reduce((a, b) => (a.dmg >= b.dmg ? a : b));
            return { hour: h, best, count: avail.length };
        });
        // リーダー変化点を検出
        let prevBestName = null;
        let leaderChanges = 0;
        rows.forEach(r => {
            if (r.best?.name && r.best.name !== prevBestName) {
                r.isLeaderChange = true;
                prevBestName = r.best.name;
                leaderChanges++;
            }
        });
        return { rows, leaderChanges };
    }

    /**
     * 「今から N 時間の範囲」に出られる候補だけを残す (2026-09-08 ユーザー要望)。
     * ⏳隙間型 (flexTime) は時刻を約束しない = いつでも可として通す。
     * 時間帯が未登録で隙間型でもない人は「出られる時間が分からない」ので、範囲を指定したときは外す。
     * hours が null / 0 以下なら制限なし (全員そのまま)
     * @param {{availableSlots?:string[], flexTime?:boolean}[]} candidates
     * @param {{curHour:number, hours:number|null}} args curHour は 0-23 (JST)
     */
    function filterByWindow(candidates, { curHour, hours }) {
        const list = Array.isArray(candidates) ? candidates : [];
        if (hours == null || !(hours > 0)) return list.slice();
        const keyOf = (h) => `h${String(((h % 24) + 24) % 24).padStart(2, '0')}`;
        const span = Math.min(24, Math.floor(hours));
        return list.filter(p => {
            if (p.flexTime) return true;
            const set = new Set(p.availableSlots || []);
            if (set.size === 0) return false;
            for (let k = 0; k < span; k++) if (set.has(keyOf(curHour + k))) return true;
            return false;
        });
    }

    /**
     * 締め凸コンソールの窓 (2026-09-10)。運営が当日いちばん知りたいのは
     * 「今すぐ打つか / もう少し待つか」なので、待つ長さで並べる。
     * hours = null は「今日いっぱい (制限なし)」。
     */
    const FINISH_WINDOWS = [
        { key: 'now', label: '今すぐ',     hours: 1 },
        { key: 'h2',  label: '2時間以内',  hours: 2 },
        { key: 'h4',  label: '4時間以内',  hours: 4 },
        { key: 'all', label: '今日いっぱい', hours: null },
    ];

    /**
     * 別のボスの締め凸依頼を、その人ごとに畳む。
     * ★ 1人の持ち凸は3つしかないので、別のボスの案に同じ人が出ていると足し算が合わない。
     * ★ **ボス番号で持つ** (件数で数えない) — 理由は2つ (Codex指摘 2026-09-10):
     *   ① 同じ人・同じボスに依頼行が2つあると、件数だと二重に引いてしまう
     *   ② 了承済みの依頼は、本人がそのボスへ凸を報告したあとも**撃破まで残る**。
     *      件数だと「報告済みの凸 (attackCount)」と「了承済み」で同じ1凸を二重に引く。
     *      ボス番号で持てば「もうそのボスへ凸したか」で消し込める。
     * @param {{player_id:any, boss_number:number, status:string}[]} requests
     * @param {number} bossNumber いま見ているボス (ここへの依頼は自分自身なので数えない)
     * @returns {Map<string, {accepted:Set<number>, pending:Set<number>}>} key は String(player_id)
     */
    function commitmentsElsewhere(requests, bossNumber) {
        const m = new Map();
        for (const r of (Array.isArray(requests) ? requests : [])) {
            if (r == null || r.player_id == null) continue;
            const bn = Number(r.boss_number);
            if (!Number.isFinite(bn)) continue;
            if (bn === Number(bossNumber)) continue;                      // 自分のボスは対象外
            const st = r.status;
            if (st !== 'accepted' && st !== 'pending') continue;          // 断られた依頼は数えない
            const k = String(r.player_id);
            const cur = m.get(k) || { accepted: new Set(), pending: new Set() };
            cur[st].add(bn);
            m.set(k, cur);
        }
        // ★ 同じボスに accepted と pending が両方あるなら accepted が勝つ (確認中とは出さない)
        for (const v of m.values()) for (const bn of v.accepted) v.pending.delete(bn);
        return m;
    }

    /** その人が「まだ果たしていない」約束の数。約束したボスへ既に凸していれば済んでいる */
    function _openAccepted(p, com) {
        const c = com && p && p.id != null ? com.get(String(p.id)) : null;
        if (!c || c.accepted.size === 0) return 0;
        const done = new Set((p.attacks || []).map(a => Number(a && a.boss_number)));
        let open = 0;
        for (const bn of c.accepted) if (!done.has(bn)) open++;
        return open;
    }
    /** 別のボスで「確認中」の返事待ちが残っているか (済んだボスのぶんは数えない) */
    function _hasOpenPending(p, com) {
        const c = com && p && p.id != null ? com.get(String(p.id)) : null;
        if (!c || c.pending.size === 0) return false;
        const done = new Set((p.attacks || []).map(a => Number(a && a.boss_number)));
        for (const bn of c.pending) if (!done.has(bn)) return true;
        return false;
    }

    /**
     * 別のボスの約束で凸が埋まった人を外す。
     * ★ **候補を作るところで1回だけ**通し、一覧・推薦プラン・Push で同じ顔ぶれを使うこと
     *   (コンソールだけで外すと、下の一覧や Push には残って二重に頼める — Codex指摘 2026-09-10)
     */
    function filterByCommitments(candidates, commitments) {
        const list = Array.isArray(candidates) ? candidates : [];
        if (!commitments || commitments.size === 0) return list.slice();
        return list.filter(p => (3 - (Number(p.attackCount) || 0) - _openAccepted(p, commitments)) > 0);
    }

    /**
     * 「今」打てる手と「もう少し待って」打てる手を、窓ごとに並べて比べる。
     *
     * ★ 決めごと:
     *   - **きれい = オーバーキルが小さい**。同点なら人数が少ないほう、さらに同点なら早い窓
     *     (待つのはコストなので、同じ結果なら早いほうを採る)
     *   - **待って増える人 (newFaces) を出す**。これが無いと「なぜ待つと良くなるのか」が読めない
     *   - **別のボスで凸が埋まっている人は候補から外す** (了承済みのみ)。
     *     確認中は約束ではないので残し、印だけ付ける
     *
     * @param {Object} args
     * @param {FinishCandidate[]} args.candidates dmg降順。availableSlots / flexTime / id を持つ
     * @param {number} args.remHP 残HP (B)
     * @param {number} args.curHour 0-23 (JST)
     * @param {number|null} [args.shots] 何人で締めるか (null = 自動)
     * @param {Map<string,{accepted:number,pending:number}>} [args.commitments] commitmentsElsewhere の結果
     * @param {{key:string,label:string,hours:number|null}[]} [args.windows]
     */
    function compareFinishWindows({ candidates, remHP, curHour, shots = null, commitments = null, windows = FINISH_WINDOWS }) {
        const all = Array.isArray(candidates) ? candidates : [];
        // ★ もう倒れているボスに「倒しきれません」と出さない (Codex指摘 2026-09-10)。
        //   computeFinishPlans は remHP<=0 で cannotKill:false を返すので、ここで見分ける
        if (!(Number(remHP) > 0)) {
            return { rows: [], bestKey: null, gainB: null, killableAfterWait: false, anyKillable: false, alreadyDead: true };
        }
        const pool = filterByCommitments(all, commitments);
        // ★ 窓は**待つ長さの順**に正規化してから使う (呼ぶ側の並びに結論が左右されないように)。
        //   制限なし (hours == null) はいちばん長く待つ扱い
        const ws = [...(Array.isArray(windows) ? windows : FINISH_WINDOWS)]
            .sort((a, b) => (a.hours == null ? Infinity : a.hours) - (b.hours == null ? Infinity : b.hours));
        const rows = [];
        let prevNames = null;
        for (const w of ws) {
            const inWin = filterByWindow(pool, { curHour, hours: w.hours });
            const names = new Set(inWin.map(p => p.name));
            // 待って**増えた**人 (ひとつ前の窓に居なかった人)。最初の窓は空
            const newFaces = prevNames === null ? [] : inWin.filter(p => !prevNames.has(p.name)).map(p => p.name);
            prevNames = names;
            const r = computeFinishPlans(inWin, remHP, { shots });
            rows.push({
                key: w.key, label: w.label, hours: w.hours,
                count: inWin.length,
                newFaces,
                plan: r.tight || null,
                safe: r.safe || null,
                cannotKill: !!r.cannotKill || !r.tight,
                // 確認中の依頼がある人は印を付ける (外しはしない)
                pendingNames: inWin.filter(p => _hasOpenPending(p, commitments)).map(p => p.name),
            });
        }
        // いちばんきれいな窓: オーバーキル小 → 人数少 → 早い窓
        let best = null;
        rows.forEach((r, i) => {
            if (!r.plan) return;
            if (!best) { best = { row: r, i }; return; }
            const a2 = r.plan, b2 = best.row.plan;
            if (a2.overkill < b2.overkill - 1e-9
                || (Math.abs(a2.overkill - b2.overkill) <= 1e-9 && a2.shots < b2.shots)) best = { row: r, i };
        });
        // ★ 「今」は並びの先頭ではなく**いちばん短く待つ窓**で決める
        const now = rows.length ? rows.reduce((a, b) => ((a.hours == null ? Infinity : a.hours) <= (b.hours == null ? Infinity : b.hours) ? a : b)) : null;
        const bestKey = best ? best.row.key : null;
        // 待つと何B節約できるか (今すぐ倒せる場合だけ意味がある)
        const gainB = (best && now && now.plan && best.row !== now)
            ? Math.max(0, now.plan.overkill - best.row.plan.overkill) : null;
        // 今は倒しきれないが、待てば倒せる
        const killableAfterWait = !!(now && !now.plan && best);
        return { rows, bestKey, gainB, killableAfterWait, anyKillable: !!best };
    }

    /**
     * 同時に出した複数の案の進み具合をまとめる (③ 複数案の同時打診・2026-09-10)。
     *
     * ★ なぜ要るか (運営ふるりの言葉):
     *   「A さんが進言してくれても、理想を言えば B+C さんの方がキレイに削りきれるときに、
     *     B と C さんどちらかが反応が無いとユニオン全体で進行できなくなる。
     *     結果 A さんには待たせてしまう」
     *   → 1案ずつ順に聞くと**返事待ちが直列に積み上がる**。同時に出して先に揃った案で確定する。
     *
     * ★ 決めごと:
     *   - **成立 = その案の全員が了承**。1人でも断ったらその案は死ぬ (待っても揃わない)
     *   - 成立した案が複数あるなら、**先に揃ったほう**を採る (最後の了承が早い順)。
     *     同時刻なら人数の少ないほう → 案の並び順、で決める (毎回同じ答えになるように)
     *   - **落ちた案の人は「待たされている人」ではない**。確定したら必ず伝える
     *     (黙って流すと、次から返事が来なくなる)
     *
     * @param {{player_id:any, plan_key:string, status:string, responded_at?:string,
     *          deadline_at?:string, name?:string}[]} rows 同じ offer_id の行
     * @param {{now?: number}} [opts] now = 判定時刻 (ミリ秒)。省略時は現在時刻
     * @returns {{plans:Array, winner:string|null, waitingOn:string[], allDead:boolean,
     *            expired:boolean, deadlineAt:string|null, decided:boolean}}
     */
    function offerProgress(rows, opts = {}) {
        const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.player_id != null);
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const byPlan = new Map();
        let deadlineAt = null;
        for (const r of list) {
            const k = r.plan_key == null ? '-' : String(r.plan_key);
            if (!byPlan.has(k)) byPlan.set(k, []);
            byPlan.get(k).push(r);
            if (r.deadline_at && (!deadlineAt || String(r.deadline_at) < deadlineAt)) deadlineAt = String(r.deadline_at);
        }
        const ts = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
        const plans = [...byPlan.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, rs]) => {
            // ★ 同じ人が2行あっても1人として数える (揃ったかの判定が狂う)。より進んだ返事を採る
            const rank = { declined: 3, accepted: 2, pending: 1 };
            const byPlayer = new Map();
            for (const r of rs) {
                const pk = String(r.player_id);
                const cur = byPlayer.get(pk);
                // ★ 数えるのは1人でも、**行はすべて覚えておく** (Codex指摘 2026-09-10)。
                //   1行しか持たないと、確定のときに落とし損ねた行が「確認中」で残り、
                //   あとから二重に頼まれる。44 の一意索引が守っている前提に寄りかからない
                if (!cur) {
                    byPlayer.set(pk, { rep: r, rows: [r] });
                } else {
                    cur.rows.push(r);
                    if ((rank[r.status] || 0) > (rank[cur.rep.status] || 0)) cur.rep = r;
                }
            }
            const members = [...byPlayer.values()].map(({ rep: r, rows }) => ({
                id: r.player_id,
                rowId: r.id != null ? r.id : null,
                // その人のその案の行すべて (落とすときはこちらを使う)
                rowIds: rows.map(x => (x.id != null ? x.id : null)).filter(x => x != null),
                missingRowIds: rows.filter(x => x.id == null).length,
                name: r.name || (r.players && r.players.name) || String(r.player_id),
                status: r.status,
                respondedAt: r.responded_at || null,
            }));
            const accepted = members.filter(m => m.status === 'accepted');
            const declined = members.filter(m => m.status === 'declined');
            const waiting = members.filter(m => m.status !== 'accepted' && m.status !== 'declined');
            // 揃った時刻 = その案のいちばん遅い了承 (全員そろって初めて成立するので)
            const readyAt = (declined.length === 0 && waiting.length === 0 && members.length > 0)
                ? accepted.reduce((mx, m) => { const t = ts(m.respondedAt); return t != null && (mx == null || t > mx) ? t : mx; }, null)
                : null;
            return {
                key, members,
                acceptedCount: accepted.length,
                total: members.length,
                waitingNames: waiting.map(m => m.name),
                declinedNames: declined.map(m => m.name),
                ready: declined.length === 0 && waiting.length === 0 && members.length > 0,
                dead: declined.length > 0,
                readyAt,
            };
        });
        // 先に揃った案が勝ち。時刻が同じ / 読めないときは 人数少 → 並び順
        const readyPlans = plans.filter(p => p.ready);
        let winner = null;
        for (const p of readyPlans) {
            if (!winner) { winner = p; continue; }
            const a = p.readyAt, b = winner.readyAt;
            if (a != null && b != null && a !== b) { if (a < b) winner = p; continue; }
            if (a != null && b == null) { winner = p; continue; }
            if (a == null && b != null) continue;
            if (p.total !== winner.total) { if (p.total < winner.total) winner = p; continue; }
            // ここまで同じなら並び順 (plans は key 昇順) = 先に来たほうを残す
        }
        const dl = ts(deadlineAt);
        return {
            plans,
            winner: winner ? winner.key : null,
            // まだ返事が無い人 (生きている案のぶんだけ。死んだ案の返事を待っても意味が無い)
            waitingOn: [...new Set(plans.filter(p => !p.dead).flatMap(p => p.waitingNames))],
            allDead: plans.length > 0 && plans.every(p => p.dead),
            expired: dl != null && now > dl && !winner,
            deadlineAt,
            decided: !!winner,
        };
    }

    /**
     * 確定したときに「落ちた案の人」を返す。★ 黙って流さないための材料。
     * 勝った案にも入っている人は除く (その人には別途お願いが立っている)。
     */
    /**
     * 確定したときの後始末。**「見送りにする行」と「知らせる人」は別物**なので分けて返す
     * (Codex指摘 2026-09-10 — 一緒にしていたため、勝った案にも居る人の落ちた行が
     *  accepted のまま残り、DB 上で確定が表せていなかった)。
     *
     * @returns {{rowIds:(number|string)[], notify:{id,name,rowIds}[], missingRowIds:number}}
     *   rowIds        落ちた案の行**すべて** (勝った案に居る人のぶんも含む)
     *   notify        「今回は見送り」を知らせる人。勝った案にも居る人と、自分で断った人は除く
     *   missingRowIds 行 id が分からなかった数。0 でなければ確定してはいけない
     */
    function offerLosers(progress, winnerKey) {
        const empty = { rowIds: [], notify: [], missingRowIds: 0 };
        if (!progress || !Array.isArray(progress.plans)) return empty;
        const win = progress.plans.find(p => p.key === winnerKey);
        const winIds = new Set((win ? win.members : []).map(m => String(m.id)));
        const rowIds = [];
        let missingRowIds = 0;
        const out = new Map();
        for (const p of progress.plans) {
            if (p.key === winnerKey) continue;
            for (const m of p.members) {
                // ★ 行は**誰のものでも・何行でも**落とす。勝った案に居る人の行を残すと、
                //   その案が accepted のまま生き続けて「確定した」ことが記録に出ない
                const mine = Array.isArray(m.rowIds) ? m.rowIds : (m.rowId != null ? [m.rowId] : []);
                for (const rid of mine) rowIds.push(rid);
                missingRowIds += Number(m.missingRowIds) || (mine.length === 0 ? 1 : 0);
                if (winIds.has(String(m.id))) continue;     // 勝った案にも居る = 見送りではない
                if (m.status === 'declined') continue;      // 断った人に「落ちました」は要らない
                const k = String(m.id);
                // ★ 同じ人が落ちた案に2つ居ることがある。**行はすべて**返す
                //   (1行だけ落とすと、もう片方が「確認中」のまま残って二重に頼める)
                const cur = out.get(k) || { id: m.id, name: m.name, rowIds: [] };
                for (const rid of mine) cur.rowIds.push(rid);
                out.set(k, cur);
            }
        }
        return { rowIds, notify: [...out.values()], missingRowIds };
    }

    root.finishDomain = {
        computeFinishPlans, buildFinishLeaderTimeline, filterByWindow,
        FINISH_WINDOWS, compareFinishWindows, commitmentsElsewhere, filterByCommitments,
        offerProgress, offerLosers,
    };
})(typeof window !== 'undefined' ? window : globalThis);
