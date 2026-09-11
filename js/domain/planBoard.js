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

    /**
     * 🧩 模擬ピース = 提出された模擬カード (人 × 編成 × ダメージ) を、盤に置く駒として並べる (パズル盤 ③)。
     *   placed = いまのプラン (or 固定・約束) にその編成が入っている。人ごとの残凸 (3 - 実凸)。
     *   並びは 残凸が多い人 → その人の最大ダメージ (余っている強いピースが上)。
     * @param {Object} a
     * @param {Object[]} a.players   盤面の players ({id, name, attackCount, unavailableThisSeason, loadoutsByAttr:{attr:[{slot,dmgB,team}]}})
     * @param {Object|null=} a.plan  いまのプラン (levels[].bosses[].attacks[] に memberId / loadoutSlot、bosses[].weakness)
     * @param {Object[]=} a.reservations 予約 (固定・約束のカードは placed 扱い)
     * @param {(r:Object)=>boolean=} a.isFixed 予約が固定かの判定 (reservationsDomain.isFixed)
     */
    function piecesOf({ players, plan, reservations, isFixed } = {}) {
        const placedKey = new Set();   // `${memberId}:${weakness}:${slot}`
        const where = new Map();       // 同じ鍵 → { bossNumber, hourIdx, hourLabel, pinned, promise }
        (Array.isArray(plan && plan.levels) ? plan.levels : []).forEach(lv => (lv.bosses || []).forEach(b => (b.attacks || []).forEach(a => {
            const k = `${a.memberId}:${b.weakness}:${Number(a.loadoutSlot) || 1}`;
            placedKey.add(k);
            if (!where.has(k)) where.set(k, { bossNumber: Number(b.bossNumber), hourIdx: a.hourIdx ?? null, hourLabel: a.hourLabel || null, pinned: !!a.pinned, promise: !!a.fromReservation && !a.pinned });
        })));
        const fixedFn = typeof isFixed === 'function' ? isFixed : () => false;
        const bossWeak = new Map((Array.isArray(plan && plan.levels) && plan.levels[0] ? plan.levels[0].bosses : []).map(b => [Number(b.bossNumber), b.weakness]));
        (Array.isArray(reservations) ? reservations : []).forEach(r => {
            if (!fixedFn(r)) return;
            const w = bossWeak.get(Number(r.boss_number));
            if (!w) return;
            const k = `${r.player_id}:${w}:${Number(r.loadout_slot) || 1}`;
            placedKey.add(k);
            if (!where.has(k)) where.set(k, { bossNumber: Number(r.boss_number), hourIdx: null, hourLabel: r.time_slot ? `${Number(String(r.time_slot).slice(1))}時` : null, pinned: r.status === 'pinned', promise: r.status !== 'pinned' });
        });
        const out = [];
        for (const p of Array.isArray(players) ? players : []) {
            if (!p || p.unavailableThisSeason) continue;
            const remaining = Math.max(0, 3 - (Number(p.attackCount) || 0));
            const lo = p.loadoutsByAttr && typeof p.loadoutsByAttr === 'object' ? p.loadoutsByAttr : {};
            for (const attr of Object.keys(lo)) {
                for (const l of Array.isArray(lo[attr]) ? lo[attr] : []) {
                    if (!l || !(Number(l.dmgB) > 0)) continue;
                    const slot = Number(l.slot) || 1;
                    const k = `${p.id}:${attr}:${slot}`;
                    out.push({ memberId: p.id, name: p.name, attr, slot, dmgB: Number(l.dmgB), team: Array.isArray(l.team) ? l.team.filter(Boolean) : [],
                               remaining, placed: placedKey.has(k), where: where.get(k) || null });
                }
            }
        }
        const maxDmg = new Map();
        out.forEach(x => maxDmg.set(String(x.memberId), Math.max(maxDmg.get(String(x.memberId)) || 0, x.dmgB)));
        out.sort((a, b) => (b.remaining - a.remaining)
            || ((maxDmg.get(String(b.memberId)) || 0) - (maxDmg.get(String(a.memberId)) || 0))
            || (String(a.memberId) < String(b.memberId) ? -1 : String(a.memberId) > String(b.memberId) ? 1 : 0)
            || (b.dmgB - a.dmgB));
        return out;
    }

    /**
     * 盤の上の判定 (ユーザー指定 2026-09-11): ① 有利属性のボスだけ ② その人の戦闘可能時間だけ (⏳隙間型は例外)。
     * 残凸・キャラ被り・本人の申請は reservationsDomain.canPin が見る。レベルは見ない (算出が決める)
     */
    function canPlace({ player, attr, boss, hourIdx, hourOrder } = {}) {
        if (!player) return { ok: false, reason: 'no_player', label: 'メンバーが盤面にいません' };
        if (!boss) return { ok: false, reason: 'no_boss', label: 'ボスがありません' };
        if (!attr || boss.weakness !== attr) return { ok: false, reason: 'attr', label: `${boss.weakness ? (ATTR_JP[boss.weakness] || boss.weakness) + 'PT' : '別の属性'} のボスです` };
        if (!player.flexTime) {
            const win = windowOf(player, hourOrder);
            if (!Number.isInteger(hourIdx) || !win.has(hourIdx)) return { ok: false, reason: 'time', label: `${player.name || ''} の戦闘可能時間の外です` };
        }
        return { ok: true };
    }
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };

    root.planBoardDomain = { conditionsOf, conditionSummary, windowOf, stiffness, mockUpdatesSince, piecesOf, canPlace, WHO, FROM, PREV, ATTR_JP };
})(typeof window !== 'undefined' ? window : globalThis);
