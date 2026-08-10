// ============================================================================
// ドメイン: ユニオン事前比較 (UI再設計 Stage2 — 模擬タブの新機能)
// ----------------------------------------------------------------------------
// 今シーズンの模擬提出 (player_damages) から、属性別の「模擬ダメージ」/
// 「模擬ふるり値」ランキングを組む純関数。DOM・グローバル状態は読まない。
//
// ふるり値の意味論は模擬レーダー (index.html renderMyFururiRadar) と同一:
// 「基準者の今季模擬 + SLv換算」との比。計算式は fururiDomain.calcPerAttackFururi を
// 属性キーを bossCode として再利用する — **式をここに再実装しない**。
// 基準は月初固定 (呼び出し側が _loadMockRadarBase 相当を渡す) ため、
// 月途中の他人の更新で自分との比較が歪まない公平性ルールもレーダーと共通。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {{id:(string|number), name:string, slv?:(number|null)}} MockPlayer
     * @typedef {{player_id:(string|number), attribute:string, slot?:number, damage_b:number, boss_level?:?number}} MockDamageRow
     * @typedef {{slv:number, dmgByAttr:Object<string, number>}} MockBase  _loadMockRadarBase の形
     * @typedef {{playerId:(string|number), name:string, value:number, damageB:number, slot:number, bossLevel:?number, rank:number}} MockCompareRow
     */

    /**
     * 属性別のユニオン事前比較モデルを構築する。
     * @param {Object} input
     * @param {string} input.attribute            正規形属性キー (fire/water/electric/iron/wind)
     * @param {'damage'|'fururi'} input.mode
     * @param {MockPlayer[]} input.players        比較対象のロースター (アクティブメンバー)
     * @param {MockDamageRow[]} input.damages     今季の模擬提出行 (全員分・全属性でよい)
     * @param {MockBase|null} input.base          基準者の今季模擬 (fururi モードのみ使用)
     * @param {Object<string,number>|null} input.slvRatioTable  SLv→倍率 (fururi モードのみ使用)
     * @returns {{rows:MockCompareRow[], missing:{playerId,name}[], noSlv:{playerId,name}[],
     *            meta:{mode:string, attribute:string, count:number, baseMissing:boolean}}}
     *   rows: 採用値の降順 + 同値同順位 (1,2,2,4 方式)。同属性2編成は高い方を採用し slot を返す。
     *   missing: その属性が未提出の人 (ランキング対象外)。
     *   noSlv: fururi モードで提出はあるが SLv 未登録/換算表に無い等で計算不能の人。
     *   meta.baseMissing: fururi モードで基準者の当該属性模擬が無く、全行を計算できなかった。
     */
    function buildMockComparison({ attribute, mode, players, damages, base, slvRatioTable }) {
        const list = Array.isArray(players) ? players : [];
        const rowsRaw = Array.isArray(damages) ? damages : [];
        const useFururi = mode === 'fururi';

        // 属性別・プレイヤー別のベスト提出 (複数編成は高い方を採用、採用 slot と測定レベルを記憶)
        // ★ 比較は従来どおり「属性ごとの最大値」。測定レベルで値を割り引いたりはしない
        //   (レベル違いを混ぜて並べること自体は避けられないので、行にレベルを出して見える化する)
        const bestByPlayer = new Map();   // playerId -> {damageB, slot, bossLevel}
        rowsRaw.forEach(d => {
            if (!d || d.attribute !== attribute) return;
            const v = Number(d.damage_b) || 0;
            if (v <= 0) return;
            const prev = bestByPlayer.get(d.player_id);
            if (!prev || v > prev.damageB) {
                const lv = Number(d.boss_level);
                bestByPlayer.set(d.player_id, {
                    damageB: v,
                    slot: Number(d.slot) || 1,
                    bossLevel: (Number.isInteger(lv) && lv >= 1 && lv <= 4) ? lv : null,
                });
            }
        });

        const calc = root.fururiDomain?.calcPerAttackFururi;
        const baseDmg = Number(base?.dmgByAttr?.[attribute]) || 0;
        const baseSlv = Number(base?.slv) || 0;
        const baseMissing = useFururi && !(baseDmg > 0 && baseSlv > 0 && typeof calc === 'function');
        // 基準マップ: 属性キーを bossCode として classic 形式に包む (レーダーと同じ換算になる)
        const maps = baseMissing ? null
            : { classic: { [attribute]: { damage: baseDmg, slv: baseSlv } }, mean: null, median: null };

        const rows = [];
        const missing = [];
        const noSlv = [];
        list.forEach(p => {
            const best = bestByPlayer.get(p.id);
            if (!best) { missing.push({ playerId: p.id, name: p.name }); return; }
            if (!useFururi) {
                rows.push({ playerId: p.id, name: p.name, value: best.damageB, damageB: best.damageB, slot: best.slot, bossLevel: best.bossLevel ?? null, rank: 0 });
                return;
            }
            if (baseMissing) return;   // 基準なし: 提出者も並べられない (meta.baseMissing で通知)
            const slv = Number(p.slv) || 0;
            const val = slv > 0 ? calc({
                damage: best.damageB, playerSLv: slv, bossCode: attribute,
                mode: 'classic', maps, slvRatioTable,
            }) : null;
            if (val == null) { noSlv.push({ playerId: p.id, name: p.name }); return; }
            rows.push({ playerId: p.id, name: p.name, value: val, damageB: best.damageB, slot: best.slot, bossLevel: best.bossLevel ?? null, rank: 0 });
        });

        // 降順 + 同値同順位 (1,2,2,4)。同値の並びは名前で安定させる
        rows.sort((a, b) => (b.value - a.value) || String(a.name).localeCompare(String(b.name), 'ja'));
        rows.forEach((r, i) => {
            r.rank = (i > 0 && rows[i - 1].value === r.value) ? rows[i - 1].rank : i + 1;
        });

        return {
            rows, missing, noSlv,
            meta: { mode: useFururi ? 'fururi' : 'damage', attribute, count: rows.length, baseMissing },
        };
    }

    root.mockCompareDomain = { buildMockComparison };
})(typeof window !== 'undefined' ? window : globalThis);
