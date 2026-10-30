// ============================================================================
// ドメイン: レイド日の「ブロック」(2026-10-17 第45期に向けた反省 → ブロック制)
// ----------------------------------------------------------------------------
// レイド日 (朝5時〜翌4時59分) をいくつかの時間帯のかたまりに分け、運営は**次のブロックだけ**を約束する。
// 後ろのブロックはまだ約束していないので、組み直しても誰の約束も壊れない (第44回の一番の反省
// 「当日のプラン組み直しでメンバーを振り回した」を、約束の範囲を狭めることで構造的に防ぐ)。
//
// ★ 区切りはそのときのユニオンメンバー次第 (ふるりの判断 2026-10-17) — 固定にしない。
//   シーズンごとに運営が決め、`seasons.metadata.blocks` に [{ name, from, to }] で持つ (無ければ既定の 6 つ = 5 時から 4 時間ずつ)。
// ★ 2026-10-30 (ふるり「A,B,C,D…とブロックを作ってそれぞれ 5～9 時と設定」・設計図 docs/ブロック設定_設計図_2026-10-30.md):
//   文字 A・B・C… は**並び順から作る** (保存しない)。名前は任意 (空でよい)。時刻は時計の言い方「5〜9時」(= 5:00〜9:00・to は含む時のまま)。
//   normalize の出力は 5 つの欄 letter / name / short (「A 朝」か「A」) / range (「5〜9時」) / label (「A 朝 5〜9時」) を持つ。
//   ★ 読む側は name から文を組まない (short / range / label を読む)。ブロックを写す所 (決定の控え・blockScope・〆 など) にも 5 つを写す
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

    /** 既定の 6 ブロック = 5 時から 4 時間ずつ (2026-10-24 ふるりの決定。それまでは 7 つ: 朝 5〜8 / 午前 9〜11 / 昼 12〜14 / 午後 15〜17 / 夕方 18〜20 / 夜 21〜23 / 深夜 0〜4)。
     *  from / to は「時」(含む)。夜は 21〜翌0 (5 時始まりの並びで続いている = 日付をまたいでよい)、深夜は 翌1〜4。シーズンごとに ✏️ シーズン編集で変えられる */
    const DEFAULT_BLOCKS = [
        { name: '朝', from: 5, to: 8 }, { name: '午前', from: 9, to: 12 }, { name: '午後', from: 13, to: 16 },
        { name: '夕方', from: 17, to: 20 }, { name: '夜', from: 21, to: 0 }, { name: '深夜', from: 1, to: 4 },
    ];
    const MIN_BLOCKS = 2, MAX_BLOCKS = 12, MAX_NAME = 6;

    const wrap = (h) => (h >= 0 && h <= 4) ? `翌${h}` : String(h);
    const LETTERS = 'ABCDEFGHIJKL';
    /** 並び順 → 文字 (0 → A)。範囲外は '' */
    const letterOf = (i) => (Number.isInteger(i) && i >= 0 && i < LETTERS.length) ? LETTERS[i] : '';
    /** 終わりの「時刻」= to (含む時) の次の時。翌4 の次はレイド日の終わり「翌5」 */
    function endLabel(to) {
        const k = idxOfHour(to);
        if (k < 0) return '';
        return k + 1 < HOUR_ORDER.length ? wrap(HOUR_ORDER[k + 1]) : '翌5';
    }
    /** 「時」として読めるものだけ数にする: 整数 0〜23、または数字だけの文字列。それ以外は null */
    function toHour(v) {
        let n = null;
        if (typeof v === 'number' && Number.isInteger(v)) n = v;
        else if (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) n = Number(v.trim());
        return (n !== null && n >= 0 && n <= 23) ? n : null;
    }
    /** 「5〜9時」「翌1〜翌5時」「9〜10時」(1 時間でも) — 時計の言い方 (終わりは時刻) */
    function rangeOf(b) {
        if (!b) return '';
        const from = toHour(b.from), to = toHour(b.to);
        if (from === null || to === null) return '';
        return `${wrap(from)}〜${endLabel(to)}時`;
    }
    /** 「A 朝」「A」(i が無く b.letter も無ければ名前だけ) */
    function shortOf(b, i) {
        if (!b) return '';
        const letter = letterOf(i) || (typeof b.letter === 'string' ? b.letter : '');
        const name = (typeof b.name === 'string') ? b.name.trim() : '';
        return [letter, name].filter(Boolean).join(' ');
    }
    /** 「A 朝 5〜9時」「A 5〜9時」 */
    function labelOf(b, i) {
        if (!b) return '';
        return [shortOf(b, i), rangeOf(b)].filter(Boolean).join(' ');
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
     * 条件: 5時から翌4時まで隙間も重なりも無く順に並ぶ / 2〜12 個 / 名前は任意 (6 文字まで・付けた名前どうしは重ねない)
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
            const i = out.length;
            const name = (typeof raw?.name === 'string') ? raw.name.trim() : '';
            const letter = letterOf(i);
            const short = [letter, name].filter(Boolean).join(' ');
            if (name.length > MAX_NAME) return err(`「${name}」は長すぎます (${MAX_NAME} 文字まで)`);
            if (name && names.has(name)) return err(`「${name}」が 2 つあります`);   // 名前の無いブロックは何個あってもよい (文字で区別する)
            if (name) names.add(name);
            // ★ 時刻は整数か数字の文字列だけ (Number() は null / '' / true を 0 や 1 に数値化してしまう — Codex指摘 2026-10-18)
            const from = toHour(raw?.from), to = toHour(raw?.to);
            if (from === null || to === null) return err(`「${short}」の時刻が読めません`);
            const hours = hoursBetween(from, to);
            if (!hours) return err(`「${short}」は終わりが始まりより前です`);
            if (idxOfHour(from) !== cursor) {
                return err(cursor === 0 ? '最初のブロックは 5時 から始めてください' : `「${short}」の前に隙間か重なりがあります`);
            }
            cursor += hours.length;
            const range = rangeOf({ from, to });
            out.push({ letter, name, short, range, label: `${short} ${range}`, from, to, fromIdx: idxOfHour(from), toIdx: idxOfHour(to), hours, slots: hours.map(keyOf) });
        }
        if (cursor !== HOUR_ORDER.length) return err('最後のブロックは 翌5時 で終えてください');
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
    /** 24 時間を n 個に均等に分けた設定 (名前なし)。割り切れない余りは前のブロックから 1 時間ずつ (5 つ = 5・5・5・5・4 時間)。範囲外は null */
    function evenSplit(n) {
        if (!Number.isInteger(n) || n < MIN_BLOCKS || n > MAX_BLOCKS) return null;
        const base = Math.floor(HOUR_ORDER.length / n), extra = HOUR_ORDER.length % n, out = [];
        let k = 0;
        for (let i = 0; i < n; i++) {
            const len = base + (i < extra ? 1 : 0);
            out.push({ name: '', from: HOUR_ORDER[k], to: HOUR_ORDER[k + len - 1] });
            k += len;
        }
        return out;
    }
    /** i 番目のブロックを 2 つに分ける (前半を長めに: 5 時間なら 3 + 2)。後ろは名前なし。1 時間しかない・MAX に達しているなら null */
    function splitAt(config, i) {
        const cfg = (Array.isArray(config) ? config : []).map(b => ({ name: b.name, from: toHour(b.from), to: toHour(b.to) }));
        const b = cfg[i];
        if (!b || cfg.length >= MAX_BLOCKS || b.from === null || b.to === null) return null;
        const a = idxOfHour(b.from), z = idxOfHour(b.to);
        if (a < 0 || z <= a) return null;
        const half = Math.ceil((z - a + 1) / 2);
        cfg.splice(i + 1, 0, { name: '', from: HOUR_ORDER[a + half], to: b.to });
        b.to = HOUR_ORDER[a + half - 1];
        return cfg;
    }
    /** i 番目のブロックの終わり (含む時) を変え、次のブロックの始まりを合わせる。次のブロックを 1 時間は残す。動かせなければ null */
    function setEndAt(config, i, to) {
        const cfg = (Array.isArray(config) ? config : []).map(b => ({ name: b.name, from: toHour(b.from), to: toHour(b.to) }));
        const b = cfg[i], nx = cfg[i + 1], t = toHour(to);
        if (!b || !nx || t === null) return null;
        const a = idxOfHour(b.from), k = idxOfHour(t), nz = idxOfHour(nx.to);
        if (k < a || k >= nz) return null;
        b.to = t;
        nx.from = HOUR_ORDER[k + 1];
        return cfg;
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
            // 🧱 段階 3: ブロックで約束した予約 (block_from〜block_to) は、窓が範囲と重なれば中
            if (r.time_mode === 'block') {
                const f = idxOfHour(r.block_from), t = idxOfHour(r.block_to);
                if (f < 0 || t < 0) return true;
                return f <= a1 && t >= a0;
            }
            const i = idxOfHour(hourOfKey(r.time_slot));
            return i < 0 || (i >= a0 && i <= a1);
        });
    }
    /**
     * 時間アンケートをブロックで見せる・聞く (③-b・2026-10-18・ふるりの判断「時間アンケートは PAD で」)。
     * 各ブロックの ON の具合: 'on' (全部の時間が ON) / 'partial' (一部) / 'off'。内部は 1 時間刻み 'hXX' のまま
     */
    function blockStates(blocks, slots) {
        const set = new Set((Array.isArray(slots) ? slots : []).map(String));
        return (Array.isArray(blocks) ? blocks : []).map((b, idx) => {
            const on = b.slots.filter(k => set.has(k)).length;
            return { idx, name: b.name, letter: b.letter || letterOf(idx), short: b.short || shortOf(b, idx), range: b.range || rangeOf(b), label: b.label || labelOf(b, idx), hours: b.slots.length, on, state: on === 0 ? 'off' : (on === b.slots.length ? 'on' : 'partial') };
        });
    }
    /** ブロックを丸ごと ON / OFF にした時間帯 ('hXX' の配列・5時始まりの並び) */
    function toggleBlock(slots, block, on) {
        const set = new Set((Array.isArray(slots) ? slots : []).map(String));
        for (const k of (block && Array.isArray(block.slots)) ? block.slots : []) { if (on) set.add(k); else set.delete(k); }
        return HOUR_ORDER.map(keyOf).filter(k => set.has(k));
    }
    /** 「A 朝・E 夜 (一部)」。何も無ければ '未登録' */
    function blocksLabel(blocks, slots) {
        const parts = blockStates(blocks, slots).filter(x => x.state !== 'off').map(x => x.state === 'partial' ? `${x.short} (一部)` : x.short);
        return parts.length ? parts.join('・') : '未登録';
    }
    /**
     * 📅 きょうの凸 (③-c・2026-10-18・モック 3): ブロックごとに 1 行。
     *   state: past (もう過ぎた) / now (いま) / next (次) / later (その先)
     *   done: このブロックの時刻に報告した自分の凸 / planned: 配信プランでこのブロックに置かれた自分の凸
     *   covered: このブロックの割当は配信で決まっているか (1 日ぶんの配信なら全部・ブロックのぶんだけの配信ならそのブロックだけ・配信無しなら無し)
     * @param {{blocks:Object[], nowHour:number, plan:Object|null, viewerId:any, attacks:Object[], hourOfIso:(iso:string)=>number|null}} a
     */
    function todayRows(a) {
        const blocks = Array.isArray(a && a.blocks) ? a.blocks : [];
        const nowIdx = blockIndexOfHour(blocks, a && a.nowHour);
        // 🧱 段階 7 (2026-10-23): 配信はブロックごとに最新を持つので、複数の配信 (plans) を受ける。1 つだけ (plan) の呼び方も残す。
        //   ブロックのぶんの配信 (blockScope あり) はその範囲の凸だけを見る (後ろのブロックの予想を出さない)。1 日ぶんの配信は全部
        const plans = Array.isArray(a && a.plans) ? a.plans.filter(Boolean) : (a && a.plan ? [a.plan] : []);
        const sameId = (x, y) => x != null && y != null && String(x) === String(y);
        const inScope = (plan, hourIdx) => {
            const s = plan && plan.blockScope;
            if (!s) return true;
            const a0 = idxOfHour(s.from), a1 = idxOfHour(s.to);
            return a0 < 0 || a1 < 0 || a1 < a0 || (hourIdx >= a0 && hourIdx <= a1);
        };
        const planned = [];
        for (const plan of plans) {
            for (const lv of (Array.isArray(plan.levels) ? plan.levels : [])) {
                for (const b of (Array.isArray(lv.bosses) ? lv.bosses : [])) {
                    for (const at of (Array.isArray(b.attacks) ? b.attacks : [])) {
                        if (!sameId(at.memberId, a.viewerId) || !Number.isInteger(at.hourIdx) || !inScope(plan, at.hourIdx)) continue;
                        const bi = blocks.findIndex(bk => at.hourIdx >= bk.fromIdx && at.hourIdx <= bk.toIdx);
                        if (bi < 0) continue;
                        planned.push({ block: bi, bossNumber: b.bossNumber, bossName: b.name || null, weakness: b.weakness || null, level: lv.level,
                            dmgB: Number(at.dmgB) || 0, hourLabel: at.hourLabel || null, flex: !!at.flex, loadoutSlot: at.loadoutSlot || 1, team: Array.isArray(at.team) ? at.team : null });
                    }
                }
            }
        }
        // covered = そのブロックに効いている配信がある (ブロックのぶんの配信はそのブロックだけ・1 日ぶんの配信は全部)
        const coveredAt = (b) => plans.some(p => !p.blockScope || (Number(p.blockScope.from) === Number(b.from) && Number(p.blockScope.to) === Number(b.to)));
        const done = [];
        for (const r of (Array.isArray(a && a.attacks) ? a.attacks : [])) {
            if (!r) continue;
            const h = (typeof r.reported_at === 'string' && typeof a.hourOfIso === 'function') ? a.hourOfIso(r.reported_at) : null;
            const bi = h == null ? -1 : blockIndexOfHour(blocks, h);
            done.push({ block: bi, bossNumber: r.boss_number ?? null, level: r.level ?? null, damageB: Number(r.damage_raw) > 0 ? Number(r.damage_raw) / 1e9 : 0, hour: h });
        }
        const rows = blocks.map((b, i) => ({
            idx: i, name: b.name, letter: b.letter || letterOf(i), short: b.short || shortOf(b, i), range: b.range || rangeOf(b), label: b.label || labelOf(b, i),
            state: nowIdx < 0 ? 'later' : (i < nowIdx ? 'past' : (i === nowIdx ? 'now' : (i === nowIdx + 1 ? 'next' : 'later'))),
            planned: planned.filter(x => x.block === i),
            done: done.filter(x => x.block === i),
            covered: coveredAt(b),
        }));
        return { rows, nowIdx, unknownTime: done.filter(x => x.block < 0), total: done.length };
    }
    /** そのブロックに入る凸の数 */
    const attackCountIn = (plan, scope) => (scopePlan(plan, scope)?.levels || []).reduce((t, lv) => t + lv.bosses.reduce((u, b) => u + b.attacks.length, 0), 0);

    // ===== 🧱 ブロックごとの凸数 (段階 2・2026-10-22 ユーザー決定「朝 1・夕方 2 のような希望を予約なしで通す」) =====
    //   鍵はブロックの `from-to` (時)。区切りが変わっても読める (合わない鍵は捨てる)。値は 1〜3 で合計 3 まで。
    //   入れていないブロックは「運営におまかせ」(そのブロックの上限なし)
    const MAX_ATTACKS = 3;
    const countKey = (b) => (b && Number.isInteger(b.from) && Number.isInteger(b.to)) ? `${b.from}-${b.to}` : '';
    const countsTotal = (counts) => Object.values(counts && typeof counts === 'object' ? counts : {}).reduce((t, n) => t + (Number(n) || 0), 0);
    /** ON (1 時間でも出られる) のブロックの鍵だけ残し、1〜3 の整数にして、合計を 3 までに (ブロックの順で詰める)。空なら null */
    function normalizeCounts(counts, blocks, slots) {
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
        const list = Array.isArray(blocks) ? blocks : [];
        const on = new Set(blockStates(list, slots).filter(s => s.state !== 'off').map(s => s.idx));
        const out = {};
        let total = 0;
        list.forEach((b, i) => {
            const k = countKey(b);
            const n = Number(counts[k]);
            if (!on.has(i) || !k || !Number.isInteger(n) || n < 1) return;
            const take = Math.min(n, MAX_ATTACKS - total);
            if (take > 0) { out[k] = take; total += take; }
        });
        return total > 0 ? out : null;
    }
    /** 1 つのブロックの凸数を ±1。0 になったら鍵を消す (おまかせ)。合計 3 を超える + と、OFF のブロックは何もしない */
    function stepCount(counts, blocks, slots, idx, delta) {
        const list = Array.isArray(blocks) ? blocks : [];
        const base = normalizeCounts(counts, list, slots) || {};
        const keep = () => (Object.keys(base).length ? base : null);
        const b = list[Number(idx)];
        const st = b ? blockStates(list, slots)[Number(idx)] : null;
        if (!b || !st || st.state === 'off') return keep();
        const k = countKey(b);
        const cur = Number(base[k]) || 0;
        if (delta > 0 && (countsTotal(base) >= MAX_ATTACKS || cur >= MAX_ATTACKS)) return keep();
        const out = { ...base };
        const next = cur + (delta > 0 ? 1 : -1);
        if (next <= 0) delete out[k]; else out[k] = next;
        return Object.keys(out).length ? out : null;
    }
    /** 「A 朝 1 · D 2」(ブロックの順)。無ければ '' */
    function countsLabel(counts, blocks) {
        if (!counts || typeof counts !== 'object') return '';
        return (Array.isArray(blocks) ? blocks : []).map((b, i) => {
            const n = Number(counts[countKey(b)]);
            return Number.isInteger(n) && n > 0 ? `${b.short || shortOf(b, i)} ${n}` : '';
        }).filter(Boolean).join(' · ');
    }
    /**
     * ソルバーに渡す上限 (段階 2b)。[{ fromIdx, toIdx, max }] — max は「そのブロックでまだ置ける数」= 凸数 − そのブロックで済んだ凸。
     * @param {Object|null} counts  保存した凸数 ({ "5-8": 1 })
     * @param {Object[]} blocks     シーズンのブロック
     * @param {number[]} doneHours  済んだ凸の時 (0〜23)。どのブロックで済んだかを数える
     */
    function capsOf(counts, blocks, doneHours) {
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return [];
        const list = Array.isArray(blocks) ? blocks : [];
        const done = new Map();
        (Array.isArray(doneHours) ? doneHours : []).forEach(h => { const i = blockIndexOfHour(list, h); if (i >= 0) done.set(i, (done.get(i) || 0) + 1); });
        const out = [];
        let total = 0;   // ★ 合計 3 もブロックの順で守る (保存の時点で詰めてあっても、生の値を受けたときに 3 を超えて渡さない: Codex指摘)
        list.forEach((b, i) => {
            const n = Number(counts[countKey(b)]);
            if (!Number.isInteger(n) || n < 1) return;
            const take = Math.min(n, MAX_ATTACKS - total);
            if (take <= 0) return;
            total += take;
            out.push({ fromIdx: b.fromIdx, toIdx: b.toIdx, max: Math.max(0, take - (done.get(i) || 0)) });
        });
        return out;
    }

    root.raidBlocksDomain = {
        HOUR_ORDER, DEFAULT_BLOCKS, MIN_BLOCKS, MAX_BLOCKS, MAX_NAME,
        normalize, blocksOfSeason, toConfig, sameConfig, labelOf, shortOf, rangeOf, letterOf, endLabel, toHour, addSplit, removeAt, evenSplit, splitAt, setEndAt,
        blockIndexOfHour, blockIndexOfSlot, blockAt, canAttackInBlock, membersInBlock, blocksOfSlots, slotsOfBlocks,
        scopePlan, attackCountIn, laterSlot, scopeReservations, blockStates, toggleBlock, blocksLabel, todayRows,
        countKey, countsTotal, normalizeCounts, stepCount, countsLabel, capsOf,
    };
})(typeof window !== 'undefined' ? window : globalThis);
