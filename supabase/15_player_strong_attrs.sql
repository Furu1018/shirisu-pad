-- ============================================================================
-- Phase: メンバー 得意属性 対応
-- 各プレイヤーが「得意とする属性」を 0〜5 個選択して登録できる。
-- マイページで設定、メンバー一覧などで他メンバーから一目で確認できる。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS strong_attributes TEXT[] NOT NULL DEFAULT '{}';

-- CHECK 制約: 配列の各要素は 5属性のいずれか
-- (PostgreSQL は配列要素レベルの CHECK は素直に書けないので、配列全体を集合と見なす方針で記述)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'players_strong_attrs_valid'
    ) THEN
        ALTER TABLE players
            ADD CONSTRAINT players_strong_attrs_valid
            CHECK (strong_attributes <@ ARRAY['fire','water','electric','iron','wind']::TEXT[]);
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
