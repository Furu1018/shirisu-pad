-- ============================================================================
-- Phase: 約束を作るときも 📌 を数える (全体監査 2026-09-14 #1 #2)
-- ----------------------------------------------------------------------------
-- 「約束 (approved) + 📌 (pinned) + 実凸 ≤ 3」は、45 では **📌 を置くとき**しか見ていなかった
-- (plan_reservations_pin_check は NEW.status = 'pinned' 以外を素通し)。そのため
--   ・締め凸の了承 (approved を直接 INSERT)          … 39 は 📌 を数えず、45 は素通し
--   ・本人の申請の承認 (requested → approved)         … 同上
--   ・本人が 📌 を引き受ける (pinned → approved) … 他の 📌 を数えない
-- のどれでも、📌 が 3 件ある人に 4 件目の固定ができ、ソルバー (isFixed = 約束 + 📌) が 3 枠の人に 4 凸ぶん配っていた。
--
-- このマイグレーションは 45 の関数を**差し替える**だけ (トリガは 45 のまま: BEFORE INSERT OR UPDATE OF status, player_id, season_id)。
--   ★ NEW.status が 'pinned' または 'approved' のときに数える。
--   ★ 本人の申請 (requested) と実凸は今までどおり 📌 に塞がれない (45 の設計判断「約束を運営の手で増やさない」のまま)。
--     申請は承認の瞬間に初めて枠を取る。
--   ★ 同じカード (同じ人・ボス・編成枠) の 📌 は「この約束の下書き」なので数えない
--     (承認のあと画面が superseded で外す。数えると 📌 を先に外さないと承認できなくなる)。
--   ★ JS 側の reservationsDomain.canApprove と**同じ式**にすること (tests/run-tests.mjs が突き合わせる)。
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
    -- 状態が変わらない再保存 (approved のまま中身だけ触る等) は見ない
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('attack:' || NEW.season_id || ':' || NEW.player_id, 0));
    SELECT hard_date INTO v_hard_date FROM seasons WHERE id = NEW.season_id;
    -- 約束 (approved / 承認済み起点の cancel_requested) + 固定 (pinned)。JS の canApprove / canPin の held と同じ集合
    SELECT COUNT(*) INTO v_held FROM plan_reservations
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND (status IN ('approved', 'pinned') OR (status = 'cancel_requested' AND approved_at IS NOT NULL))
       AND id <> COALESCE(NEW.id, -1)
       -- 同じカードの 📌 は数えない (この約束の下書き。承認後に外れる)
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

NOTIFY pgrst, 'reload schema';
