-- ============================================================================
-- Phase: nikke_characters から base_name カラムを削除
-- 役割が icon_paths[] と aliases[] で完結するため、base_name は不要と判断
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

-- インデックスがあれば先に削除
DROP INDEX IF EXISTS idx_nikke_characters_base;

ALTER TABLE nikke_characters
    DROP COLUMN IF EXISTS base_name;

NOTIFY pgrst, 'reload schema';
