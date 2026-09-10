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
     * 別のボスの締め凸依頼で、その人の凸がもう埋まっているかを数える。
     * ★ 1人の持ち凸は3つしかないので、別のボスの案に同じ人が出ていると足し算が合わない。
     *   了承済み (accepted) は**使う約束が済んでいる**ので凸を1つ消費したものとして扱い、
     *   確認中 (pending) はまだ約束ではないので数えず、印だけ付ける。
     * @param {{player_id:any, boss_number:number, status:string}[]} requests
     * @param {number} bossNumber いま見ているボス (ここへの依頼は自分自身なので数えない)
     * @returns {Map<string, {accepted:number, pending:number}>} key は String(player_id)
     */
    function commitmentsElsewhere(requests, bossNumber) {
        const m = new Map();
        for (const r of (Array.isArray(requests) ? requests : [])) {
            if (r == null || r.player_id == null) continue;
            if (Number(r.boss_number) === Number(bossNumber)) continue;   // 自分のボスは対象外
            const st = r.status;
            if (st !== 'accepted' && st !== 'pending') continue;          // 断られた依頼は数えない
            const k = String(r.player_id);
            const cur = m.get(k) || { accepted: 0, pending: 0 };
            cur[st] += 1;
            m.set(k, cur);
        }
        return m;
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
        const usedOf = (p) => (commitments && p && p.id != null) ? (commitments.get(String(p.id)) || null) : null;
        // ★ 了承済みのぶん凸が埋まっている人は、この ボスの候補から外す
        //   (attackCount は「報告済み」しか数えないので、了承済みの約束はここで引く)
        const pool = all.filter(p => {
            const c = usedOf(p);
            if (!c || !c.accepted) return true;
            const left = 3 - (Number(p.attackCount) || 0) - c.accepted;
            return left > 0;
        });
        const rows = [];
        let prevNames = null;
        for (const w of windows) {
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
                pendingNames: inWin.filter(p => { const c = usedOf(p); return !!(c && c.pending); }).map(p => p.name),
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
        const now = rows[0] || null;
        const bestKey = best ? best.row.key : null;
        // 待つと何B節約できるか (今すぐ倒せる場合だけ意味がある)
        const gainB = (best && now && now.plan && best.row !== now)
            ? Math.max(0, now.plan.overkill - best.row.plan.overkill) : null;
        // 今は倒しきれないが、待てば倒せる
        const killableAfterWait = !!(now && !now.plan && best);
        return { rows, bestKey, gainB, killableAfterWait, anyKillable: !!best };
    }

    root.finishDomain = {
        computeFinishPlans, buildFinishLeaderTimeline, filterByWindow,
        FINISH_WINDOWS, compareFinishWindows, commitmentsElsewhere,
    };
})(typeof window !== 'undefined' ? window : globalThis);
