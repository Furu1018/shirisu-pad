-- ============================================================================
-- シーズン確認・編集 (運営) の原子的保存 RPC
-- ----------------------------------------------------------------------------
-- ハード日/月キー更新・凸日付の追随移行・ボス名更新を1トランザクションで実行する。
-- 別々のクエリだと途中失敗や「開いている間にシーズン終了」の競合で
-- seasons.hard_date と attacks.attack_date が不整合になり、凸が盤面から
-- 消えて見えるため (盤面ローダは attack_date = hard_date で絞る)。
-- クライアントは js/supabase-client.js の supabaseSaveSeasonEdits が呼ぶ。
-- 未適用環境では非原子的な逐次更新に静かにフォールバックする。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor でこのファイルを実行
-- ============================================================================

CREATE OR REPLACE FUNCTION ops_update_season_meta(
    p_season_id BIGINT,
    p_month_key TEXT,
    p_hard_date DATE,
    p_boss_names JSONB DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
BEGIN
    -- サーバ側でも月キーを検証 (クライアント検証だけだと 2026-13 等が保存できてしまう)
    IF p_month_key IS NULL OR p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION '月キーは YYYY-MM 形式 (月は01〜12) で指定してください';
    END IF;
    IF p_hard_date IS NULL THEN
        RAISE EXCEPTION 'ハード日を指定してください';
    END IF;

    -- 行ロック + アクティブ確認: モーダルを開いている間にシーズンが終了された場合は
    -- ここで止まり、終了済みシーズン (やそのボス名) を書き換えない
    PERFORM 1 FROM seasons WHERE id = p_season_id AND is_active = true FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください';
    END IF;

    UPDATE seasons
       SET month_key = p_month_key,
           hard_date = p_hard_date
     WHERE id = p_season_id;

    -- 凸日付の追随: ずれている凸をすべて新ハード日へ合わせる
    -- (冪等 — 過去に生じた不整合もこの保存で治る)
    -- 既知の限界 (受容済み): この UPDATE の後に旧ハード日付きの凸 INSERT がコミットされる
    -- 極小のレース窓がある (凸報告は季節行ロックに参加しない)。起きても編集を再保存すれば
    -- <> 条件の移行で自己修復する。内輪運用でハード日編集は本番前の誤記修正が主のため許容
    UPDATE attacks
       SET attack_date = p_hard_date
     WHERE season_id = p_season_id
       AND attack_date <> p_hard_date;

    -- ボス名 (任意): [{"boss_number":1,"name":"..."}]。空文字・null は「変更しない」
    FOR r IN
        SELECT (e->>'boss_number')::int AS bn, trim(e->>'name') AS nm
          FROM jsonb_array_elements(COALESCE(p_boss_names, '[]'::jsonb)) e
    LOOP
        IF r.bn IS NOT NULL AND r.nm IS NOT NULL AND r.nm <> '' THEN
            UPDATE bosses SET name = r.nm
             WHERE season_id = p_season_id AND boss_number = r.bn;
        END IF;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION ops_update_season_meta(BIGINT, TEXT, DATE, JSONB) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
