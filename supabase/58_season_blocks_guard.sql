-- ============================================================================
-- 🧱 ブロックの設定のガード (2026-10-30 ふるり「A,B,C…とブロックを作って 5～9 時と設定」・設計図 docs/ブロック設定_設計図_2026-10-30.md Q5)
-- ブロックの文字 A・B・C は並び順から作る。ブロックを足し引きすると文字がずれ、鍵 (from-to) も変わるので、
-- 凸数の登録 (availability_confirmations.block_counts)・ブロックの予約 (plan_reservations の time_mode 'block')・✅ 決定 (published_plans の plan.decided)
-- が 1 件でもあるシーズンでは区切りを変えさせない。画面 (👑 🧱 ブロックの設定) も同じ判定で読み取り専用にするが、
-- 古い版・2 人の運営の競合で通らないよう DB でも断る。「既定に戻す」(null) も同じ。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
-- 前提: 50_season_blocks_rpc.sql (ops_set_season_blocks)・53 (block_counts)・54 (予約のブロック)・56 (決定)
-- 未適用でも画面は判定して読み取り専用にする (DB の断りが無いだけ)
-- ============================================================================

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION ops_set_season_blocks(
    p_season_id BIGINT,
    p_blocks JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_meta JSONB;
    v_clear BOOLEAN;
    e JSONB;
    v_counts INT;
    v_resv INT;
    v_decided INT;
BEGIN
    -- ★ 既定に戻せるのは null だけ。配列でない・空の配列は壊れた入力として断る (黙って鍵を消さない)
    v_clear := p_blocks IS NULL OR jsonb_typeof(p_blocks) = 'null';
    IF NOT v_clear THEN
        IF jsonb_typeof(p_blocks) <> 'array' OR jsonb_array_length(p_blocks) = 0 THEN
            RAISE EXCEPTION 'ブロックは配列で渡してください (既定に戻すなら null)' USING ERRCODE = 'P0001';
        END IF;
        IF jsonb_array_length(p_blocks) > 12 THEN
            RAISE EXCEPTION 'ブロックは 12 個までです' USING ERRCODE = 'P0001';
        END IF;
        FOR e IN SELECT * FROM jsonb_array_elements(p_blocks) LOOP
            IF jsonb_typeof(e) <> 'object' OR NOT (e ? 'name') OR NOT (e ? 'from') OR NOT (e ? 'to')
               OR jsonb_typeof(e->'name') <> 'string' OR jsonb_typeof(e->'from') <> 'number' OR jsonb_typeof(e->'to') <> 'number' THEN
                RAISE EXCEPTION 'ブロックの形が違います (name / from / to)' USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
    END IF;

    -- ★ 2026-10-30: 使われているシーズンは変えない (シーズンの行を先に握ってから数える = 数えたあとに区切りが変わらない)
    PERFORM 1 FROM seasons WHERE id = p_season_id AND is_active = TRUE FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください' USING ERRCODE = 'P0001';
    END IF;
    SELECT COUNT(*) INTO v_counts FROM availability_confirmations
     WHERE season_id = p_season_id AND jsonb_typeof(block_counts) = 'object' AND block_counts <> '{}'::jsonb;
    SELECT COUNT(*) INTO v_resv FROM plan_reservations
     WHERE season_id = p_season_id AND time_mode = 'block' AND status IN ('requested', 'approved', 'cancel_requested', 'pinned');
    SELECT COUNT(*) INTO v_decided FROM published_plans
     WHERE season_id = p_season_id AND jsonb_typeof(plan->'decided') = 'object';
    IF v_counts + v_resv + v_decided > 0 THEN
        RAISE EXCEPTION 'このシーズンのブロックは変えられません (凸数の登録 % 件・ブロックの予約 % 件・決定 % 件)。変えるならシーズンを作り直してください', v_counts, v_resv, v_decided
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE seasons
       SET metadata = CASE WHEN v_clear THEN COALESCE(metadata, '{}'::jsonb) - 'blocks'
                           ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('blocks', p_blocks) END
     WHERE id = p_season_id AND is_active = TRUE
     RETURNING metadata INTO v_meta;
    IF NOT FOUND THEN
        RAISE EXCEPTION '対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_meta;
END;
$$;

GRANT EXECUTE ON FUNCTION ops_set_season_blocks(BIGINT, JSONB) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
