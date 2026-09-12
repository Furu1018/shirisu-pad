-- ============================================================================
-- Phase: 👑 運営担当 (2026-09-12 ユーザー決定「ふるり がマスター運営。ふるり だけが運営担当を任命でき、任命された人が運営判定」)
-- ----------------------------------------------------------------------------
-- players.ops_role: 'master' (1人・ふるり) / 'ops' (任命された人) / NULL (メンバー)。
--   master → 🛠 トグルで運営画面とメンバー画面を行き来できる (開発中の確認用)
--   ops    → 名乗った時点で常に運営画面 (トグルは出ない)
--   NULL   → 常にメンバー画面
--   運営あての通知 (予約の申請・取消希望・📣 の返事・締め凸の返事) は master + ops の全員へ届く
-- ★ 認証は無いので、これは**誤操作防止の役割分け**であって認可ではない (RLS anon 全許可・名乗りは自己申告)。
-- ★ master は このマイグレーションが「ふるり」に1回だけ付ける。クライアントは 'ops' と NULL しか書かない。
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (再実行しても壊れない)
-- ============================================================================
SET lock_timeout = '3s';

ALTER TABLE players ADD COLUMN IF NOT EXISTS ops_role TEXT;                  -- 'master' | 'ops' | NULL
ALTER TABLE players ADD COLUMN IF NOT EXISTS ops_appointed_by TEXT;          -- 誰が任命したか (表示用)
ALTER TABLE players ADD COLUMN IF NOT EXISTS ops_appointed_at TIMESTAMPTZ;

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_ops_role_check;
ALTER TABLE players ADD CONSTRAINT players_ops_role_check
    CHECK (ops_role IS NULL OR ops_role IN ('master', 'ops'));

-- マスターは1人だけ (部分一意索引。定数式 (true) の索引は「1行だけ」の常套手段)
CREATE UNIQUE INDEX IF NOT EXISTS uq_players_ops_master ON players((true)) WHERE ops_role = 'master';

-- ふるり をマスターに (まだ誰もマスターでないときだけ・1回だけ)
UPDATE players
   SET ops_role = 'master', ops_appointed_by = 'migration 46', ops_appointed_at = NOW()
 WHERE name = 'ふるり' AND ops_role IS NULL
   AND NOT EXISTS (SELECT 1 FROM players WHERE ops_role = 'master');

NOTIFY pgrst, 'reload schema';
