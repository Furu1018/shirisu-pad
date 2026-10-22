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
     * 届いていない人: 模擬が 5 属性そろっていない人。書庫 (archived) と「今回は難しい」(unavailableThisSeason) は除く。
     * 期限 = その人が最初に出られるブロック (戦闘可能時間が 1 時間でも入る最初のブロック)。
     * ⏳隙間型・時間未登録は「いつでも」(期限なし・並びは最後)。
     * @param {{ players?: Array<Object>, blocks?: Array<Object> }} a  players は opsStore の盤面の形 (damagesByAttr / availableSlots / flexTime)
     * @returns {Array<{ id, name, missing: string[], missingJp: string[], submitted: number, deadline: { idx, name }|null, noSlots: boolean }>}
     */
    function missingRows({ players, blocks } = {}) {
        const rb = root.raidBlocksDomain;
        const list = Array.isArray(players) ? players : [];
        const bl = Array.isArray(blocks) ? blocks : [];
        const out = [];
        for (const p of list) {
            if (!p || p.archived || p.unavailableThisSeason) continue;
            const dmg = p.damagesByAttr || {};
            const missing = ATTR_KEYS.filter(a => !((Number(dmg[a]) || 0) > 0));
            if (missing.length === 0) continue;
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

    root.mockIntakeDomain = { ATTR_KEYS, ATTR_JP, missingRows, summary, readonlyRows };
})(typeof window !== 'undefined' ? window : globalThis);
