-- ============================================================================
-- Phase: 締め凸調整中アピール機能
-- 「私が今、この属性/ボスの締め凸を調整しています」をリアルタイムに共有
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

-- finish_coordinations: アクティブな調整中宣言 (1メンバー1行)
-- 30分で自動失効 (expires_at で判定、FE側で filter)
CREATE TABLE IF NOT EXISTS finish_coordinations (
    player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    boss_number INT,              -- 任意。ボス番号を指定して「B3 を調整中」と表現
    attribute TEXT CHECK (attribute IS NULL OR attribute IN ('fire','water','electric','iron','wind')),
    note TEXT,                    -- 任意のメモ (例: 「20:00 集合します」)
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finish_coordinations_expires
    ON finish_coordinations(expires_at);

ALTER TABLE finish_coordinations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON finish_coordinations;
CREATE POLICY "anon_all" ON finish_coordinations FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON finish_coordinations;
CREATE POLICY "authenticated_all" ON finish_coordinations FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
