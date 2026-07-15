-- ============================================================================
-- しりすこPAD バックアップ復元ヘルパー
-- ----------------------------------------------------------------------------
-- 復元 (設定タブ → バックアップから復元) は行を明示ID付きで再投入するため、
-- BIGSERIAL の採番シーケンスが古いままになる。放置すると新規メンバー追加や
-- 凸報告の INSERT が重複キーエラーになるため、復元の最後にこの関数を呼んで
-- 各シーケンスを MAX(id)+1 に合わせる。
--
-- 適用方法: Supabase ダッシュボード → SQL Editor でこのファイルを実行
-- ============================================================================

CREATE OR REPLACE FUNCTION restore_fix_sequences()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM setval(pg_get_serial_sequence('players', 'id'),
                   COALESCE((SELECT MAX(id) FROM players), 0) + 1, false);
    PERFORM setval(pg_get_serial_sequence('seasons', 'id'),
                   COALESCE((SELECT MAX(id) FROM seasons), 0) + 1, false);
    PERFORM setval(pg_get_serial_sequence('attacks', 'id'),
                   COALESCE((SELECT MAX(id) FROM attacks), 0) + 1, false);
    PERFORM setval(pg_get_serial_sequence('push_subscriptions', 'id'),
                   COALESCE((SELECT MAX(id) FROM push_subscriptions), 0) + 1, false);
    PERFORM setval(pg_get_serial_sequence('push_notifications_log', 'id'),
                   COALESCE((SELECT MAX(id) FROM push_notifications_log), 0) + 1, false);
END;
$$;

GRANT EXECUTE ON FUNCTION restore_fix_sequences() TO anon, authenticated;
