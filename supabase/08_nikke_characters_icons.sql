-- ============================================================================
-- Phase: NIKKE キャラクターマスタにアイコン画像対応
-- スキン違いは同一エントリで複数アイコンを保持できるよう icon_paths を配列で。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE nikke_characters
    ADD COLUMN IF NOT EXISTS icon_paths TEXT[] NOT NULL DEFAULT '{}';

-- 画像パス完全一致での逆引き検索を高速化 (GIN index)
CREATE INDEX IF NOT EXISTS idx_nikke_characters_icon_paths
    ON nikke_characters USING GIN (icon_paths);

NOTIFY pgrst, 'reload schema';
