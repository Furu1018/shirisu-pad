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

// Edge Function 'send-push' (slug は実デプロイ先に合わせる) で Push送信
// 引数: { title, body, url?, tag?, playerIds?, requireInteraction? }
// playerIds 未指定なら全購読者へ配信
window.sendPushNotification = async function (payload, opts = {}) {
    const slug = opts.functionName || 'send-push';
    const { data, error } = await supabase.functions.invoke(slug, { body: payload });
    if (error) throw new Error(`Push送信失敗: ${error.message || error}`);
    if (!data?.ok) throw new Error(data?.error || 'Push送信エラー');

    // 履歴記録 (失敗してもメイン送信処理は止めない)
    try {
        const isSpecific = Array.isArray(payload.playerIds) && payload.playerIds.length > 0;
        await supabase.from('push_notifications_log').insert({
            title: payload.title || '',
            body: payload.body || '',
            url: payload.url || null,
            target_kind: isSpecific ? 'specific' : 'all',
            target_player_ids: isSpecific ? payload.playerIds : null,
            sender_player_id: opts.senderPlayerId || null,
            sent_count: Number(data.sent) || 0,
            target_count: Number(data.target) || (isSpecific ? payload.playerIds.length : 0),
        });
    } catch (e) { console.warn('[push log] insert skipped:', e?.message || e); }

    return data;
};

// 通知履歴をロード。playerId 指定時は自分宛 (broadcast or 含まれる) のみ。
window.supabaseLoadRecentNotifications = async function (limit = 30, playerId = null) {
    const { data, error } = await supabase
        .from('push_notifications_log')
        .select('id, sent_at, title, body, url, target_kind, target_player_ids, sender_player_id, sent_count, target_count')
        .order('sent_at', { ascending: false })
        .limit(Math.max(limit * 2, 50));
    if (error) throw error;
    let rows = data || [];
    if (playerId != null) {
        rows = rows.filter(r =>
            r.target_kind === 'all'
            || (Array.isArray(r.target_player_ids) && r.target_player_ids.includes(playerId))
        );
    }
    return rows.slice(0, limit);
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
    // 1) 最新シーズン (hard_date 降順)。テストシーズンは比較・ふるり値の対象外。
    const { data: seasons, error: sErr } = await supabase
        .from('seasons')
        .select('id, month_key, hard_date, union_rank, metadata')
        .eq('is_test', false)
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
    // characters カラム未マイグの環境でも壊れないよう2段階フォールバック
    try {
        const r = await supabase
            .from('player_damages')
            .select('attribute, damage_b, updated_at, characters')
            .eq('player_id', playerId);
        if (!r.error) return r.data || [];
    } catch { /* fallthrough */ }
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

// プレイヤーの通知受信可能時間帯 (availability) を取得
// 戻り値: ['morning','noon',...] (空配列なら未登録=全時間帯OK扱い)
window.supabaseLoadAvailability = async function (playerId) {
    const { data, error } = await supabase
        .from('availability')
        .select('time_slot')
        .eq('player_id', playerId);
    if (error) throw error;
    return (data || []).map(d => d.time_slot);
};

// プレイヤーの availability を slots[] で上書き
window.supabaseSaveAvailability = async function (playerId, slots) {
    const valid = ['morning','noon','evening','night','latenight'];
    const clean = (slots || []).filter(s => valid.includes(s));
    // 一旦全削除して入れ直し
    const { error: dErr } = await supabase
        .from('availability')
        .delete()
        .eq('player_id', playerId);
    if (dErr) throw dErr;
    if (clean.length === 0) return;
    const rows = clean.map(s => ({ player_id: playerId, time_slot: s }));
    const { error: iErr } = await supabase
        .from('availability')
        .insert(rows);
    if (iErr) throw iErr;
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
        .select('id, month_key, hard_date, current_level, union_rank, is_active, is_test')
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
window.supabaseAddAttack = async function ({ seasonId, playerId, attackDate, bossNumber, bossCode, damageRaw, level, characters }, opts = {}) {
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

    // ボス残HPを自動的に減算 (OCRで残HPを正確に書き換える場合は skipHpDecrement=true で skip)
    if (!opts.skipHpDecrement && damageRaw > 0) {
        try {
            const { data: boss } = await supabase
                .from('bosses')
                .select('remaining_hp_raw')
                .eq('season_id', seasonId)
                .eq('boss_number', bossNumber)
                .single();
            if (boss) {
                const newRem = Math.max(0, Number(boss.remaining_hp_raw || 0) - Math.round(damageRaw));
                await supabase
                    .from('bosses')
                    .update({ remaining_hp_raw: newRem })
                    .eq('season_id', seasonId)
                    .eq('boss_number', bossNumber);
            }
        } catch (e) { console.warn('[boss hp auto-decrement] failed:', e?.message || e); }
    }

    return data;
};

// 凸を削除 (ボス残HPを復元: damage_raw 分を total_hp_raw で頭打ちにして加算)
window.supabaseDeleteAttack = async function (attackId) {
    const { data: old, error: oErr } = await supabase
        .from('attacks')
        .select('damage_raw, season_id, boss_number')
        .eq('id', attackId)
        .single();
    if (oErr) throw oErr;

    const { error } = await supabase
        .from('attacks')
        .delete()
        .eq('id', attackId);
    if (error) throw error;

    const dmg = Math.round(Number(old?.damage_raw) || 0);
    if (dmg > 0 && old) {
        try {
            const { data: boss } = await supabase
                .from('bosses')
                .select('remaining_hp_raw, total_hp_raw')
                .eq('season_id', old.season_id)
                .eq('boss_number', old.boss_number)
                .single();
            if (boss) {
                const newRem = Math.min(Number(boss.total_hp_raw || 0), Number(boss.remaining_hp_raw || 0) + dmg);
                await supabase
                    .from('bosses')
                    .update({ remaining_hp_raw: newRem })
                    .eq('season_id', old.season_id)
                    .eq('boss_number', old.boss_number);
            }
        } catch (e) { console.warn('[boss hp restore on delete] failed:', e?.message || e); }
    }
};

// 凸のダメージを更新 (差分をボス残HPに反映)
window.supabaseUpdateAttackDamage = async function (attackId, damageRaw) {
    const { data: old, error: oErr } = await supabase
        .from('attacks')
        .select('damage_raw, season_id, boss_number')
        .eq('id', attackId)
        .single();
    if (oErr) throw oErr;
    const newDmg = Math.round(damageRaw);
    const delta = newDmg - Math.round(Number(old?.damage_raw) || 0);

    const { error } = await supabase
        .from('attacks')
        .update({ damage_raw: newDmg })
        .eq('id', attackId);
    if (error) throw error;

    if (delta !== 0 && old) {
        try {
            const { data: boss } = await supabase
                .from('bosses')
                .select('remaining_hp_raw, total_hp_raw')
                .eq('season_id', old.season_id)
                .eq('boss_number', old.boss_number)
                .single();
            if (boss) {
                // 凸ダメージが増えた=残HP減る、減った=残HP戻る
                const newRem = Math.max(0, Math.min(Number(boss.total_hp_raw || 0), Number(boss.remaining_hp_raw || 0) - delta));
                await supabase
                    .from('bosses')
                    .update({ remaining_hp_raw: newRem })
                    .eq('season_id', old.season_id)
                    .eq('boss_number', old.boss_number);
            }
        } catch (e) { console.warn('[boss hp delta on update] failed:', e?.message || e); }
    }
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
// payload: { hardDate, monthKey, bosses: [...], isTest?, seedFromPrevious? }
window.supabaseCreateSeason = async function (payload) {
    if (!payload.hardDate) throw new Error('hardDate 必須');
    if (!payload.monthKey) throw new Error('monthKey 必須');
    if (!Array.isArray(payload.bosses) || payload.bosses.length !== 5) throw new Error('boss は5体必要');

    const ATTR_FROM_CODE = { 'H.S.T.A.': 'fire', 'P.S.I.D.': 'water', 'D.M.T.R.': 'iron', 'Z.E.U.S.': 'electric', 'A.N.M.I.': 'wind' };
    const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
    const HARD_LV1_HP = { tyrant: 99856279200, lord: 150841813600 };

    const isTest = !!payload.isTest;

    // テストシーズンの場合: 現在の player_damages をスナップショットして metadata に保存
    let metadata = {};
    if (isTest) {
        const { data: dmgs } = await supabase
            .from('player_damages')
            .select('player_id, attribute, damage_b');
        metadata = { is_test: true, damages_snapshot: dmgs || [] };
    }

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
            is_test: isTest,
            metadata,
        })
        .select('id, hard_date, month_key, is_test')
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

    // 前回レイド実績からダメージ + 編成 を初期登録
    let seededCount = 0, charactersSeeded = 0;
    if (payload.seedFromPrevious) {
        const r = await window.supabaseSeedDamagesFromPreviousSeason(season.id);
        seededCount = r.seeded || 0;
        charactersSeeded = r.charactersSeeded || 0;
    }

    return { ...season, seededCount, charactersSeeded };
};

// 前回レイドの実攻撃ダメージから各メンバーの属性別ダメージを初期登録
// 同じPT属性に複数回凸している場合は「最大値」を採用
// newSeasonId: 今作成したシーズン (除外用)
window.supabaseSeedDamagesFromPreviousSeason = async function (newSeasonId) {
    // 直近の前シーズン (新シーズンを除く、テストシーズン除外、hard_date 降順で先頭)
    const { data: seasons, error: sErr } = await supabase
        .from('seasons')
        .select('id, hard_date')
        .neq('id', newSeasonId)
        .eq('is_test', false)
        .order('hard_date', { ascending: false })
        .limit(1);
    if (sErr) throw sErr;
    if (!seasons || seasons.length === 0) return { seeded: 0, reason: 'no_previous' };
    const prevId = seasons[0].id;

    // 前シーズンのボス boss_code -> weakness(=PT属性)
    const { data: bosses } = await supabase
        .from('bosses').select('boss_code, weakness').eq('season_id', prevId);
    const weaknessByCode = new Map((bosses || []).map(b => [b.boss_code, b.weakness]));

    // 前シーズンの全攻撃 (characters カラム未マイグ環境ではフォールバック)
    let atks = null;
    try {
        const r = await supabase
            .from('attacks').select('player_id, boss_code, damage_raw, characters').eq('season_id', prevId);
        if (!r.error) atks = r.data;
    } catch { /* fallthrough */ }
    if (atks == null) {
        const r2 = await supabase
            .from('attacks').select('player_id, boss_code, damage_raw').eq('season_id', prevId);
        atks = r2.data;
    }

    // 古いスキーマで attacks.characters に画像パス (./character-images/xxx.webp) が
    // 保存されているケースを除外。本物のキャラ名だけを通す。
    const _isLikelyCharName = (s) => {
        if (typeof s !== 'string') return false;
        const t = s.trim();
        if (t.length === 0 || t.length > 40) return false;
        if (t.includes('/') || t.includes('\\')) return false;        // ファイルパス
        if (/\.(webp|png|jpg|jpeg|gif|svg)$/i.test(t)) return false;  // 画像拡張子
        if (/^[a-fA-F0-9]{12,}$/.test(t)) return false;               // UUID/ハッシュ風
        if (/^https?:\/\//i.test(t)) return false;                    // URL
        return true;
    };
    // (player_id, ptAttr) ごとに「最大ダメージ凸の damage + characters」を保持
    const maxMap = new Map();
    (atks || []).forEach(a => {
        const attr = weaknessByCode.get(a.boss_code);
        if (!attr) return;
        const key = `${a.player_id}:${attr}`;
        const dmg = Number(a.damage_raw) || 0;
        const cur = maxMap.get(key);
        if (!cur || dmg > cur.dmg) {
            const chars = Array.isArray(a.characters)
                ? a.characters.filter(_isLikelyCharName)  // ← ファイルパス等を除外
                : [];
            maxMap.set(key, { dmg, characters: chars });
        }
    });

    const rows = [];
    for (const [key, v] of maxMap.entries()) {
        const idx = key.lastIndexOf(':');
        const pid = Number(key.slice(0, idx));
        const attr = key.slice(idx + 1);
        if (v.dmg <= 0) continue;
        rows.push({
            player_id: pid,
            attribute: attr,
            damage_b: Number((v.dmg / 1e9).toFixed(3)),
            characters: v.characters,  // 最大ダメ凸の編成も一緒に引き継ぎ
            updated_at: new Date().toISOString(),
        });
    }
    if (rows.length > 0) {
        // characters カラムが未マイグの環境では characters を抜いてリトライ
        let err;
        const r1 = await supabase
            .from('player_damages')
            .upsert(rows, { onConflict: 'player_id,attribute' });
        err = r1.error;
        if (err) {
            const fallbackRows = rows.map(({ characters, ...rest }) => rest);
            const r2 = await supabase
                .from('player_damages')
                .upsert(fallbackRows, { onConflict: 'player_id,attribute' });
            if (r2.error) throw r2.error;
        }
    }
    const charSeedCount = rows.filter(r => Array.isArray(r.characters) && r.characters.length > 0).length;
    return { seeded: rows.length, charactersSeeded: charSeedCount };
};

// アクティブなテストシーズンを削除し、player_damages と元のアクティブシーズンを復元
window.supabaseDeleteActiveTestSeason = async function () {
    const { data: season, error: sErr } = await supabase
        .from('seasons')
        .select('id, is_test, metadata, month_key')
        .eq('is_active', true)
        .eq('is_test', true)
        .maybeSingle();
    if (sErr) throw sErr;
    if (!season) throw new Error('アクティブなテストシーズンがありません');

    // player_damages をスナップショットから復元
    const snapshot = season.metadata?.damages_snapshot;
    if (Array.isArray(snapshot)) {
        await supabase.from('player_damages').delete().gte('player_id', 0);
        if (snapshot.length > 0) {
            const rows = snapshot.map(s => ({
                player_id: s.player_id,
                attribute: s.attribute,
                damage_b: s.damage_b,
            }));
            await supabase.from('player_damages').upsert(rows, { onConflict: 'player_id,attribute' });
        }
    }

    // テストシーズン削除 (CASCADE で bosses / attacks も消える)
    const { error: dErr } = await supabase.from('seasons').delete().eq('id', season.id);
    if (dErr) throw dErr;

    // 直近の非テストシーズンを再アクティブ化
    const { data: prev } = await supabase
        .from('seasons').select('id, month_key').eq('is_test', false)
        .order('hard_date', { ascending: false }).limit(1);
    let restoredKey = null;
    if (prev && prev.length > 0) {
        await supabase.from('seasons').update({ is_active: true }).eq('id', prev[0].id);
        restoredKey = prev[0].month_key;
    }
    return { ok: true, restoredKey };
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
            .update({ total_hp_raw: hp[tier], remaining_hp_raw: hp[tier] })
            .eq('season_id', seasonId)
            .eq('tier', tier);
        if (error) throw error;
    }
};

// ============================================================================
// NIKKE キャラクター自動学習マスタ
// OCRから渡された生のキャラ名配列を、既存マスタとのファジィマッチで正規化し、
// 新規/エイリアスを自動的に DB に書き込む。返り値は canonical_name の配列。
// ============================================================================
const _normalizeNikkeName = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.normalize('NFKC');                          // 全角→半角、合成正規化
    s = s.replace(/[：]/g, ':');                            // 全角コロンを半角に
    s = s.replace(/\s+/g, '');                              // 空白除去
    s = s.replace(/^[Ⅰ-ⅩⅠ-ⅩIVXⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩABC]+\b/, '');   // 先頭バースト記号
    s = s.replace(/^[・…．\.,、…]+/, '');                  // 先頭の中黒・句読点
    s = s.replace(/[・…．\.,、…\s]+$/, '');                // 末尾の中黒・句読点
    return s.length > 0 ? s : null;
};
// 一方が他方の接頭辞である関係 (OCR途中切れ/補完不足を許容)
const _isPrefixMatch = (a, b, minLen = 4) => {
    if (!a || !b || a.length < minLen || b.length < minLen) return false;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return longer.startsWith(shorter);
};
const _levenshtein = (a, b) => {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n; if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = dp[0]; dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
            prev = tmp;
        }
    }
    return dp[n];
};
const _similarity = (a, b) => {
    const dist = _levenshtein(a, b);
    const longer = Math.max(a.length, b.length);
    return longer === 0 ? 1 : 1 - dist / longer;
};

// 文字列が本物のキャラ名らしいか判定 (ファイルパス・ハッシュ・URLは除外)
const _looksLikeCharName = (s) => {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length === 0 || t.length > 40) return false;
    if (t.includes('/') || t.includes('\\')) return false;
    if (/\.(webp|png|jpg|jpeg|gif|svg)$/i.test(t)) return false;
    if (/^[a-fA-F0-9]{12,}$/.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return false;
    return true;
};

// OCRで取れたキャラ名配列を正規化 + 自動学習 + DB保存。
// rawNames: string[] (null/undefined 含む可)
// 戻り値: { canonical: string[], pending: string[] }
window.supabaseRegisterOcrCharacters = async function (rawNames) {
    const out = { canonical: [], pending: [] };
    if (!Array.isArray(rawNames) || rawNames.length === 0) return out;
    // ファイルパス等のゴミを最初に除外 (旧スキーマ由来の混入対策)
    rawNames = rawNames.filter(_looksLikeCharName);
    if (rawNames.length === 0) return out;

    // 既存マスタを一括取得 (運用上は数十〜数百行なので軽い)
    let master = [];
    try {
        const { data } = await supabase
            .from('nikke_characters')
            .select('canonical_name, aliases, sighting_count, is_confirmed');
        master = data || [];
    } catch { return out; }

    // 正規化後文字列で検索しやすくする辞書
    const normIndex = new Map();  // normalizedName -> canonical_name
    master.forEach(m => {
        normIndex.set(_normalizeNikkeName(m.canonical_name), m.canonical_name);
        (m.aliases || []).forEach(al => {
            const n = _normalizeNikkeName(al);
            if (n) normIndex.set(n, m.canonical_name);
        });
    });

    const nowIso = new Date().toISOString();
    for (const raw of rawNames) {
        const norm = _normalizeNikkeName(raw);
        if (!norm) { out.canonical.push(null); continue; }

        // 1) 既存と完全一致 (正規化後) → カウント++
        if (normIndex.has(norm)) {
            const canon = normIndex.get(norm);
            try {
                const existing = master.find(m => m.canonical_name === canon);
                const newCount = (existing?.sighting_count || 0) + 1;
                await supabase.from('nikke_characters').update({
                    sighting_count: newCount,
                    last_seen: nowIso,
                    is_confirmed: existing?.is_confirmed || newCount >= 3,
                }).eq('canonical_name', canon);
            } catch { /* noop */ }
            out.canonical.push(canon);
            continue;
        }

        // 2) ファジィ最近傍。接頭辞関係(=OCR途中切れ)は 0.92 にブーストして優先
        let best = null, bestScore = 0;
        for (const m of master) {
            const mNorm = _normalizeNikkeName(m.canonical_name) || '';
            const lev = _similarity(norm, mNorm);
            const pre = _isPrefixMatch(norm, mNorm, 4) ? 0.92 : 0;
            const score = Math.max(lev, pre);
            if (score > bestScore) { bestScore = score; best = m; }
        }
        if (best && bestScore >= 0.85) {
            const bestNorm = _normalizeNikkeName(best.canonical_name) || '';
            // 新しい raw が既存より長い接頭辞関係 → 既存を「短い表記」と判断し、canonical を新しい方に rename
            const shouldPromoteToLonger = _isPrefixMatch(norm, bestNorm, 4) && norm.length > bestNorm.length;
            try {
                if (shouldPromoteToLonger) {
                    const aliases = Array.from(new Set([
                        ...(best.aliases || []),
                        best.canonical_name,  // 旧短名をエイリアスに残す
                    ]));
                    const newCount = (best.sighting_count || 0) + 1;
                    // PK 変更のため delete → insert
                    await supabase.from('nikke_characters').delete().eq('canonical_name', best.canonical_name);
                    await supabase.from('nikke_characters').insert({
                        canonical_name: raw,
                        aliases,
                        sighting_count: newCount,
                        first_seen: best.first_seen,
                        last_seen: nowIso,
                        is_confirmed: best.is_confirmed || newCount >= 3,
                    });
                    // ローカル辞書を更新 (旧短名→新長名)
                    for (const [k, v] of normIndex.entries()) {
                        if (v === best.canonical_name) normIndex.set(k, raw);
                    }
                    normIndex.set(norm, raw);
                    out.canonical.push(raw);
                } else {
                    const aliases = Array.from(new Set([...(best.aliases || []), raw]));
                    const newCount = (best.sighting_count || 0) + 1;
                    await supabase.from('nikke_characters').update({
                        aliases,
                        sighting_count: newCount,
                        last_seen: nowIso,
                        is_confirmed: best.is_confirmed || newCount >= 3,
                    }).eq('canonical_name', best.canonical_name);
                    normIndex.set(norm, best.canonical_name);
                    out.canonical.push(best.canonical_name);
                }
            } catch (e) {
                console.warn('[char match update]', e?.message || e);
                out.canonical.push(best.canonical_name);
            }
            continue;
        }

        // 3) どれにも該当しなければ新規追加
        try {
            await supabase.from('nikke_characters').insert({
                canonical_name: raw,
                aliases: [],
                sighting_count: 1,
                is_confirmed: false,
                first_seen: nowIso,
                last_seen: nowIso,
            });
            normIndex.set(norm, raw);
            master.push({ canonical_name: raw, aliases: [], sighting_count: 1, is_confirmed: false });
        } catch { /* noop: テーブル未作成時など */ }
        out.canonical.push(raw);
        // 0.50 〜 0.85 は運営レビュー候補として薄くマーク
        if (best && bestScore >= 0.50) out.pending.push(`${raw} ≈ ${best.canonical_name} (${(bestScore*100|0)}%)`);
    }
    return out;
};

// player_damages の characters カラムを更新 (該当行が無ければ upsert で作成)
// 同じ (player_id, attribute) は1行しか無い前提 (既存スキーマの onConflict ターゲット)
window.supabaseSaveTeamForAttribute = async function (playerId, attribute, characters) {
    if (!playerId || !attribute || !Array.isArray(characters)) return;
    const cleaned = characters.filter(c => typeof c === 'string' && c.trim().length > 0);
    try {
        await supabase.from('player_damages').upsert({
            player_id: playerId,
            attribute,
            characters: cleaned,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'player_id,attribute' });
    } catch (e) {
        // characters カラム未マイグレーションのときは静かにスキップ
        console.warn('[saveTeamForAttribute] skipped:', e?.message || e);
    }
};

// nikke_characters の一覧取得 (運営UI 用)
window.supabaseLoadCharacterMaster = async function () {
    try {
        const { data } = await supabase
            .from('nikke_characters')
            .select('*')
            .order('sighting_count', { ascending: false });
        return data || [];
    } catch { return []; }
};

// 名前 + アイコン画像で登録/更新 (ブートストラップウィザード用)
// 同一 canonical_name が既にあれば icon_paths に追加 (重複しないように)、無ければ新規 INSERT
window.supabaseRegisterCharacterWithIcon = async function (canonicalName, iconPath) {
    if (!canonicalName || typeof canonicalName !== 'string') throw new Error('canonical_name 必須');
    if (!iconPath || typeof iconPath !== 'string') throw new Error('icon_path 必須');
    const name = canonicalName.trim();
    if (!name) throw new Error('canonical_name 空不可');

    // 既存をチェック
    const { data: existing } = await supabase
        .from('nikke_characters')
        .select('canonical_name, icon_paths, aliases, sighting_count, is_confirmed')
        .eq('canonical_name', name)
        .maybeSingle();

    const nowIso = new Date().toISOString();
    if (existing) {
        const paths = Array.isArray(existing.icon_paths) ? [...existing.icon_paths] : [];
        if (!paths.includes(iconPath)) paths.push(iconPath);
        await supabase.from('nikke_characters').update({
            icon_paths: paths,
            is_confirmed: true,   // 運営が手動でひも付けたのは確定扱い
            last_seen: nowIso,
        }).eq('canonical_name', name);
        return { canonical_name: name, updated: true, icon_count: paths.length };
    }
    // 新規登録
    await supabase.from('nikke_characters').insert({
        canonical_name: name,
        aliases: [],
        icon_paths: [iconPath],
        sighting_count: 0,
        is_confirmed: true,
        first_seen: nowIso,
        last_seen: nowIso,
    });
    return { canonical_name: name, inserted: true, icon_count: 1 };
};

// 画像パスから canonical_name を逆引き
window.supabaseFindCharacterByIconPath = async function (iconPath) {
    if (!iconPath) return null;
    try {
        const { data } = await supabase
            .from('nikke_characters')
            .select('canonical_name')
            .contains('icon_paths', [iconPath])
            .maybeSingle();
        return data?.canonical_name || null;
    } catch { return null; }
};

// nikke_characters の1行を更新 (canonical_name の変更含む)
// oldCanonical を別の正式名に rename する場合 = 旧行を delete し、新行を upsert + 既存の aliases/count をマージ
window.supabaseUpdateCharacterMasterEntry = async function (oldCanonical, patch) {
    if (!oldCanonical) throw new Error('oldCanonical 必須');
    const newCanonical = (patch.canonical_name ?? oldCanonical).trim();
    if (!newCanonical) throw new Error('canonical_name は空にできません');
    const newAliases = Array.isArray(patch.aliases) ? patch.aliases.filter(Boolean) : null;
    const isConfirmed = patch.is_confirmed;

    // rename = canonical_name 変更時
    if (newCanonical !== oldCanonical) {
        // 旧行の情報を取得
        const { data: old } = await supabase
            .from('nikke_characters').select('*').eq('canonical_name', oldCanonical).maybeSingle();
        if (!old) throw new Error('旧エントリが見つかりません');
        // 新行を upsert (重複時はマージ)
        const { data: existing } = await supabase
            .from('nikke_characters').select('*').eq('canonical_name', newCanonical).maybeSingle();
        const mergedAliases = Array.from(new Set([
            ...(existing?.aliases || []),
            ...(newAliases || old.aliases || []),
            oldCanonical,  // 旧名もエイリアスに残す
        ]));
        const mergedCount = (existing?.sighting_count || 0) + (old.sighting_count || 0);
        await supabase.from('nikke_characters').upsert({
            canonical_name: newCanonical,
            aliases: mergedAliases,
            sighting_count: mergedCount,
            is_confirmed: (isConfirmed != null ? !!isConfirmed : (existing?.is_confirmed || old.is_confirmed)),
            first_seen: old.first_seen,
            last_seen: new Date().toISOString(),
        });
        // 旧行を削除
        await supabase.from('nikke_characters').delete().eq('canonical_name', oldCanonical);
        return { renamed: true, canonical_name: newCanonical };
    }
    // 通常更新
    const update = {};
    if (newAliases != null) update.aliases = newAliases;
    if (isConfirmed != null) update.is_confirmed = !!isConfirmed;
    if (Array.isArray(patch.icon_paths)) update.icon_paths = patch.icon_paths.filter(Boolean);
    if (Object.keys(update).length === 0) return { unchanged: true };
    const { error } = await supabase.from('nikke_characters').update(update).eq('canonical_name', oldCanonical);
    if (error) throw error;
    return { renamed: false, canonical_name: oldCanonical };
};

// 別エントリへ統合 (sourceCanonical を targetCanonical に吸収する)
window.supabaseMergeCharacterMasterEntry = async function (sourceCanonical, targetCanonical) {
    if (!sourceCanonical || !targetCanonical) throw new Error('source/target 必須');
    if (sourceCanonical === targetCanonical) throw new Error('source と target が同じです');
    const { data: src } = await supabase.from('nikke_characters').select('*').eq('canonical_name', sourceCanonical).maybeSingle();
    const { data: tgt } = await supabase.from('nikke_characters').select('*').eq('canonical_name', targetCanonical).maybeSingle();
    if (!src) throw new Error('source エントリが見つかりません');
    if (!tgt) throw new Error('target エントリが見つかりません');
    const mergedAliases = Array.from(new Set([
        ...(tgt.aliases || []),
        ...(src.aliases || []),
        sourceCanonical,  // 旧名もエイリアスに残す
    ]));
    const mergedCount = (tgt.sighting_count || 0) + (src.sighting_count || 0);
    await supabase.from('nikke_characters').update({
        aliases: mergedAliases,
        sighting_count: mergedCount,
        is_confirmed: tgt.is_confirmed || src.is_confirmed || mergedCount >= 3,
        last_seen: new Date().toISOString(),
    }).eq('canonical_name', targetCanonical);
    await supabase.from('nikke_characters').delete().eq('canonical_name', sourceCanonical);
    return { merged: true };
};

// 行を完全削除 (誤登録の整理用)
window.supabaseDeleteCharacterMasterEntry = async function (canonicalName) {
    if (!canonicalName) throw new Error('canonical_name 必須');
    const { error } = await supabase.from('nikke_characters').delete().eq('canonical_name', canonicalName);
    if (error) throw error;
};

// ============================================================================
// 設定タブ用: メンバーの通知状況一覧
// 戻り値: [{ id, name, subscribed, deviceCount, slotsOn, lastDmgUpdate }]
// ============================================================================
window.supabaseLoadMemberNotificationStatus = async function () {
    const { data: players } = await supabase
        .from('players')
        .select('id, name, archived')
        .or('archived.is.null,archived.eq.false')
        .order('name', { ascending: true });
    const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('player_id, created_at');
    const { data: avail } = await supabase
        .from('availability')
        .select('player_id, time_slot');
    const { data: dmgs } = await supabase
        .from('player_damages')
        .select('player_id, updated_at');

    const subsByPlayer = new Map();
    (subs || []).forEach(s => {
        if (!subsByPlayer.has(s.player_id)) subsByPlayer.set(s.player_id, 0);
        subsByPlayer.set(s.player_id, subsByPlayer.get(s.player_id) + 1);
    });
    const slotsByPlayer = new Map();
    (avail || []).forEach(s => {
        if (!slotsByPlayer.has(s.player_id)) slotsByPlayer.set(s.player_id, 0);
        slotsByPlayer.set(s.player_id, slotsByPlayer.get(s.player_id) + 1);
    });
    const lastDmgByPlayer = new Map();
    (dmgs || []).forEach(d => {
        const t = new Date(d.updated_at).getTime();
        const cur = lastDmgByPlayer.get(d.player_id) || 0;
        if (t > cur) lastDmgByPlayer.set(d.player_id, t);
    });

    return (players || []).map(p => ({
        id: p.id,
        name: p.name,
        subscribed: (subsByPlayer.get(p.id) || 0) > 0,
        deviceCount: subsByPlayer.get(p.id) || 0,
        slotsOn: slotsByPlayer.get(p.id) || 0,
        lastDmgUpdate: lastDmgByPlayer.get(p.id) || null,
    }));
};

// ============================================================================
// 設定タブ用: 最近のアクティビティを集約
// 既存テーブルの timestamps を集めて新しい順に並べる (新規スキーマ追加なし)
// ============================================================================
window.supabaseLoadRecentActivity = async function (limit = 50) {
    const events = [];

    const { data: atks } = await supabase
        .from('attacks')
        .select('attack_number, boss_code, damage_raw, reported_at, players(name)')
        .order('reported_at', { ascending: false })
        .limit(20);
    (atks || []).forEach(a => events.push({
        type: 'attack', ts: a.reported_at,
        text: `${a.players?.name || '?'} が ${a.boss_code} に ${(Number(a.damage_raw) / 1e9).toFixed(2)}B 凸 (${a.attack_number}凸目)`,
    }));

    const { data: ses } = await supabase
        .from('seasons')
        .select('month_key, current_level, is_test, created_at')
        .order('created_at', { ascending: false })
        .limit(5);
    (ses || []).forEach(s => events.push({
        type: 'season', ts: s.created_at,
        text: `シーズン ${s.month_key} (${s.is_test ? 'テスト' : 'Lv' + (s.current_level || 1)}) 作成`,
    }));

    const { data: subRows } = await supabase
        .from('push_subscriptions')
        .select('created_at, players(name)')
        .order('created_at', { ascending: false })
        .limit(10);
    (subRows || []).forEach(s => events.push({
        type: 'subscribe', ts: s.created_at,
        text: `${s.players?.name || '?'} が通知を有効化`,
    }));

    const { data: dmgRows } = await supabase
        .from('player_damages')
        .select('attribute, damage_b, updated_at, players(name)')
        .order('updated_at', { ascending: false })
        .limit(15);
    (dmgRows || []).forEach(d => events.push({
        type: 'damage', ts: d.updated_at,
        text: `${d.players?.name || '?'} の ${d.attribute}PT ダメージ → ${Number(d.damage_b).toFixed(1)}B`,
    }));

    // Push通知の送信履歴
    try {
        const { data: noti } = await supabase
            .from('push_notifications_log')
            .select('title, target_kind, target_count, sent_count, sent_at')
            .order('sent_at', { ascending: false })
            .limit(15);
        (noti || []).forEach(n => events.push({
            type: 'notification', ts: n.sent_at,
            text: `📣 通知送信「${n.title}」 ${n.target_kind === 'all' ? '全員' : `${n.target_count}名宛`} (${n.sent_count}件配信)`,
        }));
    } catch { /* テーブル未作成時はスキップ */ }

    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return events.slice(0, limit);
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

    // 2) 全プレイヤーの player_damages を一括取得 (characters 列はマイグ未適用なら無視)
    let dmgs = null;
    try {
        const r = await supabase
            .from('player_damages')
            .select('player_id, attribute, damage_b, updated_at, characters');
        dmgs = r.data;
    } catch { /* characters 未追加 */ }
    if (dmgs == null) {
        const r2 = await supabase
            .from('player_damages')
            .select('player_id, attribute, damage_b, updated_at');
        dmgs = r2.data;
    }
    const dmgByPlayer = new Map();
    const teamByPlayer = new Map();  // { player_id: { attr: [chars] } }
    (dmgs || []).forEach(d => {
        if (!dmgByPlayer.has(d.player_id)) dmgByPlayer.set(d.player_id, {});
        dmgByPlayer.get(d.player_id)[d.attribute] = Number(d.damage_b) || 0;
        if (Array.isArray(d.characters) && d.characters.length > 0) {
            if (!teamByPlayer.has(d.player_id)) teamByPlayer.set(d.player_id, {});
            teamByPlayer.get(d.player_id)[d.attribute] = d.characters;
        }
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

    // 4) availability(凸可能時間帯): 「現在凸可能な人のみ」モードのフィルタ用。
    const slotsByPlayer = new Map();
    const { data: avSlots } = await supabase
        .from('availability')
        .select('player_id, time_slot');
    (avSlots || []).forEach(s => {
        if (!slotsByPlayer.has(s.player_id)) slotsByPlayer.set(s.player_id, []);
        slotsByPlayer.get(s.player_id).push(s.time_slot);
    });

    // 5) SLv: 直近の実シーズン(テスト除外)の player_sync_levels を取得。
    //    最適プランで「低レベルは低SLv、高レベルは高SLv」の割当に使う。
    const slvByPlayer = new Map();
    const { data: latestReal } = await supabase
        .from('seasons').select('id').eq('is_test', false)
        .order('hard_date', { ascending: false }).limit(1).maybeSingle();
    if (latestReal) {
        const { data: slvs } = await supabase
            .from('player_sync_levels')
            .select('player_id, sync_level')
            .eq('season_id', latestReal.id);
        (slvs || []).forEach(s => slvByPlayer.set(s.player_id, Number(s.sync_level) || 0));
    }

    // 平均登録ダメージ(>0のみ)。新メンバーのSLv推定の手がかり。
    const avgDmgOf = (pid) => {
        const vals = Object.values(dmgByPlayer.get(pid) || {}).filter(v => v > 0);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    };
    // SLv既知 かつ ダメージありの (avgDmg, slv) ペア = 最新月の参照表。
    const knownPairs = (players || [])
        .filter(p => slvByPlayer.has(p.id) && avgDmgOf(p.id) > 0)
        .map(p => ({ avgDmg: avgDmgOf(p.id), slv: slvByPlayer.get(p.id) }));
    // ダメージ出力が最も近い既知メンバーのSLvを借りる(最近傍)。パワークリープのため最新月で推定。
    const estimateSlv = (pid) => {
        if (knownPairs.length === 0) return 0;
        const a = avgDmgOf(pid);
        if (a <= 0) return 0;
        let best = knownPairs[0];
        for (const k of knownPairs) {
            if (Math.abs(k.avgDmg - a) < Math.abs(best.avgDmg - a)) best = k;
        }
        return best.slv;
    };

    const result = (players || []).map(p => {
        const known = slvByPlayer.has(p.id);
        return {
            id: p.id,
            name: p.name,
            damagesByAttr: dmgByPlayer.get(p.id) || {},
            teamsByAttr: teamByPlayer.get(p.id) || {},
            attacks: attacksByPlayer.get(p.id) || [],
            attackCount: (attacksByPlayer.get(p.id) || []).length,
            syncLevel: known ? slvByPlayer.get(p.id) : estimateSlv(p.id),
            syncLevelEstimated: !known,
            availableSlots: slotsByPlayer.get(p.id) || [],
        };
    });
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
