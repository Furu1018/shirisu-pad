-- ============================================================================
-- Phase: バースト枠を意識した編成ピッカー
-- nikke_characters.burst_alt — 「複数バーストで使えるキャラ」のサブバースト。
-- 例: ラピ：レッドフード は表示上 B3 だが B1 枠としても使える → burst='B3', burst_alt='B1'
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- 冪等 (再実行可)。前提: 24_nikke_burst.sql
-- ============================================================================

ALTER TABLE public.nikke_characters ADD COLUMN IF NOT EXISTS burst_alt text;

-- 値の制約 (burst と同じ語彙)。再実行できるよう DROP → ADD
ALTER TABLE public.nikke_characters DROP CONSTRAINT IF EXISTS nikke_characters_burst_alt_check;
ALTER TABLE public.nikke_characters ADD CONSTRAINT nikke_characters_burst_alt_check
    CHECK (burst_alt IS NULL OR burst_alt IN ('B1','B2','B3','BΛ'));

-- サブは主バーストと同じ値にできない (同じなら情報量ゼロ = 入力ミス)。
-- 主が未設定なのにサブだけある状態も禁止 (表示の主が決まらないため)
ALTER TABLE public.nikke_characters DROP CONSTRAINT IF EXISTS nikke_characters_burst_alt_distinct;
ALTER TABLE public.nikke_characters ADD CONSTRAINT nikke_characters_burst_alt_distinct
    CHECK (burst_alt IS NULL OR (burst IS NOT NULL AND burst_alt <> burst));

-- ---------------------------------------------------------------------------
-- 既知のサブバースト投入 (現時点で確実に分かっている1件のみ。
-- 他のバーストチェンジ系キャラは 設定タブ → キャラ管理 → 編集 から手動で足す)
-- ---------------------------------------------------------------------------
-- 24_nikke_burst.sql では半角コロン表記で登録済み。全角表記の揺れも拾っておく。
UPDATE public.nikke_characters SET burst_alt = 'B1'
 WHERE canonical_name IN ('ラピ:レッドフード', 'ラピ：レッドフード')
   AND burst = 'B3';

NOTIFY pgrst, 'reload schema';   -- API にカラムを即認識させる
