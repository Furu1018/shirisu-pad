-- ============================================================================
-- Phase: 配信プランの「確認しました」
-- メンバーが配信プランを確認したことを記録し、運営が再配信したときに
-- 「プランが更新されました」の案内 + Push通知を出せるようにする
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS plan_acks (
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    plan_id   BIGINT NOT NULL,               -- 確認した published_plans.id
                                             -- ※ FK は張らない: 再配信時に古い行が消えても
                                             --   「誰が追従していたか」を残すため (通知対象の判定に使う)
    acked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (season_id, player_id)       -- 1シーズン1人1行 (最新の確認だけ持つ)
);

CREATE INDEX IF NOT EXISTS idx_plan_acks_season ON plan_acks(season_id);

ALTER TABLE plan_acks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON plan_acks;
CREATE POLICY "anon_all" ON plan_acks FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON plan_acks;
CREATE POLICY "authenticated_all" ON plan_acks FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
