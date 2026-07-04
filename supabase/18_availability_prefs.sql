-- ============================================================================
-- Phase: 戦闘可能時間の運用オプション
-- ----------------------------------------------------------------------------
-- flex_time        : ⏳ 隙間時間型。当日いつ動けるか読めないが3凸はする人。
--                    凸プランではボス割当のみ行い、時間帯は固定しない (律速にもしない)。
-- notify_all_hours : 🔔 通知はいつでも受け取る。戦闘可能時間外でも
--                    締め凸候補などの狙い撃ち通知の対象に含める。
--
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE players ADD COLUMN IF NOT EXISTS flex_time        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS notify_all_hours BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
