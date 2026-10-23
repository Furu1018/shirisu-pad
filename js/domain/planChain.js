// ============================================================================
// ドメイン: 残りのブロックを一気に組む (🧱 段階 8・2026-10-23 ユーザー決定「早い段階で模擬が出そろったら一気に最後まで組める機能」)
// ----------------------------------------------------------------------------
// 「前のブロックは模擬のスコアどおり削れたと仮定する」(ユーザー決定) ので、ブロックごとに
//   ① そのブロックの人だけで組む → ② そのブロックの凸を**実行したことにして盤面を進める** (残 HP・レベル・済んだ凸・使ったキャラ) → ③ 次のブロックを組む
// を繰り返す。②がここ (projectBoard)。①はソルバー (画面側が computeOptimalPlan を呼ぶ)。
// ★ ずれたら運営がそのブロック (時間があれば) か次のブロックの頭で組み直す — だから予想は「仮」で、配信にはその印 (plan.chained) を付ける
// ★ 盤面の進め方は tests/bench-blockflow/base.mjs の execute と同じ: 有限のレベルは min(ダメージ, 残り) だけ削る・5 体倒れたら次のレベル (HP は表)・
//   Lv3 を踏破したら Lv4 = ボス 5 だけ・HP 無限 (ソルバーは season.current_level 4 で Lv4 だけを組む)
// 純関数・引数渡し。入力は変えない (写しを返す)
(function (root) {
    'use strict';
    const HOUR_BASE = 5;   // レイド日は 5 時始まり (HOUR_ORDER の 0 = 5 時)
    /** 行番号 (0 = 5時) → 時 (0-23) */
    const hourOfIdx = (idx) => ((Number(idx) || 0) + HOUR_BASE) % 24;
    /**
     * 予想の凸の「報告時刻」(ISO・JST)。凸数の上限 (capsOf) と結果の突き合わせがブロックを時刻で決めるので、その時刻に凸したことにする。
     * 翌 0〜4 時はレイド日の翌日
     */
    function isoAt(hardDate, hourIdx) {
        const d = String(hardDate || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
        const h = hourOfIdx(hourIdx);
        const base = new Date(`${d}T00:00:00+09:00`);
        if (Number.isNaN(base.getTime())) return null;
        const dayShift = (h < HOUR_BASE) ? 1 : 0;
        const t = new Date(base.getTime() + (dayShift * 24 + h) * 3600000);
        return t.toISOString();
    }
    /** プランの凸をブロックの範囲だけ時刻の順に (凸の無い行は飛ばす) */
    function attacksIn(plan, block) {
        const out = [];
        for (const lv of (plan && Array.isArray(plan.levels) ? plan.levels : [])) {
            if (lv.infinite) {
                for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) for (const a of (Array.isArray(b.attacks) ? b.attacks : [])) {
                    if (a && Number.isInteger(a.hourIdx) && a.hourIdx >= block.fromIdx && a.hourIdx <= block.toIdx) out.push({ ...a, level: 4, bossNumber: Number(b.bossNumber), infinite: true });
                }
                continue;
            }
            for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) for (const a of (Array.isArray(b.attacks) ? b.attacks : [])) {
                if (a && Number.isInteger(a.hourIdx) && a.hourIdx >= block.fromIdx && a.hourIdx <= block.toIdx) out.push({ ...a, level: Number(lv.level), bossNumber: Number(b.bossNumber) });
            }
        }
        return out.sort((x, y) => (x.hourIdx - y.hourIdx) || (x.level - y.level) || (x.bossNumber - y.bossNumber));
    }
    /**
     * そのブロックの凸を実行したことにして、盤面 (season / bosses / players) を進める。
     * @param {{ season:Object, bosses:Object[], players:Object[] }} board  ソルバーに渡す形の盤面 (opsStore の写しでよい)
     * @param {Object} plan  ソルバーの出力 (levels[].bosses[].attacks[])
     * @param {{ fromIdx:number, toIdx:number }} block
     * @param {{ hpOf: (level:number, tier:string) => number }} o  レベルの HP (B)。ソルバーの表を渡す
     * @returns {{ season, bosses, players, done: Object[], level: number, cleared: number[] }}  done = 実行したことにした凸 / cleared = このブロックで踏破したレベル
     */
    function projectBoard(board, plan, block, o = {}) {
        const hpOf = typeof o.hpOf === 'function' ? o.hpOf : () => 0;
        const season = { ...(board && board.season || {}) };
        let level = Number(season.current_level) || 1;
        const bosses = (board && Array.isArray(board.bosses) ? board.bosses : []).map(b => ({ ...b }));
        const players = (board && Array.isArray(board.players) ? board.players : []).map(p => ({ ...p, attacks: Array.isArray(p.attacks) ? p.attacks.slice() : [] }));
        const remB = (b) => (Number(b.remaining_hp_raw) || 0) / 1e9;
        const done = [], cleared = [];
        for (const a of attacksIn(plan, block)) {
            const p = players.find(x => String(x.id) === String(a.memberId));
            if (!p) continue;
            const count = Number(p.attackCount) || p.attacks.length;
            if (count >= 3) continue;
            const team = Array.isArray(a.team) ? a.team.filter(Boolean) : [];
            const used = new Set(p.attacks.flatMap(x => Array.isArray(x.characters) ? x.characters : []));
            if (team.some(c => used.has(c))) continue;   // 同じキャラは 1 日 1 回 (予想どおりに行かなかった凸は置かない)
            const dmgB = Number(a.dmgB) || 0;
            let dealtB = 0;
            if (level >= 4) {
                if (a.bossNumber !== 5) continue;   // Lv4 はボス 5 だけ
                dealtB = dmgB;
            } else {
                const b = bosses.find(x => Number(x.boss_number) === a.bossNumber);
                if (!b || remB(b) <= 1e-9) continue;   // もう倒れている (予想の時点より前に別の凸で倒れた)
                dealtB = Math.min(dmgB, remB(b));
                b.remaining_hp_raw = Math.max(0, (Number(b.remaining_hp_raw) || 0) - dealtB * 1e9);
                if (bosses.every(x => remB(x) <= 1e-9)) {
                    cleared.push(level);
                    level++;
                    if (level <= 3) bosses.forEach(x => { const hp = hpOf(level, x.tier); x.total_hp_raw = hp * 1e9; x.remaining_hp_raw = hp * 1e9; });
                    else bosses.forEach(x => { const inf = Number(x.boss_number) === 5; x.total_hp_raw = (inf ? 1e6 : 0) * 1e9; x.remaining_hp_raw = (inf ? 1e6 : 0) * 1e9; });
                }
            }
            const row = { boss_number: a.bossNumber, level: a.level, damage_raw: Math.round(dealtB * 1e9), characters: team, reported_at: isoAt(season.hard_date, a.hourIdx), predicted: true, loadout_slot: Number(a.loadoutSlot) || 1 };
            p.attacks.push(row);
            p.attackCount = count + 1;
            done.push({ memberId: a.memberId, memberName: a.memberName || null, bossNumber: a.bossNumber, level: a.level, hourIdx: a.hourIdx, dmgB, dealtB,
                reservationId: a.reservationId ?? null });   // 予約の凸を実行したことにしたら、次のブロックではその予約を拘束に渡さない (画面側)
        }
        season.current_level = level;
        return { season, bosses, players, done, level, cleared };
    }
    /** 1 ブロックぶんの要約 (確認ダイアログ用) */
    function summarize(plan, block, proj) {
        const n = attacksIn(plan, block).length;
        const unassigned = Array.isArray(plan && plan.unassigned) ? plan.unassigned.length : 0;
        return { attacks: n, executed: proj ? proj.done.length : n, levelAfter: proj ? proj.level : null, cleared: proj ? proj.cleared.slice() : [], unassigned };
    }
    /** 並びに依らない JSON (鍵は名前順・配列は中身の文字列順) — 盤面の印に使う */
    function stableJson(v) {
        if (Array.isArray(v)) return '[' + v.map(stableJson).sort().join(',') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
        return JSON.stringify(v === undefined ? null : v);
    }
    function hash32(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); }
    /**
     * 盤面の印。一気に組む の配信の直前に「組んだときと同じ盤面か」を見る (Codex 再監査 D2)。
     * ★ **ソルバーの入力になるものは全部**見る: シーズン (id・レベル) / ボス (番号・残 HP・総 HP) / 人ごとの 凸 (id・ボス・レベル・ダメージ・キャラ・時刻)・模擬 (damagesByAttr / loadoutsByAttr。運営除外の行 excludedByAttr は盤面に入らない表示用なので見ない — 除外のまま理由を直しただけで止めない)・
     *   参加可能時間 (availableSlots / unavailableThisSeason / flexTime / blockCounts)・SLv。以前は HP・レベル・凸の数だけで、確認ダイアログの間に参加可能時間や模擬が変わってもすり抜けた。
     * 名前・写真・通知の設定は見ない (変わっても配信は危なくない)。並び (人・時間・キャラ) には依らない
     */
    function boardSignature(board) {
        if (!board) return '';
        const season = board.season || {};
        const bosses = (Array.isArray(board.bosses) ? board.bosses : []).map(b => ({ n: b.boss_number ?? null, rem: Number(b.remaining_hp_raw) || 0, total: Number(b.total_hp_raw) || 0 }));
        const players = (Array.isArray(board.players) ? board.players : []).map(p => ({
            id: p.id ?? null, attackCount: Number(p.attackCount) || 0,
            attacks: (Array.isArray(p.attacks) ? p.attacks : []).map(a => ({ id: a.id ?? null, boss: a.boss_number ?? null, level: a.level ?? null, dmg: a.damage_raw ?? null, chars: Array.isArray(a.characters) ? a.characters : [], at: a.reported_at ?? null })),
            damagesByAttr: p.damagesByAttr ?? null, loadoutsByAttr: p.loadoutsByAttr ?? null,
            availableSlots: p.availableSlots ?? null, unavailableThisSeason: !!p.unavailableThisSeason, flexTime: !!p.flexTime, blockCounts: p.blockCounts ?? null, syncLevel: p.syncLevel ?? null,
        }));
        return 's' + (season.id ?? '') + '|lv' + (Number(season.current_level) || 0) + '|' + hash32(stableJson({ bosses, players }));
    }
    root.planChainDomain = { HOUR_BASE, hourOfIdx, isoAt, attacksIn, projectBoard, summarize, boardSignature };
})(typeof window !== 'undefined' ? window : globalThis);
