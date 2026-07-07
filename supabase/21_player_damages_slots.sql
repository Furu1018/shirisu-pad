-- ============================================================================
-- Phase: 模擬戦の1属性2編成対応
-- 同属性への2凸 (属性特化・レイド進行上の必要) に備え、player_damages を
-- 1属性につき最大2編成 (slot 1/2) 保存できるようにする。
-- 主キーが (player_id, attribute) → (player_id, attribute, slot) に変わるため、
-- クライアントの upsert onConflict も同時に切り替え済み (フォールバックあり)。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE player_damages
    ADD COLUMN IF NOT EXISTS slot INT NOT NULL DEFAULT 1;

ALTER TABLE player_damages DROP CONSTRAINT IF EXISTS chk_player_damages_slot;
ALTER TABLE player_damages
    ADD CONSTRAINT chk_player_damages_slot CHECK (slot IN (1, 2));

-- 主キー張り替え (既存データは全行 slot=1 なので衝突しない)
ALTER TABLE player_damages DROP CONSTRAINT IF EXISTS player_damages_pkey;
ALTER TABLE player_damages ADD PRIMARY KEY (player_id, attribute, slot);

NOTIFY pgrst, 'reload schema';
