// ============================================================================
// ドメイン: テストシーズン終了時のキャラマスタ整理 (運営改修 #3 — 2026-08-31)
// ----------------------------------------------------------------------------
// 旧仕様は「テスト作成時のスナップショットに無い名前を全部削除」だった。テスト中に
// 運営が正規に手動登録した新キャラ (2026-08-20 のペルソナ3体 + 素体2体) まで巻き込むため、
// 終了前に候補を分類して運営に見せ、削除は明示的に選ばれた行だけにする。
//
// 分類ルール (消し過ぎない側に倒す):
//   - スナップショットにある名前          → 候補にしない (テスト前から居た)
//   - created_by_test_season_id == 今回   → 'test'   既定ON  (テスト中の OCR 自動学習)
//   - created_by_test_season_id が別の値  → 'other-test' 既定OFF (要確認)
//   - タグ無し・観測0・確定               → 'manual' 既定OFF (運営の手動登録)
//   - タグ無し・観測>0・未確定            → 'ocr'    既定OFF (33適用前の自動学習。由来不明)
//   - それ以外                            → 'unknown' 既定OFF
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {Object} CharRow  nikke_characters の行 (必要な列だけ)
     * @property {string} canonical_name
     * @property {number=} sighting_count
     * @property {boolean=} is_confirmed
     * @property {number|null=} created_by_test_season_id  33_nikke_test_origin 未適用環境では undefined
     */

    /**
     * テスト終了で削除候補になるキャラを分類する。
     * @param {{snapshotNames?: string[]|null, currentRows?: CharRow[]|null, testSeasonId?: number|null}} args
     * @returns {{canonical_name:string, origin:string, defaultDelete:boolean, reason:string, sighting_count:number, is_confirmed:boolean}[]}
     *   既定ON (defaultDelete=true) を先頭に、以降は名前順
     */
    function classifyTestSeasonChars({ snapshotNames, currentRows, testSeasonId } = {}) {
        const snap = new Set(Array.isArray(snapshotNames) ? snapshotNames : []);
        const sid = (testSeasonId == null || testSeasonId === '') ? null : Number(testSeasonId);
        const out = [];
        for (const r of (Array.isArray(currentRows) ? currentRows : [])) {
            const name = r && typeof r.canonical_name === 'string' ? r.canonical_name : null;
            if (!name || snap.has(name)) continue;
            const tag = (r.created_by_test_season_id == null) ? null : Number(r.created_by_test_season_id);
            const seen = Number(r.sighting_count) || 0;
            const confirmed = !!r.is_confirmed;
            let origin, defaultDelete, reason;
            if (tag != null && sid != null && tag === sid) {
                origin = 'test'; defaultDelete = true;
                reason = `テスト中に自動学習 (観測${seen}回)`;
            } else if (tag != null) {
                origin = 'other-test'; defaultDelete = false;
                reason = `別のテスト (#${tag}) 由来 — 要確認`;
            } else if (seen === 0 && confirmed) {
                origin = 'manual'; defaultDelete = false;
                reason = '運営の手動登録 (観測0・確定) — 残す';
            } else if (seen > 0 && !confirmed) {
                origin = 'ocr'; defaultDelete = false;
                reason = `自動学習 (観測${seen}回・未確定) — 由来不明のため既定は残す`;
            } else {
                origin = 'unknown'; defaultDelete = false;
                reason = `観測${seen}回・${confirmed ? '確定' : '未確定'} — 既定は残す`;
            }
            out.push({ canonical_name: name, origin, defaultDelete, reason, sighting_count: seen, is_confirmed: confirmed });
        }
        out.sort((a, b) => (Number(b.defaultDelete) - Number(a.defaultDelete)) || a.canonical_name.localeCompare(b.canonical_name, 'ja'));
        return out;
    }

    /**
     * 実際に削除してよい名前だけに絞る (安全弁)。
     * スナップショットに含まれる名前・文字列でないもの・重複を落とす。
     * @param {string[]|null|undefined} requested  運営が選んだ名前
     * @param {string[]|null|undefined} snapshotNames
     */
    function filterDeletableChars(requested, snapshotNames) {
        const snap = new Set(Array.isArray(snapshotNames) ? snapshotNames : []);
        const seen = new Set();
        const out = [];
        for (const n of (Array.isArray(requested) ? requested : [])) {
            if (typeof n !== 'string' || !n || snap.has(n) || seen.has(n)) continue;
            seen.add(n); out.push(n);
        }
        return out;
    }

    root.testSeasonDomain = { classifyTestSeasonChars, filterDeletableChars };
})(typeof window !== 'undefined' ? window : globalThis);
