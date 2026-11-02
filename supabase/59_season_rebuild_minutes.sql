-- ============================================================================
-- ⏱ 再編成時間 (第46回の反省 ⑥・2026-11-02 ふるり「ブロックとブロックの間に運営のプラン再編成の時間を設けたい」・
--   docs/第46期_前日準備と組むの見直し_2026-11-01.md §6)
-- 最後以外の各ブロックの最後の N 分は凸しない時間 (運営が次のブロックを組む)。シーズンごとに seasons.metadata.rebuild_minutes
-- (0〜59 の整数・鍵なし = 0 = 再編成なし) に持つ。区切り (blocks) は変えない。
-- 保存は 51 の ops_set_season_meta_key (DB 側で metadata || {鍵} / - 鍵 の 1 文) — 鍵の白リストに rebuild_minutes を足す。
-- 値は 0〜59 の整数か null (null で鍵を消す)。文字列の "20"・小数・範囲外は断る。保存するのは整数に揃えた値 (20.0 → 20)。
-- member_input の検査・UPDATE 文・アクティブでないときの断りは 51 と同じ。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
-- 前提: 51_season_member_input_rpc.sql (同じ引数の関数を置き換える)
-- 未適用でも画面は「読んで混ぜて書く」で保存できる (同時編集に弱いだけ)。
-- ★ 59 のあとに 51 を流し直すと白リストが member_input だけに戻る — 99_check_applied.sql の 59 の行が false になるので、59 も流し直す
-- ============================================================================

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION ops_set_season_meta_key(
    p_season_id BIGINT,
    p_key TEXT,
    p_value JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_meta JSONB;
    v_clear BOOLEAN;
    v_num NUMERIC;
    v_value JSONB;
BEGIN
    IF p_key IS NULL OR p_key NOT IN ('member_input', 'rebuild_minutes') THEN
        RAISE EXCEPTION 'この鍵は書けません: %', COALESCE(p_key, '(null)') USING ERRCODE = 'P0001';
    END IF;
    v_clear := p_value IS NULL OR jsonb_typeof(p_value) = 'null';
    v_value := p_value;
    IF NOT v_clear AND p_key = 'member_input' AND p_value <> '"full"'::jsonb THEN
        RAISE EXCEPTION 'member_input は ''full'' か null です' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_clear AND p_key = 'rebuild_minutes' THEN
        IF jsonb_typeof(p_value) <> 'number' THEN
            RAISE EXCEPTION 'rebuild_minutes は 0〜59 の整数か null です' USING ERRCODE = 'P0001';
        END IF;
        v_num := (p_value #>> '{}')::numeric;
        IF v_num <> trunc(v_num) OR v_num < 0 OR v_num > 59 THEN
            RAISE EXCEPTION 'rebuild_minutes は 0〜59 の整数か null です' USING ERRCODE = 'P0001';
        END IF;
        v_value := to_jsonb(v_num::int);
    END IF;

    UPDATE seasons
       -- metadata が object 以外 (NULL・配列・スカラー) なら {} から作り直す (|| や - は配列に対して別の意味になる — Codex指摘 b8f9d94)
       SET metadata = CASE WHEN v_clear THEN (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) - p_key
                           ELSE (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) || jsonb_build_object(p_key, v_value) END
     WHERE id = p_season_id AND is_active = TRUE
     RETURNING metadata INTO v_meta;
    IF NOT FOUND THEN
        RAISE EXCEPTION '対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_meta;
END;
$$;

GRANT EXECUTE ON FUNCTION ops_set_season_meta_key(BIGINT, TEXT, JSONB) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
