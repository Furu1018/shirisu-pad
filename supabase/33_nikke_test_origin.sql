-- ============================================================================
-- Phase: テストシーズン終了の安全化 (運営改修 #3 — 2026-08-31)
-- nikke_characters に「どのテストシーズン中に OCR 自動学習で作られた行か」を記録する。
-- テスト終了時はこのタグが今回のテストを指す行だけを削除候補 (既定ON) にし、
-- テスト中に運営が手動登録した正規キャラを巻き込まない。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (再実行しても安全)
-- 未適用でも動く: クライアントは列が無ければタグ無しで登録し、終了時の候補は全て既定OFF になる
-- ============================================================================

ALTER TABLE nikke_characters
    ADD COLUMN IF NOT EXISTS created_by_test_season_id BIGINT REFERENCES seasons(id) ON DELETE SET NULL;

-- テスト終了時の候補抽出用 (タグ付き行は少数なので部分インデックス)
CREATE INDEX IF NOT EXISTS idx_nikke_characters_test_origin
    ON nikke_characters(created_by_test_season_id)
    WHERE created_by_test_season_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';   -- API に即認識させる。忘れると列が見えず 400 になる
