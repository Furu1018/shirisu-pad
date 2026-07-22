// ============================================================================
// 状態ストア: 運営ダッシュボード盤面 (リアーキ ステップ3 — ARCHITECTURE-AUDIT.md §4-3)
// ----------------------------------------------------------------------------
// 旧 `_opsDashboardCache` / `_opsDashboardCacheAt` (index.html に47+3箇所散在) を置換する
// 単一ストア。盤面 { season, bosses, players } の読み書きは必ずここを通る:
//   読み: get() / 全量ロード: load() / プラン用鮮度保証: isStale()+load() /
//   書き込み操作後: invalidate() / ポーリングの軽量差し替え: patchBosses() /
//   SLv即時反映: patchPlayer()
//
// 変えてはいけない不変条件 (旧実装から引き継ぎ — 調査記録は ARCHITECTURE-AUDIT.md §4-3):
//  1. ops タブ描画 (renderOpsDashboard) は毎回 load() = 開くたびフレッシュ (TTLなし)
//  2. プラン算出だけ 60秒TTL (isStale(60_000) → load)。描画系はTTL対象外
//  3. invalidate() 後の get() は null — 「書き込み後は必ず再ロード」の契約
//  4. patchBosses は loadedAt を更新しない — .bosses だけ新しくてもプランTTLは
//     「古い」判定を維持し、プラン算出時に必ず全量を取り直す保険が働く
//  5. load() が reject した場合、既存データは保持される (旧: 代入前に throw と同じ)
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /** @type {{season:Object|null, bosses:Object[], players:Object[]}|null} */
    let data = null;
    let loadedAt = 0;                 // 最終「全量」ロード時刻 (部分patchでは更新しない)
    let loadFn = null;                // テスト用に差し替え可。既定は supabase ローダ (遅延解決)
    let generation = 0;               // 世代番号: load開始/invalidate で進む (Codex監査指摘のレース対策)

    async function doLoad() {
        const fn = loadFn || root.supabaseLoadOpsDashboardData;
        // 世代ガード: 応答待ちの間に invalidate() (書き込み操作) や新しい load() が起きたら、
        // このロードの結果は「古い盤面」なのでストアには保存しない。
        //  - invalidate 後に保存すると、無効化したはずの盤面が復活する
        //  - 並行 load では遅い古の応答が新しい応答を上書きする
        // 旧実装 (_opsDashboardCache = await ...) から存在したレースで、集約を機に修正。
        // 呼び出し元にはフェッチ結果をそのまま返す (その画面の描画には使ってよい —
        // ストアが持つのは常に最新世代だけ、という契約)
        const gen = ++generation;
        const fresh = await fn();     // throw 時は data を触らない (不変条件5)
        if (gen === generation) {
            data = fresh;
            loadedAt = Date.now();
        }
        return fresh;
    }

    const opsStore = {
        /** 現在の盤面 (未ロード/無効化後は null。例外は投げない) */
        get() { return data; },

        /** 強制全量ロード (ops タブ描画・書き込み後の再描画用) */
        async load() { return doLoad(); },

        /** ttlMs より古い/未ロードなら true (プラン算出の鮮度保証用。nowMs はテスト注入用) */
        isStale(ttlMs, nowMs = Date.now()) {
            return !data || (nowMs - loadedAt) > ttlMs;
        },

        /** 書き込み操作後の無効化。次の load() まで get() は null。進行中の load の結果も破棄する */
        invalidate() { generation++; data = null; },

        /**
         * ポーリングの軽量差し替え: シーズンが一致するときだけ bosses を差し替える。
         * loadedAt は意図的に更新しない (不変条件4)。
         * @returns {boolean} 差し替えたか
         */
        patchBosses(seasonId, bosses) {
            if (!data || !data.season || data.season.id !== seasonId) return false;
            data.bosses = bosses;
            return true;
        },

        /**
         * プレイヤー1人の部分更新 (SLv保存の即時反映など)。全量再ロードなし。
         * @returns {boolean} 反映したか (未ロード/該当なしは false)
         */
        patchPlayer(playerId, patch) {
            const p = data && Array.isArray(data.players)
                ? data.players.find(x => x.id === playerId) : null;
            if (!p) return false;
            Object.assign(p, patch);
            return true;
        },

        /** テスト用: ローダ差し替え (null で既定に戻す)。本番コードから呼ばないこと */
        configure({ load } = {}) { loadFn = load || null; },
    };

    root.opsStore = opsStore;
})(typeof window !== 'undefined' ? window : globalThis);
