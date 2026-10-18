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
                        dmgB: Number(a.dmgB) || 0, level: lv.level == null ? null : Number(lv.level), flex: !!a.flex });
                }
            }
        }
        return out;
    }
    /**
     * @param {{ attacks: Array<Object>, plan: Object|null, nowMs: number, lowRatio?: number, timeGapH?: number }} a
     *   attacks = 盤面の凸 (id / player_id / name / boss_number / boss_code / damage_raw / reported_at / level / attack_number / confirmed_at / confirmed_by)
     *   plan = 配信プラン (computeOptimalPlanCore の出力)。無ければ印は付けない (hasPlan=false)
     * @returns {{ rows: Array<Object>, missing: Array<Object>, hasPlan: boolean, counts: { total, confirmed, flagged, missing } }}
     */
    function buildRows({ attacks, plan, nowMs, lowRatio = 0.7, timeGapH = 3 } = {}) {
        const list = (Array.isArray(attacks) ? attacks : []).filter(a => a && a.id != null);
        const planned = plannedOf(plan).map(p => ({ ...p, used: false }));
        const hasPlan = planned.length > 0;
        const nowIdx = hourIdxOfMs(nowMs);
        // 報告は古い順に見て、同じ人・同じボスの割当のうち時刻の近いものへ当てる (1 つの割当に 1 つの報告)
        const sorted = list.slice().sort((a, b) => ((ms(a.reported_at) ?? 0) - (ms(b.reported_at) ?? 0)) || (Number(a.id) - Number(b.id)));
        const rows = sorted.map(a => {
            const atMs = ms(a.reported_at), hourIdx = hourIdxOfMs(atMs);
            const damageB = (Number(a.damage_raw) || 0) / 1e9;
            const mine = planned.filter(p => String(p.memberId) === String(a.player_id));
            const cands = mine.filter(p => !p.used && p.bossNumber === Number(a.boss_number));
            let matched = null;
            if (cands.length) {
                const dist = (p) => (p.hourIdx == null || hourIdx == null) ? 0 : Math.abs(p.hourIdx - hourIdx);
                cands.sort((x, y) => dist(x) - dist(y));
                matched = cands[0]; matched.used = true;
            }
            const flags = [];
            if (hasPlan) {
                if (!matched) {
                    const rest = [...new Set(mine.filter(p => !p.used).map(p => `B${p.bossNumber}`))];
                    flags.push({ key: 'unplanned', text: mine.length === 0 ? '配信に割当なし' : (rest.length ? `計画は ${rest.join('・')}` : '計画より多い') });
                } else {
                    if (matched.dmgB > 0 && damageB < matched.dmgB * lowRatio) flags.push({ key: 'low', text: `予定 ${matched.dmgB.toFixed(1)}B → ${damageB.toFixed(1)}B` });
                    if (!matched.flex && matched.hourIdx != null && hourIdx != null && Math.abs(matched.hourIdx - hourIdx) >= timeGapH) {
                        flags.push({ key: 'time', text: `予定 ${hourLabelOfIdx(matched.hourIdx)} → 報告 ${hourLabelOfIdx(hourIdx)}` });
                    }
                }
            }
            return {
                id: a.id, playerId: a.player_id, name: a.name || String(a.player_id),
                bossNumber: Number(a.boss_number), bossCode: a.boss_code || null, damageB, atMs, hourIdx,
                level: a.level == null ? null : Number(a.level), attackNumber: a.attack_number == null ? null : Number(a.attack_number),
                confirmedAt: ms(a.confirmed_at), confirmedBy: a.confirmed_by || null, flags,
                planned: matched ? { bossNumber: matched.bossNumber, hourIdx: matched.hourIdx, dmgB: matched.dmgB } : null,
            };
        });
        rows.sort((a, b) => ((b.atMs ?? 0) - (a.atMs ?? 0)) || (Number(b.id) - Number(a.id)));   // 新しい順
        // 報告漏れの候補: 予定の時刻を過ぎたのに報告が無い割当 (⏳隙間・時刻なし・いまが読めないときは数えない)
        const missing = planned.filter(p => !p.used && !p.flex && p.hourIdx != null && nowIdx != null && p.hourIdx < nowIdx)
            .map(p => ({ memberId: p.memberId, bossNumber: p.bossNumber, hourIdx: p.hourIdx, hourLabel: hourLabelOfIdx(p.hourIdx), dmgB: p.dmgB, level: p.level }))
            .sort((a, b) => (a.hourIdx - b.hourIdx) || (a.bossNumber - b.bossNumber));
        return {
            rows, missing, hasPlan,
            counts: { total: rows.length, confirmed: rows.filter(r => r.confirmedAt != null).length, flagged: rows.filter(r => r.flags.length > 0).length, missing: missing.length },
        };
    }
    /** 見出しの一言: 「確認 3 / 12 · 要確認 2 · 未報告 1」。報告も未報告も無ければ「まだ報告はありません」 */
    function summary(res) {
        const c = res && res.counts;
        if (!c) return '';
        if (!c.total && !c.missing) return 'まだ報告はありません';
        return [`確認 ${c.confirmed} / ${c.total}`, c.flagged ? `要確認 ${c.flagged}` : '', c.missing ? `未報告 ${c.missing}` : ''].filter(Boolean).join(' · ');
    }
    root.attackCheckDomain = { HOUR_BASE, FLAG_JP, hourIdxOfMs, hourLabelOfIdx, plannedOf, buildRows, summary };
})(typeof window !== 'undefined' ? window : globalThis);
