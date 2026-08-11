-- ============================================================================
-- Phase: 模擬スロットのレベル別測定値 (1スロット = 1編成)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
--
-- 何が変わるか:
--   30_player_damages_level では「1行 = 1提出 (編成+レベル+値)」だったため、
--   同じ編成をレベル違いで測るとスロット (=編成の多様性のための3枠) を食い潰していた。
--   スロットの意味を「1スロット = 1編成」に変え、レベル別の測定値は
--   levels JSONB でスロットの中に持つ (ユーザー承認 2026-08-12)。
--
--   levels = { "0": 14.2, "4": 12.5 }   キー "0"=レベル未指定(全レベル可)〜"4" / 値=B単位
--
-- 不変条件 (クライアントの _upsertPlayerDamages が維持):
--   damage_b   = levels の最大値 (レベル無視の従来表示との互換)
--   boss_level = その最大値の測定キー ("0"→NULL)。互換ミラー — 本SQL未適用環境や
--                旧クライアントは「ベスト測定1件」として従来どおり動く
--   同値タイは "0" > 高レベル の順 (より広く使える側に倒す)
--
-- 値の正数チェックはクライアント正規化 (js/domain/mockLevels.js normLevels) に委ねる
-- (CHECK にサブクエリが書けないため。キーの集合のみ DB で縛る)。
-- ============================================================================

-- ---- 1) levels カラム ----
ALTER TABLE player_damages ADD COLUMN IF NOT EXISTS levels JSONB;

ALTER TABLE player_damages DROP CONSTRAINT IF EXISTS chk_player_damages_levels;
ALTER TABLE player_damages ADD CONSTRAINT chk_player_damages_levels
    CHECK (levels IS NULL
           OR (jsonb_typeof(levels) = 'object'
               AND levels - '0' - '1' - '2' - '3' - '4' = '{}'::jsonb));

-- ---- 2) 既存データの移行: (damage_b, boss_level) → levels ミラー ----
-- 冪等 (levels が未設定の行のみ)。damage_b<=0 の行は測定なしとして levels NULL のまま
UPDATE player_damages
   SET levels = jsonb_build_object(COALESCE(boss_level, 0)::text, damage_b)
 WHERE levels IS NULL AND damage_b > 0;

-- ---- 3) ワンショット自動マージ ----
-- 30 の運用で「同一編成のレベル違い」が別スロットに入ったデータを、最小スロットへ統合する。
-- 同一編成の判定 = キャラ5人の正規化 (NFKC・trim・小文字) 順不同完全一致
-- (js/optimal-plan.js の sameTeam / js/domain/mockLevels.js と同一規則)。
-- キャラが5人揃っていない行は対象外 (安全側)。冪等 — 2回目は重複グループが無いので no-op。
DO $$
DECLARE
    g RECORD;
    v_levels JSONB;
    v_best NUMERIC;
    v_boss INT;
    v_upd TIMESTAMPTZ;
    v_merged INT := 0;
BEGIN
    FOR g IN
        WITH n AS (
            SELECT player_id, attribute, slot,
                   (SELECT array_agg(lower(normalize(btrim(c), NFKC))
                                     ORDER BY lower(normalize(btrim(c), NFKC)))
                      FROM unnest(characters) c) AS tkey
              FROM player_damages
             WHERE array_length(characters, 1) = 5
        )
        SELECT player_id, attribute, tkey, array_agg(slot ORDER BY slot) AS slots
          FROM n
         WHERE NOT EXISTS (SELECT 1 FROM unnest(tkey) k WHERE k IS NULL OR k = '')
           AND (SELECT count(DISTINCT k) FROM unnest(tkey) k) = 5
         GROUP BY player_id, attribute, tkey
        HAVING count(*) > 1
    LOOP
        -- グループ全行の levels をキーごとに max で統合。
        -- CHECK は値の型まで縛れないため、数値型のエントリだけを対象にする
        -- (非数値が混ざっていてもこの移行が中断しない = 冪等性の維持。Codexレビュー指摘)
        SELECT jsonb_object_agg(k, v) INTO v_levels FROM (
            SELECT e.key AS k, max((e.value)::numeric) AS v
              FROM player_damages pd,
                   jsonb_each(COALESCE(pd.levels,
                       jsonb_build_object(COALESCE(pd.boss_level, 0)::text, pd.damage_b))) e
             WHERE pd.player_id = g.player_id AND pd.attribute = g.attribute
               AND pd.slot = ANY(g.slots)
               AND jsonb_typeof(e.value) = 'number'
               AND (e.value)::numeric > 0
             GROUP BY e.key
        ) s;
        IF v_levels IS NULL THEN CONTINUE; END IF;

        -- 互換ミラー (damage_b = 最大値 / boss_level = そのキー。タイは "0" > 高レベル)
        SELECT max((e.value)::numeric) INTO v_best
          FROM jsonb_each(v_levels) e WHERE jsonb_typeof(e.value) = 'number';
        SELECT CASE WHEN bool_or(e.key = '0') THEN NULL ELSE max((e.key)::int) END
          INTO v_boss
          FROM jsonb_each(v_levels) e
         WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric = v_best;
        SELECT max(updated_at) INTO v_upd
          FROM player_damages
         WHERE player_id = g.player_id AND attribute = g.attribute AND slot = ANY(g.slots);

        UPDATE player_damages
           SET levels = v_levels, damage_b = v_best, boss_level = v_boss, updated_at = v_upd
         WHERE player_id = g.player_id AND attribute = g.attribute AND slot = g.slots[1];

        DELETE FROM player_damages
         WHERE player_id = g.player_id AND attribute = g.attribute
           AND slot = ANY(g.slots) AND slot <> g.slots[1];

        v_merged := v_merged + 1;
    END LOOP;
    RAISE NOTICE '同一編成のレベル違いスロットを統合: % グループ', v_merged;
END $$;

-- ---- 4) 不変条件の DB 側強制 (BEFORE トリガー) ----
-- damage_b = levels の最大値 / boss_level = そのキー、が崩れた書き込みが来たら
-- 「(damage_b, boss_level) の単一測定」として levels を畳み直す。
-- 主目的はロールアウト中の**旧クライアント** (levels を知らずに damage_b だけ更新する) —
-- 旧クライアントの世界観は「1行=1測定」なので、この畳み込みがそのまま正しい意味になる。
-- 新クライアントは常にミラー一致で送る (_upsertPlayerDamages) ためこのトリガーは素通り。
CREATE OR REPLACE FUNCTION player_damages_sync_levels() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_max NUMERIC;
    v_key INT;
BEGIN
    IF NEW.levels IS NULL OR jsonb_typeof(NEW.levels) <> 'object' OR NEW.levels = '{}'::jsonb THEN
        RETURN NEW;
    END IF;
    SELECT max((e.value)::numeric) INTO v_max
      FROM jsonb_each(NEW.levels) e WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric > 0;
    IF v_max IS NULL THEN
        NEW.levels := NULL;
        RETURN NEW;
    END IF;
    SELECT CASE WHEN bool_or(e.key = '0') THEN NULL ELSE max((e.key)::int) END INTO v_key
      FROM jsonb_each(NEW.levels) e
     WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric = v_max;
    -- NUMERIC(8,3) への丸めを考慮して比較 (jsonb 側はフル精度で持っているため)
    IF round(v_max, 3) IS DISTINCT FROM NEW.damage_b OR v_key IS DISTINCT FROM NEW.boss_level THEN
        NEW.levels := jsonb_build_object(COALESCE(NEW.boss_level, 0)::text, NEW.damage_b);
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_player_damages_sync_levels ON player_damages;
CREATE TRIGGER trg_player_damages_sync_levels
    BEFORE INSERT OR UPDATE ON player_damages
    FOR EACH ROW EXECUTE FUNCTION player_damages_sync_levels();

COMMENT ON COLUMN player_damages.levels IS
    'レベル別測定値 {"0":14.2,"4":12.5}。キー"0"=未指定(全レベル可)〜"4"、値=B単位。'
    'damage_b=最大値 / boss_level=そのキーの互換ミラー (維持は _upsertPlayerDamages)。'
    '記録レベルLの測定は対象レベル≤Lにだけ使う。';

NOTIFY pgrst, 'reload schema';
