-- ============================================================================
-- 🧱 ブロック制 ③-d: メンバーの入力 (模擬の提出シート・凸の申請) を出すかをシーズンに保存する RPC
-- seasons.metadata.member_input = 'full' (出す) / 鍵なし (既定: 出さない = メンバーの入力は最低限。
-- 模擬は Discord にスクショを貼り、運営が PAD に登録する — 旗振り役詰所の合意・ふるりの判断 2026-10-17)。
-- 50_season_blocks_rpc.sql と同じく DB 側で metadata || {鍵} / - 鍵 の 1 文にして、同時編集で他の鍵を消さない。
-- 鍵は白リスト (いまは member_input だけ)。値は 'full' か null。
-- 未適用の環境では「読んで混ぜて書く」にフォールバックする (劣化動作)。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor でこのファイルを実行
-- ============================================================================

DROP FUNCTION IF EXISTS ops_set_season_meta_key(BIGINT, TEXT, JSONB);

CREATE FUNCTION ops_set_season_meta_key(
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
BEGIN
    IF p_key IS NULL OR p_key NOT IN ('member_input') THEN
        RAISE EXCEPTION 'この鍵は書けません: %', COALESCE(p_key, '(null)') USING ERRCODE = 'P0001';
    END IF;
    v_clear := p_value IS NULL OR jsonb_typeof(p_value) = 'null';
    IF NOT v_clear AND p_key = 'member_input' AND p_value <> '"full"'::jsonb THEN
        RAISE EXCEPTION 'member_input は ''full'' か null です' USING ERRCODE = 'P0001';
    END IF;

    UPDATE seasons
       SET metadata = CASE WHEN v_clear THEN COALESCE(metadata, '{}'::jsonb) - p_key
                           ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(p_key, p_value) END
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
