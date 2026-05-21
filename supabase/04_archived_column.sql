-- ============================================================================
-- Phase 2a 追加分: players.archived カラムを追加
-- ============================================================================
-- 「脱退」を表現するためのフラグ。過去データ(凸履歴等)は CASCADE で消さず、
-- 選択リスト・締め凸候補等から非表示にするだけ。
-- 後から復活させたい場合は archived=FALSE に戻すだけ。
--
-- 適用: Supabase Dashboard → SQL Editor で全文ペーストして Run
-- ============================================================================

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- 既存行は自動的に FALSE (DEFAULTで埋まる)
-- 既存メンバーをすぐ archived にしたい場合は別途 UPDATE で対応
