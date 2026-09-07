-- ============================================================================
-- Phase: 凸報告を1つの操作にまとめる (L2 / 課題E — 2026-09-07)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
-- 前提: supabase/39_plan_reservations.sql
--
-- なぜ必要か:
--   現行の `supabaseAddAttack` は 3リクエストに分かれている:
--     ① 既存の凸を読んで attack_number を決める → ② attacks に insert
--     → ③ bosses を読んで残HPを引いて update
--   ①と②の間に別端末が凸すると attack_number が衝突し、③は read-modify-write なので
--   2人が同時に凸すると片方のダメージが残HPに反映されない。
--   予約が入ると、これに「予約を fulfilled にする」が加わる。
--   **凸が入ったのに予約が生きたまま**になると、ソルバーがその枠を二重に押さえて
--   その人の残り凸が消える = 約束を守るための仕組みが逆に人を止めてしまう。
--
--   そこで「attack_number の採番 / insert / 残HP減算 / 予約の消し込み」を
--   **サーバ側の1トランザクション**にまとめる。
--
-- ★ 撃破の通知はここでは判定しない — 残HPを0にする経路は代理凸・ダメージ編集・
--   運営の一括保存など複数あり、書き込み側のフックは必ず漏れる。
--   検知は盤面の変化を見る `_checkRaidEvents` 側に一本化してある (CLAUDE.md 参照)
-- ============================================================================

SET lock_timeout = '3s';

-- p_reservation_id を渡すと、その予約を fulfilled にして凸に紐づける。
-- NULL なら従来どおりの凸報告 (予約なし)。
-- p_skip_hp_decrement = true は OCR で残HPを直接書き換える経路用 (二重に引かない)。
CREATE OR REPLACE FUNCTION report_attack(
    p_season_id BIGINT,
    p_player_id BIGINT,
    p_attack_date DATE,
    p_boss_number INT,
    p_boss_code TEXT,
    p_damage_raw BIGINT,
    p_level INT DEFAULT 1,
    p_characters JSONB DEFAULT '[]'::jsonb,
    p_reservation_id BIGINT DEFAULT NULL,
    p_skip_hp_decrement BOOLEAN DEFAULT FALSE,
    p_actor TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_num INT;
    v_attack attacks;
    v_res plan_reservations;
    v_hp_after BIGINT := NULL;
BEGIN
    -- ★ 同じ人の凸を直列化する。行ロックが取れないので、プレイヤー単位のアドバイザリロックを使う。
    --   これが無いと ①採番 と ②insert の間に別端末が割り込み、attack_number が衝突する
    PERFORM pg_advisory_xact_lock(hashtextextended('attack:' || p_season_id || ':' || p_player_id, 0));

    -- 予約を先に確定させる (存在しない・他人のもの・承認済みでない、をここで弾く)
    IF p_reservation_id IS NOT NULL THEN
        SELECT * INTO v_res FROM plan_reservations WHERE id = p_reservation_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION '予約が見つかりません (id=%)', p_reservation_id USING ERRCODE = 'no_data_found';
        END IF;
        IF v_res.player_id <> p_player_id OR v_res.season_id <> p_season_id THEN
            RAISE EXCEPTION 'この予約は別のメンバー/シーズンのものです' USING ERRCODE = 'check_violation';
        END IF;
        IF v_res.status <> 'approved' THEN
            RAISE EXCEPTION '承認済みの予約ではありません (いま %)', v_res.status USING ERRCODE = 'check_violation';
        END IF;
        -- ★ ボスが違う凸で予約を消し込ませない (「別のボスを殴ったのに予約が消えた」を防ぐ)。
        --   レベルは実際の進行とずれることがあるので照合しない (ボスと本人が合っていれば実行とみなす)
        IF v_res.boss_number <> p_boss_number THEN
            RAISE EXCEPTION '予約のボス (B%) と凸のボス (B%) が違います', v_res.boss_number, p_boss_number
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- 空いている attack_number (1..3)
    SELECT COALESCE(MIN(n), 0) INTO v_num FROM generate_series(1, 3) AS n
     WHERE NOT EXISTS (
         SELECT 1 FROM attacks a
          WHERE a.season_id = p_season_id AND a.player_id = p_player_id
            AND a.attack_date = p_attack_date AND a.attack_number = n);
    IF v_num = 0 THEN
        RAISE EXCEPTION '既に3凸済みです' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO attacks (season_id, player_id, attack_date, boss_number, boss_code,
                         damage_raw, attack_number, level, characters, reservation_id)
    VALUES (p_season_id, p_player_id, p_attack_date, p_boss_number, p_boss_code,
            GREATEST(0, COALESCE(p_damage_raw, 0)), v_num, COALESCE(p_level, 1),
            COALESCE(p_characters, '[]'::jsonb), p_reservation_id)
    RETURNING * INTO v_attack;

    -- 残HPの減算。read-modify-write ではなく1文で引く (同時凸でも取りこぼさない)
    IF NOT p_skip_hp_decrement AND COALESCE(p_damage_raw, 0) > 0 AND p_boss_number IS NOT NULL THEN
        UPDATE bosses
           SET remaining_hp_raw = GREATEST(0, COALESCE(remaining_hp_raw, 0) - p_damage_raw),
               updated_at = NOW()
         WHERE season_id = p_season_id AND boss_number = p_boss_number
        RETURNING remaining_hp_raw INTO v_hp_after;
    END IF;

    -- 予約の消し込み。**同じトランザクションで**やることが要点 —
    -- 別リクエストにすると「凸は入ったのに予約が生きたまま」が起きる
    IF p_reservation_id IS NOT NULL THEN
        UPDATE plan_reservations
           SET status = 'fulfilled', release_reason = 'fulfilled', updated_at = NOW()
         WHERE id = p_reservation_id;
        INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
        VALUES (p_reservation_id, 'approved', 'fulfilled', p_actor, '凸報告により実行済み');
    END IF;

    RETURN jsonb_build_object(
        'id', v_attack.id,
        'attack_number', v_attack.attack_number,
        'hp_after', v_hp_after,
        'reservation_id', p_reservation_id
    );
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION report_attack(BIGINT, BIGINT, DATE, INT, TEXT, BIGINT, INT, JSONB, BIGINT, BOOLEAN, TEXT)
    TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
