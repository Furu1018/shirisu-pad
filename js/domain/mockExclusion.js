// ============================================================================
// ドメイン: 模擬提出の運営除外 (35_player_damages_exclusion.sql)
// ----------------------------------------------------------------------------
// メンバーが誤った値・異常値を模擬で提出して放置したとき、運営がその行 (player_id, attribute, slot)
// を「除外」して、プラン算出・締め凸候補・残凸表・事前比較・提出状況から外す (2026-09-05 第44回ハード日の対応)。
//   excluded_at     除外した時刻 (NULL = 通常)
//   excluded_by     除外した運営の表示名
//   excluded_reason 理由 (本人の模擬パネル・編成編集モーダルに表示される)
// ルール:
//   - 行は消さない (本人が確認・修正できるよう残す)。読み取り側で外すだけ
//   - 本人がその行を保存し直す (supabaseSaveMockSubmission / supabaseSavePlayerDamage /
//     supabaseDeleteMockLevel) と除外は自動で解除される = 修正すれば運営の手を煩わせず戻る
//   - 凸報告の焼き戻し (characters だけの更新) では解除しない (値を見直していないため)
//   - 除外の粒度は行 (= 編成)。レベル別測定値の1件だけを除外することはできない
//     (本人が該当レベルの測定を消して保存し直せば解除される)
//   - 35 未適用の環境では列が無い → 読み取りは除外なしに静かに劣化、除外操作だけエラーで適用を案内
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM/Supabase 非依存で node からテスト可:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const COLS = ['excluded_at', 'excluded_by', 'excluded_reason'];
    const REASON_MAX = 80;   // 本人向けの1行表示に収まる長さ
    const BY_MAX = 40;

    /** 行が運営除外されているか (excluded_at があれば true。null / undefined / 空文字は通常) */
    function isExcluded(row) {
        if (!row || typeof row !== 'object') return false;
        const v = row.excluded_at;
        return v != null && v !== '' && v !== false;
    }

    /** 使える行と除外行に分ける (順序は維持) */
    function splitExcluded(rows) {
        const usable = [], excluded = [];
        (Array.isArray(rows) ? rows : []).forEach(r => (isExcluded(r) ? excluded : usable).push(r));
        return { usable, excluded };
    }

    /** 3列だけ落とした複製 (35未適用環境の upsert フォールバック用) */
    function stripExclusion(row) {
        if (!row || typeof row !== 'object') return row;
        const out = { ...row };
        COLS.forEach(c => { delete out[c]; });
        return out;
    }

    /** 解除 = 3列とも NULL に戻す payload (本人の保存し直しで常に同梱する) */
    function clearPatch() {
        return { excluded_at: null, excluded_by: null, excluded_reason: null };
    }

    /**
     * 除外 / 解除の update payload。
     * @param {{excluded:boolean, by?:string, reason?:string, now?:Date|string|number}} o
     */
    function exclusionPatch({ excluded, by, reason, now } = {}) {
        if (!excluded) return clearPatch();
        const r = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
        const b = String(by == null ? '' : by).trim().slice(0, BY_MAX) || '運営';
        const at = now instanceof Date ? now : new Date(now || Date.now());
        return { excluded_at: at.toISOString(), excluded_by: b, excluded_reason: r || null };
    }

    function fmtAt(v) {
        const d = new Date(v);
        if (!Number.isFinite(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 表示用ラベル: 「運営が除外 (理由) — ふるり 9/5 10:12」。通常行は空文字 */
    function exclusionLabel(row) {
        if (!isExcluded(row)) return '';
        const reason = row.excluded_reason ? String(row.excluded_reason).trim() : '';
        const by = row.excluded_by ? String(row.excluded_by).trim() : '';
        const at = fmtAt(row.excluded_at);
        const who = [by, at].filter(Boolean).join(' ');
        return `運営が除外${reason ? ` (${reason})` : ''}${who ? ` — ${who}` : ''}`;
    }

    root.mockExclusionDomain = {
        COLS,
        REASON_MAX,
        isExcluded,
        splitExcluded,
        stripExclusion,
        clearPatch,
        exclusionPatch,
        exclusionLabel,
    };
})(typeof window !== 'undefined' ? window : globalThis);
