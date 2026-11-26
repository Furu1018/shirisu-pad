// ============================================================================
// ドメイン: 属性ごとに「その属性で選ばれてきたボス」へダメージが出やすかった編成 (本家 + GB)
// 第46回の反省 ⑤ (メモ docs/第46期_前日準備と組むの見直し_2026-11-01.md の §5・Q7〜Q10・見本 docs/前日準備モック_2026-11-01.html の ④)
// ----------------------------------------------------------------------------
// ふるり 11/1「水冷なら水冷で選ばれるボスに対しての編成をまとめて (本家 + GB)」。
//   - 本家はボスのコード (H.S.T.A. = 水冷 など) と PT 属性が固定 → 同じコードのボスを回またぎで集める (Q10)
//   - 単位は SLv 600 換算の B (Q8)。ユニオン = damage ÷ ratio(SLv) × ratio(600)、GB = medianFururi × baseDamage ÷ ratio(baseSlv) × ratio(600)
//     (2026-11 から GB の単位は slv-b だが、書き出しの baseDamage = 1e9・baseSlv = 600 なので同じ式で合う)
//   - 締め凸は除く (残り HP ぶんしか記録されない)。締め凸が分からない回 (isKill が無い = 第43回以前) は入れない
//   - 編成は画像の名前 (BlaBlaLINK の CDN のハッシュ・"…webp") で突き合わせる。月次JSON の characters と GB の gbId が同じ名前
//     (名前の表記ゆれ「:」「：」に左右されない)。5 人そろわない凸は数えずに件数だけ返す
//   - ユニオンは 1 編成 1 凸がほとんど → n=1 を「中央値」と呼ばない・「誰が・生のダメージ・SLv → 換算」を添える (Q9)
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM / 通信に触れない (node からテストできる)
// ============================================================================
(function (root) {
    'use strict';

    const ATTRS = ['fire', 'water', 'electric', 'iron', 'wind'];
    const REF_SLV = 600;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    /** './character-images/abc.webp' → 'abc.webp' (GB の gbId と同じ形)。空は null */
    const hashOf = (p) => { const s = String(p == null ? '' : p).trim().split('/').pop(); return s ? s : null; };
    /** 月次JSON のボス名は位置のローマ数字つき (「Iオベリスク」「IVリビルドバルカンR」) → 外す */
    const bossName = (b) => String(b == null ? '' : b).replace(/^(?:IV|V|I{1,3})(?=[^\sIVX])/, '').trim();
    const median = (arr) => {
        const s = (Array.isArray(arr) ? arr : []).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
        if (!s.length) return null;
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const ratioOf = (table, slv) => { const v = table && slv != null ? num(table[String(slv)]) : null; return v != null && v > 0 ? v : null; };
    const hasKillFlags = (players) => (Array.isArray(players) ? players : []).some(p => (p && Array.isArray(p.attacks) ? p.attacks : []).some(a => a && typeof a.isKill === 'boolean'));
    const blank = () => ({ bosses: [], comps: [], unresolved: 0, noSlv: 0 });

    /**
     * ユニオン (本家の月次JSON) → 属性ごと: その属性で殴ったボス (回・名前・凸数・真ん中) と編成 (回またぎ・ボス別の内訳・誰が)。
     * @param {{ months: {key:string, players:Object[]}[], ratioTable: Object, attrOf: (code:string)=>string|null, refSlv?: number }} a
     * @returns {{ attrs: Object<string, {bosses, comps, unresolved, noSlv}>, months: string[], skipped: string[] }}
     *   bosses[] = { month, boss, code, attacks (締め凸込み), kills, n (数えた凸), med (SLv600 B・n=0 なら null) }
     *   comps[]  = { key, faces (並びは最初に見た凸のまま), entries: [{ month, boss, n, med }], who: [{ player, month, boss, rawB, slv, normB }] }
     */
    function unionCompsByAttr({ months, ratioTable, attrOf, refSlv = REF_SLV } = {}) {
        const fn = typeof attrOf === 'function' ? attrOf : () => null;
        const r600 = ratioOf(ratioTable, refSlv);
        const acc = {};
        const used = [], skipped = [];
        for (const m of (Array.isArray(months) ? months : [])) {
            const players = m && Array.isArray(m.players) ? m.players : [];
            if (!m || !m.key || !players.length) continue;
            if (!hasKillFlags(players)) { skipped.push(m.key); continue; }   // 締め凸が分からない回は入れない (除いたつもりの数字に見える)
            used.push(m.key);
            for (const p of players) {
                const slv = num(p && p.syncLevel), r = ratioOf(ratioTable, slv);
                for (const at of (p && Array.isArray(p.attacks)) ? p.attacks : []) {
                    if (!at || !at.bossCode) continue;
                    const attr = fn(at.bossCode);
                    if (!attr || !ATTRS.includes(attr)) continue;
                    const x = acc[attr] ??= { bosses: new Map(), comps: new Map(), unresolved: 0, noSlv: 0 };
                    const boss = bossName(at.bossType) || String(at.bossCode);
                    const bk = `${m.key}|${boss}`;
                    const b = x.bosses.get(bk) || (x.bosses.set(bk, { month: m.key, boss, code: String(at.bossCode), attacks: 0, kills: 0, vals: [] }), x.bosses.get(bk));
                    b.attacks += 1;
                    if (at.isKill === true) { b.kills += 1; continue; }   // 締め凸は火力から外す
                    const d = num(at.damage);
                    if (!(d > 0)) continue;
                    if (r == null || r600 == null) { x.noSlv += 1; continue; }
                    const v = d / r * r600 / 1e9;
                    b.vals.push(v);
                    const faces = (Array.isArray(at.characters) ? at.characters : []).map(hashOf).filter(Boolean);
                    if (faces.length !== 5) { x.unresolved += 1; continue; }   // 5 人そろわない凸は編成に数えない (件数だけ言う)
                    const key = faces.slice().sort().join('|');
                    const c = x.comps.get(key) || (x.comps.set(key, { key, faces, entries: new Map(), who: [] }), x.comps.get(key));
                    const e = c.entries.get(bk) || (c.entries.set(bk, { month: m.key, boss, vals: [] }), c.entries.get(bk));
                    e.vals.push(v);
                    c.who.push({ player: String(p && p.player || ''), month: m.key, boss, rawB: d / 1e9, slv, normB: v });
                }
            }
        }
        const attrs = {};
        for (const attr of ATTRS) {
            const x = acc[attr];
            if (!x) { attrs[attr] = blank(); continue; }
            attrs[attr] = {
                bosses: [...x.bosses.values()].map(b => ({ month: b.month, boss: b.boss, code: b.code, attacks: b.attacks, kills: b.kills, n: b.vals.length, med: median(b.vals) }))
                    .sort((a, b) => b.month.localeCompare(a.month) || a.boss.localeCompare(b.boss, 'ja')),
                comps: [...x.comps.values()].map(c => ({
                    key: c.key, faces: c.faces,
                    entries: [...c.entries.values()].map(e => ({ month: e.month, boss: e.boss, n: e.vals.length, med: median(e.vals) })),
                    who: c.who.slice().sort((a, b) => b.normB - a.normB),
                })),
                unresolved: x.unresolved, noSlv: x.noSlv,
            };
        }
        return { attrs, months: used, skipped };
    }

    /**
     * GB (凍結エクスポート) → 属性ごと: その回のボス (名前・人数・真ん中) と編成 (人数つき・回またぎ)。
     * @param {{ exports: {key:string, json:Object}[], ratioTable: Object, refSlv?: number }} a
     * @returns {{ attrs: Object<string, {bosses, comps}>, months: string[] }}
     *   bosses[] = { month, boss, n, med }・comps[] = { key, faces, names: {face: 名前}, entries: [{ month, boss, n, med }] }
     */
    function gbCompsByAttr({ exports, ratioTable, refSlv = REF_SLV } = {}) {
        const r600 = ratioOf(ratioTable, refSlv);
        const acc = {};
        const used = [];
        for (const ex of (Array.isArray(exports) ? exports : [])) {
            const j = ex && ex.json;
            if (!ex || !ex.key || !j || !j.base || !j.attributes) continue;
            const rb = ratioOf(ratioTable, num(j.base.baseSlv));
            if (rb == null || r600 == null) continue;
            used.push(ex.key);
            for (const attr of ATTRS) {
                const A = attr.toUpperCase();
                const bA = (j.base.attributes || {})[A], g = j.attributes[A];
                const baseDamage = bA ? num(bA.baseDamage) : null;
                if (!g || !(baseDamage > 0)) continue;
                const conv = (f) => { const v = num(f); return v != null && v > 0 ? v * baseDamage / rb * r600 / 1e9 : null; };
                const boss = String((bA && bA.bossName) || A);
                const x = acc[attr] ??= { bosses: [], comps: new Map() };
                const ab = g.attackBenchmark || {};
                x.bosses.push({ month: ex.key, boss, n: num(ab.n) || 0, med: conv(ab.medianFururi) });
                for (const c of Array.isArray(g.comps) ? g.comps : []) {
                    const faces0 = (c && Array.isArray(c.arrangements) && c.arrangements[0] && Array.isArray(c.arrangements[0].memberGbIdsInOrder))
                        ? c.arrangements[0].memberGbIdsInOrder : String(c && c.compKey || '').split('|');
                    const faces = faces0.map(hashOf).filter(Boolean);
                    const med = conv(c && c.medianFururi), n = num(c && c.n) || 0;
                    if (faces.length !== 5 || med == null || !(n > 0)) continue;
                    const key = faces.slice().sort().join('|');
                    const k = x.comps.get(key) || (x.comps.set(key, { key, faces, names: {}, entries: [] }), x.comps.get(key));
                    for (const mm of Array.isArray(c.members) ? c.members : []) { const h = hashOf(mm && mm.gbId); if (h && mm.name) k.names[h] = String(mm.name); }
                    k.entries.push({ month: ex.key, boss, n, med });
                }
            }
        }
        const attrs = {};
        for (const attr of ATTRS) {
            const x = acc[attr];
            attrs[attr] = x ? { bosses: x.bosses.sort((a, b) => b.month.localeCompare(a.month)), comps: [...x.comps.values()] } : { bosses: [], comps: [] };
        }
        return { attrs, months: used };
    }

    // entries を絞って n (凸数・人数) で重みを付けた真ん中
    const weigh = (entries) => {
        const es = entries.filter(e => e.med != null && e.n > 0);
        const n = es.reduce((s, e) => s + e.n, 0);
        return n ? { n, med: es.reduce((s, e) => s + e.med * e.n, 0) / n } : null;
    };

    /**
     * 画面に出す形: ボスで絞る (null = まとめて)・高い順・上位 top。
     * @param {{ union: {bosses, comps}, gb: {bosses, comps}, boss?: string|null, top?: number }} a
     * @returns {{ unionRows, gbRows, unionMed, gbMed, chars }}
     *   unionRows[] = { key, faces, n, med, entries (絞った内訳), who (絞った人) }・gbRows[] = { key, faces, names, n, med, entries }
     *   unionMed / gbMed = 絞った範囲のボスの真ん中 (凸数・人数で重み)。chars = ボスに絞ったときだけ「入っていると出た」(3 凸以上・ユニオン)
     */
    function view({ union, gb, boss = null, top = 5 } = {}) {
        const pick = (b) => boss == null || b === boss;
        const u = union || blank(), g = gb || { bosses: [], comps: [] };
        const unionRows = u.comps.map(c => {
            const entries = c.entries.filter(e => pick(e.boss));
            const w = weigh(entries);
            return w ? { key: c.key, faces: c.faces, n: w.n, med: w.med, entries, who: c.who.filter(x => pick(x.boss)) } : null;
        }).filter(Boolean).sort((a, b) => b.med - a.med || b.n - a.n || a.key.localeCompare(b.key)).slice(0, top);
        const gbRows = g.comps.map(c => {
            const entries = c.entries.filter(e => pick(e.boss));
            const w = weigh(entries);
            return w ? { key: c.key, faces: c.faces, names: c.names, n: w.n, med: w.med, entries } : null;
        }).filter(Boolean).sort((a, b) => b.med - a.med || b.n - a.n || a.key.localeCompare(b.key)).slice(0, top);
        const uw = weigh(u.bosses.filter(b => pick(b.boss)));
        const gw = weigh(g.bosses.filter(b => pick(b.boss)));
        // 入っていると出た (キャラ別): 回またぎだとボスの差が混ざるので、ボスに絞ったときだけ。3 凸以上・真ん中の高い順
        let chars = [];
        if (boss != null) {
            const byFace = new Map();
            for (const c of u.comps) for (const w of c.who) {
                if (w.boss !== boss) continue;
                for (const f of c.faces) { const a = byFace.get(f) || (byFace.set(f, []), byFace.get(f)); a.push(w.normB); }
            }
            chars = [...byFace.entries()].filter(([, v]) => v.length >= 3).map(([face, v]) => ({ face, n: v.length, med: median(v) }))
                .sort((a, b) => b.med - a.med || b.n - a.n || a.face.localeCompare(b.face)).slice(0, 8);
        }
        return { unionRows, gbRows, unionMed: uw ? uw.med : null, unionN: uw ? uw.n : 0, gbMed: gw ? gw.med : null, gbN: gw ? gw.n : 0, chars };
    }

    root.attrCompsDomain = { ATTRS, REF_SLV, hashOf, bossName, median, unionCompsByAttr, gbCompsByAttr, view };
})(typeof window !== 'undefined' ? window : globalThis);
