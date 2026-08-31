-- ============================================================================
-- Phase: 手動キャラ登録の二者確認 (運営改修 #6 — 2026-08-31)
-- 運営の手動登録を「要確認」で入れ、登録者とは別の運営が根拠URLを見て確定する。
-- 2026-08-21 に素体ソリン/ブリッドがスキン版と混同されて誤バースト (B1↔B3) で登録され、
-- 誰も検証しないまま GB まで波及したのが動機。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (再実行しても安全)
-- 未適用でも動く: 登録は is_confirmed=false のみで入り (根拠・登録者は保存されない)、
-- 一覧では「⚠未確定」表示になる。確定はチェックボックスで従来どおり可能
-- ============================================================================

ALTER TABLE nikke_characters ADD COLUMN IF NOT EXISTS registered_by       TEXT;         -- 手動登録した運営の表示名
ALTER TABLE nikke_characters ADD COLUMN IF NOT EXISTS verification_source TEXT;         -- 根拠URL (game8 等の個別ページ)
ALTER TABLE nikke_characters ADD COLUMN IF NOT EXISTS verified_by         TEXT;         -- 確定した運営の表示名
ALTER TABLE nikke_characters ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ;  -- 確定日時
-- notes (メモ) は 07_nikke_characters_and_team_links.sql で作成済み

NOTIFY pgrst, 'reload schema';   -- API に即認識させる。忘れると列が見えず 400 になる
