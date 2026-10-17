-- ============================================================================
-- 🧱 ブロック制: レイド日のブロック (時間帯の区切り) をシーズンに原子的に保存する RPC
-- seasons.metadata.blocks = [{ name, from, to }] を **metadata の他の鍵を壊さずに** 書く。
-- クライアント (js/supabase-client.js の supabaseUpdateSeasonBlocks) は「読んで・混ぜて・書く」の
-- 非原子的な方法で動いていたが、運営 2 人が同時に ✏️ シーズン編集を保存すると後の人が前の人の
-- 区切りを消し、読んだあとに別経路が metadata を更新していると damages_snapshot 等も失い得る (Codex指摘 2026-10-18)。
-- DB 側で `metadata || jsonb_build_object('blocks', …)` (null なら `metadata - 'blocks'` = 既定に戻す) にすれば
-- 1 文で済み、競合しない。未適用の環境では従来の方法にフォールバックする (劣化動作)。
-- 検査 (5時〜翌4時を隙間も重なりも無く・2〜12 個) はクライアントの js/domain/raidBlocks.js が唯一。
-- ここでは形 (null か 配列・要素がオブジェクト・name/from/to がある・12 個まで) だけを見る。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor でこのファイルを実行
-- ============================================================================

DROP FUNCTION IF EXISTS ops_set_season_blocks(BIGINT, JSONB);

CREATE FUNCTION ops_set_season_blocks(
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
