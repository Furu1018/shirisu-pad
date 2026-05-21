-- ============================================================================
-- しりすこPAD Supabase RLS Policies (Phase 0)
-- ============================================================================
-- 初期: しりすこ内輪向けに anon 全許可（読み書き両方）
-- 将来 Supabase Auth を導入時に、auth.uid() ベースに段階的に締める想定
-- ============================================================================

-- 全テーブルで RLS を有効化（"Enable automatic RLS" でほぼ自動だが念のため）
ALTER TABLE players               ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_damages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons               ENABLE ROW LEVEL SECURITY;
ALTER TABLE bosses                ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_sync_levels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE attacks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_offs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability          ENABLE ROW LEVEL SECURITY;
ALTER TABLE finish_claims         ENABLE ROW LEVEL SECURITY;
ALTER TABLE fururi_simulation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions    ENABLE ROW LEVEL SECURITY;

-- ===== 全テーブル: anon に全操作許可（初期版） =====
-- 後で auth.uid() ベースに置き換える際は DROP POLICY → 新規 CREATE POLICY で差し替え

DO $$
DECLARE
    t TEXT;
    tables TEXT[] := ARRAY[
        'players','player_damages','seasons','bosses','player_sync_levels',
        'attacks','day_offs','availability','finish_claims',
        'fururi_simulation_scores','push_subscriptions'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS "anon_all" ON %I', t);
        EXECUTE format('CREATE POLICY "anon_all" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
        EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON %I', t);
        EXECUTE format('CREATE POLICY "authenticated_all" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
    END LOOP;
END $$;
