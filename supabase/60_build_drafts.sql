-- ============================================================================
-- 📝 🧱 組む の下書きの共有 + だれがどのブロックを開いているか (2026-11-27 ふるり「② 必要」・見本 88yepqLS55WK18h7j37nwi ②)
-- ----------------------------------------------------------------------------
-- 🧮「残りを自動で組む」の結果は ✅ 決定するまでその端末の中だけだった (手で置いた駒は plan_reservations にあるので 10 秒でほかの運営に届く)。
-- → 自分の 🧮 の結果を下書きとして置き、ほかの運営の 🧱 組む に「取り込む」を出す。2 人で同じブロックを組まないよう、開いているブロックの札 (👤) も出す。
--   1 行 = (シーズン, 運営, 種類)。書くのはアプリの upsert だけ (index.html の _obDraftPush / _obPeersTick)。
--   kind 'draft' = 🧮 で組んだ結果 (payload = { plans: { <ブロックの添字>: 組んだプラン }, skip: { <添字>: [外した駒の鍵] }, at, by })
--   kind 'open'  = いま 🧱 組む で開いているブロック (payload = { idx, at }・20 秒ごとに書き直す。45 秒より古い行は閉じたとみなす)
-- ★ 下書きは「見せるだけ」— 取り込むまでほかの運営の画面は何も変わらない。決定 (published_plans) とは別 (メンバーには何も届かない)
-- ★ シーズン・運営を消すと一緒に消える (CASCADE)。表の写しは練習の偽のサーバ (js/practice/server.js) にもある
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (何度実行しても安全)
-- 未適用のあいだ: 下書きも札も出ない (読み出しが null = 分からない)。🧱 組む はいまのまま動く
-- ============================================================================
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS build_drafts (
    season_id   BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id   BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    kind        TEXT   NOT NULL,
    payload     JSONB  NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (season_id, player_id, kind),
    CONSTRAINT build_drafts_kind_check CHECK (kind IN ('draft', 'open'))
);

ALTER TABLE build_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON build_drafts;
CREATE POLICY "anon_all" ON build_drafts FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON build_drafts;
CREATE POLICY "authenticated_all" ON build_drafts FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
