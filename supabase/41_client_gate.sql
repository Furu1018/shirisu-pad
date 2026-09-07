-- ============================================================================
-- Phase: 互換ゲート (L2 ⑦ — 2026-09-07)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
--
-- 何のためのものか:
--   予約 (39/40) が入ると「予約を知らないクライアント」が事故を起こす。
--   古いアプリは ①予約を無視したプランを表示し ②凸を直に insert して予約を消し込まず
--   ③配信し直して予約入りのプランを上書きする。どれも「約束を守る」仕組みを内側から壊す。
--
--   ★ **配信JSONに版を入れるだけでは効かない**。古いクライアントはその版を読まないため。
--     先にゲートを配り、行き渡ってから予約入りの配信を始める (2段階リリース)。
--
--   min_client_build : これ未満のクライアントは プラン表示・凸報告・配信 を止める
--   min_plan_schema  : これ未満の版しか読めないクライアントは配信プランを表示しない
--
-- ★ 初期値は **0 = 誰も止めない**。ゲートを配る回のリリースで締めてはいけない —
--   その時点ではまだ全員が新クライアントを取得できていないので、締めると
--   「更新してください」と出たまま更新経路が無い人が出る。
--   全員に行き渡ったことを確認してから、運営が値を上げる。
--
-- ★ ゲートが読めないときは **通す** (fail-open)。ここを fail-closed にすると、
--   一時的な通信断でユニオン全員のアプリが使えなくなる。ゲートは事故防止であって
--   認可ではない (RLS は anon 全許可という設計判断のまま)。
--
-- 未適用の環境: ゲートが無い = 誰も止めない。クライアントは静かに素通りする
-- ============================================================================

SET lock_timeout = '3s';

-- 1行だけ持つ設定表 (id = 1 に固定。複数行を作らせない)
CREATE TABLE IF NOT EXISTS app_gate (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- クライアントの版。index.html の CLIENT_BUILD と比べる (YYYYMMDDnn の整数)
    min_client_build BIGINT NOT NULL DEFAULT 0 CHECK (min_client_build >= 0),
    -- 配信プランの版。plan.schema と比べる
    min_plan_schema  INT NOT NULL DEFAULT 0 CHECK (min_plan_schema >= 0),
    -- 止めるときに出す一言 (空なら既定の文面)
    message TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 既定行。★ ON CONFLICT DO NOTHING なので、再実行しても運営が上げた値を戻さない
INSERT INTO app_gate (id, min_client_build, min_plan_schema)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE app_gate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON app_gate;
CREATE POLICY "anon_all" ON app_gate FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON app_gate;
CREATE POLICY "authenticated_all" ON app_gate FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 配信プランの版。読むだけのクライアントが「この配信は自分には新しすぎる」と判断できるようにする。
-- ★ 既存行は NULL のまま = 版を持たない旧配信。クライアントは NULL を 0 として扱う
ALTER TABLE published_plans ADD COLUMN IF NOT EXISTS plan_schema INT;

NOTIFY pgrst, 'reload schema';   -- API に即認識させる (忘れると 404 になる)
