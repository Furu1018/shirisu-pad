-- ============================================================================
-- Phase: 戦闘可能時間の「今季の確認」(2026-09-07)
-- ----------------------------------------------------------------------------
-- 第44回の実害: 「設定しているはずなのに実際にいない人が多い」「本人も自分が
-- 何時に戦闘可能設定にしているか把握できていない」。
--
-- 原因は availability が**無期限のプロフィール設定**であること。シーズンの区別も
-- 確認日時も無く、前月の設定がそのまま残り続ける。
--
--   いつもの生活時間 = availability (これまで通り。次回の初期値として使う)
--   今季の確約       = このテーブル (レイドごとに本人が確認する)
--
-- ★ 時間帯そのものはコピーしない。ここが持つのは「いつ確認したか」と「今回は難しいか」だけ。
--   時間帯を二重に持つと、片方だけ直したときにどちらが正かで必ず揉める。
--   確認済みの人の時間帯は availability を見る (= 確認した時点の内容で確定とみなす)
--
-- ★ 未確認は「空欄」と同じ扱い = **未確定**。運営側は催促の対象にし、
--   締め凸の即時候補には入れない。勝手に「前回のまま有効」とみなさない
--
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS availability_confirmations (
    season_id    BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id    BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 今回は参加が難しい (時間を出せない)。時間帯が空でも「確認はした」と区別するため
    unavailable  BOOLEAN NOT NULL DEFAULT FALSE,
    -- 確認した時点で登録していた時間帯の数。あとから availability を変えたことに気づける
    slot_count   SMALLINT,
    PRIMARY KEY (season_id, player_id)     -- 1シーズン1人1行 (最新の確認だけ持つ)
);

CREATE INDEX IF NOT EXISTS idx_availability_confirmations_season
    ON availability_confirmations(season_id);

ALTER TABLE availability_confirmations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON availability_confirmations;
CREATE POLICY "anon_all" ON availability_confirmations FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON availability_confirmations;
CREATE POLICY "authenticated_all" ON availability_confirmations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ★ 既存シーズンぶんを埋めない。埋めると「本人が確認した」と嘘をつくことになり、
--   このテーブルを作った意味そのものが無くなる (未確認を見つけるのが目的)

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 追補 (2026-09-07): 確認した時点の時間帯そのものを持つ。
-- slot_count (枠数) だけだと h21→h22 の付け替えを見逃し、「確認済み」のままになる。
-- ★ これは**確認時のスナップショット**であって、現在の設定ではない。
--   現在の時間帯は availability が唯一の正 — ここを見て時間帯を決めないこと
-- ----------------------------------------------------------------------------
ALTER TABLE availability_confirmations ADD COLUMN IF NOT EXISTS slots_snapshot TEXT[];

NOTIFY pgrst, 'reload schema';
