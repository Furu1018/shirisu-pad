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
                if (idxs.length) deadline = { idx: idxs[0], name: String(bl[idxs[0]].name || '') };
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
     * 📸 運営の取り込みの保存先 (編成① / ②) の既定 (段階 5: ボス 5 の 2 編成目を取り込めるように — 常に編成①だと 1 つ目を上書きする: Codex指摘 2c264a5)。
     *   ① 同じ編成がもうある → その枠 (測定の更新)。同じ = 読み取れたキャラ (3 人以上) が全員その編成に入っている (読み取りが欠けても同じと分かる・
     *      2 人入れ替えた別の編成は同じにしない — 重なりの人数で見ると別の編成で編成①を上書きした: Codex指摘 f0ac5d8)
     *   ② 編成①が空き → 1 / ③ 編成②が空き → 2 / ④ 両方埋まっている → ダメージの低いほう (同じなら 2)
     * @param {{ existing: Array<{slot:number, team?:string[], dmgB?:number}>, characters?: string[] }} a  existing = その人のその属性の模擬
     * @returns {1|2}
     */
    function defaultSlot({ existing, characters } = {}) {
        const list = (Array.isArray(existing) ? existing : []).filter(Boolean).map(e => ({ slot: Number(e.slot) || 1, team: Array.isArray(e.team) ? e.team.filter(Boolean).map(String) : [], dmgB: Number(e.dmgB) || 0 }));
        const mine = [...new Set((Array.isArray(characters) ? characters : []).filter(Boolean).map(String))];
        if (mine.length >= 3) {
            const same = list.filter(e => e.team.length && mine.every(c => e.team.includes(c)));
            if (same.length === 1) return same[0].slot === 2 ? 2 : 1;
        }
        const has = (n) => list.some(e => e.slot === n);
        if (!has(1)) return 1;
        if (!has(2)) return 2;
        const s1 = list.find(e => e.slot === 1), s2 = list.find(e => e.slot === 2);
        return (s1.dmgB < s2.dmgB) ? 1 : 2;
    }

    root.mockIntakeDomain = { ATTR_KEYS, ATTR_JP, missingRows, summary, readonlyRows, b5SecondOf, defaultSlot };
})(typeof window !== 'undefined' ? window : globalThis);
