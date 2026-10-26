-- ============================================================================
-- Phase: ✓ 凸しました (シンプル化 S4・2026-10-27 ふるりの構想「本番の凸報告は実際の数字や構成は入れずに『凸が完了したことだけ』」)
-- メンバー (または運営が代わりに) 時間割の自分の行で ✓ を 1 タップ → attacks に「ダメージ 0・予定の編成」の行を 1 つ。
-- 残り凸と使ったキャラが正しく減る (次のブロックを組むときに正しい)。ボスの残り HP は動かさない (運営が BlaBlaLINK の画像で直す)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
-- 前提: supabase/39_plan_reservations.sql・40_attack_with_reservation_rpc.sql・45 / 47 (📌)
--
--   attacks.source             NULL = 従来の報告 (ダメージあり) / 'tap' = 本人の ✓ / 'ops_tap' = 運営が代わりに付けた ✓
--   attacks.planned_damage_raw ✓ の行の「予定のダメージ」(damage_raw は 0 のまま。分析のダメージの集計からは source のある行を外す)
--   attacks.plan_key           どの予定の凸か (ブロック|レベル|ボス|人|編成)。同じ凸に二重に ✓ を付けない (一意索引)
-- ============================================================================

SET lock_timeout = '3s';

ALTER TABLE attacks ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE attacks ADD COLUMN IF NOT EXISTS planned_damage_raw BIGINT;
ALTER TABLE attacks ADD COLUMN IF NOT EXISTS plan_key TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attacks_source_check') THEN
        ALTER TABLE attacks ADD CONSTRAINT attacks_source_check CHECK (source IS NULL OR source IN ('tap', 'ops_tap'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_attacks_plan_key
    ON attacks (season_id, player_id, attack_date, plan_key) WHERE plan_key IS NOT NULL;

-- p_reservation_id = その凸の駒 (📌 手で置いた / 承認済みのブロックの約束)。渡すと 📌 は外し (released)、約束は実行済み (fulfilled) にする
--   (残り凸を二重に数えない)。合わない駒 (別の人・別のボス・もう終わった) は黙って触らない (✓ そのものは通す)
CREATE OR REPLACE FUNCTION mark_attack_done(
    p_season_id BIGINT,
    p_player_id BIGINT,
    p_attack_date DATE,
    p_boss_number INT,
    p_boss_code TEXT,
    p_level INT,
    p_characters JSONB,
    p_planned_damage_raw BIGINT,
    p_plan_key TEXT,
    p_source TEXT DEFAULT 'tap',
    p_reservation_id BIGINT DEFAULT NULL,
    p_actor TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_num INT;
    v_attack attacks;
    v_res plan_reservations;
    v_res_to TEXT := NULL;
BEGIN
    IF p_source IS NULL OR p_source NOT IN ('tap', 'ops_tap') THEN
        RAISE EXCEPTION '✓ の種類が不正です' USING ERRCODE = 'check_violation';
    END IF;
    IF p_plan_key IS NULL OR length(p_plan_key) = 0 THEN
        RAISE EXCEPTION 'どの凸の ✓ か分かりません' USING ERRCODE = 'check_violation';
    END IF;
    IF p_boss_number IS NULL OR p_boss_number < 1 OR p_boss_number > 5 THEN
        RAISE EXCEPTION 'ボスの番号が不正です' USING ERRCODE = 'check_violation';
    END IF;
    -- ★ report_attack と同じ鍵で同じ人の凸を直列化する (採番の衝突・二重押し)
    PERFORM pg_advisory_xact_lock(hashtextextended('attack:' || p_season_id || ':' || p_player_id, 0));

    -- 二重押し: 同じ凸の ✓ がもうあれば、その行を返す (2 つ目を作らない)
    SELECT * INTO v_attack FROM attacks
     WHERE season_id = p_season_id AND player_id = p_player_id AND attack_date = p_attack_date AND plan_key = p_plan_key
     LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('id', v_attack.id, 'attack_number', v_attack.attack_number, 'already', true, 'reservation', NULL);
    END IF;

    SELECT COALESCE(MIN(n), 0) INTO v_num FROM generate_series(1, 3) AS n
     WHERE NOT EXISTS (
         SELECT 1 FROM attacks a
          WHERE a.season_id = p_season_id AND a.player_id = p_player_id
            AND a.attack_date = p_attack_date AND a.attack_number = n);
    IF v_num = 0 THEN
        RAISE EXCEPTION '既に3凸済みです' USING ERRCODE = 'check_violation';
    END IF;

    -- 駒: 同じ人・同じシーズン・同じボスの 📌 / 約束だけ
    IF p_reservation_id IS NOT NULL THEN
        SELECT * INTO v_res FROM plan_reservations WHERE id = p_reservation_id FOR UPDATE;
        IF FOUND AND v_res.player_id = p_player_id AND v_res.season_id = p_season_id AND v_res.boss_number = p_boss_number THEN
            IF v_res.status = 'pinned' THEN v_res_to := 'released';
            ELSIF v_res.status = 'approved' OR (v_res.status = 'cancel_requested' AND v_res.approved_at IS NOT NULL) THEN v_res_to := 'fulfilled';
            END IF;
        END IF;
    END IF;

    -- ダメージは 0 (HP は動かさない)。予定のダメージは planned_damage_raw に
    INSERT INTO attacks (season_id, player_id, attack_date, boss_number, boss_code,
                         damage_raw, attack_number, level, characters, reservation_id,
                         source, planned_damage_raw, plan_key)
    VALUES (p_season_id, p_player_id, p_attack_date, p_boss_number, p_boss_code,
            0, v_num, COALESCE(p_level, 1), COALESCE(p_characters, '[]'::jsonb),
            CASE WHEN v_res_to = 'fulfilled' THEN p_reservation_id ELSE NULL END,
            p_source, GREATEST(0, COALESCE(p_planned_damage_raw, 0)), p_plan_key)
    RETURNING * INTO v_attack;

    IF v_res_to IS NOT NULL THEN
        PERFORM set_config('app.reservation_rpc', 'on', true);
        UPDATE plan_reservations
           SET status = v_res_to, release_reason = 'fulfilled', updated_at = NOW()
         WHERE id = p_reservation_id;
        INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
        VALUES (p_reservation_id, v_res.status, v_res_to, p_actor, '✓ 凸しました により実行済み');
    END IF;

    RETURN jsonb_build_object('id', v_attack.id, 'attack_number', v_attack.attack_number, 'already', false, 'reservation', v_res_to);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION mark_attack_done(BIGINT, BIGINT, DATE, INT, TEXT, INT, JSONB, BIGINT, TEXT, TEXT, BIGINT, TEXT)
    TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
