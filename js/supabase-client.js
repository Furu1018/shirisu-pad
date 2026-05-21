// ============================================================================
// しりすこPAD Supabase クライアント設定
// ============================================================================
// このファイルは index.html から module として読み込まれる想定。
// Publishable key は公開しても安全な性質のキーだが、変更が必要なら
// Supabase Dashboard → Project Settings → API から取得して更新する。
//
// 使い方:
//   import { supabase } from './js/supabase-client.js';
//   const { data, error } = await supabase.from('players').select('*');
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://djahnbzwupxcekneydid.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_UHIiSKofk_9Ck56Jrhi7fA__YjZS3pJ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
        persistSession: false,  // 認証未使用のため
        autoRefreshToken: false,
    },
});

// 接続テスト用ヘルパー: ブラウザコンソールで window.supabaseTest() を実行
window.supabaseTest = async function () {
    console.group('🔌 Supabase 接続テスト');
    try {
        const { data: seasons, error: sErr } = await supabase
            .from('seasons')
            .select('month_key, hard_date, union_rank, is_active')
            .order('month_key', { ascending: false })
            .limit(5);
        if (sErr) throw sErr;
        console.log('✅ seasons (最新5件):', seasons);

        const { count: playerCount } = await supabase
            .from('players')
            .select('*', { count: 'exact', head: true });
        console.log(`✅ players: ${playerCount} 名`);

        const { count: attackCount } = await supabase
            .from('attacks')
            .select('*', { count: 'exact', head: true });
        console.log(`✅ attacks: ${attackCount} 件`);

        console.log('🎉 Supabase 接続OK');
    } catch (err) {
        console.error('❌ Supabase 接続エラー:', err);
        console.log('チェック: ① schema/RLS SQL を実行したか ② SUPABASE_URL/KEY が正しいか');
    }
    console.groupEnd();
};

// ページロード時に1回だけサイレント接続確認（エラー時のみコンソール警告）
(async () => {
    try {
        const { error } = await supabase.from('seasons').select('id').limit(1);
        if (error) {
            console.warn('[Supabase] 初期接続に失敗:', error.message);
            console.warn('[Supabase] テストするには window.supabaseTest() を実行');
        } else {
            console.log('[Supabase] 接続OK (window.supabaseTest() で詳細確認可)');
        }
    } catch (e) {
        console.warn('[Supabase] 初期化エラー:', e);
    }
})();
