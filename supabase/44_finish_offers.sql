-- ============================================================================
-- Phase: 締め凸の「複数案の同時打診」(2026-09-10)
-- ----------------------------------------------------------------------------
-- 運営ふるりの言葉 (2026-09-10 の聞き取り):
--   「A さんがやってくれると進言してくれても、理想を言えば B+C さんの方がキレイに
--     削りきれるときに、B と C さんどちらかが反応が無いとユニオン全体で進行できなく
--     なる (何もできない時間・返事待ちが生まれる)。結果 A さんには待たせてしまう」
--
-- → 1案ずつ順に打診するのをやめ、**A案と B+C案を同時に、期限つきで**出す。
--   先に全員そろった案で確定し、落ちた案の人には「今回は◯◯さんにお願いしました」を返す。
--
-- 既存の finish_requests に3列足すだけ。**行の意味は変えない**
-- (1行 = 「誰に・どのボスの・どのレベルの締め凸を頼んだか」)。
--
--   offer_id    : 同時に出した1回ぶんの打診をまとめる鍵。同じ回の全行が同じ値
--   plan_key    : その回の中のどの案か ('A' / 'B' …)。NULL = 44 適用前の単独依頼
--   deadline_at : 返事の期限。過ぎたら運営が「返事が無い案」を諦める判断材料にする
--
-- ★ 「どの案で確定したか」は列を足さない。**確定 = 落ちた案の行を declined にする**
--   ことで表せる (status はもう pending/accepted/declined を持っている)。
--   状態を二重に持つと必ず食い違うため。
--
-- ★ 未適用でも壊れない: クライアントは列が無ければ従来どおり「1案だけの依頼」として
--   動く (offer_id / plan_key を送らない)。同時打診の操作だけがエラーで案内を出す。
--
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE finish_requests ADD COLUMN IF NOT EXISTS offer_id TEXT;
ALTER TABLE finish_requests ADD COLUMN IF NOT EXISTS plan_key TEXT;
ALTER TABLE finish_requests ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;

-- 同じ回・同じ案の中で同じ人が2行になっていたら、案の「全員そろったか」が数えられない
CREATE UNIQUE INDEX IF NOT EXISTS uq_finish_requests_offer_plan_player
    ON finish_requests(offer_id, plan_key, player_id)
    WHERE offer_id IS NOT NULL;

-- 打診の回ごとに引く (運営の進捗表示)
CREATE INDEX IF NOT EXISTS idx_finish_requests_offer
    ON finish_requests(offer_id) WHERE offer_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
