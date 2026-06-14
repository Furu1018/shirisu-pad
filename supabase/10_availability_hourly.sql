-- ============================================================================
-- Phase: availability を1時間刻みに移行
-- 旧 CHECK 制約 (morning/noon/evening/night/latenight) を撤去し、
-- hXX (h00〜h23) 形式に許可。既存データは hXX 配列に展開して挿入し直す。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

BEGIN;

-- 1) 既存の旧キーを新キーに変換した中間テーブルを作る
CREATE TEMP TABLE _avail_expanded AS
SELECT player_id, slot::text AS time_slot
FROM availability,
LATERAL (
    SELECT unnest(
        CASE time_slot
            WHEN 'morning'   THEN ARRAY['h05','h06','h07','h08']
            WHEN 'noon'      THEN ARRAY['h09','h10','h11','h12','h13']
            WHEN 'evening'   THEN ARRAY['h14','h15','h16','h17']
            WHEN 'night'     THEN ARRAY['h18','h19','h20','h21','h22','h23']
            WHEN 'latenight' THEN ARRAY['h00','h01','h02','h03','h04']
            -- 既に hXX なら自身をそのまま返す
            ELSE ARRAY[time_slot]
        END
    ) AS slot
) AS expansion;

-- 2) 旧テーブルを空にして CHECK 制約を張り替え
DELETE FROM availability;
ALTER TABLE availability
    DROP CONSTRAINT IF EXISTS availability_time_slot_check;
ALTER TABLE availability
    ADD CONSTRAINT availability_time_slot_check
    CHECK (time_slot ~ '^h(0[0-9]|1[0-9]|2[0-3])$');

-- 3) 展開済みデータを再挿入 (重複は無視)
INSERT INTO availability (player_id, time_slot)
SELECT player_id, time_slot FROM _avail_expanded
ON CONFLICT (player_id, time_slot) DO NOTHING;

DROP TABLE _avail_expanded;

-- 4) PostgREST スキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';

COMMIT;
