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

// ----------------------------------------------------------------------------
// データローダ: Supabase の正規化テーブルから既存JSON形式へ変換して返す
// (autoLoadData() から呼び出される。JSONフォーマット互換のため processRawData
// はそのまま再利用できる)
// ----------------------------------------------------------------------------
window.supabaseLoadLatestSeasons = async function (limit = 2) {
    // 1) 最新シーズン (hard_date 降順)
    const { data: seasons, error: sErr } = await supabase
        .from('seasons')
        .select('id, month_key, hard_date, union_rank, metadata')
        .order('hard_date', { ascending: false })
        .limit(limit);
    if (sErr) throw sErr;
    if (!seasons || seasons.length === 0) return [];

    const result = [];
    for (const s of seasons) {
        // 2) SLv 履歴
        const { data: syncs, error: slErr } = await supabase
            .from('player_sync_levels')
            .select('sync_level, players(name)')
            .eq('season_id', s.id);
        if (slErr) throw slErr;
        const syncMap = new Map();
        (syncs || []).forEach(x => {
            if (x.players?.name) syncMap.set(x.players.name, x.sync_level);
        });

        // 3a) このシーズンのボス情報を別途取得 (boss_code -> name のマップを構築)
        const { data: bossesRows, error: bErr } = await supabase
            .from('bosses')
            .select('boss_number, boss_code, name')
            .eq('season_id', s.id);
        if (bErr) throw bErr;
        const bossNameByCode = new Map();
        const bossNumberByCode = new Map();
        (bossesRows || []).forEach(b => {
            bossNameByCode.set(b.boss_code, b.name);
            bossNumberByCode.set(b.boss_code, b.boss_number);
        });

        // 3b) 凸記録 (プレイヤー名のみネスト。bosses は複合FKのため別取得)
        const { data: atks, error: aErr } = await supabase
            .from('attacks')
            .select('attack_number, damage_raw, level, characters, boss_code, boss_number, players(name)')
            .eq('season_id', s.id)
            .order('attack_number', { ascending: true });
        if (aErr) throw aErr;

        // 4) Fururi 模擬戦スコア
        const { data: sims, error: simErr } = await supabase
            .from('fururi_simulation_scores')
            .select('boss_code, damage_raw')
            .eq('season_id', s.id);
        if (simErr) throw simErr;
        const simScores = {};
        (sims || []).forEach(x => { simScores[x.boss_code] = Number(x.damage_raw); });

        // 5) プレイヤー単位に集約
        const playersMap = new Map();
        (atks || []).forEach(a => {
            const name = a.players?.name;
            if (!name) return;
            if (!playersMap.has(name)) {
                playersMap.set(name, {
                    player: name,
                    totalDamage: 0,
                    attackCount: 0,
                    syncLevel: syncMap.get(name) || 0,
                    attacks: [],
                });
            }
            const p = playersMap.get(name);
            const damage = Number(a.damage_raw) || 0;
            p.totalDamage += damage;
            p.attackCount += 1;
            p.attacks.push({
                bossType: bossNameByCode.get(a.boss_code) || a.boss_code,
                bossCode: a.boss_code,
                difficulty: 'HARD',
                level: a.level || 1,
                damage,
                characters: Array.isArray(a.characters) ? a.characters : [],
            });
        });

        // 凸ゼロでもSLv登録があれば player として含める
        for (const [name, slv] of syncMap.entries()) {
            if (!playersMap.has(name)) {
                playersMap.set(name, {
                    player: name,
                    totalDamage: 0,
                    attackCount: 0,
                    syncLevel: slv,
                    attacks: [],
                });
            }
        }

        const players = Array.from(playersMap.values());
        const metadata = {
            ...(s.metadata || {}),
            unionRank: s.union_rank ?? (s.metadata && s.metadata.unionRank) ?? null,
        };
        if (Object.keys(simScores).length > 0) {
            metadata.fururiSimulationScores = simScores;
        }

        result.push({ key: s.month_key, json: { players, metadata } });
    }
    return result;
};

// 全プレイヤー一覧を取得（脱退者除く、name 昇順）
// includeArchived=true で脱退者も含める（メンバー管理画面用）
window.supabaseLoadAllPlayers = async function (includeArchived = false) {
    let query = supabase
        .from('players')
        .select('id, name, is_temp, archived')
        .order('name', { ascending: true });
    if (!includeArchived) {
        query = query.or('archived.is.null,archived.eq.false');
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
};

// 新規メンバー追加
window.supabaseAddPlayer = async function (name) {
    const cleaned = (name || '').trim();
    if (!cleaned) throw new Error('名前が空です');
    const { data, error } = await supabase
        .from('players')
        .insert({ name: cleaned })
        .select('id, name')
        .single();
    if (error) throw error;
    return data;
};

// プレイヤーを脱退扱い (archived=true) にする
window.supabaseArchivePlayer = async function (playerId) {
    const { error } = await supabase
        .from('players')
        .update({ archived: true })
        .eq('id', playerId);
    if (error) throw error;
};

// 脱退扱いから復活
window.supabaseUnarchivePlayer = async function (playerId) {
    const { error } = await supabase
        .from('players')
        .update({ archived: false })
        .eq('id', playerId);
    if (error) throw error;
};

// プレイヤー名を変更
window.supabaseRenamePlayer = async function (playerId, newName) {
    const cleaned = (newName || '').trim();
    if (!cleaned) throw new Error('名前が空です');
    const { error } = await supabase
        .from('players')
        .update({ name: cleaned })
        .eq('id', playerId);
    if (error) throw error;
};

// プレイヤーを完全削除（過去の凸データもCASCADEで消える、危険操作）
window.supabaseDeletePlayer = async function (playerId) {
    const { error } = await supabase
        .from('players')
        .delete()
        .eq('id', playerId);
    if (error) throw error;
};

// プレイヤーを ID で取得（存在チェック用）
window.supabaseGetPlayerById = async function (playerId) {
    const { data, error } = await supabase
        .from('players')
        .select('id, name')
        .eq('id', playerId)
        .single();
    if (error) return null;
    return data;
};

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
