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
--   publish_decided_plan       ✅ 決定の配信 (シーズンごとに直列化・押したときの決定がまだ最新か確かめる・形は published_plan_decided_ok)
--   trg_published_plans_no_legacy_after_decision  決定のあるシーズンに従来の配信を入れさせない
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
    v_hard_date DATE;
    v_active INT := 0;
    v_done INT := 0;
    v_over INT := 0;
    v_at_risk BIGINT[] := '{}';
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

    -- ★ 残凸の見張り (report_attack = 40 と同じ)。凸は拒まない — ゲームの中ではもう起きた事実で、記録を拒むと凸が消える。
    --   代わりに「守れなくなる予約」(生きている予約 + 済んだ凸 + この凸 が 3 を超えるぶん・新しい順) を返し、運営が解除する (S4 Codex 監査 C)
    SELECT hard_date INTO v_hard_date FROM seasons WHERE id = p_season_id;
    SELECT COUNT(*) INTO v_active FROM plan_reservations
     WHERE season_id = p_season_id AND player_id = p_player_id
       AND status IN ('requested', 'approved', 'cancel_requested')
       AND (p_reservation_id IS NULL OR id <> p_reservation_id);
    SELECT COUNT(*) INTO v_done FROM attacks
     WHERE season_id = p_season_id AND player_id = p_player_id
       AND (v_hard_date IS NULL OR attack_date = v_hard_date);
    v_over := GREATEST(0, (v_active + v_done + 1) - 3);
    IF v_over > 0 THEN
        SELECT COALESCE(array_agg(id ORDER BY requested_at DESC, id DESC), '{}') INTO v_at_risk
          FROM (SELECT id, requested_at FROM plan_reservations
                 WHERE season_id = p_season_id AND player_id = p_player_id
                   AND status IN ('requested', 'approved', 'cancel_requested')
                   AND (p_reservation_id IS NULL OR id <> p_reservation_id)
                 ORDER BY requested_at DESC, id DESC
                 LIMIT v_over) q;
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

    RETURN jsonb_build_object('id', v_attack.id, 'attack_number', v_attack.attack_number, 'already', false, 'reservation', v_res_to,
                              'over_capacity', v_over, 'reservations_at_risk', to_jsonb(v_at_risk));
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION mark_attack_done(BIGINT, BIGINT, DATE, INT, TEXT, INT, JSONB, BIGINT, TEXT, TEXT, BIGINT, TEXT)
    TO anon, authenticated;

-- ============================================================================
-- 決定の行の形 (js/domain/decidePlan.js の isDecided と同じ): decided はオブジェクト・blocks は 1 つ以上の配列で、どのブロックも鍵 'from-to' を持つ・levels は無いか配列か null。
--   形の崩れた「決定」が 1 行でも入ると、画面はそれを決定として読まず (isDecided) サーバは決定として数え、以後の決定が「別の運営が先に決定しました」で止まり続ける
-- ============================================================================
CREATE OR REPLACE FUNCTION published_plan_decided_ok(p JSONB) RETURNS BOOLEAN AS $$
BEGIN
    IF p IS NULL OR jsonb_typeof(p -> 'decided') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p -> 'decided' -> 'blocks') IS DISTINCT FROM 'array' THEN
        RETURN false;
    END IF;
    IF jsonb_array_length(p -> 'decided' -> 'blocks') = 0 THEN
        RETURN false;
    END IF;
    IF p ? 'levels' AND jsonb_typeof(p -> 'levels') NOT IN ('array', 'null') THEN
        RETURN false;
    END IF;
    RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'decided' -> 'blocks') AS e(b)
                        WHERE jsonb_typeof(b) <> 'object' OR COALESCE(b ->> 'key', '') !~ '^[0-9]{1,2}-[0-9]{1,2}$');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- ✅ 決定 (シンプル化 S4) の配信: シーズンごとに直列化し、押したときの「前の決定」がまだ最新か確かめてから入れる (S4 Codex 監査 A・B)。
--   2 人の運営が同じ前提で同時に決定すると、両方が入って先着側も古い前提で通知を送っていた (読み直し → 比較 → insert の間の TOCTOU)
--   p_expected_decision_id = 押したときの最新の決定の行 (無ければ NULL / 0)。違えば '別の運営が先に決定しました' (serialization_failure)
-- ============================================================================
CREATE OR REPLACE FUNCTION publish_decided_plan(
    p_season_id BIGINT,
    p_plan JSONB,
    p_published_by BIGINT,
    p_published_by_name TEXT,
    p_plan_schema INT,
    p_expected_decision_id BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_latest BIGINT;
    v_row published_plans;
BEGIN
    IF NOT published_plan_decided_ok(p_plan) THEN
        RAISE EXCEPTION '決定の中身がありません' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('publish:' || p_season_id, 0));
    SELECT MAX(id) INTO v_latest FROM published_plans WHERE season_id = p_season_id AND plan ? 'decided';
    IF COALESCE(v_latest, 0) <> COALESCE(p_expected_decision_id, 0) THEN
        RAISE EXCEPTION '別の運営が先に決定しました' USING ERRCODE = 'serialization_failure';
    END IF;
    INSERT INTO published_plans (season_id, plan, published_by, published_by_name, plan_schema)
    VALUES (p_season_id, p_plan, p_published_by, p_published_by_name, GREATEST(0, COALESCE(p_plan_schema, 0)))
    RETURNING * INTO v_row;
    RETURN jsonb_build_object('id', v_row.id, 'published_at', v_row.published_at);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION publish_decided_plan(BIGINT, JSONB, BIGINT, TEXT, INT, BIGINT) TO anon, authenticated;

-- 決定のあるシーズンには、従来の配信 (plan.decided の無い行) を決定より後に入れさせない (S4 Codex 監査 B・D)。
--   混ざると従来の行が最新になり、メンバーの時間割と ✓ が従来の表示に戻り、決定から外れた人に通知も届かない。
--   publish_decided_plan と同じ鍵で直列化する (「決定なし」を確かめた直後に別の端末が決定する、を通さない)。
--   「後」は id で見る (読む側は id の大きいほうを新しいとする)。ふだんの配信は採番が最大なので「決定が 1 つでもあれば拒む」と同じ。
--   バックアップの復元は行を id 順とは限らない順に入れる — 決定より前の従来の行 (id が小さい) は通す。
--   決定の行 (decided の鍵がある行) は形 (published_plan_decided_ok) だけ確かめて通す
CREATE OR REPLACE FUNCTION published_plans_no_legacy_after_decision() RETURNS trigger AS $$
BEGIN
    IF NEW.plan ? 'decided' THEN
        IF NOT published_plan_decided_ok(NEW.plan) THEN
            RAISE EXCEPTION '決定の中身がありません' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('publish:' || NEW.season_id, 0));
    IF EXISTS (SELECT 1 FROM published_plans WHERE season_id = NEW.season_id AND plan ? 'decided' AND id < NEW.id) THEN
        RAISE EXCEPTION 'このシーズンは「決定」で配信しています (従来の配信は使えません)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_published_plans_no_legacy_after_decision ON published_plans;
CREATE TRIGGER trg_published_plans_no_legacy_after_decision
    BEFORE INSERT ON published_plans
    FOR EACH ROW EXECUTE FUNCTION published_plans_no_legacy_after_decision();

NOTIFY pgrst, 'reload schema';
