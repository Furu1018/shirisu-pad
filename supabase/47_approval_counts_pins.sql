-- ============================================================================
-- Phase: 約束を作るときも 📌 を数える (全体監査 2026-09-14 #1 #2 + 修正後の Codex 指摘 2 件)
-- ----------------------------------------------------------------------------
-- 「約束 (approved) + 📌 (pinned) + 実凸 ≤ 3」は、45 では **📌 を置くとき**しか見ていなかった
-- (plan_reservations_pin_check は NEW.status = 'pinned' 以外を素通し)。そのため
--   ・締め凸の了承 (approved を直接 INSERT)          … 39 は 📌 を数えず、45 は素通し
--   ・本人の申請の承認 (requested → approved)         … 同上
--   ・本人が 📌 を引き受ける (pinned → approved) … 他の 📌 を数えない
-- のどれでも、📌 が 3 件ある人に 4 件目の固定ができ、ソルバー (isFixed = 約束 + 📌) が 3 枠の人に 4 凸ぶん配っていた。
--
-- このマイグレーションは 2 つの関数を差し替える (トリガは 45 のまま: BEFORE INSERT OR UPDATE OF status, player_id, season_id)。
-- ① plan_reservations_pin_check
--   ★ NEW.status が 'pinned' または 'approved' のときに数える。
--   ★ 本人の申請 (requested) と実凸は今までどおり 📌 に塞がれない (45 の設計判断「約束を運営の手で増やさない」のまま)。
--     申請は承認の瞬間に初めて枠を取る。
--   ★ 同じカード (同じ人・ボス・編成枠) の 📌 は「この約束の下書き」なので数えない (② が同じトランザクションで外す)。
--   ★ 早期 return は「状態・人・シーズンがすべて不変」のときだけ — 状態だけ見ると pinned 行を別の人・別のシーズンへ
--     動かす更新が素通りし、4 件目が入る (修正後の Codex 指摘)
-- ② reservation_set_status (45 の写し + approved になった瞬間に同じカードの 📌 を superseded で外す)
--   ★ 45 の本文から**機械的に写している** (tests/run-tests.mjs が [47-supersede] の印の間を除いて 45 と一致することを見る)
--   ★ JS 側の reservationsDomain.canApprove と**同じ式**にすること (テストが突き合わせる)。
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (再実行しても壊れない)。99_check_applied.sql で確認できる
-- ============================================================================
SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION plan_reservations_pin_check()
RETURNS TRIGGER AS $$
DECLARE
    v_hard_date DATE;
    v_held INT;
    v_done INT;
BEGIN
    -- 📌 を置くとき と 約束を作るとき (approved になるとき) だけ見る。
    -- requested / cancel_requested / 終端 (fulfilled・released・rejected) は見ない
    IF NEW.status NOT IN ('pinned', 'approved') THEN
        RETURN NEW;
    END IF;
    -- 状態も人もシーズンも変わらない再保存 (approved のまま中身だけ触る等) は見ない。
    -- ★ 状態だけを見ると、pinned 行を別の人・別のシーズンへ動かす更新が素通りする (修正後の Codex 指摘)
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status
       AND OLD.player_id IS NOT DISTINCT FROM NEW.player_id
       AND OLD.season_id IS NOT DISTINCT FROM NEW.season_id THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('attack:' || NEW.season_id || ':' || NEW.player_id, 0));
    SELECT hard_date INTO v_hard_date FROM seasons WHERE id = NEW.season_id;
    -- 約束 (approved / 承認済み起点の cancel_requested) + 固定 (pinned)。JS の canApprove / canPin の held と同じ集合
    SELECT COUNT(*) INTO v_held FROM plan_reservations
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND (status IN ('approved', 'pinned') OR (status = 'cancel_requested' AND approved_at IS NOT NULL))
       AND id <> COALESCE(NEW.id, -1)
       -- 同じカードの 📌 は数えない (この約束の下書き。reservation_set_status が同じトランザクションで外す)
       AND NOT (status = 'pinned' AND NEW.status = 'approved'
                AND boss_number = NEW.boss_number AND loadout_slot = NEW.loadout_slot);
    SELECT COUNT(*) INTO v_done FROM attacks
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND (v_hard_date IS NULL OR attack_date = v_hard_date);
    IF v_held + v_done + 1 > 3 THEN
        IF NEW.status = 'pinned' THEN
            RAISE EXCEPTION '運営の固定が残凸を超えます (約束・固定 % 件 + 実凸 % 件)', v_held, v_done
                USING ERRCODE = 'check_violation';
        ELSE
            RAISE EXCEPTION '約束が残凸を超えます (約束・固定 % 件 + 実凸 % 件) — 📌 の固定を外してから承認してください', v_held, v_done
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ② 45 の reservation_set_status の写し + approved の瞬間に同じカードの 📌 を外す ([47-supersede] の印の間だけが差分)
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
    v_pin RECORD;   -- [47] 同じカードの 📌 を外すため
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

    -- [47-supersede-begin]
    -- ★ 約束が生まれたら、同じカード (同じ人・ボス・編成枠) の 📌 = この約束の下書き は**同じトランザクションで**外す
    --   (全体監査 2026-09-14・修正後の Codex 指摘)。画面側が別リクエストで外すまでの間、約束 1 + 📌 3 = 4 行が
    --   isFixed に見え、別の運営の算出・配信がそれを読めていた。pin_check は同じカードの 📌 を数えない前提なので、
    --   ここで必ず外して整合させる。画面側の supersede は 47 未適用の環境のためだけに残っている
    IF p_to = 'approved' THEN
        FOR v_pin IN
            SELECT id FROM plan_reservations
             WHERE season_id = v_row.season_id AND player_id = v_row.player_id
               AND boss_number = v_row.boss_number AND loadout_slot = v_row.loadout_slot
               AND status = 'pinned' AND id <> v_row.id
             FOR UPDATE
        LOOP
            UPDATE plan_reservations
               SET status = 'released', released_by = p_actor, released_at = NOW(), release_reason = 'superseded', updated_at = NOW()
             WHERE id = v_pin.id;
            INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
            VALUES (v_pin.id, 'pinned', 'released', p_actor, 'superseded');
        END LOOP;
    END IF;
    -- [47-supersede-end]
    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';
