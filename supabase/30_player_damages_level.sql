-- ============================================================================
-- Phase: 模擬戦のボスレベル対応 (提出スロット 2 → 3 / レベル記録)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
--
-- 何が変わるか:
--   ゲーム側のアップデート (2026-08-10) で模擬戦の練習ボスのレベルを選べるようになった。
--   同じ編成でもボスのレベルが上がると出力は落ちるため、
--   「何Bか」だけでなく「**どのレベルで測ったか**」を持たないと当日の予測がずれる。
--
-- 使い方のルール (ユーザー決定 2026-08-10):
--   記録レベル L の提出は **対象レベル ≤ L** にだけ使う。
--   高難度で出せた出力は低難度なら確実に出せる (下限として保証される) が、
--   逆に Lv1 で測った値を Lv3 に使うと過大評価になりうるため。
--
-- ★ boss_level が NULL = 「レベル未指定」= 従来どおり全レベルで使える。
--   移行のため。既存の提出 (この SQL 適用時点で 235 行) は全部 NULL になる。
--   ここを 1 で埋めてしまうと **Lv2 以降に誰も割り当てられなくなり配信プランが壊れる**
--   ので、DEFAULT は付けない。新規提出だけが明示的なレベルを持つ。
-- ============================================================================

-- ---- スロットを3つに ----
-- 1属性につき3編成まで。同じ編成をレベル違いで出す使い方も想定している
-- (例: ①=Lv4で測った値 / ②=Lv1で測った値 → ソルバーが対象レベルに合う方を使う)。
-- 同一編成はキャラが完全に被るので、当日2凸には**ならない** (既存のキャラ被り判定で弾かれる)。
ALTER TABLE player_damages DROP CONSTRAINT IF EXISTS chk_player_damages_slot;
ALTER TABLE player_damages
    ADD CONSTRAINT chk_player_damages_slot CHECK (slot IN (1, 2, 3));

-- ---- 測定したボスレベル ----
-- 模擬戦で選べるのは Lv1〜Lv4 (本番の Lv4 = ボス5・HP無限 に対応)。
ALTER TABLE player_damages
    ADD COLUMN IF NOT EXISTS boss_level INT;

ALTER TABLE player_damages DROP CONSTRAINT IF EXISTS chk_player_damages_boss_level;
ALTER TABLE player_damages
    ADD CONSTRAINT chk_player_damages_boss_level
    CHECK (boss_level IS NULL OR boss_level BETWEEN 1 AND 4);

COMMENT ON COLUMN player_damages.boss_level IS
    '模擬戦で測定したボスのレベル (1〜4)。NULL = 未指定 = 全レベルで使える (移行互換)。'
    '記録レベル L の行は対象レベル ≤ L にだけ使う。';

NOTIFY pgrst, 'reload schema';
