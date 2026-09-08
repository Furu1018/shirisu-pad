-- ============================================================================
-- Phase: 予約から「レベル」を外す (L2 / 2026-09-08 ユーザー決定)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
-- 前提: supabase/39_plan_reservations.sql (再実行済みのもの)
--
-- なぜ変えるか:
--   ボスはすべてのレベルで共通で、レベルで変わるのは HP だけ。
--   メンバーの約束は「この時刻に・この弱点のボスを・この編成で」であって、レベルは本人が
--   選ぶものではない。レベルを本人に選ばせると
--     「どう計算しても13時に Lv3 へ届かないのに 10時に Lv3 のボスを予約」
--   のように、計画が破綻するだけの予約が作れてしまう (2026-09-07 深夜の実機テストで発覚)。
--   レベルを外せば、10時にそのボスがどのレベルにいても予約は成立し、
--   どのレベルに置くかはソルバーが時間軸から決める。
--
-- 何を変えるか:
--   1. 生きている予約の一意性を「誰が・レベル・ボス・編成枠」→「誰が・ボス・編成枠」に。
--      同じカード (編成) は1日1回しか使えないので、レベル違いの二重予約はそもそも意味がない
--   2. raid_level を NULL 可に (メンバー発の予約は NULL。締め凸依頼の了承だけ運営がレベル付きで作る)
--
-- ★ 順序が要点 (Codex指摘 2026-09-08): **新しい索引を先に作り、古い索引を落とし、最後に NULL 可にする**。
--   先に NULL 可にしてから索引を張り替えると、その間に入った NULL レベルの重複が新索引の作成を
--   失敗させ、しかも古い索引はもう無い = 一意性が守られない窓が開く。
--   この順なら、途中で失敗しても古い索引が残っていて (NULL はまだ入れないので) 何も壊れず、そのまま再実行できる。
--
-- ⚠ 生きている予約に「同じ人・同じボス・同じ編成枠」の重複があると新索引を作れない。
--   その場合は最初の検査で止まり、どの予約かを表示する。運営が画面で片方を解除してから再実行する
--   (状態の変更は RPC 経由に縛ってあるので、この SQL からは触らない)
-- ============================================================================

SET lock_timeout = '3s';

-- 1) 重複を検査して、あれば分かる形で止める
DO $$
DECLARE
    v_dup TEXT;
BEGIN
    SELECT string_agg(format('player=%s boss=%s slot=%s (ids %s)', player_id, boss_number, loadout_slot, ids), ' / ')
      INTO v_dup
      FROM (
          SELECT player_id, boss_number, loadout_slot, string_agg(id::text, ',') AS ids
            FROM plan_reservations
           WHERE status IN ('requested', 'approved', 'cancel_requested')
           GROUP BY season_id, player_id, boss_number, loadout_slot
          HAVING COUNT(*) > 1
      ) d;
    IF v_dup IS NOT NULL THEN
        RAISE EXCEPTION '同じ人・同じボス・同じ編成枠の生きている予約が重複しています。運営画面で片方を解除してから再実行してください: %', v_dup
            USING ERRCODE = 'check_violation';
    END IF;
END $$;

-- 2) 新しい索引を先に作る (重複が同時に入っていればここで失敗し、古い索引は残る = 再実行できる)
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_reservations_active_card
    ON plan_reservations(season_id, player_id, boss_number, loadout_slot)
    WHERE status IN ('requested', 'approved', 'cancel_requested');

-- 3) 古い索引を落とす
DROP INDEX IF EXISTS uq_plan_reservations_active;

-- 4) 最後にレベルを任意に。CHECK (BETWEEN 1 AND 4) は NULL を通すのでそのまま
ALTER TABLE plan_reservations ALTER COLUMN raid_level DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
