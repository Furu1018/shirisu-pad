-- ============================================================================
-- Phase: ボスHPの鮮度表示
-- bosses に updated_at を追加し、HP が最後に動いた時刻を運営画面に表示できるようにする
-- (最適プラン・締め凸候補は残HP頼みのため「何分前の情報か」の可視化が当日運用に効く)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE bosses
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS trg_bosses_updated_at ON bosses;
CREATE TRIGGER trg_bosses_updated_at
BEFORE UPDATE ON bosses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

NOTIFY pgrst, 'reload schema';
