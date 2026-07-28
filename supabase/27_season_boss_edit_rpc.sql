-- ============================================================================
-- シーズン確認・編集 v2: ボスコード (属性) の修正対応
-- ----------------------------------------------------------------------------
-- 26_season_meta_rpc.sql の ops_update_season_meta を 5引数に拡張する。
-- 追加の p_boss_codes で「ボスの属性 (=ボスコード) を間違えて作成した」場合の
-- 修正を原子的に行う: bosses.boss_code/attribute/weakness の更新 +
-- 記録済み attacks.boss_code / fururi_simulation_scores.boss_code の追随移行
-- (凸は boss_number で紐付くため移行は安全)。
-- UNIQUE(season_id, boss_code) があるため入替 (スワップ) は2段階更新で行う:
-- 一時コード → 最終コード (単発の更新でも一意制約に当たらない)。
-- 級 (tier) は HP と連動するためこの RPC でも変更不可 (作り直し運用のまま)。
-- 既知の限界 (受容済み): finish_coordinations.attribute (締め凸調整中の表示・30分TTL) は
-- 追随しない — 自然失効する一時データのため。配信済みプランも自動反映されない
-- (クライアントが保存時に再算出・再配信を促す)。
-- クライアントは js/supabase-client.js の supabaseSaveSeasonEdits が呼ぶ。
-- 未適用環境ではコード変更を含む保存だけ逐次更新にフォールバックする (26 は据え置きでOK)。
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor でこのファイルを実行
-- ============================================================================

-- 旧シグネチャを除去してから作り直す (残すと PostgREST の RPC 解決が曖昧になる)
DROP FUNCTION IF EXISTS ops_update_season_meta(BIGINT, TEXT, DATE, JSONB);
DROP FUNCTION IF EXISTS ops_update_season_meta(BIGINT, TEXT, DATE, JSONB, JSONB);

CREATE FUNCTION ops_update_season_meta(
    p_season_id BIGINT,
    p_month_key TEXT,
    p_hard_date DATE,
    p_boss_names JSONB DEFAULT '[]'::jsonb,
    p_boss_codes JSONB DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
    v_old TEXT;
BEGIN
    -- サーバ側でも月キーを検証 (クライアント検証だけだと 2026-13 等が保存できてしまう)
    IF p_month_key IS NULL OR p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION '月キーは YYYY-MM 形式 (月は01〜12) で指定してください';
    END IF;
    IF p_hard_date IS NULL THEN
        RAISE EXCEPTION 'ハード日を指定してください';
    END IF;

    -- 行ロック + アクティブ確認: モーダルを開いている間にシーズンが終了された場合は
    -- ここで止まり、終了済みシーズン (やそのボス) を書き換えない
    PERFORM 1 FROM seasons WHERE id = p_season_id AND is_active = true FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください';
    END IF;

    UPDATE seasons
       SET month_key = p_month_key,
           hard_date = p_hard_date
     WHERE id = p_season_id;

    -- 凸日付の追随: ずれている凸をすべて新ハード日へ合わせる (冪等 — 再保存で不整合も治る)
    -- 既知の限界 (受容済み): この UPDATE の後に旧ハード日付きの凸 INSERT がコミットされる
    -- 極小のレース窓がある (凸報告は季節行ロックに参加しない)。起きても編集を再保存すれば
    -- <> 条件の移行で自己修復する。内輪運用でハード日編集は本番前の誤記修正が主のため許容
    UPDATE attacks
       SET attack_date = p_hard_date
     WHERE season_id = p_season_id
       AND attack_date <> p_hard_date;

    -- ボスコード (属性) の変更 (任意):
    -- [{"boss_number":2,"boss_code":"H.S.T.A.","attribute":"fire","weakness":"water"}]
    -- attribute/weakness はクライアント (supabase-client.js の共有マップ) が導出して渡す。
    -- ここでは値の妥当性のみ検証する (相性表を SQL に二重実装しない)
    IF jsonb_array_length(COALESCE(p_boss_codes, '[]'::jsonb)) > 0 THEN
        -- 事前検証: 値の妥当性 + 変更後の最終状態でコードが重複しないこと
        FOR r IN
            SELECT (e->>'boss_number')::int AS bn,
                   trim(e->>'boss_code')    AS code,
                   e->>'attribute'          AS attr,
                   e->>'weakness'           AS weak
              FROM jsonb_array_elements(p_boss_codes) e
        LOOP
            IF r.bn IS NULL OR r.code IS NULL OR r.code = '' THEN
                RAISE EXCEPTION 'ボスコード変更の指定が不正です (boss_number=%)', r.bn;
            END IF;
            IF r.attr NOT IN ('fire','water','electric','iron','wind')
               OR r.weak NOT IN ('fire','water','electric','iron','wind') THEN
                RAISE EXCEPTION 'ボス%の属性指定が不正です (attribute=%, weakness=%)', r.bn, r.attr, r.weak;
            END IF;
        END LOOP;
        -- 同一ボスへの二重指定を拒否 (フェーズ1/2の対応が崩れ、凸コードだけずれる恐れがある)
        IF (SELECT count(*) <> count(DISTINCT (e->>'boss_number')::int)
              FROM jsonb_array_elements(p_boss_codes) e) THEN
            RAISE EXCEPTION '同じボスに複数のコード変更が指定されています';
        END IF;
        IF (SELECT count(*) <> count(DISTINCT final_code) FROM (
                SELECT COALESCE(e.code, b.boss_code) AS final_code
                  FROM bosses b
                  LEFT JOIN (
                        SELECT (x->>'boss_number')::int AS bn, trim(x->>'boss_code') AS code
                          FROM jsonb_array_elements(p_boss_codes) x
                       ) e ON e.bn = b.boss_number
                 WHERE b.season_id = p_season_id
            ) t) THEN
            RAISE EXCEPTION '同じボスコードを複数のボスに割り当てることはできません (入替の場合は両方のボスを変更してください)';
        END IF;

        -- フェーズ1: 変更対象を一時コードへ退避 (UNIQUE(season_id, boss_code) 回避。
        -- fururi_simulation_scores も旧コードから一時コードへ同伴させる)
        FOR r IN
            SELECT (e->>'boss_number')::int AS bn, trim(e->>'boss_code') AS code
              FROM jsonb_array_elements(p_boss_codes) e
        LOOP
            SELECT boss_code INTO STRICT v_old FROM bosses
             WHERE season_id = p_season_id AND boss_number = r.bn;
            IF v_old = r.code THEN CONTINUE; END IF;   -- 実質変更なしはスキップ
            UPDATE bosses SET boss_code = '~EDIT~' || r.bn
             WHERE season_id = p_season_id AND boss_number = r.bn;
            UPDATE fururi_simulation_scores SET boss_code = '~EDIT~' || r.bn
             WHERE season_id = p_season_id AND boss_code = v_old;
        END LOOP;

        -- フェーズ2: 最終コード + 属性/弱点を確定し、凸・fururi の非正規化コードを追随
        FOR r IN
            SELECT (e->>'boss_number')::int AS bn,
                   trim(e->>'boss_code')    AS code,
                   e->>'attribute'          AS attr,
                   e->>'weakness'           AS weak
              FROM jsonb_array_elements(p_boss_codes) e
        LOOP
            UPDATE bosses
               SET boss_code = r.code, attribute = r.attr, weakness = r.weak
             WHERE season_id = p_season_id AND boss_number = r.bn
               AND boss_code = '~EDIT~' || r.bn;   -- フェーズ1で退避した行だけ (変更なしはそのまま)
            UPDATE fururi_simulation_scores SET boss_code = r.code
             WHERE season_id = p_season_id AND boss_code = '~EDIT~' || r.bn;
            -- 凸は boss_number が主の紐付け。IS DISTINCT FROM で code が NULL の行も埋める
            UPDATE attacks SET boss_code = r.code
             WHERE season_id = p_season_id AND boss_number = r.bn
               AND boss_code IS DISTINCT FROM r.code;
        END LOOP;

        -- 念のため: 一時コードが残っていたら全体を巻き戻す (ロジックバグの検出)
        IF EXISTS (SELECT 1 FROM bosses WHERE season_id = p_season_id AND boss_code LIKE '~EDIT~%') THEN
            RAISE EXCEPTION '内部エラー: ボスコード更新が不完全です (変更は保存されていません)';
        END IF;
    END IF;

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

GRANT EXECUTE ON FUNCTION ops_update_season_meta(BIGINT, TEXT, DATE, JSONB, JSONB) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
