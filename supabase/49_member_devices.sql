-- ============================================================================
-- Phase: 📱 メンバーの端末の状態 (通知の見える化 D・2026-10-08 ユーザー決定 Q4「今入れる」)
-- ----------------------------------------------------------------------------
-- 「メンバーが端末で通知を設定できているか」はサーバからは見えない (OS の許可は端末の中)。
-- → 本人の端末がアプリを開いたときに、自分の状態を報告する (index.html の _reportMemberDevice)。
--   1 ブラウザ (の localStorage) = 1 行 (同じ端末でも別のブラウザは別の行)。device_id は localStorage の乱数 = 主キー (恒久ではない: サイトデータを消すと
--   新しい行になり、古い行は last_seen_at が止まるだけ)。名乗り直しは同じ device_id の行を上書き
--   (いまの名乗りだけが残る)。書き込みは 1 時間に 1 回まで (内容が変わればすぐ) なので、
--   last_seen_at は「最後に報告した時刻」= 最大 1 時間古い。
-- 運営は メンバー状況 の 🔔 (最後に開いた端末が「拒否」なら 🔔⚠) と「メンバーの通知状況」の 端末 列で
--   許可 / 拒否 / 未設定・最後に開いた日時・アプリの版 を見る。
-- ★ app_build は移行の進み具合の**観測値** (未起動の端末は見えない)。互換ゲートを締める証明にはならない。
-- 設計の正本: docs/通知の見える化_設計案_2026-10-08.md (Codex レビュー済み)
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (何度実行しても安全)
-- 未適用のあいだ: 端末の報告は黙って捨てる (42P01)。運営の画面は端末の情報なしで従来どおり
-- ============================================================================
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS member_devices (
    device_id        TEXT PRIMARY KEY,
    player_id        BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    ua               TEXT,
    push_permission  TEXT NOT NULL DEFAULT 'unknown',
    push_endpoint    TEXT,
    app_build        TEXT,
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reported_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT member_devices_permission_check CHECK (push_permission IN ('granted', 'denied', 'default', 'unsupported', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_member_devices_player ON member_devices(player_id, last_seen_at DESC);

ALTER TABLE member_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON member_devices;
CREATE POLICY "anon_all" ON member_devices FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON member_devices;
CREATE POLICY "authenticated_all" ON member_devices FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
