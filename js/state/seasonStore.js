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
//  4. invalidate() は進行中の ensure() の結果を破棄し、**最新世代で取り直してから返す**
//     (古いシーズンを呼び出し元に渡さない — 凸書き込みの宛先になるため。
//      opsStore.load() の「スナップショットを返す」契約とは意図的に異なる: あちらの
//      呼び出し元は描画のみで、無効化した側が必ず再描画を呼ぶ定型があるため)
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
    let inflight = null;      // 読み込み中の 1 本 {gen, fn, p}。同じ世代の ensure() はこれを分け合う
    const listeners = [];     // invalidate のたびに呼ぶ (画面側の描画キャッシュ破棄など)

    const seasonStore = {
        /** 現在のキャッシュ (未ロード/無効化後は null。例外は投げない) */
        get() { return data; },

        /**
         * キャッシュがあれば返し、無ければロードする (旧 ensureActiveSeasonLoaded と同一挙動)。
         * 失敗時は {season:null,bosses:[]} をキャッシュ (不変条件1)。ローダ未定義なら null (同2)。
         * 応答待ち中に invalidate されたら、古い結果は呼び出し元にも渡さず**最新世代で取り直す**
         * (Codex レビュー指摘: ensure() の呼び出し元はシーズンIDで凸を書き込むため、
         *  無効化前のシーズンを返すと古いシーズンへの書き込みになり得る)。
         */
        async ensure() {
            // 取り直しは実用上1〜2回で収束する (invalidate はユーザー操作起点)。
            // 上限は無限ループ保険で、超えたら「取得不能」として null (呼び出し側は ?.season ガード済み)
            for (let attempt = 0; attempt < 5; attempt++) {
                if (data) return data;
                const fn = loadFn || root.supabaseLoadActiveSeasonWithBosses;   // 回り直すたびに解決する (差し替え前のローダで読み直さない: Codex 再監査 701b640)
                if (typeof fn !== 'function') return null;
                const gen = generation;
                // ★ 同じ世代の読み込みは 1 本を分け合う (2026-11-13 軽量化)。起動時はホームのカード 10 枚前後が
                //   キャッシュの無いうちに一斉に ensure() を呼び、同じシーズンとボスを 10 回以上読んでいた。
                //   世代が進んだら (invalidate) 古い 1 本は使わず、新しい世代で読み直す (不変条件 4 はそのまま)
                if (!inflight || inflight.gen !== gen || inflight.fn !== fn) {
                    const mine = { gen, fn, p: null };
                    let started;
                    try { started = Promise.resolve(fn()); } catch (e) { started = Promise.reject(e); }   // ローダはその場で呼ぶ (従来と同じ順序)
                    mine.p = started.catch((e) => {
                        if (typeof console !== 'undefined') console.warn('[seasonStore] アクティブシーズン取得失敗:', e);
                        return { season: null, bosses: [] };
                    });
                    // ★ 済んだあとも片付けない: 同じ世代の遅れて来た ensure() (無効化で回り直した人) が、済んだ 1 本の結果を受け取れる。
                    //   片付けると、その人が data の入る直前に来たときにもう 1 本読んでいた。世代が進めば使われない
                    inflight = mine;
                }
                const fresh = await inflight.p;
                if (gen === generation) {
                    if (!data) data = fresh;
                    return data;
                }
                // 世代が進んだ = 応答待ち中に書き込み操作があった → 古い結果は捨てて取り直し
            }
            return null;
        },

        /** 書き込み操作 (凸報告・HP更新・シーズン切替) 後の無効化 */
        /**
         * キャッシュを捨てる。
         * ★ シーズンが変われば**画面に出ているものは全部古い**ので、聞き手 (画面側) にも知らせる。
         *   呼び出し箇所は 14 か所あり、そのたびに画面側の後始末を書き足すのは必ず忘れる
         *   (2026-09-10: シーズンを終了してもホームに予約が残った。終了処理にだけ足しても
         *    作成・テスト作成・テスト終了で同じことが起きる、と Codex に指摘された)
         */
        invalidate() {
            generation++;
            data = null;
            for (const fn of listeners) { try { fn(); } catch { /* 1つ転んでも残りは呼ぶ */ } }
        },
        /** 無効化のたびに呼ばれる。画面側が描画キャッシュを捨てるのに使う。 */
        onInvalidate(fn) { if (typeof fn === 'function') listeners.push(fn); },

        /** ポーリングの軽量差し替え: シーズン一致時のみ bosses を差し替える */
        patchBosses(seasonId, bosses) {
            if (!data || !data.season || data.season.id !== seasonId) return false;
            data.bosses = bosses;
            return true;
        },

        /** テスト用: ローダ差し替え (null で既定に戻す)。本番コードから呼ばないこと */
        //   ★ 世代も進める: 差し替える前のローダで読み込み中だった結果を、差し替えたあとの data に入れない (Codex 監査 c103408)
        configure({ load } = {}) { loadFn = load || null; generation++; },
    };

    root.seasonStore = seasonStore;
})(typeof window !== 'undefined' ? window : globalThis);
