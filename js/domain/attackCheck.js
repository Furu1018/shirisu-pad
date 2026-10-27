// ============================================================================
// ✅ 凸報告の確認 — 純ロジック (🧱 ブロック制 ③-f・2026-10-18)
// ----------------------------------------------------------------------------
// 凸報告は本人がする → 運営がチェック (ふるりの判断 2026-10-17 ④)。第45回は報告漏れ 5 凸・申告ミス 1 件があった。
// ここは「きょうの凸報告」を配信プランと突き合わせて印を付け (計画にない / 予定よりかなり低い / 予定の時刻とずれ)、
// 予定の時刻を過ぎたのに報告が無い割当 (報告漏れの候補) を並べるだけ。✓ 確認の保存は index.html (supabaseSetAttackConfirmed)。
// 時刻は JST の 1 時間刻み hourIdx (5 時 = 0 … 翌 4 時 = 23・ソルバーと同じ)。DOM 非依存。node tests/run-tests.mjs で検証
// ============================================================================
(function (root) {
    'use strict';
    const HOUR_BASE = 5, JST_OFFSET_H = 9;
    const FLAG_JP = { unplanned: '計画にない', low: '予定よりかなり低い', time: '予定の時刻とずれ' };
    const ms = (v) => { if (v == null) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
    /** エポック ms → JST の時間帯 (5 時 = 0 … 翌 4 時 = 23)。JST は夏時間が無いので足し算でよい */
    function hourIdxOfMs(v) {
        const t = ms(v);
        if (t == null) return null;
        const h = Math.floor((t + JST_OFFSET_H * 3600000) / 3600000) % 24;
        return (h - HOUR_BASE + 24) % 24;
    }
    function hourLabelOfIdx(idx) {
        if (!Number.isInteger(idx) || idx < 0 || idx > 23) return '';
        const h = idx + HOUR_BASE;
        return h >= 24 ? `翌${h - 24}時` : `${h}時`;
    }
    /** 配信プランの割当を平らに: { memberId, bossNumber, hourIdx, dmgB, level, flex } */
    function plannedOf(plan) {
        const out = [];
        for (const lv of (plan && Array.isArray(plan.levels) ? plan.levels : [])) {
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                for (const a of (Array.isArray(b.attacks) ? b.attacks : [])) {
                    if (!a || a.memberId == null) continue;
                    out.push({ memberId: a.memberId, bossNumber: Number(b.bossNumber), hourIdx: Number.isInteger(a.hourIdx) ? a.hourIdx : null,
                        dmgB: Number(a.dmgB) || 0, level: lv.level == null ? null : Number(lv.level), flex: !!a.flex, loadoutSlot: Number(a.loadoutSlot) || 1,
                        blockEnd: !!a.blockEnd });   // ✅ 決定の割当 (S4): 時刻はブロックの終わりに寄せてある (約束はブロックだけ) → 時刻のずれの印は出さない
                }
            }
        }
        return out;
    }
    /** 報告の無い凸 (割当) の鍵: 配信の id + 人 + レベル + ボス + 時刻 + 編成枠。「凸していない」の印 (段階 4) に使う (編成枠が無いと同じ時刻の編成①②を区別できない: Codex指摘) */
    function missingKey(planId, m) {
        if (planId == null || !m) return null;
        return [planId, m.memberId, m.level == null ? '' : m.level, m.bossNumber, m.hourIdx == null ? '' : m.hourIdx, Number(m.loadoutSlot) || 1].join('|');
    }
    /**
     * @param {{ attacks: Array<Object>, plan: Object|null, nowMs: number, lowRatio?: number, timeGapH?: number, sinceMs?: number|null, planId?: *, skips?: Set<string>|null }} a
     *   attacks = 盤面の凸 (id / player_id / name / boss_number / boss_code / damage_raw / reported_at / level / attack_number / confirmed_at / confirmed_by)
     *   plan = 配信プラン (computeOptimalPlanCore の出力)。無ければ印は付けない (hasPlan=false)
     *   照合は 同じ人・同じボス・同じレベル。ボス未指定 (代理凸) と 配信に無いレベルの凸は unchecked (理由の文) で印を付けず、割当も食わない
     *   sinceMs (段階 4) = 配信を算出した時刻。それより前に入っていた凸は、その凸を前提に組んだプランなので照合しない (unchecked)。
     *     ★ 時刻でブロックを決めない — 運営があとから取り込む凸の reported_at は登録した時刻 (凸した時刻ではない)
     *   planId + skips (段階 4) = 「凸していない」の印 (missingKey の集合)。当たる割当は missing から skipped へ
     * @returns {{ rows: Array<Object>, missing: Array<Object>, skipped: Array<Object>, hasPlan: boolean, counts: { total, confirmed, flagged, unchecked, missing, skipped } }}
     */
    function buildRows({ attacks, plan, nowMs, lowRatio = 0.7, timeGapH = 3, sinceMs = null, planId = null, skips = null } = {}) {
        const list = (Array.isArray(attacks) ? attacks : []).filter(a => a && a.id != null);
        const planned = plannedOf(plan).map(p => ({ ...p, used: false }));
        const hasPlan = planned.length > 0;
        // 配信が持つレベル。別のレベルの凸 (レベルが進む前の古い凸) は、いまの配信では照合できない (Codex指摘 ccfff3e:
        //   最新の配信だけで全報告を見ると、古い凸が新しいレベルの割当を食って 未報告 / 食い違い を誤表示する)
        const planLevels = new Set(planned.map(p => p.level).filter(l => l != null));
        const nowIdx = hourIdxOfMs(nowMs);
        const since = ms(sinceMs);   // 配信を算出した時刻 (段階 4)
        // 報告は古い順に見て、同じ人・同じボス・同じレベルの割当のうち時刻の近いものへ当てる (1 つの割当に 1 つの報告)
        const sorted = list.slice().sort((a, b) => ((ms(a.reported_at) ?? 0) - (ms(b.reported_at) ?? 0)) || (Number(a.id) - Number(b.id)));
        const rows = sorted.map(a => {
            const atMs = ms(a.reported_at), hourIdx = hourIdxOfMs(atMs);
            const damageB = (Number(a.damage_raw) || 0) / 1e9;
            const level = a.level == null ? null : Number(a.level);
            const bossNumber = a.boss_number == null ? null : Number(a.boss_number);
            // 照合できない凸: ボス未指定 (代理凸) / 配信に無いレベルの凸 (レベルが進む前のぶん) / 配信の算出より前の凸。印は付けず、割当も食わない
            const unchecked = bossNumber == null ? 'ボス未指定 (照合できません)'
                : (hasPlan && since != null && atMs != null && atMs < since) ? 'いまの配信より前の凸'
                : (hasPlan && level != null && planLevels.size && !planLevels.has(level)) ? `Lv${level} の凸 (いまの配信は Lv${[...planLevels].sort((x, y) => x - y).join('・')})` : null;
            const mine = unchecked ? [] : planned.filter(p => String(p.memberId) === String(a.player_id) && (level == null || p.level == null || p.level === level));
            const cands = mine.filter(p => !p.used && p.bossNumber === bossNumber);
            let matched = null;
            if (cands.length) {
                const dist = (p) => (p.hourIdx == null || hourIdx == null) ? 0 : Math.abs(p.hourIdx - hourIdx);
                cands.sort((x, y) => dist(x) - dist(y));
                matched = cands[0]; matched.used = true;
            }
            const flags = [];
            if (hasPlan && !unchecked) {
                if (!matched) {
                    const rest = [...new Set(mine.filter(p => !p.used).map(p => `B${p.bossNumber}`))];
                    flags.push({ key: 'unplanned', text: mine.length === 0 ? '配信に割当なし' : (rest.length ? `計画は ${rest.join('・')}` : '計画より多い') });
                } else {
                    // ✓ 凸しました (56・数字の無い行) はダメージを持たないので「予定より低い」にしない
                    const tapOnly = !!a.source && !(Number(a.damage_raw) > 0);
                    if (!tapOnly && matched.dmgB > 0 && damageB < matched.dmgB * lowRatio) flags.push({ key: 'low', text: `予定 ${matched.dmgB.toFixed(1)}B → ${damageB.toFixed(1)}B` });
                    // ✓ 凸しました の行 (押した時刻) と 決定の割当 (ブロックだけを約束) には「予定の時刻とずれ」を付けない (S4 レビュー [19][21])
                    if (!tapOnly && !matched.blockEnd && !matched.flex && matched.hourIdx != null && hourIdx != null && Math.abs(matched.hourIdx - hourIdx) >= timeGapH) {
                        flags.push({ key: 'time', text: `予定 ${hourLabelOfIdx(matched.hourIdx)} → 報告 ${hourLabelOfIdx(hourIdx)}` });
                    }
                }
            }
            return {
                id: a.id, playerId: a.player_id, name: a.name || String(a.player_id),
                bossNumber, bossCode: a.boss_code || null, damageB, atMs, hourIdx,
                level, attackNumber: a.attack_number == null ? null : Number(a.attack_number),
                // S5: 運営が ✓ 凸の記録で付けた ✓ (source 'ops_tap') は運営が見て付けたもの = 確認済み (⚔️ 戦況の数を ✓ のたびに増やさない)
                confirmedAt: ms(a.confirmed_at) ?? (a.source === 'ops_tap' ? (ms(a.reported_at) ?? 0) : null), confirmedBy: a.confirmed_by || (a.source === 'ops_tap' ? '✓ 凸の記録' : null), flags, unchecked,
                planned: matched ? { bossNumber: matched.bossNumber, hourIdx: matched.hourIdx, dmgB: matched.dmgB, level: matched.level } : null,
            };
        });
        rows.sort((a, b) => ((b.atMs ?? 0) - (a.atMs ?? 0)) || (Number(b.id) - Number(a.id)));   // 新しい順
        // 報告漏れの候補: 予定の時刻を過ぎたのに報告が無い割当 (⏳隙間・時刻なし・いまが読めないときは数えない)
        const late = planned.filter(p => !p.used && !p.flex && p.hourIdx != null && nowIdx != null && p.hourIdx < nowIdx)
            .map(p => ({ memberId: p.memberId, bossNumber: p.bossNumber, hourIdx: p.hourIdx, hourLabel: hourLabelOfIdx(p.hourIdx), dmgB: p.dmgB, level: p.level,
                loadoutSlot: p.loadoutSlot, key: missingKey(planId, p) }))
            .sort((a, b) => (a.hourIdx - b.hourIdx) || (a.bossNumber - b.bossNumber));
        // 「凸していない」と運営が決めた割当は数えない (次のブロックの残り凸に戻る = 何も登録しない、を明示しただけ)
        const isSkipped = (m) => !!(m.key && skips && typeof skips.has === 'function' && skips.has(m.key));
        const missing = late.filter(m => !isSkipped(m)), skipped = late.filter(isSkipped);
        return {
            rows, missing, skipped, hasPlan,
            counts: { total: rows.length, confirmed: rows.filter(r => r.confirmedAt != null).length, flagged: rows.filter(r => r.flags.length > 0).length,
                unchecked: rows.filter(r => !!r.unchecked).length, missing: missing.length, skipped: skipped.length },
        };
    }
    /** 見出しの一言: 「確認 3 / 12 · 要確認 2 · 未報告 1」。報告も未報告も無ければ「まだ報告はありません」 */
    function summary(res) {
        const c = res && res.counts;
        if (!c) return '';
        if (!c.total && !c.missing) return 'まだ報告はありません';
        return [`確認 ${c.confirmed} / ${c.total}`, c.flagged ? `要確認 ${c.flagged}` : '', c.unchecked ? `照合できない ${c.unchecked}` : '', c.missing ? `結果がまだ ${c.missing}` : '', c.skipped ? `凸していない ${c.skipped}` : ''].filter(Boolean).join(' · ');
    }
    root.attackCheckDomain = { HOUR_BASE, FLAG_JP, hourIdxOfMs, hourLabelOfIdx, plannedOf, buildRows, summary, missingKey };
})(typeof window !== 'undefined' ? window : globalThis);
