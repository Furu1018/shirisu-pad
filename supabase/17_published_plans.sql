-- ============================================================================
-- Phase: 凸プラン配信
-- 運営が算出した最適凸プランを保存し、全メンバーのマイページで閲覧できるようにする
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS published_plans (
    id BIGSERIAL PRIMARY KEY,
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    plan JSONB NOT NULL,                 -- computeOptimalPlanCore の出力をそのまま保存
    published_by BIGINT REFERENCES players(id) ON DELETE SET NULL,
    published_by_name TEXT,              -- 表示用 (players を引かずに出せるよう非正規化)
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_published_plans_season
    ON published_plans(season_id, published_at DESC);

ALTER TABLE published_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON published_plans;
CREATE POLICY "anon_all" ON published_plans FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON published_plans;
CREATE POLICY "authenticated_all" ON published_plans FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
