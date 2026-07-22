// ============================================================================
// ドメイン: ふるり値計算 (リアーキ ステップ2 — ARCHITECTURE-AUDIT.md §4-2)
// ----------------------------------------------------------------------------
// index.html の calculateFururiScore / buildFururiBaseMap 等から純ロジックを抽出。
// アプリ状態 (currentData / slvRatioTable 等のグローバル) は一切読まず、全て引数で受ける。
// index.html 側は同名の薄いアダプタが残り、グローバルを集めてここへ渡すだけ。
//
// ふるり値 = プレイヤーのダメージ ÷ 「基準者(ふるり)が同条件で出すはずのダメージ」。
// SLv の差は slvRatioTable (SLv→倍率) で正規化する。1.0 = 基準者と同等の火力。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {Object<string, number>} SlvRatioTable  SLv(文字列キー) → 補正倍率
     * @typedef {{damage:number, slv:number, sampleSize?:number}} FururiBaseEntry
     * @typedef {Object<string, FururiBaseEntry>} FururiBaseMap  bossCode → 基準エントリ
     * @typedef {{classic:FururiBaseMap|null, mean:FururiBaseMap|null, median:FururiBaseMap|null}} FururiBaseMaps
     *   classic = ふるり本人の bossCode別ダメージ / mean = ふるり5属性平均 (均整) /
     *   median = ユニオン上位N名平均 (変数名は歴史的経緯で median のまま)
     */

    /**
     * SLv 換算係数を返す。基準SLv のダメージを playerSLv 相当に直すには damage * playerRatio / baseRatio。
     * テーブルに無い SLv は null (計算不能を呼び出し側で null 伝播させる)。
     */
    function slvRatioPair(slvRatioTable, baseSlv, playerSlv) {
        if (!slvRatioTable || !playerSlv || playerSlv <= 0) return null;
        const baseRatio = slvRatioTable[String(baseSlv)];
        const playerRatio = slvRatioTable[String(playerSlv)];
        if (!baseRatio || !playerRatio) return null;
        return { baseRatio, playerRatio };
    }

    /**
     * 基準マップ3種を構築する (旧 buildFururiBaseMap の純粋部分)。
     * @param {Object} args
     * @param {{player:string, syncLevel:number, damage:number, attacks?:{bossCode?:string, damage:number}[]}[]} args.players
     * @param {string} args.basePlayerName        基準者 (ふるり) の表示名
     * @param {Object<string, number>=} args.simulationScores  bossCode→模擬値。登録がある bossCode は実凸より優先
     * @param {SlvRatioTable|null} args.slvRatioTable
     * @param {number=} args.topN                 median(上位平均) の採用人数 (既定10)
     * @returns {FururiBaseMaps & {basePlayer: object|null}}
     */
    function buildFururiBaseMaps({ players, basePlayerName, simulationScores, slvRatioTable, topN = 10 }) {
        const empty = { classic: null, mean: null, median: null, basePlayer: null };
        if (!Array.isArray(players) || players.length === 0) return empty;
        const basePlayer = players.find(p => p.player === basePlayerName && p.syncLevel > 0) || null;
        if (!basePlayer) return empty;

        // --- classic: ふるりの bossCode別 max ---
        const classic = {};
        (basePlayer.attacks || []).forEach(a => {
            if (!a.bossCode) return;
            if (!classic[a.bossCode] || a.damage > classic[a.bossCode].damage) {
                classic[a.bossCode] = { damage: a.damage, slv: basePlayer.syncLevel };
            }
        });
        // 模擬スコアの運用ルール: 登録がある boss_code は模擬値を採用 (通常は未凸属性の補完のみ。
        // 基準者が締め凸で最大を出せなかった場合だけ運営が差し替え登録する)
        const sim = simulationScores || {};
        Object.keys(sim).forEach(code => {
            if (typeof sim[code] === 'number' && sim[code] > 0) {
                classic[code] = { damage: sim[code], slv: basePlayer.syncLevel };
            }
        });

        // --- mean (均整): ふるりの5属性平均を全 bossCode 共通基準に ---
        let mean = null;
        const vals = Object.values(classic).map(v => v.damage).filter(v => v > 0);
        if (vals.length > 0) {
            const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
            mean = {};
            Object.keys(classic).forEach(code => { mean[code] = { damage: avg, slv: basePlayer.syncLevel }; });
        }

        // --- median (上位N名平均): 各bossCodeで SLv正規化済みダメージの上位N名平均。
        //     プレイヤーごとに同bossCodeの最大のみ採用 (同属性2凸の低い方を排除)
        let median = null;
        const baseRatio = slvRatioTable && slvRatioTable[String(basePlayer.syncLevel)];
        if (baseRatio) {
            const bestPerPlayerByCode = {};   // {code: Map<playerName, normalized>}
            players.forEach(p => {
                if (!p.syncLevel || p.syncLevel <= 0) return;
                const pr = slvRatioTable[String(p.syncLevel)];
                if (!pr) return;
                (p.attacks || []).forEach(a => {
                    if (!a.bossCode || !(a.damage > 0)) return;
                    const normalized = a.damage * baseRatio / pr;
                    if (!bestPerPlayerByCode[a.bossCode]) bestPerPlayerByCode[a.bossCode] = new Map();
                    const prev = bestPerPlayerByCode[a.bossCode].get(p.player) || 0;
                    if (normalized > prev) bestPerPlayerByCode[a.bossCode].set(p.player, normalized);
                });
            });
            const topNAvg = (mapByPlayer, n) => {
                const arr = [...(mapByPlayer?.values() || [])].sort((a, b) => b - a).slice(0, n);
                return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
            };
            median = {};
            Object.keys(classic).forEach(code => {
                const mp = bestPerPlayerByCode[code];
                median[code] = (mp && mp.size > 0)
                    ? { damage: topNAvg(mp, topN), slv: basePlayer.syncLevel, sampleSize: Math.min(mp.size, topN) }
                    : classic[code];   // データが無い属性は classic にフォールバック
            });
        }
        return { classic, mean, median, basePlayer };
    }

    /** モードに応じた基準マップを選ぶ (無ければ classic に落ちる) */
    function fururiBaseMapByMode(maps, mode) {
        if (!maps) return null;
        if (mode === 'mean') return maps.mean || maps.classic;
        if (mode === 'median') return maps.median || maps.classic;
        return maps.classic;
    }

    /** 全体(3凸合計)モード用の基準合計 (旧 getFururiBaseTotalsByMode) */
    function fururiBaseTotalsByMode({ basePlayer, mode, maps }) {
        if (mode === 'mean' && maps?.mean) {
            const vals = Object.values(maps.mean).map(v => v.damage);
            if (vals.length > 0) return vals[0] * 3;   // 全bossCode同値
        } else if (mode === 'median' && maps?.median) {
            const totals = Object.values(maps.median).map(v => v.damage);
            if (totals.length > 0) return totals.reduce((a, b) => a + b, 0) * 3 / totals.length;
        }
        return basePlayer.damage;   // classic
    }

    /** 全体(3凸合計)のふるり値 (旧 calculateFururiScore) */
    function calcFururiScore({ playerDamage, playerSLv, basePlayer, mode, maps, slvRatioTable }) {
        if (!slvRatioTable || !basePlayer) return null;
        const pair = slvRatioPair(slvRatioTable, basePlayer.syncLevel, playerSLv);
        if (!pair) return null;
        const baseTotal = fururiBaseTotalsByMode({ basePlayer, mode: mode || 'classic', maps });
        const baseScaled = baseTotal * pair.playerRatio / pair.baseRatio;
        return playerDamage / baseScaled;
    }

    /** 凸単位のふるり値 (旧 calculatePerAttackFururi) */
    function calcPerAttackFururi({ damage, playerSLv, bossCode, mode, maps, slvRatioTable }) {
        const baseMap = fururiBaseMapByMode(maps, mode || 'classic');
        if (!baseMap || !bossCode || !baseMap[bossCode]) return null;
        const base = baseMap[bossCode];
        const pair = slvRatioPair(slvRatioTable, base.slv, playerSLv);
        if (!pair) return null;
        const baseScaled = base.damage * pair.playerRatio / pair.baseRatio;
        return damage / baseScaled;
    }

    root.fururiDomain = {
        buildFururiBaseMaps,
        fururiBaseMapByMode,
        fururiBaseTotalsByMode,
        calcFururiScore,
        calcPerAttackFururi,
    };
})(typeof window !== 'undefined' ? window : globalThis);
