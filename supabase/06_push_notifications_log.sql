-- ============================================================================
-- Phase: Push通知履歴
-- 運営が送信した Push 通知の本文・送信先・送信時刻を記録し、
-- 受信者があとから「何の通知が来たか」を確認できるようにする
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS push_notifications_log (
    id BIGSERIAL PRIMARY KEY,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT,
    target_kind TEXT NOT NULL DEFAULT 'all',  -- 'all' or 'specific'
    target_player_ids BIGINT[],               -- specific のとき対象 player_id 配列
    sender_player_id BIGINT REFERENCES players(id) ON DELETE SET NULL,
    sent_count INT DEFAULT 0,
    target_count INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_log_sent_at
    ON push_notifications_log (sent_at DESC);

ALTER TABLE push_notifications_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON push_notifications_log;
CREATE POLICY "anon_all" ON push_notifications_log FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON push_notifications_log;
CREATE POLICY "authenticated_all" ON push_notifications_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- スキーマキャッシュ即時反映 (任意 — 自動でもしばらく経てば反映されます)
NOTIFY pgrst, 'reload schema';
