// ============================================================================
// ドメイン: 戦闘可能時間 (availability) の読み方
// ----------------------------------------------------------------------------
// 第44回の反省: 「メンバーが自分の設定している時間を認識していない」(2026-09-08 ユーザー)。
//   ① ホームで自分の時間帯を一目で見直せるようにする (要約と24コマの帯)
//   ② (撤去) 当日、本人の時間帯が始まったら「戦闘可能時間になりました」を届ける — 2026-11-27 に 📣 当日の知らせ の「ブロックの始まり」(運営が押す) へ
//   ③ 締め凸検索で「今から N 時間の範囲」に出られる人だけを候補にする
// この3つが同じ読み方 (どの時刻が ON か・どこで区切るか) を共有するための純ロジック。
//
// 時間帯は 'hXX' (h00〜h23) の配列。並びは 5時始まり (HOUR_ORDER = 5..23, 0..4) で見る —
// 深夜0〜4時はレイド日の終わりで、「21〜翌2時」のように日付をまたいで続く。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM/Supabase 非依存で node からテスト可:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
    const keyOf = (h) => `h${String(((h % 24) + 24) % 24).padStart(2, '0')}`;
    const hourOf = (key) => {
        const m = /^h(\d\d)$/.exec(String(key || ''));
        return m ? Number(m[1]) : null;
    };
    const toSet = (slots) => new Set((Array.isArray(slots) ? slots : []).map(String));

    /**
     * ON の時間帯を、5時始まりの並びで連続する区間にまとめる。
     * @returns {{start:number, end:number, hours:number}[]} start/end は時 (0-23)。end は区間の最後の「時」(含む)
     */
    function rangesOf(slots) {
        const set = toSet(slots);
        const out = [];
        let cur = null;
        for (const h of HOUR_ORDER) {
            if (set.has(keyOf(h))) {
                if (cur) { cur.end = h; cur.hours++; }
                else cur = { start: h, end: h, hours: 1 };
            } else if (cur) { out.push(cur); cur = null; }
        }
        if (cur) out.push(cur);
        return out;
    }

    // 「5〜9時」「21〜翌2時」のように読む = 時計の言い方 (終わりは時刻: 5・6・7・8 時の枠 → 5〜9時。1 時間なら「13〜14時」。翌4 の次は「翌5」)。
    //   ブロック (raidBlocksDomain.rangeOf) と同じ言い方 (2026-10-30 ふるり「5～9時」)
    function rangeLabel(r) {
        const wrap = (h) => (h >= 0 && h <= 4) ? `翌${h}` : String(h);
        const end = r.end === 4 ? '翌5' : wrap((r.end + 1) % 24);
        return `${wrap(r.start)}〜${end}時`;
    }

    /** 「5〜9時・21〜翌2時 (10時間)」 */
    function labelOf(slots, opts = {}) {
        const rs = rangesOf(slots);
        if (rs.length === 0) return opts.flexTime ? '⏳ 隙間時間型 (時刻は約束しない)' : '未登録';
        const total = rs.reduce((s, r) => s + r.hours, 0);
        const body = rs.map(rangeLabel).join('・');
        return `${body} (${total}時間)${opts.flexTime ? ' + ⏳隙間' : ''}`;
    }

    /** その時刻が ON か */
    const isOn = (slots, hour) => toSet(slots).has(keyOf(hour));

    /** その時刻を含む区間 (無ければ null) */
    function windowAt(slots, hour) {
        const h = ((hour % 24) + 24) % 24;
        return rangesOf(slots).find(r => {
            const a = HOUR_ORDER.indexOf(r.start), b = HOUR_ORDER.indexOf(r.end), i = HOUR_ORDER.indexOf(h);
            return i >= a && i <= b;
        }) || null;
    }

    /**
     * 今から N 時間の範囲に出られるか。⏳隙間型は時刻を約束しない = いつでも可として通す。
     * 未登録 (空) で隙間型でもない人は「出られる時間が分からない」ので範囲指定のときは外す
     * @param {string[]} slots
     * @param {number} curHour 0-23
     * @param {number|null} hours 範囲 (null / 0 以下 = 制限なし)
     */
    function canAttackWithin(slots, curHour, hours, opts = {}) {
        if (hours == null || !(hours > 0)) return true;
        if (opts.flexTime) return true;
        const set = toSet(slots);
        if (set.size === 0) return false;
        const span = Math.min(24, Math.floor(hours));   // finishDomain.filterByWindow と同じ丸め (1.5時間 = 1時間)
        for (let k = 0; k < span; k++) {
            if (set.has(keyOf(curHour + k))) return true;
        }
        return false;
    }

    root.availabilityDomain = {
        HOUR_ORDER, keyOf, hourOf,
        rangesOf, rangeLabel, labelOf, isOn, windowAt, canAttackWithin,   // ⏰「参加可能時間になりました」(windowStartsAt / reminderTargets) は 2026-11-27 に撤去 (📣 当日の知らせ の「ブロックの始まり」へ)
    };
})(typeof window !== 'undefined' ? window : globalThis);
