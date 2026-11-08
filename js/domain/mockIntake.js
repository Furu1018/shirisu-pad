// ============================================================================
// 📸 運営の模擬取り込み — 純ロジック (🧱 ブロック制 ③-e・2026-10-18)
// ----------------------------------------------------------------------------
// メンバーの入力を最低限にしたので (③-d)、模擬戦のスクショは Discord に貼られ、運営が PAD に登録する。
// ここは「届いていない人」とその期限 (= その人が最初に出られるブロックの前) を決めるだけ。
// 読み取り (OCR) と保存は本人の「画像で提出」と同じ経路 (index.html handleOpsMockIntakeUpload → myDmgPreviewModal)。
// DOM 非依存。node tests/run-tests.mjs で検証
// ============================================================================
(function (root) {
    'use strict';
    const ATTR_KEYS = ['fire', 'water', 'electric', 'iron', 'wind'];
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };

    /**
     * 🧱 段階 5 (ユーザー決定 i 2026-10-22): 遅い時間 (18 時以降) に出られる人は、ボス 5 の弱点の模擬を 2 編成出す。
     * 朝・昼だけの人は対象外 (Lv4 = ボス 5 だけ・HP 無限 が開くのは遅い時間なので、2 編成目が生きるのは遅い時間の人だけ)。
     * @param {Object} p  盤面の人 (availableSlots / loadoutsByAttr)
     * @param {string|null} b5Weakness  ボス 5 の弱点属性 (持っていく PT)。分からなければ null (= 判定しない)
     * @returns {{ have: number, need: number, short: number }|null}  対象外 (朝・昼だけ・時間未登録・ボス 5 不明) は null
     */
    const LATE_HOURS = new Set([18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4]);
    function b5SecondOf(p, b5Weakness) {
        if (!p || !b5Weakness) return null;
        const slots = Array.isArray(p.availableSlots) ? p.availableSlots : [];
        const late = slots.some(k => { const m = /^h(\d\d)$/.exec(String(k)); return !!m && LATE_HOURS.has(Number(m[1])); });
        if (!late) return null;
        const los = (p.loadoutsByAttr && Array.isArray(p.loadoutsByAttr[b5Weakness])) ? p.loadoutsByAttr[b5Weakness].filter(Boolean) : [];
        const have = Math.min(2, los.length);
        return { have, need: 2, short: 2 - have };
    }

    /**
     * 届いていない人: 模擬が 5 属性そろっていない人。書庫 (archived) と「今回は難しい」(unavailableThisSeason) は除く。
     * 期限 = その人が最初に出られるブロック (戦闘可能時間が 1 時間でも入る最初のブロック)。
     * ⏳隙間型・時間未登録は「いつでも」(期限なし・並びは最後)。
     * 🧱 段階 5: b5Weakness を渡すと、遅い時間の人のボス 5 の 2 編成目の不足 (b5Short) も数える (5 属性そろっていても届いていない人に入る)
     * @param {{ players?: Array<Object>, blocks?: Array<Object>, b5Weakness?: string|null }} a  players は opsStore の盤面の形 (damagesByAttr / availableSlots / flexTime / loadoutsByAttr)
     * @returns {Array<{ id, name, missing: string[], missingJp: string[], submitted: number, deadline: { idx, name }|null, noSlots: boolean, b5Short: number }>}
     */
    function missingRows({ players, blocks, b5Weakness = null } = {}) {
        const rb = root.raidBlocksDomain;
        const list = Array.isArray(players) ? players : [];
        const bl = Array.isArray(blocks) ? blocks : [];
        const out = [];
        for (const p of list) {
            if (!p || p.archived || p.unavailableThisSeason) continue;
            const dmg = p.damagesByAttr || {};
            const missing = ATTR_KEYS.filter(a => !((Number(dmg[a]) || 0) > 0));
            const b5 = b5SecondOf(p, b5Weakness);
            const b5Short = b5 ? b5.short : 0;
            if (missing.length === 0 && b5Short === 0) continue;
            const slots = Array.isArray(p.availableSlots) ? p.availableSlots : [];
            let deadline = null;
            if (rb && bl.length && slots.length && !p.flexTime) {
                const idxs = rb.blocksOfSlots(bl, slots);
                if (idxs.length) deadline = { idx: idxs[0], name: String(bl[idxs[0]].name || ''), short: String(bl[idxs[0]].short || bl[idxs[0]].name || ''), range: String(bl[idxs[0]].range || ''), label: String(bl[idxs[0]].label || ''), ...rebuildAt(bl, idxs[0]) };
            }
            out.push({
                id: p.id, name: p.name, missing, missingJp: missing.map(a => ATTR_JP[a]),
                submitted: ATTR_KEYS.length - missing.length, deadline,
                noSlots: !p.flexTime && slots.length === 0,
                b5Short,
            });
        }
        // 並び: 期限の早い順 (いつでも = 最後) → 足りない属性が多い順 → 名前
        const key = (r) => (r.deadline ? r.deadline.idx : Number.MAX_SAFE_INTEGER);
        out.sort((a, b) => (key(a) - key(b)) || (b.missing.length - a.missing.length) || String(a.name).localeCompare(String(b.name), 'ja'));
        return out;
    }

    /** 見出しの一言: 「届いていない人 N / M」。全員そろっていれば「全員そろっています」 */
    function summary(rows, total) {
        const n = Array.isArray(rows) ? rows.length : 0;
        const m = Number(total) || 0;
        return n === 0 ? (m > 0 ? '全員そろっています' : '') : `届いていない人 ${n} / ${m}`;
    }

    /**
     * 📘 本人のホームに出す読み取り専用の模擬 (🧱 段階 1・2026-10-22 決定 f「模擬は Discord → 運営が登録 → 本人には読むだけ」)。
     * 属性ごとに 編成① / ② を並べ、無い属性も行として返す (画面は薄く「未登録」と出す)。
     * @param {Array<{attribute:string, slot?:number, characters?:string[]}>} rows  player_damages の行 (supabaseLoadPlayerDamages)
     * @param {{ damageOf?: (row:Object) => number }} o  ダメージの読み方 (画面は mockDamageOf を渡す。無ければ damage_b)
     * @returns {Array<{ key:string, name:string, teams: Array<{ slot:number, team:string[], dmgB:number }>, missing:boolean }>}
     */
    function readonlyRows(rows, o = {}) {
        const damageOf = (o && typeof o.damageOf === 'function') ? o.damageOf : (r) => Number(r && r.damage_b) || 0;
        const list = Array.isArray(rows) ? rows : [];
        return ATTR_KEYS.map(key => {
            const teams = list.filter(r => r && String(r.attribute || '').toLowerCase() === key)
                .map(r => ({ slot: Number(r.slot) || 1, team: Array.isArray(r.characters) ? r.characters.filter(Boolean).map(String) : [], dmgB: Number(damageOf(r)) || 0 }))
                .filter(t => t.team.length > 0 || t.dmgB > 0)   // 空の行 (編成もダメージも無い) は無いのと同じ
                .sort((a, b) => a.slot - b.slot);
            return { key, name: ATTR_JP[key], teams, missing: teams.length === 0 };
        });
    }

    /**
     * 📸 運営の取り込みの保存先 (編成① / ② / ③) の既定 (段階 5: ボス 5 の 2 編成目を取り込めるように — 常に編成①だと 1 つ目を上書きする: Codex指摘 2c264a5。
     *   🗣 2026-10-24 ふるりの決定で 1 属性 3 つまで (SQL 55))。
     *   ① 同じ編成がもうある → その枠 (測定の更新)。同じ = 読み取れたキャラ (3 人以上) が全員その編成に入っている (読み取りが欠けても同じとみなす。
     *      2 人入れ替えた別の編成は同じにしない — 重なりの人数で見ると別の編成で編成①を上書きした: Codex指摘 f0ac5d8)
     *   ② 空いている枠のいちばん若いもの (① → ② → ③) / ③ 全部埋まっている → ダメージの低い枠 (同じなら後ろの枠)
     * @param {{ existing: Array<{slot:number, team?:string[], dmgB?:number}>, characters?: string[] }} a  existing = その人のその属性の模擬
     * @returns {1|2|3}
     */
    const SLOTS = [1, 2, 3];
    function defaultSlot({ existing, characters } = {}) {
        const list = (Array.isArray(existing) ? existing : []).filter(Boolean)
            .map(e => ({ slot: Number(e.slot) || 1, team: Array.isArray(e.team) ? e.team.filter(Boolean).map(String) : [], dmgB: Number(e.dmgB) || 0 }))
            .filter(e => SLOTS.includes(e.slot));
        const mine = [...new Set((Array.isArray(characters) ? characters : []).filter(Boolean).map(String))];
        if (mine.length >= 3) {
            const same = list.filter(e => e.team.length && mine.every(c => e.team.includes(c)));
            if (same.length === 1) return same[0].slot;
        }
        const empty = SLOTS.find(n => !list.some(e => e.slot === n));
        if (empty) return empty;
        let best = 1;
        for (const n of SLOTS) {
            const e = list.find(x => x.slot === n), b = list.find(x => x.slot === best);
            if (e.dmgB <= b.dmgB) best = n;
        }
        return best;
    }

    // ===== ▶︎ 模擬ダメージ表 (シンプル化 S1・2026-10-26 ふるりの構想「提出してもらったユーザー名と属性とダメージ入力 / 一覧表 / 被りは赤枠」) =====
    /** 属性の並び = ボス 1〜5 の弱点の順 (シーズンごとに変わる)。ボスが欠けていれば残りを既定の順で足す */
    function attrOrderOfBosses(bosses) {
        const out = [];
        (Array.isArray(bosses) ? bosses : []).slice().sort((a, b) => (Number(a && a.boss_number) || 0) - (Number(b && b.boss_number) || 0))
            .forEach(b => { const w = String(b && b.weakness || '').toLowerCase(); if (ATTR_KEYS.includes(w) && !out.includes(w)) out.push(w); });
        ATTR_KEYS.forEach(a => { if (!out.includes(a)) out.push(a); });
        return out;
    }
    /** ⏱ 〆 の時刻 (第46回の反省 ⑥): 1 つ前のブロックに再編成時間があれば、その始まり { at: '8:40' } (運営はそこから次のブロックを組む)。無ければ {} (A は前に再編成が無い・0 分) */
    const rebuildAt = (bl, i) => (i > 0 && bl[i - 1] && bl[i - 1].rebuild && bl[i - 1].rebuild.from) ? { at: String(bl[i - 1].rebuild.from) } : {};
    /** 〆 = その人が最初に出られるブロック (missingRows と同じ決め方)。前のブロックに再編成時間があれば at = その始まり */
    function deadlineOf(p, blocks) {
        const rb = root.raidBlocksDomain;
        const bl = Array.isArray(blocks) ? blocks : [];
        const slots = Array.isArray(p && p.availableSlots) ? p.availableSlots : [];
        if (!rb || !bl.length || !slots.length || (p && p.flexTime)) return null;
        const idxs = rb.blocksOfSlots(bl, slots);
        return idxs.length ? { idx: idxs[0], name: String(bl[idxs[0]].name || ''), short: String(bl[idxs[0]].short || bl[idxs[0]].name || ''), range: String(bl[idxs[0]].range || ''), label: String(bl[idxs[0]].label || ''), ...rebuildAt(bl, idxs[0]) } : null;
    }
    /** 出られるブロックが 1 つだけならそのブロック (blockBuildDomain.lockKind の 'only' と同じ判定: 出られるブロックの数が 1)。⏳隙間・時間未登録・2 つ以上は null */
    function onlyBlockOf(p, blocks) {
        const rb = root.raidBlocksDomain;
        const bl = Array.isArray(blocks) ? blocks : [];
        const slots = Array.isArray(p && p.availableSlots) ? p.availableSlots : [];
        if (!rb || !bl.length || !slots.length || (p && p.flexTime)) return null;
        const idxs = rb.blocksOfSlots(bl, slots);
        if (idxs.length !== 1) return null;
        const b = bl[idxs[0]];
        return { idx: idxs[0], short: String(b.short || b.name || ''), label: String(b.label || '') };
    }
    /**
     * 同じ人の編成どうしのキャラ被り (同じキャラは 1 日 1 回 → 両方は使えない)。list[].team を見て list[].dup を立てる (キャラの無い編成は判定しない)。
     * ▶︎ 模擬ダメージ表の赤い枠 と ✏️ まとめて入力 の顔の赤 が同じ判定になるよう、ここが唯一
     */
    function markDup(list) {
        const all = Array.isArray(list) ? list : [];
        for (const x of all) x.dup = false;
        for (const x of all) for (const y of all) {
            if (x === y) continue;
            const tx = Array.isArray(x.team) ? x.team.filter(Boolean) : [], ty = Array.isArray(y.team) ? y.team.filter(Boolean) : [];
            if (tx.length && ty.length && tx.some(c => ty.includes(c))) { x.dup = true; y.dup = true; }
        }
        return all;
    }
    /**
     * 人 × 属性 の表。マス = その人のその属性の編成 (slot / dmgB / team / dup)。
     * dup = 同じ人の別の編成 (属性を問わず) と同じキャラが 1 人でもいる (同じキャラは 1 日 1 回 → 両方は使えない)。キャラの無い編成は判定しない。
     * 並びは missingRows と同じ (〆 の早い順 → 足りない属性が多い順 → 名前)。書庫と「今回は難しい」は除く。
     * @param {{ players?: Array<Object>, blocks?: Array<Object>, bosses?: Array<Object>, b5Weakness?: string|null }} a
     * @returns {{ attrs: string[], rows: Array<{ id, name, deadline, only, noSlots, submitted, missing: string[], b5Short: number, cells: Object<string, Array<{slot, dmgB, team, dup}>> }> }}
     *   only = 出られるブロックが 1 つだけの人はそのブロック { idx, short, label } (「このブロックのみ」= 第46期メモ §3 の 5。その人の模擬を先に埋める)。ほかは null
     */
    function tableRows({ players, blocks, bosses, b5Weakness = null } = {}) {
        const attrs = attrOrderOfBosses(bosses);
        const rows = [];
        for (const p of (Array.isArray(players) ? players : [])) {
            if (!p || p.archived || p.unavailableThisSeason) continue;
            const lo = p.loadoutsByAttr && typeof p.loadoutsByAttr === 'object' ? p.loadoutsByAttr : {};
            const all = [];
            attrs.forEach(a => (Array.isArray(lo[a]) ? lo[a] : []).forEach(l => {
                if (!l) return;
                const dmgB = Number(l.dmgB) || 0, team = Array.isArray(l.team) ? l.team.filter(Boolean).map(String) : [];
                if (!(dmgB > 0) && !team.length) return;
                all.push({ attr: a, slot: Number(l.slot) || 1, dmgB, team, dup: false });
            }));
            markDup(all);
            const cells = {};
            attrs.forEach(a => { cells[a] = all.filter(x => x.attr === a).sort((x, y) => x.slot - y.slot).map(({ slot, dmgB, team, dup }) => ({ slot, dmgB, team, dup })); });
            const missing = attrs.filter(a => !cells[a].some(c => c.dmgB > 0));
            const b5 = b5SecondOf(p, b5Weakness);
            const slots = Array.isArray(p.availableSlots) ? p.availableSlots : [];
            rows.push({ id: p.id, name: p.name, deadline: deadlineOf(p, blocks), only: onlyBlockOf(p, blocks), noSlots: !p.flexTime && slots.length === 0, submitted: attrs.length - missing.length, missing, b5Short: b5 ? b5.short : 0, cells });
        }
        const key = (r) => (r.deadline ? r.deadline.idx : Number.MAX_SAFE_INTEGER);
        rows.sort((a, b) => (key(a) - key(b)) || (b.missing.length - a.missing.length) || String(a.name).localeCompare(String(b.name), 'ja'));
        return { attrs, rows };
    }

    // ===== ✏️ 1 人 5 属性のまとめて入力 (第46期メモ §3・2026-11-08・ふるり「人を選ぶ → 入力のモーダルで一気に登録」) =====
    const keyOf = (team) => [...new Set((Array.isArray(team) ? team : []).filter(Boolean).map(String))].sort().join('|');
    const clean5 = (team) => [...new Set((Array.isArray(team) ? team : []).filter(Boolean).map(String))];
    /**
     * 属性ごとのプリセット (Q4 の並び): 1. この属性でよく使われる編成 (📚 人気編成と同じ集計 `popularTeamsDomain.buildPopularTeams` の list を
     *   **今回の模擬の人数 → 過去の凸の人数 → 使った人数** の順に並べ直し・上位 limit) → 2. 前回の自分 (前のレイドの実凸・人気に無いものだけ後ろに足す。人気にあればその行に mine)。
     *   3. 「自分で 5 キャラを選ぶ」は画面 (顔を押す)。
     *   dup = その人のほかの編成 (いま画面に入っているもの・編集中の枠は除く = others) とキャラが被る → 選べない (同じキャラは 1 日 1 回)。dupWith = 被るキャラ
     * @param {{ popular?: Array<{team:string[], count?:number, mockCount?:number, histCount?:number}>, lastRaid?: string[][], others?: string[][], limit?: number }} a
     * @returns {Array<{ key:string, team:string[], source:'popular'|'last', mine:boolean, count:number, mockCount:number, histCount:number, dup:boolean, dupWith:string[] }>}
     */
    function presetsFor({ popular, lastRaid, others, limit = 5 } = {}) {
        const lim = Number.isInteger(limit) && limit > 0 ? limit : 5;
        const oth = (Array.isArray(others) ? others : []).map(clean5).filter(t => t.length);
        // 同じ 5 人 (並びだけ違う) が 2 行来たら 1 つにまとめる (人数はそれぞれ大きいほう。buildPopularTeams はもう鍵でまとめているので通常は来ない)
        const byKey = new Map();
        for (const g0 of (Array.isArray(popular) ? popular : [])) {
            if (!g0) continue;
            const g = { team: clean5(g0.team), count: Number(g0.count) || 0, mockCount: Number(g0.mockCount) || 0, histCount: Number(g0.histCount) || 0 };
            if (g.team.length !== 5) continue;
            const k = keyOf(g.team), cur = byKey.get(k);
            if (!cur) byKey.set(k, g);
            else { cur.count = Math.max(cur.count, g.count); cur.mockCount = Math.max(cur.mockCount, g.mockCount); cur.histCount = Math.max(cur.histCount, g.histCount); }
        }
        const pop = [...byKey.values()]
            .sort((a, b) => (b.mockCount - a.mockCount) || (b.histCount - a.histCount) || (b.count - a.count) || (keyOf(a.team) < keyOf(b.team) ? -1 : keyOf(a.team) > keyOf(b.team) ? 1 : 0));
        const out = [], seen = new Set();
        for (const g of pop) {
            const k = keyOf(g.team);
            seen.add(k);
            out.push({ key: k, team: g.team, source: 'popular', mine: false, count: g.count, mockCount: g.mockCount, histCount: g.histCount });
            if (out.length >= lim) break;
        }
        for (const t0 of (Array.isArray(lastRaid) ? lastRaid : [])) {
            const t = clean5(t0);
            if (t.length !== 5) continue;   // 5 人そろわない (解決できなかった) 凸は使わない (人気編成と同じ)
            const k = keyOf(t);
            const hit = out.find(o => o.key === k);
            if (hit) { hit.mine = true; continue; }
            if (seen.has(k)) continue;
            seen.add(k);
            const pg = pop.find(g => keyOf(g.team) === k) || null;   // 上位 limit に入らなかった人気の編成なら人数も添える
            out.push({ key: k, team: t, source: 'last', mine: true, count: pg ? pg.count : 0, mockCount: pg ? pg.mockCount : 0, histCount: pg ? pg.histCount : 0 });
        }
        for (const o of out) {
            o.dupWith = [...new Set(oth.flatMap(x => x.filter(c => o.team.includes(c))))];
            o.dup = o.dupWith.length > 0;
        }
        return out;
    }
    /**
     * まとめて保存の中身 (Q5「1 回押すと入れた属性ぶんが全部保存される・裏は属性ごとに今の保存を順に」): **変えた枠だけ・ダメージの入っている枠だけ**。
     *   変えていない枠は保存しない (活動ログに「運営が代理で登録」が人数ぶん並ばないように)。編成だけ入れてダメージが無い枠は保存しない (Q6: 1 編成 = ダメージ 1 つ)。
     * @param {Array<{ attr:string, slot:number, damageB:number|null, team:string[], dirty:boolean }>} rows  画面の枠 (属性の順)
     * @returns {{ saves: Array<{attr:string, slot:number, damageB:number, characters:string[]|null}>, skipped: Array<{attr:string, slot:number, why:'unchanged'|'no_damage'}> }}
     */
    function bulkSaves(rows) {
        const saves = [], skipped = [];
        for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r || !ATTR_KEYS.includes(r.attr)) continue;
            const slot = SLOTS.includes(Number(r.slot)) ? Number(r.slot) : 1;
            const dmg = Number(r.damageB);
            if (!r.dirty) { skipped.push({ attr: r.attr, slot, why: 'unchanged' }); continue; }
            if (!(dmg > 0)) { skipped.push({ attr: r.attr, slot, why: 'no_damage' }); continue; }
            const team = clean5(r.team);
            saves.push({ attr: r.attr, slot, damageB: dmg, characters: team.length ? team : null });
        }
        return { saves, skipped };
    }

    root.mockIntakeDomain = { ATTR_KEYS, ATTR_JP, missingRows, summary, readonlyRows, b5SecondOf, defaultSlot, SLOTS, attrOrderOfBosses, deadlineOf, onlyBlockOf, markDup, tableRows, presetsFor, bulkSaves, keyOf };
})(typeof window !== 'undefined' ? window : globalThis);
