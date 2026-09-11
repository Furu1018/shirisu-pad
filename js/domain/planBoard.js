// ============================================================================
// ドメイン: 最適凸プランの「条件」と「盤の読みやすさ」 (パズル盤 ①② — 2026-09-11)
// ----------------------------------------------------------------------------
// ユーザーの言葉: 「今の算出がどのような状態で算出されたものか分かりにくかった」。
//   ① 条件は3つだけ選ぶ (対象 / 起点 / 前回の配信)。自動で効くもの (予約・除外・難しい・配信中) は見せるだけ。
//      **結果に「この条件で組んだ」を焼き込む** (配信されたプランにも残る → 交代した運営が読める)
//   ② 時間割で、その人の戦闘可能時間と「動かせる幅」(硬い / 狭い / 柔らかい) が読める
// ここは純ロジックだけ: 条件の正規化・要約・動かせる幅・模擬の更新数。DOM は index.html。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const WHO = { all: '全員', now: '今動ける人だけ' };
    const FROM = { now: '今から', day: '朝5時から' };
    const PREV = { keep: '前回を尊重', fresh: 'ゼロから' };

    const n0 = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

    /**
     * 算出に効いた条件を1つの形に正規化する (プランに焼き込む形)。
     * @param {Object} a
     * @param {'all'|'now'} a.who           対象 (全員 / 今動ける人だけ)
     * @param {'now'|'day'} a.from          起点 (今から / 朝5時から)
     * @param {'keep'|'fresh'} a.prev       前回の配信 (尊重 / ゼロから)
     * @param {number=} a.reservations      拘束になった予約の数 (isFixed)
     * @param {number=} a.excluded          運営が除外した模擬の数
     * @param {number=} a.unavailable       「今回は難しい」の人数
     * @param {string|null=} a.publishedBy  尊重した配信を出した人
     * @param {string|null=} a.publishedAt  その配信の時刻 (ISO)
     * @param {string|null=} a.computedBy   算出した人
     * @param {string|null=} a.computedAt   算出した時刻 (ISO)
     */
    function conditionsOf(a = {}) {
        return {
            who: a.who === 'now' ? 'now' : 'all',
            from: a.from === 'day' ? 'day' : 'now',
            prev: a.prev === 'fresh' ? 'fresh' : 'keep',
            reservations: n0(a.reservations),
            excluded: n0(a.excluded),
            unavailable: n0(a.unavailable),
            publishedBy: str(a.publishedBy),
            publishedAt: str(a.publishedAt),
            computedBy: str(a.computedBy),
            computedAt: str(a.computedAt),
        };
    }

    /** 「全員 · 今から · 前回を尊重 · 🔒予約 3 · 🚫除外 1 · ✋難しい 2」。数が 0 のものは省く (予約だけは常に出す) */
    function conditionSummary(c) {
        const x = conditionsOf(c || {});
        const parts = [WHO[x.who], FROM[x.from], PREV[x.prev], `🔒予約 ${x.reservations}`];
        if (x.excluded > 0) parts.push(`🚫除外 ${x.excluded}`);
        if (x.unavailable > 0) parts.push(`✋難しい ${x.unavailable}`);
        return parts.join(' · ');
    }

    /**
     * 戦闘可能時間 ('hXX' の配列) → 時間割の行番号 (hourOrder の添字) の Set。
     * ⏳隙間型は「いつでも」= 全部。読めない値は捨てる
     */
    function windowOf(player, hourOrder) {
        const order = Array.isArray(hourOrder) ? hourOrder : [];
        const out = new Set();
        if (!player) return out;
        if (player.flexTime) { order.forEach((_, i) => out.add(i)); return out; }
        for (const s of Array.isArray(player.availableSlots) ? player.availableSlots : []) {
            const m = /^h(\d{1,2})$/.exec(String(s));
            if (!m) continue;
            const i = order.indexOf(Number(m[1]));
            if (i >= 0) out.add(i);
        }
        return out;
    }

    /**
     * 動かせる幅。fromIdx 以降に出られる時間が何コマあるか。
     *   0 = 出られない / 1 = 硬い (その時刻しか無い) / 2〜3 = 狭い / 4〜 = 柔らかい
     * パズルで「先に置くべき駒」(硬い) が分かるようにする
     */
    function stiffness(windowSet, fromIdx) {
        const from = Number.isInteger(fromIdx) ? fromIdx : 0;
        let count = 0;
        for (const i of (windowSet instanceof Set ? windowSet : new Set())) if (i >= from) count += 1;
        const label = count === 0 ? '出られない' : count === 1 ? '硬い' : count <= 3 ? '狭い' : '柔らかい';
        return { count, label, rigid: count <= 1 };
    }

    /** 前回の算出 (since) のあとに更新された模擬の数。since が読めなければ null (きっかけを出さない) */
    function mockUpdatesSince(rows, since) {
        const t = Date.parse(typeof since === 'string' ? since : '');
        if (!Number.isFinite(t)) return null;
        let n = 0;
        for (const r of Array.isArray(rows) ? rows : []) {
            const u = Date.parse(r && typeof r.updated_at === 'string' ? r.updated_at : '');
            if (Number.isFinite(u) && u > t) n += 1;
        }
        return n;
    }

    root.planBoardDomain = { conditionsOf, conditionSummary, windowOf, stiffness, mockUpdatesSince, WHO, FROM, PREV };
})(typeof window !== 'undefined' ? window : globalThis);
