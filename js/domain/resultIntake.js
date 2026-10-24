// ============================================================================
// 📥 結果の取り込み — 純ロジック (🧱 ブロック制 段階 4・2026-10-23)
// ----------------------------------------------------------------------------
// メンバーは凸したら結果の画面のスクショを Discord に貼るだけ。運営がそれを PAD に取り込んで凸を登録する
// (ユーザー決定 2026-10-22: 凸の「済」は運営の登録で確定する・使った PT はリザルトに写らないので模擬から決める)。
// 読み取りは本人の凸報告と同じ OCR (index.html の _ocrAttackMultiAndMerge)。ここで決めるのは:
//   matchBoss       読み取ったボス名 → シーズンのボス (名前で 1 つに決まらなければ、ボスコードの推定に任せる)
//   plannedSlotFor  配信のその人・そのボスの割当のうち、まだ凸の入っていないものの編成枠
//   pickLoadout     使った編成 = その人の模擬のうち、そのボスの弱点属性 (読み取ったキャラ → 配信の割当 → きょう使っていない最初の編成)
//   check           登録の前の注意 (止めるもの: 誰か・3 凸済み・ボス・ダメージ / 知らせるだけ: 同じボスに登録済み・キャラ使用済み・模擬なし)
//   askText         報告の無い凸を Discord で聞く文
//   publishNotices  🧱 ブロックの配信の通知 (割当のある人ごとに、自分の凸を 1 通に)
// DOM 非依存。node tests/run-tests.mjs で検証
// ============================================================================
(function (root) {
    'use strict';
    const MAX_ATTACKS = 3;
    const SLOT_JP = { 1: '①', 2: '②' };
    const HOUR_BASE = 5;
    const norm = (s) => String(s == null ? '' : s).replace(/[\s　]/g, '');
    const hourLabelOfIdx = (idx) => {
        if (!Number.isInteger(idx) || idx < 0 || idx > 23) return '';
        const h = idx + HOUR_BASE;
        return h >= 24 ? `翌${h - 24}時` : `${h}時`;
    };

    /**
     * 読み取ったボス名 → シーズンのボス。名前の部分一致で 1 つに決まればそれ (2 つ以上なら完全一致だけ)。
     * 決まらなければ opts.detectCode (ボス名 → ボスコード。index.html が ocrDomain.detectBossCode を渡す) に任せる
     * @returns {Object|null} bosses の要素
     */
    function matchBoss(bossName, bosses, { detectCode } = {}) {
        const list = Array.isArray(bosses) ? bosses.filter(Boolean) : [];
        const t = norm(bossName);
        if (t.length >= 2) {
            const hit = list.filter(b => { const bn = norm(b.name); return bn.length >= 2 && (bn.includes(t) || t.includes(bn)); });
            if (hit.length === 1) return hit[0];
            const exact = hit.filter(b => norm(b.name) === t);
            if (exact.length === 1) return exact[0];
        }
        if (typeof detectCode === 'function' && t) {
            let code = null;
            try { code = detectCode(String(bossName)); } catch { code = null; }
            if (code) {
                const byCode = list.filter(b => b.boss_code === code);
                if (byCode.length === 1) return byCode[0];
            }
        }
        return null;
    }

    /**
     * 配信のその人・そのボスの割当のうち、まだ凸の入っていないものの編成枠 (時刻の早い順に、登録済みの凸の数だけ飛ばす)。
     * @param {Object|null} plan  配信プラン (blockScope で絞ったもの)
     * @param {*} memberId
     * @param {number} bossNumber
     * @param {number} doneOnBoss その人がそのボスにもう入れた凸の数 (この配信の算出のあと・同じレベル)
     * @param {number|null} level  そのレベルの割当だけを見る (省略 = すべて)。同じボスの別レベルを混ぜない (Codex指摘)
     * @returns {number|null}
     */
    function plannedSlotFor(plan, memberId, bossNumber, doneOnBoss = 0, level = null) {
        const mine = [];
        for (const lv of (plan && Array.isArray(plan.levels) ? plan.levels : [])) {
            if (level != null && lv.level != null && Number(lv.level) !== Number(level)) continue;
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                if (Number(b.bossNumber) !== Number(bossNumber)) continue;
                for (const a of (Array.isArray(b.attacks) ? b.attacks : [])) {
                    if (a && String(a.memberId) === String(memberId)) mine.push(a);
                }
            }
        }
        mine.sort((x, y) => (Number.isInteger(x.hourIdx) ? x.hourIdx : 99) - (Number.isInteger(y.hourIdx) ? y.hourIdx : 99));
        const a = mine[Math.max(0, Number(doneOnBoss) || 0)];
        return a ? (Number(a.loadoutSlot) || 1) : null;
    }

    /**
     * 使った編成を選ぶ。候補はその人の模擬のうちボスの弱点属性 (1〜2 編成)。
     *   ① 読み取ったキャラが 2 人以上入っていて、ほかの編成より多く当たる編成 (why 'ocr')
     *   ② 配信の割当の編成枠 (why 'plan')
     *   ③ きょう使ったキャラが入っていない最初の編成 (why 'unused') / どれも使っていれば 1 つ目 (why 'first')
     * @param {{ player: {loadoutsByAttr?: Object, attacks?: Array}, weakness: string, ocrCharacters?: string[], plannedSlot?: number|null }} a
     * @returns {{ options: Array<{slot:number, team:string[], dmgB:number, usedChars:string[]}>, slot: number|null, why: string|null }}
     */
    function pickLoadout({ player, weakness, ocrCharacters, plannedSlot } = {}) {
        const los = (player && player.loadoutsByAttr && Array.isArray(player.loadoutsByAttr[weakness])) ? player.loadoutsByAttr[weakness] : [];
        const used = new Set();
        (player && Array.isArray(player.attacks) ? player.attacks : []).forEach(a => (Array.isArray(a.characters) ? a.characters : []).forEach(c => { if (c) used.add(String(c)); }));
        const options = los.filter(Boolean)
            .map(lo => ({ slot: Number(lo.slot) || 1, team: (Array.isArray(lo.team) ? lo.team : []).filter(Boolean).map(String), dmgB: Number(lo.dmgB) || 0 }))
            .sort((x, y) => x.slot - y.slot)
            .map(o => ({ ...o, usedChars: o.team.filter(c => used.has(c)) }));
        if (!options.length) return { options, slot: null, why: null };
        const ocr = [...new Set((Array.isArray(ocrCharacters) ? ocrCharacters : []).filter(Boolean).map(String))];
        if (ocr.length) {
            const scored = options.map(o => ({ o, s: ocr.filter(c => o.team.includes(c)).length })).sort((x, y) => y.s - x.s);
            if (scored[0].s >= 2 && (scored.length < 2 || scored[0].s > scored[1].s)) return { options, slot: scored[0].o.slot, why: 'ocr' };
        }
        if (plannedSlot != null && options.some(o => o.slot === Number(plannedSlot))) return { options, slot: Number(plannedSlot), why: 'plan' };
        const free = options.find(o => o.usedChars.length === 0);
        if (free) return { options, slot: free.slot, why: free === options[0] ? 'first' : 'unused' };
        return { options, slot: options[0].slot, why: 'first' };
    }

    /**
     * 登録の前の注意。blocking = 押せない理由 / それ以外は知らせるだけ。
     * @param {{ player: Object|null, boss: Object|null, damageB: number|null, level?: number, loadout: Object|null, hasMock: boolean, ptName?: string }} a
     *   player は盤面の形 (attacks / attackCount)。loadout は pickLoadout の options の 1 つ (無ければ null)
     * @returns {Array<{key:string, text:string, blocking:boolean}>}
     */
    function check({ player, boss, damageB, level, loadout, hasMock, ptName } = {}) {
        const out = [];
        const atks = player && Array.isArray(player.attacks) ? player.attacks : [];
        if (!player) out.push({ key: 'player', text: '誰の凸かを選んでください', blocking: true });
        else if (atks.length >= MAX_ATTACKS) out.push({ key: 'spent', text: `${player.name || 'この人'} さんはもう ${MAX_ATTACKS} 凸登録されています`, blocking: true });
        if (!boss) out.push({ key: 'boss', text: 'ボスを選んでください (スクショから読み取れませんでした)', blocking: true });
        if (damageB == null || !Number.isFinite(Number(damageB)) || Number(damageB) < 0) out.push({ key: 'damage', text: 'ダメージを入れてください (B 単位)', blocking: true });
        if (boss && Number(level) >= 4 && Number(boss.boss_number) !== 5) out.push({ key: 'lv4', text: 'Lv4 で凸できるのはボス 5 だけです (Lv を確かめてください)', blocking: true });
        if (player && boss) {
            const same = atks.filter(a => Number(a.boss_number) === Number(boss.boss_number)).length;
            if (same > 0) out.push({ key: 'dup', text: `B${boss.boss_number} への凸がもう ${same} 件登録されています (二重に登録していないか確かめてください)`, blocking: false });
            if (!hasMock) out.push({ key: 'noMock', text: `${ptName ? ptName + 'PT の' : 'この属性の'}模擬が登録されていません (編成なしで登録します)`, blocking: false });
        }
        if (loadout && Array.isArray(loadout.usedChars) && loadout.usedChars.length) {
            out.push({ key: 'chars', text: `編成${SLOT_JP[loadout.slot] || loadout.slot}の ${loadout.usedChars.join('・')} はきょうの凸で使用済みです (編成が違うかもしれません)`, blocking: false });
        }
        return out;
    }

    /** 報告の無い凸を Discord で聞く文 */
    function askText({ name, hourLabel, bossNumber, ptName, channel = '#凸報告' } = {}) {
        const who = name ? `${name} さん` : 'お疲れさまです';
        const what = `${hourLabel ? hourLabel + 'の ' : ''}B${bossNumber}${ptName ? ` (${ptName}PT)` : ''}`;
        return `${who}、${what} の凸の結果のスクショを ${channel} に貼ってください 🙏 まだ凸していなければ、このあと出られるかだけ教えてください`;
    }

    /**
     * 🧱 ブロックの配信の通知 (ユーザー決定 h「次のブロックの配信は通知する」)。割当のある人ごとに、自分の凸を 1 通にまとめる。
     * @param {Object} scoped   配信プランを blockScope で絞ったもの (raidBlocksDomain.scopePlan)
     * @param {{ label: string, ptName?: (weakness:string)=>string, bosses?: Array, changedIds?: Set }} o
     *   changedIds = 前の配信を確認していて、割当が変わった人 (L4)。その人は「変わりました」と言う
     * @returns {Array<{ memberId:*, title:string, body:string, lines:string[] }>}  memberId の順 (決定的)
     */
    // 🗣 9h (2026-10-24 Q2): 変わった人 (changedIds) には ✅ 確認の有無 (ackedIds = 前の配信を確認していた人) で文を分ける。
    //   割当が消えた人 (goneIds・新しいプランに居ない) にも「外れました」を送る (lines は '割当なし' = 二重送信よけの ref に使う)。
    //   ackedIds が Set でない = 確認の情報が無い (取れなかった・一気に組む) → 確認の有無を断定しない文 (「まだ確認していません」と言い切らない)
    function publishNotices(scoped, { label, ptName, bosses, changedIds, ackedIds, goneIds } = {}) {
        const weakOf = new Map((Array.isArray(bosses) ? bosses : []).map(b => [Number(b.boss_number), b.weakness]));
        const byMember = new Map();
        for (const lv of (scoped && Array.isArray(scoped.levels) ? scoped.levels : [])) {
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                for (const a of (Array.isArray(b.attacks) ? b.attacks : [])) {
                    if (!a || a.memberId == null) continue;
                    const k = String(a.memberId);
                    if (!byMember.has(k)) byMember.set(k, { memberId: a.memberId, rows: [] });
                    byMember.get(k).rows.push({ hourIdx: Number.isInteger(a.hourIdx) ? a.hourIdx : null, flex: !!a.flex, bossNumber: Number(b.bossNumber),
                        weakness: b.weakness || weakOf.get(Number(b.bossNumber)) || null, slot: Number(a.loadoutSlot) || 1 });
                }
            }
        }
        const pt = (w) => (typeof ptName === 'function' && w) ? (ptName(w) || '') : '';
        const changed = changedIds instanceof Set ? changedIds : new Set();
        const acked = ackedIds instanceof Set ? ackedIds : null;
        const gone = goneIds instanceof Set ? goneIds : new Set();
        const has = (set, id) => set.has(Number(id)) || set.has(String(id));
        const lbl = label || 'このブロック';
        const notices = [...byMember.values()]
            .sort((x, y) => String(x.memberId).localeCompare(String(y.memberId), 'en', { numeric: true }))
            .map(m => {
                const lines = m.rows.slice()
                    .sort((x, y) => ((x.hourIdx ?? 99) - (y.hourIdx ?? 99)) || (x.bossNumber - y.bossNumber))
                    .map(r => `${r.flex || r.hourIdx == null ? 'ブロックのどこか' : hourLabelOfIdx(r.hourIdx)} B${r.bossNumber}${pt(r.weakness) ? ` ${pt(r.weakness)}PT` : ''} 編成${SLOT_JP[r.slot] || r.slot}`);
                const isChanged = has(changed, m.memberId);
                const tail = !isChanged || !acked ? 'ホームで確認してください'
                    : has(acked, m.memberId) ? '✅ 確認したあとにプランが変わりました。ホームで新しい凸を確認してください'
                    : 'まだ確認していませんが、プランが変わりました。ホームで新しい凸を確認してください';
                return {
                    memberId: m.memberId, lines, changed: isChanged,
                    title: isChanged ? `🔄 ${lbl} のあなたの凸が変わりました` : `🧱 ${lbl} のあなたの凸が決まりました`,
                    body: `${lines.join(' / ')} — ${tail}`,
                };
            });
        // 割当が消えた人 (新しいプランに居ない)。新しいプランに割当がある人は上で扱う (消えていない)
        for (const id of gone) {
            if (byMember.has(String(id))) continue;
            notices.push({
                memberId: id, lines: ['割当なし'], gone: true, changed: true,
                title: `🔄 ${lbl} のあなたの凸が外れました`,
                body: !acked ? '組み直しで、このブロックのあなたの割当は無くなりました。ホームで確認してください'
                    : has(acked, id) ? '✅ 確認したあとに組み直され、このブロックのあなたの割当は無くなりました。ホームで確認してください'
                    : 'まだ確認していませんが、組み直しでこのブロックのあなたの割当は無くなりました。ホームで確認してください',
            });
        }
        return notices.sort((x, y) => String(x.memberId).localeCompare(String(y.memberId), 'en', { numeric: true }));
    }

    root.resultIntakeDomain = { MAX_ATTACKS, matchBoss, plannedSlotFor, pickLoadout, check, askText, publishNotices, hourLabelOfIdx };
})(typeof window !== 'undefined' ? window : globalThis);
