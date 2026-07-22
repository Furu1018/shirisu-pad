// ============================================================================
// 状態ストア: アクティブシーズン + ボス5体 (リアーキ ステップ3の宿題 — 二重キャッシュ解消)
// ----------------------------------------------------------------------------
// 旧 `_activeSeasonCache` (index.html に28箇所散在) を置換する単一ストア。
// opsStore ({season,bosses,players} = 運営用の重い盤面) とは意図的に別持ち:
// こちらは {season,bosses} だけの軽量キャッシュで、マイページの凸報告・戦闘準備・
// 配信プラン等が高頻度に読む。無効化の連動は呼び出し側の責務のまま
// (ボスHP/凸が動く操作 = 両方無効化 / マイページの模擬・編成編集 = こちらは温存)。
//
// 旧実装から引き継ぐ不変条件:
//  1. ensure() は「キャッシュがあれば返す・無ければロード」。取得失敗時は
//     {season:null, bosses:[]} を**キャッシュして**返す (次の invalidate まで再試行しない)
//  2. supabase モジュール未ロード (関数未定義) のときは null を返し、キャッシュしない
//  3. ポーリングの patchBosses はシーズン一致時のみ・部分差し替え
//  4. invalidate() は進行中の ensure() の結果も破棄する (opsStore と同じ世代ガード)
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /** @type {{season:Object|null, bosses:Object[]}|null} */
    let data = null;
    let loadFn = null;        // テスト用差し替え。既定は supabaseLoadActiveSeasonWithBosses (遅延解決)
    let generation = 0;       // 世代番号: invalidate で進む (進行中ロードの結果を破棄)

    const seasonStore = {
        /** 現在のキャッシュ (未ロード/無効化後は null。例外は投げない) */
        get() { return data; },

        /**
         * キャッシュがあれば返し、無ければロードする (旧 ensureActiveSeasonLoaded と同一挙動)。
         * 失敗時は {season:null,bosses:[]} をキャッシュ (不変条件1)。ローダ未定義なら null (同2)。
         */
        async ensure() {
            if (data) return data;
            const fn = loadFn || root.supabaseLoadActiveSeasonWithBosses;
            if (typeof fn !== 'function') return null;
            const gen = generation;
            let fresh;
            try {
                fresh = await fn();
            } catch (e) {
                if (typeof console !== 'undefined') console.warn('[seasonStore] アクティブシーズン取得失敗:', e);
                fresh = { season: null, bosses: [] };
            }
            // 応答待ち中に invalidate された場合は保存しない (無効化済みシーズンの復活防止)
            if (gen === generation && !data) data = fresh;
            return data || fresh;
        },

        /** 書き込み操作 (凸報告・HP更新・シーズン切替) 後の無効化 */
        invalidate() { generation++; data = null; },

        /** ポーリングの軽量差し替え: シーズン一致時のみ bosses を差し替える */
        patchBosses(seasonId, bosses) {
            if (!data || !data.season || data.season.id !== seasonId) return false;
            data.bosses = bosses;
            return true;
        },

        /** テスト用: ローダ差し替え (null で既定に戻す)。本番コードから呼ばないこと */
        configure({ load } = {}) { loadFn = load || null; },
    };

    root.seasonStore = seasonStore;
})(typeof window !== 'undefined' ? window : globalThis);
