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

// ============================================================================
// Phase 6a: Web Push 通知
// ============================================================================
// VAPID公開鍵 (Phase 6a: vapidkeys.com で発行)
// 公開しても安全な性質のキー。秘密鍵は Supabase Edge Function Secrets の
// VAPID_PRIVATE_KEY / VAPID_SUBJECT に登録されている前提。
window.SHIRISU_VAPID_PUBLIC_KEY = 'BI6_g-ZWfqkRGqSQRU5NgEmLmyv8EgvvwgPFv-DDQYv2PzC1SFH-ugNcWGpQHH8E-hoBLnnFy4Yl5XFa3rysNrI';

function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const output = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
    return output;
}

// 端末がPush対応か
window.isPushSupported = function () {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
};

// SW登録 (idempotent)
window.registerPushServiceWorker = async function () {
    if (!window.isPushSupported()) throw new Error('この端末は Push 通知に非対応です');
    const reg = await navigator.serviceWorker.register('./sw.js');
    return reg;
};

// 現在の購読状態を取得
window.getPushSubscriptionStatus = async function () {
    if (!window.isPushSupported()) return { supported: false };
    const perm = Notification.permission;  // 'default' | 'granted' | 'denied'
    if (!navigator.serviceWorker.controller) {
        try { await navigator.serviceWorker.register('./sw.js'); } catch {}
    }
    let sub = null;
    try {
        const reg = await navigator.serviceWorker.ready;
        sub = await reg.pushManager.getSubscription();
    } catch {}
    return {
        supported: true,
        permission: perm,
        subscribed: !!sub,
        endpoint: sub?.endpoint || null,
        vapidConfigured: !!(window.SHIRISU_VAPID_PUBLIC_KEY && window.SHIRISU_VAPID_PUBLIC_KEY.length > 0),
    };
};

// Push通知を購読 (Notification許可も同時に取得)
// 購読情報を push_subscriptions テーブルに保存
window.subscribeToPush = async function (playerId) {
    if (!window.isPushSupported()) throw new Error('この端末は Push 通知に非対応です');
    if (!window.SHIRISU_VAPID_PUBLIC_KEY) throw new Error('VAPID公開鍵が未設定です (運営にお問い合わせ)');
    if (!playerId) throw new Error('プレイヤー未選択です');

    const reg = await window.registerPushServiceWorker();

    // 通知許可リクエスト
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
        throw new Error('通知が許可されませんでした (ブラウザ設定で許可してください)');
    }

    // PushManager で購読
    const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(window.SHIRISU_VAPID_PUBLIC_KEY),
    });

    const json = sub.toJSON();
    const endpoint = sub.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) throw new Error('購読情報の取得に失敗');

    // Supabaseに保存 (endpointユニーク前提)
    const { error } = await supabase
        .from('push_subscriptions')
        .upsert({
            player_id: playerId,
            endpoint,
            p256dh,
            auth,
            user_agent: navigator.userAgent.slice(0, 200),
        }, { onConflict: 'endpoint' });
    if (error) throw error;

    return { endpoint };
};

// Push購読を解除 (端末側 + DB側両方)
window.unsubscribeFromPush = async function () {
    if (!window.isPushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) { console.warn('unsubscribe local error', e); }
    try {
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    } catch (e) { console.warn('unsubscribe db error', e); }
};

// 自身宛のテスト通知を直接表示 (Push経由ではないローカル通知)
// VAPID鍵未設定でも動作確認に使える
window.showLocalTestNotification = async function (title = 'しりすこPAD', body = 'テスト通知です') {
    if (!('Notification' in window)) throw new Error('Notification 非対応');
    if (Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') throw new Error('通知が許可されませんでした');
    }
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification(title, { body, icon: './icon.png', badge: './icon.png' });
            return;
        } catch {}
    }
    new Notification(title, { body, icon: './icon.png' });
};

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

// プレイヤーの属性別ダメージ登録を取得（5属性ぶん、未登録は欠落）
window.supabaseLoadPlayerDamages = async function (playerId) {
    const { data, error } = await supabase
        .from('player_damages')
        .select('attribute, damage_b, updated_at')
        .eq('player_id', playerId);
    if (error) throw error;
    return data || [];
};

// プレイヤーの属性別ダメージを upsert (新規 or 上書き)
window.supabaseSavePlayerDamage = async function (playerId, attribute, damageB) {
    const valid = ['fire','water','iron','electric','wind'];
    if (!valid.includes(attribute)) throw new Error(`invalid attribute: ${attribute}`);
    const value = Number(damageB);
    if (isNaN(value) || value < 0) throw new Error('damageB は0以上の数値で指定');
    const { error } = await supabase
        .from('player_damages')
        .upsert(
            { player_id: playerId, attribute, damage_b: value, updated_at: new Date().toISOString() },
            { onConflict: 'player_id,attribute' }
        );
    if (error) throw error;
};

// プレイヤーの属性別ダメージを1件削除
window.supabaseDeletePlayerDamage = async function (playerId, attribute) {
    const { error } = await supabase
        .from('player_damages')
        .delete()
        .eq('player_id', playerId)
        .eq('attribute', attribute);
    if (error) throw error;
};

// アクティブシーズン + そのボス5体を取得
window.supabaseLoadActiveSeasonWithBosses = async function () {
    const { data: season, error: sErr } = await supabase
        .from('seasons')
        .select('id, month_key, hard_date, current_level, union_rank, is_active')
        .eq('is_active', true)
        .order('hard_date', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (sErr) throw sErr;
    if (!season) return { season: null, bosses: [] };
    const { data: bosses, error: bErr } = await supabase
        .from('bosses')
        .select('boss_number, boss_code, name, attribute, weakness, tier, total_hp_raw, remaining_hp_raw')
        .eq('season_id', season.id)
        .order('boss_number', { ascending: true });
    if (bErr) throw bErr;
    return { season, bosses: bosses || [] };
};

// プレイヤーの本日の凸記録を取得
window.supabaseLoadMyAttacks = async function (playerId, seasonId, date) {
    const { data, error } = await supabase
        .from('attacks')
        .select('id, attack_number, boss_number, boss_code, damage_raw, level, characters, reported_at')
        .eq('season_id', seasonId)
        .eq('player_id', playerId)
        .eq('attack_date', date)
        .order('attack_number', { ascending: true });
    if (error) throw error;
    return data || [];
};

// 凸を1件追加
window.supabaseAddAttack = async function ({ seasonId, playerId, attackDate, bossNumber, bossCode, damageRaw, level, characters }) {
    // attack_number は現在の凸数 + 1
    const { data: existing, error: cErr } = await supabase
        .from('attacks')
        .select('attack_number')
        .eq('season_id', seasonId)
        .eq('player_id', playerId)
        .eq('attack_date', attackDate);
    if (cErr) throw cErr;
    const used = (existing || []).map(x => x.attack_number);
    let attackNumber = 1;
    while (used.includes(attackNumber) && attackNumber <= 3) attackNumber++;
    if (attackNumber > 3) throw new Error('既に3凸済みです');

    const { data, error } = await supabase
        .from('attacks')
        .insert({
            season_id: seasonId,
            player_id: playerId,
            attack_date: attackDate,
            boss_number: bossNumber,
            boss_code: bossCode,
            damage_raw: Math.round(damageRaw),
            attack_number: attackNumber,
            level: level || 1,
            characters: characters || [],
        })
        .select('id, attack_number')
        .single();
    if (error) throw error;
    return data;
};

// 凸を削除
window.supabaseDeleteAttack = async function (attackId) {
    const { error } = await supabase
        .from('attacks')
        .delete()
        .eq('id', attackId);
    if (error) throw error;
};

// 凸のダメージを更新
window.supabaseUpdateAttackDamage = async function (attackId, damageRaw) {
    const { error } = await supabase
        .from('attacks')
        .update({ damage_raw: Math.round(damageRaw) })
        .eq('id', attackId);
    if (error) throw error;
};

// ボスHPを更新（remaining / total を raw 値で）
window.supabaseUpdateBossHp = async function (seasonId, bossNumber, totalRaw, remainingRaw) {
    if (totalRaw < 0 || remainingRaw < 0) throw new Error('HP は0以上で指定');
    if (remainingRaw > totalRaw) throw new Error('残HP は総HP を超えられません');
    const { error } = await supabase
        .from('bosses')
        .update({
            total_hp_raw: Math.round(totalRaw),
            remaining_hp_raw: Math.round(remainingRaw),
            remaining_hp_percent: totalRaw > 0 ? Math.round((remainingRaw / totalRaw) * 100) : 0,
        })
        .eq('season_id', seasonId)
        .eq('boss_number', bossNumber);
    if (error) throw error;
};

// 指定シーズン・日付の全凸を取得（プレイヤー名・ボス名つき）
window.supabaseLoadAllAttacksForSeason = async function (seasonId, attackDate) {
    const { data, error } = await supabase
        .from('attacks')
        .select('id, attack_number, boss_number, boss_code, damage_raw, level, reported_at, player_id, players(name)')
        .eq('season_id', seasonId)
        .eq('attack_date', attackDate)
        .order('reported_at', { ascending: false });
    if (error) throw error;
    return data || [];
};

// 凸のボスを変更
window.supabaseUpdateAttackBoss = async function (attackId, bossNumber, bossCode) {
    const { error } = await supabase
        .from('attacks')
        .update({ boss_number: bossNumber, boss_code: bossCode })
        .eq('id', attackId);
    if (error) throw error;
};

// 新規シーズンを作成（既存アクティブシーズンは自動で非アクティブ化）
// payload: { hardDate, monthKey, bosses: [{bossNumber, bossCode, name, tier}] }
window.supabaseCreateSeason = async function (payload) {
    if (!payload.hardDate) throw new Error('hardDate 必須');
    if (!payload.monthKey) throw new Error('monthKey 必須');
    if (!Array.isArray(payload.bosses) || payload.bosses.length !== 5) throw new Error('boss は5体必要');

    const ATTR_FROM_CODE = { 'H.S.T.A.': 'fire', 'P.S.I.D.': 'water', 'D.M.T.R.': 'iron', 'Z.E.U.S.': 'electric', 'A.N.M.I.': 'wind' };
    const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
    const HARD_LV1_HP = { tyrant: 99856279200, lord: 150841813600 };

    // 既存アクティブシーズンを is_active=false
    const { error: deactivateErr } = await supabase
        .from('seasons').update({ is_active: false }).eq('is_active', true);
    if (deactivateErr) throw deactivateErr;

    // シーズン挿入
    const { data: season, error: sErr } = await supabase
        .from('seasons')
        .insert({
            month_key: payload.monthKey,
            hard_date: payload.hardDate,
            current_level: 1,
            is_active: true,
            metadata: {},
        })
        .select('id, hard_date, month_key')
        .single();
    if (sErr) throw sErr;

    // ボス5体挿入
    const bossRows = payload.bosses.map(b => {
        const attr = ATTR_FROM_CODE[b.bossCode];
        if (!attr) throw new Error(`不明な bossCode: ${b.bossCode}`);
        const tier = b.tier === 'tyrant' ? 'tyrant' : 'lord';
        const hp = HARD_LV1_HP[tier];
        return {
            season_id: season.id,
            boss_number: b.bossNumber,
            boss_code: b.bossCode,
            name: b.name || null,
            attribute: attr,
            weakness: COUNTER[attr],
            tier,
            total_hp_raw: hp,
            remaining_hp_raw: hp,
        };
    });
    const { error: bErr } = await supabase.from('bosses').insert(bossRows);
    if (bErr) throw bErr;
    return season;
};

// アクティブシーズンを終了 (is_active=false + unionRank保存)
window.supabaseEndActiveSeason = async function (unionRank) {
    const ur = (unionRank === '' || unionRank == null) ? null : Number(unionRank);
    const { error } = await supabase
        .from('seasons')
        .update({ is_active: false, union_rank: ur })
        .eq('is_active', true);
    if (error) throw error;
};

// シーズンのレベルを変更し、ボスHPを新レベルのデフォルト値にリセット
window.supabaseLevelUpSeason = async function (seasonId, newLevel) {
    const HARD_LEVEL_HP = {
        1: { tyrant: 99856279200, lord: 150841813600 },
        2: { tyrant: 149784418800, lord: 226262720400 },
        3: { tyrant: 292445295750, lord: 349230901500 },
    };
    const hp = HARD_LEVEL_HP[newLevel];
    if (!hp) throw new Error(`Lv${newLevel} のHPデフォルトが未定義です`);

    // シーズンレベル更新
    const { error: e1 } = await supabase
        .from('seasons').update({ current_level: newLevel }).eq('id', seasonId);
    if (e1) throw e1;

    // ボスHPを階級ごとにリセット
    for (const tier of ['tyrant', 'lord']) {
        const { error } = await supabase
            .from('bosses')
            .update({ total_hp_raw: hp[tier], remaining_hp_raw: hp[tier], remaining_hp_percent: 100 })
            .eq('season_id', seasonId)
            .eq('tier', tier);
        if (error) throw error;
    }
};

// ============================================================================
// Edge Function: analyze-image (Anthropic Haiku Vision プロキシ)
// ============================================================================
// 画像 (data URL) と task を渡して構造化結果を受け取る
// task: 'attack_result' / 'bla_progress' / 'season_announce'
window.callAiVision = async function (imageDataUrl, task, options = {}) {
    const { data, error } = await supabase.functions.invoke('dynamic-service', {
        body: { image: imageDataUrl, task, ...options },
    });
    if (error) {
        throw new Error(`AI Vision呼び出し失敗: ${error.message || error}`);
    }
    if (!data?.ok) {
        throw new Error(data?.error || 'AI Vision エラー');
    }
    return data;  // { ok, result, raw, parseError, usage }
};

// ファイル(File) を data URL に変換するヘルパー
window.fileToDataUrl = function (file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

// Anthropic Haiku テキスト推論 (Phase 4d): context をプロンプトに渡して結果取得
// task: 'finish_recommend' などの定義済みタスク名
window.callAiRecommend = async function (context, task, options = {}) {
    const { data, error } = await supabase.functions.invoke('dynamic-service', {
        body: { context, task, ...options },
    });
    if (error) throw new Error(`AI推論失敗: ${error.message || error}`);
    if (!data?.ok) throw new Error(data?.error || 'AI推論エラー');
    return data;
};

// 動作テスト用 (コンソールで window.supabaseTestAi() を実行)
window.supabaseTestAi = async function () {
    console.log('[AI Vision] テストするには画像ファイルを選んでください...');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const dataUrl = await window.fileToDataUrl(file);
        console.log('[AI Vision] 解析中...');
        try {
            const res = await window.callAiVision(dataUrl, 'attack_result');
            console.log('[AI Vision] 結果:', res);
        } catch (e) {
            console.error('[AI Vision] エラー:', e);
        }
    };
    input.click();
};

// 全プレイヤーの属性別ダメージ登録を全削除
window.supabaseResetAllDamages = async function () {
    const { error } = await supabase
        .from('player_damages')
        .delete()
        .gte('player_id', 0);  // 全件削除のため常にtrueの条件
    if (error) throw error;
};

// 運営ダッシュボード用: 全アクティブメンバーを取得し、その人の各種関連情報を結合
// 戻り値: [{ id, name, archived, damagesByAttr:{fire:N,...}, attacks:[{boss_number, damage_raw, ...}], attackCount }]
window.supabaseLoadOpsDashboardData = async function () {
    const ctx = await window.supabaseLoadActiveSeasonWithBosses();
    const { season, bosses } = ctx || { season: null, bosses: [] };

    // 1) アクティブメンバー
    const { data: players, error: pErr } = await supabase
        .from('players')
        .select('id, name, archived')
        .or('archived.is.null,archived.eq.false')
        .order('name', { ascending: true });
    if (pErr) throw pErr;

    // 2) 全プレイヤーの player_damages を一括取得
    const { data: dmgs, error: dErr } = await supabase
        .from('player_damages')
        .select('player_id, attribute, damage_b, updated_at');
    if (dErr) throw dErr;
    const dmgByPlayer = new Map();
    (dmgs || []).forEach(d => {
        if (!dmgByPlayer.has(d.player_id)) dmgByPlayer.set(d.player_id, {});
        dmgByPlayer.get(d.player_id)[d.attribute] = Number(d.damage_b) || 0;
    });

    // 3) アクティブシーズンの全凸を一括取得
    let attacksByPlayer = new Map();
    if (season) {
        const { data: atks, error: aErr } = await supabase
            .from('attacks')
            .select('id, player_id, attack_number, boss_number, boss_code, damage_raw, level')
            .eq('season_id', season.id)
            .eq('attack_date', season.hard_date);
        if (aErr) throw aErr;
        (atks || []).forEach(a => {
            if (!attacksByPlayer.has(a.player_id)) attacksByPlayer.set(a.player_id, []);
            attacksByPlayer.get(a.player_id).push(a);
        });
    }

    const result = (players || []).map(p => ({
        id: p.id,
        name: p.name,
        damagesByAttr: dmgByPlayer.get(p.id) || {},
        attacks: attacksByPlayer.get(p.id) || [],
        attackCount: (attacksByPlayer.get(p.id) || []).length,
    }));
    return { season, bosses, players: result };
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
