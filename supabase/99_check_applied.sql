-- ============================================================================
-- 99_check_applied.sql — マイグレーション適用状況チェッカー
-- ----------------------------------------------------------------------------
-- SQL Editor でこのファイル全体を実行すると、01〜23 の各マイグレーションが
-- 適用済みかどうかを一覧で返す (applied=false の行が未適用)。
-- カタログ (pg_catalog / information_schema) のみ参照するため、
-- どのテーブルが欠けていても全体がエラーにならず、常に全行の判定が返る。
--
-- 使いどころ:
--   - 新しい Supabase プロジェクトを立てたとき
--   - 別PC/新環境で「機能が静かに壊れている」疑いがあるとき
--   - 新しいマイグレーションを足したとき (このファイルにも判定行を1行追加すること)
--
-- 注意: 03_seed_data は初期シード (本番運用後は再実行禁止)。
--       applied=false でも players に運用データが入っていれば問題ない。
-- ============================================================================

WITH col AS (
    -- カラム存在チェック用ヘルパー (public スキーマ)
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
)
SELECT * FROM (
    SELECT '01_schema' AS migration,
           (to_regclass('public.players') IS NOT NULL
            AND to_regclass('public.seasons') IS NOT NULL
            AND to_regclass('public.bosses') IS NOT NULL
            AND to_regclass('public.attacks') IS NOT NULL) AS applied,
           '基本テーブル群 (players/seasons/bosses/attacks ほか)' AS what

    UNION ALL SELECT '02_rls',
        EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'players' AND policyname = 'anon_all'),
        'RLS: anon 全許可ポリシー (内輪運用の割り切り)'

    UNION ALL SELECT '03_seed_data',
        NULL,
        '初期シード — カタログから判定不可。players に運用データがあれば適用不要 (本番で再実行禁止)'

    UNION ALL SELECT '04_archived_column',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'players' AND column_name = 'archived'),
        'players.archived (メンバーのアーカイブ)'

    UNION ALL SELECT '05_test_season',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'seasons' AND column_name = 'is_test'),
        'seasons.is_test (テストシーズン)'

    UNION ALL SELECT '06_push_notifications_log',
        to_regclass('public.push_notifications_log') IS NOT NULL,
        'Push 送信ログテーブル'

    UNION ALL SELECT '07_nikke_characters_and_team_links',
        to_regclass('public.nikke_characters') IS NOT NULL,
        'キャラマスタ + attacks/player_damages.characters'

    UNION ALL SELECT '08_nikke_characters_icons',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'nikke_characters' AND column_name = 'icon_paths'),
        'nikke_characters.icon_paths (アイコン紐付け)'

    UNION ALL SELECT '09_drop_base_name',
        (to_regclass('public.nikke_characters') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM col WHERE table_name = 'nikke_characters' AND column_name = 'base_name')),
        'nikke_characters.base_name の削除 (無いこと が正)'

    UNION ALL SELECT '10_availability_hourly',
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'availability_time_slot_check'
                  -- 10 は制約を正規表現 CHECK (time_slot ~ '^h(...)$') で張り直す。
                  -- 'h23' の文字列は定義に現れないため、正規表現の署名で判定する
                  AND pg_get_constraintdef(oid) LIKE '%^h(%'),
        'availability を1時間刻み (h00〜h23) に移行'

    UNION ALL SELECT '11_finish_coordinations',
        to_regclass('public.finish_coordinations') IS NOT NULL,
        '締め凸オンライン協力テーブル'

    UNION ALL SELECT '12_finish_coord_status',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'finish_coordinations' AND column_name = 'status'),
        'finish_coordinations.status'

    UNION ALL SELECT '13_player_avatars',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'players' AND column_name = 'avatar_url'),
        'players.avatar_url / avatar_character'

    UNION ALL SELECT '14_avatar_storage_policies',
        EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'Avatars: public read'),
        'Storage avatars バケットのポリシー (バケット自体は Dashboard で手動作成)'

    UNION ALL SELECT '15_player_strong_attrs',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'players' AND column_name = 'strong_attributes'),
        'players.strong_attributes (得意属性)'

    UNION ALL SELECT '16_finish_coord_practicing',
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'finish_coordinations_status_check'
                  AND pg_get_constraintdef(oid) LIKE '%practicing%'),
        'status に practicing (模擬中) を追加'

    UNION ALL SELECT '17_published_plans',
        to_regclass('public.published_plans') IS NOT NULL,
        '凸プラン配信 (📤)'

    UNION ALL SELECT '18_availability_prefs',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'players' AND column_name = 'flex_time'),
        'players.flex_time / notify_all_hours (⏳隙間型・🔔いつでも通知)'

    UNION ALL SELECT '19_activity_log',
        to_regclass('public.activity_log') IS NOT NULL,
        '詳細アクティビティログ'

    UNION ALL SELECT '20_bosses_updated_at',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'bosses' AND column_name = 'updated_at'),
        'bosses.updated_at (HP鮮度表示)'

    UNION ALL SELECT '21_player_damages_slots',
        EXISTS (SELECT 1 FROM col WHERE table_name = 'player_damages' AND column_name = 'slot'),
        'player_damages.slot (1属性2編成)'

    UNION ALL SELECT '22_finish_requests',
        to_regclass('public.finish_requests') IS NOT NULL,
        '締め凸依頼ステータス (pending/accepted/declined)'

    UNION ALL SELECT '23_restore_helpers',
        to_regproc('public.restore_fix_sequences') IS NOT NULL,
        'バックアップ復元用 RPC (設定タブの復元機能に必須)'

    UNION ALL SELECT '(storage bucket)',
        EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'avatars'),
        'avatars バケット (Dashboard → Storage で手動作成)'

    UNION ALL SELECT '(edge functions)',
        NULL,
        'send-push / analyze-image (slug: dynamic-service) — SQLから判定不可。Dashboard → Edge Functions で確認'
) t
ORDER BY migration;
