-- ============================================================================
-- Phase: メンバーアバター対応
-- 各プレイヤーが (a) キャラマスタから選んだキャラのアイコン
--          または (b) Supabase Storage にアップロードした独自画像
-- を自分のアバターとして使えるようにする。
-- ============================================================================
-- 適用:
--   1) このSQL を Supabase Dashboard → SQL Editor で実行
--   2) Storage バケット "avatars" を Dashboard で作成
--      (Storage → New bucket → name: avatars / Public: ON)
--   3) avatars バケットのポリシーを下記のように設定:
--      - SELECT (read): true (誰でも読める)
--      - INSERT (upload): true (誰でもアップ可、PADで完結)
--      - UPDATE / DELETE: true (本人差替/削除可)
-- ============================================================================

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS avatar_character TEXT;

-- avatar_character は nikke_characters.canonical_name を指す想定。
-- 外部キーは設定しない (キャラ削除時にアバター参照を残しておくため、
--  resolveAvatar 側で nikke_characters とジョインして解決する)。

NOTIFY pgrst, 'reload schema';
