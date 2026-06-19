-- ============================================================================
-- Phase: アバター用 Storage バケット ポリシー
-- ============================================================================
-- 適用前提:
--   1) 13_player_avatars.sql 適用済 (players.avatar_url + avatar_character)
--   2) Supabase Dashboard → Storage で "avatars" バケットを作成済
--      (Public: ON、Allowed MIME: image/*)
-- ============================================================================
-- このSQL は storage.objects テーブルに対する RLS ポリシーを設定する。
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

-- 既存ポリシーを削除 (再実行できるように)
DROP POLICY IF EXISTS "Avatars: public read"   ON storage.objects;
DROP POLICY IF EXISTS "Avatars: public upload" ON storage.objects;
DROP POLICY IF EXISTS "Avatars: public update" ON storage.objects;
DROP POLICY IF EXISTS "Avatars: public delete" ON storage.objects;

-- 誰でも読める (SELECT)
CREATE POLICY "Avatars: public read" ON storage.objects
    FOR SELECT TO public
    USING (bucket_id = 'avatars');

-- 誰でもアップロード可 (INSERT)
CREATE POLICY "Avatars: public upload" ON storage.objects
    FOR INSERT TO public
    WITH CHECK (bucket_id = 'avatars');

-- 誰でも更新可 (UPDATE)
CREATE POLICY "Avatars: public update" ON storage.objects
    FOR UPDATE TO public
    USING (bucket_id = 'avatars')
    WITH CHECK (bucket_id = 'avatars');

-- 誰でも削除可 (DELETE)
CREATE POLICY "Avatars: public delete" ON storage.objects
    FOR DELETE TO public
    USING (bucket_id = 'avatars');

-- 確認用:
-- SELECT policyname, cmd FROM pg_policies
-- WHERE tablename = 'objects' AND policyname LIKE 'Avatars:%';
