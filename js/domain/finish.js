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
    function computeFinishPlans(candidates, remHP) {
        if (remHP <= 0 || candidates.length === 0) return { tight: null, safe: null, cannotKill: false };
        const all = [];
        const N = candidates.length;
        for (let i = 0; i < N; i++) {
            if (candidates[i].dmg >= remHP) {
                all.push({ members: [candidates[i]], total: candidates[i].dmg, overkill: candidates[i].dmg - remHP, shots: 1 });
            }
        }
        for (let i = 0; i < N; i++) {
            for (let j = i + 1; j < N; j++) {
                const s = candidates[i].dmg + candidates[j].dmg;
                if (s >= remHP) all.push({ members: [candidates[i], candidates[j]], total: s, overkill: s - remHP, shots: 2 });
            }
        }
        // 1/2凸で削れない時のみ3凸を探索 (パフォーマンス配慮: 候補多い場合はトップ12のみ)
        if (all.length === 0) {
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

    root.finishDomain = { computeFinishPlans, buildFinishLeaderTimeline };
})(typeof window !== 'undefined' ? window : globalThis);
