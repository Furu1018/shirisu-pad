-- ============================================================================
-- Phase: 締め凸依頼を「そのレベルのそのボスへの依頼」にする (2026-09-06)
-- ----------------------------------------------------------------------------
-- 第44回で「依頼中」「了承済み」がシーズン中ずっと残り、次のレベルの依頼と
-- 見分けがつかなくなった。依頼にレイドレベルを持たせ、そのレベルのボスが倒れたら
-- (またはレベルが上がったら) 有効な依頼から外せるようにする。
--
--   raid_level: 依頼を出したときのレイドレベル (1〜4)。
--               NULL = レベルを持たない旧データ (36 適用前の依頼)
--
-- ★ 撃破・レベル進行での削除はクライアント側 (_checkRaidEvents 起点 + 取得時の
--   有効条件) が行う。**履歴は残さない** — 残すと次のレベルの依頼と混同するため
--   (ユーザー決定 2026-09-06)。代わりに activity_log へ「誰の依頼をなぜ消したか」を書く
--   (順序は 確定 → 削除 → 実際に消せたときだけログ → 通知)
--
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

ALTER TABLE finish_requests ADD COLUMN IF NOT EXISTS raid_level SMALLINT;

-- 1〜4 だけを許す (NULL = 旧データは許容)。再実行できるよう作り直す
ALTER TABLE finish_requests DROP CONSTRAINT IF EXISTS finish_requests_raid_level_check;
ALTER TABLE finish_requests ADD CONSTRAINT finish_requests_raid_level_check
    CHECK (raid_level IS NULL OR (raid_level BETWEEN 1 AND 4));

-- 「いま有効な依頼」の引き方に合わせた索引 (シーズン + レベル + ボス)
CREATE INDEX IF NOT EXISTS idx_finish_requests_season_level_boss
    ON finish_requests(season_id, raid_level, boss_number);

-- ★ 既存行の raid_level は **NULL のままにする**。
--   いま何レベルで出された依頼か分からないものを現在のレベルで埋めると、
--   撃破時に「消してはいけない依頼」を消す/「消すべき依頼」が残る の両方が起こる。
--   クライアントは NULL を「レベル不明 = 現在のレベルの依頼として扱わない」で処理する

NOTIFY pgrst, 'reload schema';
