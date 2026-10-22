-- ============================================================================
-- 🧱 ブロック制 段階 3: 予約をブロックで (2026-10-22 ユーザー決定「予約はブロックだけ選ぶ・時刻は運営がブロックの中で決める」)
-- メンバーの申請は「夕方 (18〜20時) に 風圧PT 編成① で」。時刻 (time_slot) は持たず、ブロックの時 (block_from〜block_to・含む) を持つ。
-- ソルバーは窓の中で、そのボスがいるレベルが開いている最も早い時刻 (本人が出られる時刻を先に) に置く。
-- 既存の予約 (fixed = 時刻 / flex = ⏳隙間) はそのまま。未適用でもアプリは動く (ブロックで申請するときだけ「54 を適用して」と出る)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor でこのファイルを実行 (何度実行しても同じ結果)
-- ============================================================================

-- 1) ブロックの時 (0〜23)。from > to (例: 22〜1 時) もあるので大小は縛らない
ALTER TABLE plan_reservations ADD COLUMN IF NOT EXISTS block_from SMALLINT;
ALTER TABLE plan_reservations ADD COLUMN IF NOT EXISTS block_to SMALLINT;

-- 2) time_mode に 'block' を足す (列の CHECK は既定の名前 plan_reservations_time_mode_check)
ALTER TABLE plan_reservations DROP CONSTRAINT IF EXISTS plan_reservations_time_mode_check;
ALTER TABLE plan_reservations ADD CONSTRAINT plan_reservations_time_mode_check
    CHECK (time_mode IN ('fixed', 'flex', 'block'));

-- 3) 時刻の持ち方を兼用させない (39 の決め): fixed は時刻だけ / flex は何も / block はブロックの時だけ
ALTER TABLE plan_reservations DROP CONSTRAINT IF EXISTS chk_plan_reservations_time;
ALTER TABLE plan_reservations ADD CONSTRAINT chk_plan_reservations_time
    CHECK ((time_mode = 'fixed' AND time_slot ~ '^h(0[0-9]|1[0-9]|2[0-3])$' AND block_from IS NULL AND block_to IS NULL)
        OR (time_mode = 'flex'  AND time_slot IS NULL AND block_from IS NULL AND block_to IS NULL)
        OR (time_mode = 'block' AND time_slot IS NULL AND block_from BETWEEN 0 AND 23 AND block_to BETWEEN 0 AND 23));

-- 4) 承認済みの予約の中身を動かさない (39 の守り) に、ブロックの時も足す
CREATE OR REPLACE FUNCTION plan_reservations_status_via_rpc()
RETURNS TRIGGER AS $$
DECLARE
    v_rpc BOOLEAN := COALESCE(current_setting('app.reservation_rpc', true), '') = 'on';
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_rpc THEN
        RAISE EXCEPTION '予約の状態は reservation_set_status() 経由で変更してください (履歴が残らないため)'
            USING ERRCODE = 'check_violation';
    END IF;
    -- 承認済み以降は約束の中身を動かさない。
    -- ★ 承認の瞬間 (approved への遷移) だけは、RPC が承認時のスナップショットを載せ直せるようにする
    IF OLD.status IN ('approved', 'cancel_requested', 'fulfilled', 'released', 'rejected')
       AND NOT (v_rpc AND OLD.status IN ('requested', 'cancel_requested') AND NEW.status = 'approved') THEN
        IF NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.raid_level IS DISTINCT FROM OLD.raid_level
           OR NEW.boss_number IS DISTINCT FROM OLD.boss_number
           OR NEW.time_mode IS DISTINCT FROM OLD.time_mode
           OR NEW.time_slot IS DISTINCT FROM OLD.time_slot
           OR NEW.block_from IS DISTINCT FROM OLD.block_from
           OR NEW.block_to IS DISTINCT FROM OLD.block_to
           OR NEW.loadout_slot IS DISTINCT FROM OLD.loadout_slot
           OR NEW.characters_snapshot IS DISTINCT FROM OLD.characters_snapshot
           OR NEW.expected_damage_b IS DISTINCT FROM OLD.expected_damage_b THEN
            RAISE EXCEPTION '承認済みの予約の内容 (誰が・レベル・ボス・時刻・編成) は変更できません'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';
