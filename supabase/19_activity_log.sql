-- ============================================================================
-- Phase: アクティビティログ
-- 模擬戦提出 / 凸報告 / 代理凸 / 通知ON・OFF / 戦闘可能時間変更 / 運営操作 を
-- INSERT 専用で記録し、設定タブで種別・人別にフィルタして閲覧できるようにする。
-- (player_damages 等は upsert で履歴が消えるため、導出フィードでは代替できない)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,     -- attack | proxy_attack | mock_submit | notify_on | notify_off | avail_change | ops
    player_id BIGINT REFERENCES players(id) ON DELETE SET NULL,   -- 対象プレイヤー (居ない操作は NULL)
    player_name TEXT,             -- 表示用フォールバック (players が消えても読めるよう非正規化)
    actor_name TEXT,              -- 操作した人 (代理凸・運営操作のとき)
    detail TEXT NOT NULL,         -- 表示文
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activity_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_player ON activity_log(player_id, created_at DESC);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON activity_log;
CREATE POLICY "anon_all" ON activity_log FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON activity_log;
CREATE POLICY "authenticated_all" ON activity_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
