// ============================================================================
// ドメイン: レイド日の「ブロック」(2026-10-17 第45期に向けた反省 → ブロック制)
// ----------------------------------------------------------------------------
// レイド日 (朝5時〜翌4時59分) をいくつかの時間帯のかたまりに分け、運営は**次のブロックだけ**を約束する。
// 後ろのブロックはまだ約束していないので、組み直しても誰の約束も壊れない (第44回の一番の反省
// 「当日のプラン組み直しでメンバーを振り回した」を、約束の範囲を狭めることで構造的に防ぐ)。
//
// ★ 区切りはそのときのユニオンメンバー次第 (ふるりの判断 2026-10-17) — 固定にしない。
//   シーズンごとに運営が決め、`seasons.metadata.blocks` に [{ name, from, to }] で持つ (無ければ既定の 7 つ)。
// ★ 内部の時間は今までどおり 1 時間刻み 'hXX' (HOUR_ORDER)。見せる・聞く・組む単位だけブロックにする。
//   だからソルバー・時間割・ベンチは区切りを変えても動く。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能: node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
    const norm24 = (h) => ((Number(h) % 24) + 24) % 24;
    const keyOf = (h) => `h${String(norm24(h)).padStart(2, '0')}`;
    // ★ null / '' / true を 0 や 1 と読まない (Number(null) は 0 = 深夜ブロックに化ける)。整数か数字だけの文字列だけ
    const idxOfHour = (h) => {
        const n = (typeof h === 'number') ? h : ((typeof h === 'string' && /^\s*\d{1,2}\s*$/.test(h)) ? Number(h) : NaN);
        return Number.isInteger(n) ? HOUR_ORDER.indexOf(norm24(n)) : -1;
    };
    const hourOfKey = (key) => { const m = /^h(\d\d)$/.exec(String(key || '')); return m ? Number(m[1]) : null; };

    /** 既定の 7 ブロック (ふるりの案)。from / to は「時」(含む)。深夜は 0〜4 */
    const DEFAULT_BLOCKS = [
        { name: '朝', from: 5, to: 8 }, { name: '午前', from: 9, to: 11 }, { name: '昼', from: 12, to: 14 },
        { name: '午後', from: 15, to: 17 }, { name: '夕方', from: 18, to: 20 }, { name: '夜', from: 21, to: 23 }, { name: '深夜', from: 0, to: 4 },
    ];
    const MIN_BLOCKS = 2, MAX_BLOCKS = 12, MAX_NAME = 6;

    const wrap = (h) => (h >= 0 && h <= 4) ? `翌${h}` : String(h);
    /** 「時」として読めるものだけ数にする: 整数 0〜23、または数字だけの文字列。それ以外は null */
    function toHour(v) {
        let n = null;
        if (typeof v === 'number' && Number.isInteger(v)) n = v;
        else if (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) n = Number(v.trim());
        return (n !== null && n >= 0 && n <= 23) ? n : null;
    }
    /** 「朝 5〜8時」「深夜 翌0〜翌4時」「13時」 */
    function labelOf(b) {
        if (!b) return '';
        const range = (b.from === b.to) ? `${wrap(b.from)}時` : `${wrap(b.from)}〜${wrap(b.to)}時`;
        return b.name ? `${b.name} ${range}` : range;
    }
    /** from..to を 5時始まりの並びで列挙。逆順 (to が from より前) は null */
    function hoursBetween(from, to) {
        const a = idxOfHour(from), b = idxOfHour(to);
        if (a < 0 || b < 0 || b < a) return null;
        return HOUR_ORDER.slice(a, b + 1);
    }

    /**
     * 設定 ([{ name, from, to }] / null) を検査して使える形にする。
     * 空・null は既定。壊れていれば error を返し blocks は null (呼び出し側は既定に落とす)。
     * 条件: 5時から翌4時まで隙間も重なりも無く順に並ぶ / 2〜12 個 / 名前あり (6 文字まで)
     * @returns {{ blocks: ({name:string, from:number, to:number, fromIdx:number, toIdx:number, hours:number[], slots:string[], label:string}[]|null), error: string|null, isDefault: boolean }}
     */
    function normalize(config) {
        const isDefault = !(Array.isArray(config) && config.length > 0);
        const src = isDefault ? DEFAULT_BLOCKS : config;
        const err = (msg) => ({ blocks: null, error: msg, isDefault });
        if (src.length < MIN_BLOCKS) return err(`ブロックは ${MIN_BLOCKS} つ以上にしてください`);
        if (src.length > MAX_BLOCKS) return err(`ブロックは ${MAX_BLOCKS} 個までです`);
        const out = [];
        const names = new Set();
        let cursor = 0;
        for (const raw of src) {
            const name = (typeof raw?.name === 'string') ? raw.name.trim() : '';
            if (!name) return err('名前の無いブロックがあります');
            if (name.length > MAX_NAME) return err(`「${name}」は長すぎます (${MAX_NAME} 文字まで)`);
            if (names.has(name)) return err(`「${name}」が 2 つあります`);
            names.add(name);
            // ★ 時刻は整数か数字の文字列だけ (Number() は null / '' / true を 0 や 1 に数値化してしまう — Codex指摘 2026-10-18)
            const from = toHour(raw?.from), to = toHour(raw?.to);
            if (from === null || to === null) return err(`「${name}」の時刻が読めません`);
            const hours = hoursBetween(from, to);
            if (!hours) return err(`「${name}」は終わりが始まりより前です`);
            if (idxOfHour(from) !== cursor) {
                return err(cursor === 0 ? '最初のブロックは 5時 から始めてください' : `「${name}」の前に隙間か重なりがあります`);
            }
            cursor += hours.length;
            out.push({ name, from, to, fromIdx: idxOfHour(from), toIdx: idxOfHour(to), hours, slots: hours.map(keyOf), label: labelOf({ name, from, to }) });
        }
        if (cursor !== HOUR_ORDER.length) return err('最後のブロックは 翌4時 で終えてください');
        return { blocks: out, error: null, isDefault };
    }

    /** シーズンのブロック。設定が無い・壊れているときは既定 (壊れていても画面を止めない) */
    function blocksOfSeason(season) {
        const cfg = season && season.metadata && Array.isArray(season.metadata.blocks) ? season.metadata.blocks : null;
        const r = normalize(cfg);
        return r.blocks || normalize(null).blocks;
    }
    /** 保存する形 ([{ name, from, to }]) に戻す */
    const toConfig = (blocks) => (Array.isArray(blocks) ? blocks : []).map(b => ({ name: b.name, from: b.from, to: b.to }));
    const sameConfig = (a, b) => JSON.stringify(toConfig(a)) === JSON.stringify(toConfig(b));

    /** その「時」(0-23) が入るブロックの添字。無ければ -1 */
    function blockIndexOfHour(blocks, hour) {
        const i = idxOfHour(hour);
        if (i < 0) return -1;
        return (blocks || []).findIndex(b => i >= b.fromIdx && i <= b.toIdx);
    }
    const blockIndexOfSlot = (blocks, slot) => blockIndexOfHour(blocks, hourOfKey(slot));
    const blockAt = (blocks, hour) => { const i = blockIndexOfHour(blocks, hour); return i >= 0 ? blocks[i] : null; };

    /**
     * その人がこのブロックに出られるか。⏳隙間型と時間未登録 (= いつでも) は出られる扱い
     * (ベンチ H「そのブロックに出られる人だけで組む」と同じ読み方)
     */
    function canAttackInBlock(player, block) {
        if (!player || !block) return false;
        if (player.flexTime) return true;
        const slots = Array.isArray(player.availableSlots) ? player.availableSlots : [];
        if (slots.length === 0) return true;
        const set = new Set(block.slots);
        return slots.some(s => set.has(String(s)));
    }
    const membersInBlock = (players, block) => (Array.isArray(players) ? players : []).filter(p => canAttackInBlock(p, block));

    /** 戦闘可能時間 ('hXX' の配列) → 1 時間でも出られるブロックの添字の配列 (時間アンケートをブロックで見せる・聞くため) */
    function blocksOfSlots(blocks, slots) {
        const out = new Set();
        for (const s of Array.isArray(slots) ? slots : []) { const i = blockIndexOfSlot(blocks, s); if (i >= 0) out.add(i); }
        return [...out].sort((a, b) => a - b);
    }
    /** ブロックの添字の配列 → 'hXX' の配列 (チェックで答えた時間を内部の 1 時間刻みに戻す) */
    function slotsOfBlocks(blocks, indexes) {
        const out = [];
        for (const i of Array.isArray(indexes) ? indexes : []) { const b = (blocks || [])[Number(i)]; if (b) out.push(...b.slots); }
        return out;
    }

    /**
     * ブロックを 1 つ増やす: **後ろから見て最初に 2 時間以上あるブロック**の最後の 1 時間を切り出し、その直後に名前の無い
     * 1 時間のブロックを置く。切れるブロックが無い (全部 1 時間) か MAX に達していれば null。
     * (以前は常に末尾のブロックを切っていたので、2 回目から末尾の 1 時間ブロックを `4〜4` と重複させていた — Codex指摘 2026-10-18)
     * @param {{name:string, from:number, to:number}[]} config
     */
    function addSplit(config) {
        const cfg = (Array.isArray(config) ? config : []).map(b => ({ name: b.name, from: toHour(b.from), to: toHour(b.to) }));
        if (cfg.length >= MAX_BLOCKS) return null;
        for (let i = cfg.length - 1; i >= 0; i--) {
            const b = cfg[i];
            if (b.from === null || b.to === null) continue;
            const a = idxOfHour(b.from), z = idxOfHour(b.to);
            if (z - a < 1) continue;   // 1 時間しかない
            const nb = { name: '', from: HOUR_ORDER[z], to: HOUR_ORDER[z] };
            b.to = HOUR_ORDER[z - 1];
            cfg.splice(i + 1, 0, nb);
            return cfg;
        }
        return null;
    }
    /** ブロックを 1 つ消す。消した時間は前のブロック (無ければ次) に吸わせる。MIN 未満になるなら null */
    function removeAt(config, i) {
        const cfg = (Array.isArray(config) ? config : []).map(b => ({ ...b }));
        if (cfg.length <= MIN_BLOCKS || !cfg[i]) return null;
        const gone = cfg.splice(i, 1)[0];
        if (cfg[i - 1]) cfg[i - 1].to = gone.to;
        else if (cfg[i]) cfg[i].from = gone.from;
        return cfg;
    }

    /**
     * 🧱 配信を「そのブロックのぶんだけ」に絞る (2026-10-18)。プランは浅く写し、各ボスの attacks を
     * ブロックの時間帯 (hourIdx が from〜to の行番号) のものだけにする。凸が 1 つも残らないレベルは落とす。
     * ★ 元のプランは変えない (運営の手元・配信 JSON は 1 日ぶんのまま。メンバーの画面だけがこれを見る)
     * @param {Object} plan   ソルバー出力 (levels[].bosses[].attacks[].hourIdx)
     * @param {{from:number, to:number}} scope  ブロック (blockScope)
     */
    function scopePlan(plan, scope) {
        if (!plan || !scope) return plan;
        const a0 = idxOfHour(scope.from), a1 = idxOfHour(scope.to);
        if (a0 < 0 || a1 < 0 || a1 < a0) return plan;
        const keep = (a) => a && Number.isInteger(a.hourIdx) && a.hourIdx >= a0 && a.hourIdx <= a1;
        const levels = (Array.isArray(plan.levels) ? plan.levels : [])
            .map(lv => ({ ...lv, bosses: (Array.isArray(lv.bosses) ? lv.bosses : []).map(b => ({ ...b, attacks: (Array.isArray(b.attacks) ? b.attacks : []).filter(keep) })) }))
            .filter(lv => lv.bosses.some(b => b.attacks.length > 0));
        return { ...plan, levels, blockScope: plan.blockScope || scope };
    }
    /** 2 つの時間帯 'hXX' の遅いほう (5時始まりの並びで)。読めないほうがあれば読めるほうを返す */
    function laterSlot(a, b) {
        const ia = idxOfHour(hourOfKey(a)), ib = idxOfHour(hourOfKey(b));
        if (ia < 0) return ib < 0 ? null : b;
        if (ib < 0) return a;
        return ib > ia ? b : a;
    }
    /**
     * 予約の行 (plan_reservations) をブロックの範囲に絞る。時刻の無い ⏳隙間型 (time_mode 'flex') と時刻の読めない行は残す。
     * ホームに 1 日ぶんの予約を渡すと、後ろのブロックの約束が「配信に入っていない (組み直し中)」に見える (Codex指摘 2026-10-18)
     */
    function scopeReservations(rows, scope) {
        if (!Array.isArray(rows) || !scope) return rows;
        const a0 = idxOfHour(scope.from), a1 = idxOfHour(scope.to);
        if (a0 < 0 || a1 < 0 || a1 < a0) return rows;
        return rows.filter(r => {
            if (!r || r.time_mode === 'flex') return true;
            const i = idxOfHour(hourOfKey(r.time_slot));
            return i < 0 || (i >= a0 && i <= a1);
        });
    }
    /** そのブロックに入る凸の数 */
    const attackCountIn = (plan, scope) => (scopePlan(plan, scope)?.levels || []).reduce((t, lv) => t + lv.bosses.reduce((u, b) => u + b.attacks.length, 0), 0);

    root.raidBlocksDomain = {
        HOUR_ORDER, DEFAULT_BLOCKS, MIN_BLOCKS, MAX_BLOCKS, MAX_NAME,
        normalize, blocksOfSeason, toConfig, sameConfig, labelOf, toHour, addSplit, removeAt,
        blockIndexOfHour, blockIndexOfSlot, blockAt, canAttackInBlock, membersInBlock, blocksOfSlots, slotsOfBlocks,
        scopePlan, attackCountIn, laterSlot, scopeReservations,
    };
})(typeof window !== 'undefined' ? window : globalThis);
