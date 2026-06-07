-- ============================================================================
-- Phase: NIKKE キャラクターマスタ + 編成リンク
-- 凸結果OCRから抽出したキャラ名を自動学習で蓄積し、最適プラン算出時の
-- 「同一キャラ使い回し」衝突を自動検出するための土台
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

-- ===== Nikke Characters マスタ =====
-- OCRで観測したキャラ名を逐次追加。3回以上見たら自動 confirmed。
-- 類似名 (OCRゆれ・全角コロン等) は aliases に取り込んで統合運用。
CREATE TABLE IF NOT EXISTS nikke_characters (
    canonical_name   TEXT PRIMARY KEY,
    base_name        TEXT NOT NULL,                   -- ":" の前部分 (スキン違い統合用)
    aliases          TEXT[] NOT NULL DEFAULT '{}',    -- OCRゆれ ["ラピ：レッドフ", "Rapi:RedHood"]
    sighting_count   INT NOT NULL DEFAULT 0,
    first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_confirmed     BOOLEAN NOT NULL DEFAULT FALSE,  -- 3回以上 or 運営手動で true
    notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_nikke_characters_base
    ON nikke_characters(base_name);
CREATE INDEX IF NOT EXISTS idx_nikke_characters_count
    ON nikke_characters(sighting_count DESC);

ALTER TABLE nikke_characters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON nikke_characters;
CREATE POLICY "anon_all" ON nikke_characters
    FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON nikke_characters;
CREATE POLICY "authenticated_all" ON nikke_characters
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ===== player_damages に編成カラムを追加 =====
-- その属性で「ベスト火力を出す編成」の5キャラ名 (canonical_name 配列)。
-- 凸報告OCR/模擬戦OCR/手動編集 のいずれでも更新可。
-- 最適プラン算出時の衝突チェックに使う。
ALTER TABLE player_damages
    ADD COLUMN IF NOT EXISTS characters TEXT[] NOT NULL DEFAULT '{}';

-- スキーマキャッシュ反映 (任意)
NOTIFY pgrst, 'reload schema';
