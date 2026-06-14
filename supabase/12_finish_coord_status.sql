-- ============================================================================
-- Phase: finish_coordinations に status 列を追加
-- 「今オンライン (協力可能)」と「私が調整中」を1テーブルで両立させる。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE finish_coordinations
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'coordinating'
    CHECK (status IN ('available', 'coordinating'));

-- 既存データはすべて 'coordinating' (= 過去の挙動と同等) になるので追加処理不要

NOTIFY pgrst, 'reload schema';
