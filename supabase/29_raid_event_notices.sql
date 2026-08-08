-- ============================================================================
-- Phase: 戦況の通知 (ボス撃破 / レベル開放) の二重送信よけ
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
--
-- なぜ要るか:
--   残HPを 0 にする経路は1つではない (凸報告の自動減算 / OCR適用 / 代理凸 /
--   凸ダメージの編集 / 運営の単体HP保存・一括保存・ボス概要編集 / テストシード)。
--   書き込み側を全部フックするのは漏れるし、同時報告では両方が「自分が撃破した」と
--   判定して二重に通知してしまう。
--   そこで「誰が気づいたか」ではなく **「まだ通知していないか」を DB の一意制約で確保する**。
--   気づいたクライアントが INSERT を試み、成功した1人だけが送信する。
--   これなら書き込み経路が増えても通知ロジックを直す必要がない。
-- ============================================================================

CREATE TABLE IF NOT EXISTS raid_event_notices (
    season_id   BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    kind        TEXT   NOT NULL,          -- 'boss_defeated' | 'level_open'
    ref         TEXT   NOT NULL,          -- 撃破: 'L2B3' (レベル+ボス) / 開放: 'L2'
    notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notified_by BIGINT REFERENCES players(id) ON DELETE SET NULL,
    PRIMARY KEY (season_id, kind, ref)    -- ★ これが二重送信よけの本体
);

ALTER TABLE raid_event_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON raid_event_notices;
CREATE POLICY "anon_all" ON raid_event_notices FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON raid_event_notices;
CREATE POLICY "authenticated_all" ON raid_event_notices FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
