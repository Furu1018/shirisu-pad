-- ============================================================================
-- Phase: 締め凸依頼のステータス管理
-- ----------------------------------------------------------------------------
-- 運営が締め凸依頼 Push を送った相手と、その返答状況を記録する。
-- ボスごとに「最後に送った依頼バッチ」だけを保持 (再送時は入れ替え)。
--   status: pending(確認中) / accepted(了承) / declined(不可)
--
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS finish_requests (
    id BIGSERIAL PRIMARY KEY,
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    boss_number INT NOT NULL,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_finish_requests_season_boss
    ON finish_requests(season_id, boss_number);

ALTER TABLE finish_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON finish_requests;
CREATE POLICY "anon_all" ON finish_requests FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON finish_requests;
CREATE POLICY "authenticated_all" ON finish_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
