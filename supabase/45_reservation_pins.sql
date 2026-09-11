-- ============================================================================
-- Phase: 📌 運営の固定 (パズル盤 ③④・2026-09-11 ユーザー決定「ピンは運営の下書き」)
-- ----------------------------------------------------------------------------
-- 運営が時間割の上 (または 🧩模擬ピース から) に「この人を この時刻・このボスに」と置く**下書き**。
--   status = 'pinned'。ソルバーは approved と同じく先に置いて残りを組む。
--   本人には届かない — 「📣 お願いする」で asked_at が入ったときだけ本人のホームに出る。
--   本人が引き受けると approved (約束・🔒)、難しければ released (member_declined)。運営が外せば released (ops)。
--
-- ★ 残凸の枠には**数えない**: 容量トリガ (39) / 部分一意索引 (42) / 凸報告 RPC (40) は
--   従来の集合 ('requested','approved','cancel_requested') のまま。約束ではない下書きが
--   本人の実凸や申請を塞いではいけない (第45回の趣旨「約束を運営の手で増やさない」)。
--   JS 側の ACTIVE も同じ集合のまま (tests/run-tests.mjs が突き合わせる)。
-- ★ 状態遷移は reservation_set_status に集約 (履歴が残る)。pinned → approved | released だけ。
--   pinned の行はまだ約束ではないので、ボス・時刻・編成の直接更新 (置き直し) と asked_at の更新は
--   39 の守り (承認済み以降の内容変更禁止) の対象外 = そのまま UPDATE できる。
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (再実行しても壊れない)
-- ============================================================================
SET lock_timeout = '3s';

ALTER TABLE plan_reservations ADD COLUMN IF NOT EXISTS pinned_by TEXT;              -- 置いた運営
ALTER TABLE plan_reservations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE plan_reservations ADD COLUMN IF NOT EXISTS asked_at TIMESTAMPTZ;        -- 📣 お願いした時刻 (NULL = まだ下書き)
ALTER TABLE plan_reservations ADD COLUMN IF NOT EXISTS ask_deadline_at TIMESTAMPTZ; -- 返事の期限 (表示だけ。過ぎても自動で外さない)

-- 状態に pinned を足す (JS の STATUS と同じ集合にすること)
ALTER TABLE plan_reservations DROP CONSTRAINT IF EXISTS plan_reservations_status_check;
ALTER TABLE plan_reservations ADD CONSTRAINT plan_reservations_status_check
    CHECK (status IN ('requested', 'approved', 'cancel_requested', 'fulfilled', 'released', 'rejected', 'pinned'));

-- 遷移表に pinned を足す。★ JS の TRANSITIONS と**同じ表**にすること (片方だけ変えると画面では押せるのにサーバで弾かれる)
CREATE OR REPLACE FUNCTION reservation_set_status(
    p_id BIGINT,
    p_to TEXT,
    p_expect_from TEXT DEFAULT NULL,   -- ★ 実際には必須 (NULL は下で弾く。既存呼び出しの互換のため既定値は残す)
    p_actor TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_plan_id BIGINT DEFAULT NULL,
    p_characters JSONB DEFAULT NULL,
    p_expected_b NUMERIC DEFAULT NULL
) RETURNS plan_reservations AS $$
DECLARE
    v_row plan_reservations;
    v_from TEXT;
BEGIN
    SELECT * INTO v_row FROM plan_reservations WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '予約が見つかりません (id=%)', p_id USING ERRCODE = 'no_data_found';
    END IF;
    v_from := v_row.status;
    IF p_expect_from IS NULL OR p_expect_from = '' THEN
        RAISE EXCEPTION '期待する現在の状態 (p_expect_from) は必須です' USING ERRCODE = 'check_violation';
    END IF;
    IF v_from <> p_expect_from THEN
        RAISE EXCEPTION '予約の状態が変わっています (いま % / 期待 %)', v_from, p_expect_from
            USING ERRCODE = 'serialization_failure';
    END IF;
    -- 許可する遷移だけを通す。終端 (fulfilled/released/rejected) からは動かさない
    IF NOT (
        (v_from = 'requested'        AND p_to IN ('approved', 'rejected', 'cancel_requested'))
     OR (v_from = 'approved'         AND p_to IN ('cancel_requested', 'fulfilled', 'released'))
     OR (v_from = 'cancel_requested' AND p_to IN ('released', 'approved'))
     OR (v_from = 'pinned'           AND p_to IN ('approved', 'released'))
    ) THEN
        RAISE EXCEPTION '許可されていない状態遷移です (% → %)', v_from, p_to USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('app.reservation_rpc', 'on', true);
    UPDATE plan_reservations SET
        status = p_to,
        characters_snapshot = CASE WHEN p_to = 'approved' AND p_characters IS NOT NULL
                                   THEN p_characters ELSE characters_snapshot END,
        expected_damage_b   = CASE WHEN p_to = 'approved' AND p_expected_b IS NOT NULL
                                   THEN p_expected_b ELSE expected_damage_b END,
        approved_by   = CASE WHEN p_to = 'approved' THEN COALESCE(p_actor, approved_by) ELSE approved_by END,
        approved_at   = CASE WHEN p_to = 'approved' AND approved_at IS NULL THEN NOW() ELSE approved_at END,
        approved_plan_id = COALESCE(p_plan_id, approved_plan_id),
        released_by   = CASE WHEN p_to IN ('released', 'rejected') THEN p_actor ELSE released_by END,
        released_at   = CASE WHEN p_to IN ('released', 'rejected') THEN NOW() ELSE released_at END,
        release_reason = CASE WHEN p_to IN ('released', 'rejected', 'fulfilled') THEN COALESCE(p_reason, release_reason) ELSE release_reason END,
        updated_at = NOW()
    WHERE id = p_id
    RETURNING * INTO v_row;

    INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
    VALUES (p_id, v_from, p_to, p_actor, p_reason);

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ★ 📌 の上限と重複は DB でも守る (Codex指摘 2026-09-11): 複数の運営が同時に同じ人へ置くと、
--   画面側の canPin (押した時点の DB で数えるだけ) は破れる。残凸の枠 (39 の容量トリガ) は pinned を数えない設計のままにし、
--   **pinned の行だけ**を見る別のトリガで「約束 + 固定 + 実凸 ≤ 3」を守る (JS の canPin と同じ式)。
--   鍵は 39 / 40 と同一 (同じ人の予約・固定・実凸を1本に直列化する)
-- ★ 索引を作る前に、すでにある同じカードの重複 📌 を片づける (Codex再指摘): 索引の無い版の 45 を先に流した環境で
--   重複が入っていると CREATE UNIQUE INDEX で止まり、後ろのトリガまで作られない。新しい方 (id 大) を残し、古い方は
--   released (superseded) にして履歴も残す。状態の直接更新は 39 の守りが弾くので、RPC と同じく自分を名乗ってから更新する
DO $$
DECLARE
    r RECORD;
BEGIN
    PERFORM set_config('app.reservation_rpc', 'on', true);
    FOR r IN
        SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY season_id, player_id, boss_number, loadout_slot ORDER BY id DESC) AS rn
              FROM plan_reservations WHERE status = 'pinned'
        ) d WHERE rn > 1
    LOOP
        UPDATE plan_reservations
           SET status = 'released', released_by = 'migration 45', released_at = NOW(), release_reason = 'superseded', updated_at = NOW()
         WHERE id = r.id;
        INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
        VALUES (r.id, 'pinned', 'released', 'migration 45', 'superseded');
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_reservations_pin_card
    ON plan_reservations(season_id, player_id, boss_number, loadout_slot) WHERE status = 'pinned';

CREATE OR REPLACE FUNCTION plan_reservations_pin_check()
RETURNS TRIGGER AS $$
DECLARE
    v_hard_date DATE;
    v_held INT;
    v_done INT;
BEGIN
    IF NEW.status <> 'pinned' THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('attack:' || NEW.season_id || ':' || NEW.player_id, 0));
    SELECT hard_date INTO v_hard_date FROM seasons WHERE id = NEW.season_id;
    -- 約束 (approved / 承認済み起点の cancel_requested) + 固定 (pinned)。JS の canPin の held と同じ集合
    SELECT COUNT(*) INTO v_held FROM plan_reservations
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND (status IN ('approved', 'pinned') OR (status = 'cancel_requested' AND approved_at IS NOT NULL))
       AND id <> COALESCE(NEW.id, -1);
    SELECT COUNT(*) INTO v_done FROM attacks
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND (v_hard_date IS NULL OR attack_date = v_hard_date);
    IF v_held + v_done + 1 > 3 THEN
        RAISE EXCEPTION '運営の固定が残凸を超えます (約束・固定 % 件 + 実凸 % 件)', v_held, v_done
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_reservations_pin_check ON plan_reservations;
CREATE TRIGGER trg_plan_reservations_pin_check
    BEFORE INSERT OR UPDATE OF status, player_id, season_id ON plan_reservations
    FOR EACH ROW EXECUTE FUNCTION plan_reservations_pin_check();

NOTIFY pgrst, 'reload schema';
