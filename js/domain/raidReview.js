// ============================================================================
// ドメイン: レイドの振り返り (分析タブ・2026-09-15 ユーザー要望)
// ----------------------------------------------------------------------------
// 「各属性のボスの総体力をどこまで削れたか」「凸の偏り」「ユニオンの得意・不得意」を出す。
//
// ★ 進捗率 (%) は**達成度であって属性の火力ではない** — 踏破すると 100% で頭打ちになり、
//   しかも「かけた凸数」で決まる。弱い属性に凸を集めても 100% になるので、
//   得意・不得意の主役は **1凸あたりの対GB中央値比** (SLv補正・締め凸を除く) にする (Codex と合意)。
// ★ ゲームは残HPを超えたダメージを記録しない = そのボス・その Lv の記録の合計は
//   min(実際に出した火力, そのLvのHP)。**踏破した Lv は合計が HP と厳密に一致する** —
//   ボスのクラス (tyrant/lord) の推定はこの性質だけを使い、一意に決まらなければ推定しない。
// ★ 締め凸 (isKill) は頭打ちなので**火力の指標からは外し、削った総量には含める**
//   (実績としては実際に入った量が正しい。既存の 締 バッジと同じ方針)。
//
// アプリ状態は読まず全て引数で受ける (optimal-plan.js と同じ規約: IIFE + root 直付け)。
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const LEVELS = [1, 2, 3];
    const CLASSES = ['tyrant', 'lord'];
    const num = (v) => (Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : null));

    /** hpTable = { "1": {tyrant, lord}, ... } */
    function hpOf(hpTable, level, cls) {
        const v = hpTable && hpTable[String(level)] ? num(hpTable[String(level)][cls]) : null;
        return v != null && v > 0 ? v : null;
    }

    /**
     * ボス・Lv ごとに記録を畳む。
     * @param {Object[]} players  {player, syncLevel, attacks:[{bossCode, level, damage, isKill}]}
     * @returns {{byBoss:Object, hasKillFlags:boolean}}
     *   byBoss[bossCode] = { levels: {1:{damage,attacks,kills,slices}, ...}, damage, attacks, kills, unknownLevel }
     *   slices = その Lv の凸を1本ずつ {name, damage, team, isKill} で (誰がどれだけ削ったかを帯で区切るため・2026-09-15 ユーザー要望)
     * ★ unknownLevel = Lv1〜3 に入らない凸の本数。**古い回はレベルの記録が別の形** (2026-03〜07 は 11/21/31 等) で、
     *   数えると「分子は全部の凸・分母は Lv1〜3 の HP」になって率が嘘になる (Codex指摘 2026-09-15)
     */
    function tally(players) {
        const byBoss = {};
        let hasKillFlags = false;
        for (const p of Array.isArray(players) ? players : []) {
            for (const a of (p && Array.isArray(p.attacks)) ? p.attacks : []) {
                if (!a || !a.bossCode) continue;
                if (a.isKill === true || a.isKill === false) hasKillFlags = true;
                const d = num(a.damage) || 0;
                const lv = num(a.level);
                const b = byBoss[a.bossCode] ??= { levels: {}, damage: 0, attacks: 0, kills: 0, unknownLevel: 0 };
                b.damage += d; b.attacks += 1; if (a.isKill === true) b.kills += 1;
                if (lv != null && LEVELS.includes(lv)) {
                    const L = b.levels[lv] ??= { damage: 0, attacks: 0, kills: 0, slices: [] };
                    L.damage += d; L.attacks += 1; if (a.isKill === true) L.kills += 1;
                    L.slices.push({ name: (p && p.player) || '?', damage: d, isKill: a.isKill === true,
                                    team: Array.isArray(a.characters) ? a.characters.filter(Boolean) : [] });
                } else {
                    b.unknownLevel += 1;
                }
            }
        }
        return { byBoss, hasKillFlags };
    }

    /**
     * ボスのクラス (tyrant / lord)。宣言があればそれ、無ければ「踏破した Lv の合計が設定 HP と
     * **厳密に一致**する」ことから推定する。候補が1つに定まらなければ推定しない (母数をでっち上げない)。
     * @returns {{cls:('tyrant'|'lord'|null), estimated:boolean}}
     */
    function bossClass({ levels, hpTable, declared } = {}) {
        if (CLASSES.includes(declared)) return { cls: declared, estimated: false };
        const hits = new Set();
        for (const lv of LEVELS) {
            const d = levels && levels[lv] ? num(levels[lv].damage) : null;
            if (!(d > 0)) continue;
            for (const c of CLASSES) if (hpOf(hpTable, lv, c) === d) hits.add(c);
        }
        return hits.size === 1 ? { cls: [...hits][0], estimated: true } : { cls: null, estimated: false };
    }

    /**
     * 属性ごとの進捗 (どこまで削れたか)。クラスが決まらないボスは率を出さず総量だけ。
     * @param {Object} a
     * @param {Object[]} a.players
     * @param {Object} a.hpTable            raid-config の hardLevelHp (月の上書き適用後)
     * @param {Object=} a.declaredClasses   { bossCode: 'tyrant'|'lord' } (raid-config の bossClassByMonth)
     * @param {(bossCode:string)=>(string|null)} a.attrOf  ボスコード → 持っていく PT 属性 (小文字)
     * @returns {Object[]} 進捗の高い順 (率の無いものは最後)。各行:
     *   { attr, bossCode, cls, estimated, levels:[{level, damage, hp, cleared, attacks, kills, slices}],
     *   slices = 削った量の多い順の凸 {name, damage, team, isKill, pctLevel, pctTotal} (pct は率を出せるときだけ)
     *     damage, hp, pct, attacks, kills, clearedLevels, unknownLevel, noRate }
     *   noRate: 'class' = クラスが決まらない / 'levels' = レベルの記録が古い形 (率を出さない理由)
     */
    function attributeProgress({ players, hpTable, declaredClasses, attrOf } = {}) {
        const fn = typeof attrOf === 'function' ? attrOf : () => null;
        const { byBoss } = tally(players);
        const rows = [];
        for (const bossCode of Object.keys(byBoss)) {
            const attr = fn(bossCode);
            if (!attr) continue;   // 対応の分からないボスは出さない (別シーズンの取り違え防止)
            const b = byBoss[bossCode];
            const { cls, estimated } = bossClass({ levels: b.levels, hpTable, declared: declaredClasses ? declaredClasses[bossCode] : null });
            const levels = LEVELS.map(level => {
                const L = b.levels[level] || { damage: 0, attacks: 0, kills: 0, slices: [] };
                const hp = cls ? hpOf(hpTable, level, cls) : null;
                // 凸は削った量の多い順に並べる (帯の左から大きい順に区切られる)。同じなら名前順で決定的に
                const slices = (L.slices || []).slice().sort((x, y) => y.damage - x.damage || String(x.name).localeCompare(String(y.name), 'ja'));
                return { level, damage: L.damage, attacks: L.attacks, kills: L.kills, hp, cleared: hp != null && L.damage >= hp, slices };
            });
            // ★ 率を出すのは「クラスが決まる」かつ「全部の凸が Lv1〜3 に入る」ときだけ。
            //   古い回 (レベルの記録が別の形) は分子と分母が揃わないので率を出さない (Codex指摘 2026-09-15)
            const noRate = !cls ? 'class' : (b.unknownLevel > 0 ? 'levels' : null);
            const hp = noRate ? null : levels.reduce((s, L) => s + (L.hp || 0), 0);
            // 凸ごとの割合: そのレベルのボスHPに対して / その属性の総HP (Lv1〜3) に対して
            for (const L of levels) {
                for (const s of L.slices) {
                    s.pctLevel = L.hp ? (s.damage / L.hp) * 100 : null;
                    s.pctTotal = hp ? (s.damage / hp) * 100 : null;
                }
            }
            rows.push({
                attr, bossCode, cls, estimated, levels,
                damage: b.damage, attacks: b.attacks, kills: b.kills,
                unknownLevel: b.unknownLevel, noRate,
                hp: hp || null,
                pct: hp ? (b.damage / hp) * 100 : null,
                clearedLevels: noRate ? 0 : levels.filter(L => L.cleared).length,
            });
        }
        // 進捗の高い順 → 率の無いものは最後 (総量の多い順)
        rows.sort((x, y) => (y.pct ?? -1) - (x.pct ?? -1) || y.damage - x.damage);
        return rows;
    }

    /**
     * 属性ごとの適性 (1凸あたりの強さ)。
     *   basis 'gb'  = 対GB中央値比 (SLv補正済み・締め凸を除く) — 主役
     *   basis 'slv' = GB のデータが無い月: 基準 SLv に揃えた 1凸平均
     *   basis 'raw' = SLv も取れない: 記録のままの 1凸平均
     * ★ 締め凸は火力の指標から外す。ただし isKill を持たない過去回は外せないので killsExcluded=false で知らせる
     * @param {Object} a
     * @param {Object[]} a.players
     * @param {Object=} a.ratioTable  SLv → 係数
     * @param {Object=} a.gb          GB 凍結エクスポート
     * @param {(bossCode:string)=>(string|null)} a.attrOf
     * @param {number=} a.refSlv      basis 'slv' で揃える SLv (既定: 参加者の SLv の中央値)
     * @returns {{rows:Object[], basis:string, killsExcluded:boolean, refSlv:(number|null)}}
     */
    function attributeAptitude({ players, ratioTable, gb, attrOf, refSlv } = {}) {
        const fn = typeof attrOf === 'function' ? attrOf : () => null;
        const list = Array.isArray(players) ? players : [];
        const ratioOf = (slv) => {
            const v = ratioTable && slv != null ? num(ratioTable[String(slv)]) : null;
            return v != null && v > 0 ? v : null;
        };
        const gbBase = gb && gb.base ? ratioOf(gb.base.baseSlv) : null;
        const hasKillFlags = tally(list).hasKillFlags;
        // 基準 SLv: 指定 → 参加者の中央値
        const slvs = list.map(p => num(p && p.syncLevel)).filter(v => v != null && v > 0).sort((a, b) => a - b);
        const ref = num(refSlv) || (slvs.length ? slvs[Math.floor(slvs.length / 2)] : null);
        const refRatio = ratioOf(ref);
        // 使える基準を決める (全属性で同じ基準にする — 属性ごとに違うと比べられない)
        let basis = 'raw';
        if (gbBase != null && refRatio != null) basis = 'gb';
        else if (refRatio != null) basis = 'slv';

        const acc = {};
        for (const p of list) {
            const slv = num(p && p.syncLevel);
            for (const a of (p && Array.isArray(p.attacks)) ? p.attacks : []) {
                if (!a || !a.bossCode) continue;
                const attr = fn(a.bossCode);
                if (!attr) continue;
                const d = num(a.damage) || 0;
                const x = acc[attr] ??= { attr, attacks: 0, damage: 0, scored: 0, sumB: 0, vals: [], players: new Set() };
                x.attacks += 1; x.damage += d;
                if (p && p.player) x.players.add(p.player);
                if (!(d > 0)) continue;
                if (hasKillFlags && a.isKill === true) continue;   // 締め凸は火力の指標から外す
                const r = ratioOf(slv);
                let v = null;
                if (basis === 'gb') {
                    const g = gb.attributes ? gb.attributes[attr.toUpperCase()] : null;
                    const baseDamage = gb.base.attributes ? num((gb.base.attributes[attr.toUpperCase()] || {}).baseDamage) : null;
                    const med = g && g.attackBenchmark ? num(g.attackBenchmark.medianFururi) : null;
                    if (r != null && baseDamage > 0 && med > 0) v = ((d / r) * gbBase / baseDamage) / med * 100;
                } else if (basis === 'slv') {
                    if (r != null) v = (d / r) * refRatio;
                } else {
                    v = d;
                }
                if (v == null) continue;
                x.scored += 1; x.sumB += d; x.vals.push(v);
            }
        }
        const rows = Object.values(acc).map(x => {
            const s = x.vals.slice().sort((a, b) => a - b);
            const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
            return {
                attr: x.attr, attacks: x.attacks, damage: x.damage, players: x.players.size,
                scored: x.scored,
                avgB: x.scored ? x.sumB / x.scored : null,     // 締め凸を除いた 1凸平均 (生の値)
                value: mean,                                    // 主役の指標 (basis による)
                median: s.length ? s[Math.floor(s.length / 2)] : null,
                hi: s.length ? s[s.length - 1] : null,
                lo: s.length ? s[0] : null,
            };
        });
        rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || b.attacks - a.attacks);
        return { rows, basis, killsExcluded: hasKillFlags, refSlv: basis === 'slv' ? ref : null };
    }

    /**
     * 人 × 属性: 誰がどの属性でどれだけ削ったか。
     * @returns {{rows:Object[], max:number, attrs:string[]}} rows は削った総量の多い順。
     *   各行 { name, syncLevel, total, attacks, cells: { attr: {damage, attacks, kills} } }
     */
    function memberMatrix({ players, attrOf, attrs } = {}) {
        const fn = typeof attrOf === 'function' ? attrOf : () => null;
        const rows = [];
        let max = 0;
        for (const p of Array.isArray(players) ? players : []) {
            if (!p || !p.player) continue;
            const cells = {};
            let total = 0, attacks = 0;
            for (const a of Array.isArray(p.attacks) ? p.attacks : []) {
                if (!a || !a.bossCode) continue;
                const attr = fn(a.bossCode);
                if (!attr) continue;
                const d = num(a.damage) || 0;
                const c = cells[attr] ??= { damage: 0, attacks: 0, kills: 0 };
                c.damage += d; c.attacks += 1; if (a.isKill === true) c.kills += 1;
                total += d; attacks += 1;
                if (c.damage > max) max = c.damage;
            }
            if (!attacks) continue;   // この回に凸していない人は出さない
            rows.push({ name: p.player, syncLevel: num(p.syncLevel) || null, total, attacks, cells });
        }
        rows.sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name), 'ja'));
        return { rows, max, attrs: Array.isArray(attrs) ? attrs.slice() : [] };
    }

    /**
     * 帯の中の凸の幅 (%) を出す。細い凸にも下限を与えつつ、**合計は必ず「その Lv で削った割合」に一致**させる
     * (Codex指摘 2026-09-16: CSS の min-width(px) だと本数が多いとき合計が親を超えて右端の凸が切れる)。
     *   下限 = min(削った割合 / 本数 × 0.35, 2%) — **1本あたりの取り分の 1/3 まで**に抑える。大きくすると大きい凸まで
     *   下限に潰されて「誰がたくさん削ったか」が読めなくなる (2026-09-16 に自分で踏んだ)。
     *   はみ出したぶんは、下限より余裕のある凸から**その余裕に比例して**削る。
     *   ★ 余裕は必ず足りる: はみ出し = Σ(下限 − 小さい凸) ≤ 本数 × 下限 ≤ 0.35 × 削った割合 < 削った割合 = Σ(凸)
     *     なので「下限より大きい凸」の余裕の合計を超えない。下限の上限 (0.35 と 2%) を外すとこの保証が壊れる (テストが見張る)。
     * @param {{slices:Object[], hp:(number|null), damage:number}} level
     * @returns {number[]} 各凸の幅 (%)。hp が無ければ全部 0
     */
    function sliceWidths(level) {
        const slices = (level && Array.isArray(level.slices)) ? level.slices : [];
        const hp = level ? num(level.hp) : null;
        const n = slices.length;
        if (!n || !(hp > 0)) return new Array(n).fill(0);
        const fill = Math.max(0, Math.min(100, ((num(level.damage) || 0) / hp) * 100));
        if (!(fill > 0)) return new Array(n).fill(0);
        const floor = Math.min((fill / n) * 0.35, 2);
        const base = slices.map(s => Math.max(0, ((num(s.damage) || 0) / hp) * 100));
        const out = base.map(b => Math.max(b, floor));
        const extra = out.reduce((a, b) => a + b, 0) - fill;
        if (extra > 1e-9) {
            const room = out.map(w => Math.max(0, w - floor));
            const sum = room.reduce((a, b) => a + b, 0);
            // sum が 0 になるのは「全部の凸が下限以下」= 削った割合 ≤ 本数 × 下限 のときだけで、上の保証によりあり得ない
            if (sum > 0) for (let i = 0; i < n; i++) out[i] -= extra * (room[i] / sum);
        }
        return out.map(w => Math.max(0, w));
    }

    /**
     * 表示用に幅を丸める。★ **積み上げで丸める** — 1本ずつ丸めると切り上げが積もって合計が元より増え、
     * 帯が親からはみ出して右端の凸が切れる (Codex指摘 2026-09-16)。
     * 積み上げた値を丸めて差を取ると、合計は必ず「元の合計を丸めた値」に一致する。
     * ★ 負・数でない値は**積む前に 0 にする** — 積んだあとで切り落とすと合計が合わなくなる (Codex指摘 2026-09-16)。
     *   積む値が 0 以上なので差は必ず 0 以上になり、あとから切り落とす必要がない。
     * @param {number[]} widths
     * @param {number=} digits 小数の桁 (既定 2・0〜6 まで。外れた値は 2 に倒す — 10^digits が Infinity になるのを防ぐ)
     */
    function roundWidths(widths, digits = 2) {
        const k = Math.pow(10, Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2);
        let acc = 0, prev = 0;
        return (Array.isArray(widths) ? widths : []).map(w => {
            acc += (Number.isFinite(w) && w > 0) ? w : 0;
            const cur = Math.round(acc * k) / k;
            const v = cur - prev;
            prev = cur;
            // 差は必ず 1/k の倍数なので、丸めは浮動小数のゴミ (1.0099999…) を落とすだけ — 合計は変わらない
            return Math.round(v * k) / k;
        });
    }

    root.raidReviewDomain = { tally, bossClass, attributeProgress, attributeAptitude, memberMatrix, sliceWidths, roundWidths, LEVELS, CLASSES };
})(typeof window !== 'undefined' ? window : globalThis);
