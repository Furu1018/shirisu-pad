-- ============================================================================
-- Phase: ステータスに「practicing (模擬戦挑戦中)」を追加
-- 3状態: available (オンライン協力可能) / practicing (模擬中) / coordinating (戦闘中)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE finish_coordinations
    DROP CONSTRAINT IF EXISTS finish_coordinations_status_check;
ALTER TABLE finish_coordinations
    ADD CONSTRAINT finish_coordinations_status_check
    CHECK (status IN ('available', 'practicing', 'coordinating'));

NOTIFY pgrst, 'reload schema';
