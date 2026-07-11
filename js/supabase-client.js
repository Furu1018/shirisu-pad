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

// CDN 二段フォールバック: 一部の回線/端末で esm.sh がブロック・失敗すると
// モジュール全体が死んで「supabaseXxx is not a function」になるため、
// 失敗時は jsDelivr から読み直す (top-level await はモジュールなので使用可)。
let createClient;
try {
    ({ createClient } = await import('https://esm.sh/@supabase/supabase-js@2'));
} catch (e) {
    console.warn('[supabase] esm.sh 読み込み失敗 → jsDelivr にフォールバック:', e?.message || e);
    ({ createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'));
}

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

    window.supabaseLogActivity?.('notify_on', '通知を有効化', { playerId });
    return { endpoint };
};

// Push購読を解除 (端末側 + DB側両方)。playerId は任意 (ログ記録用)
window.unsubscribeFromPush = async function (playerId = null) {
    if (!window.isPushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) { console.warn('unsubscribe local error', e); }
    try {
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    } catch (e) { console.warn('unsubscribe db error', e); }
    window.supabaseLogActivity?.('notify_off', '通知を解除', { playerId });
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
    // 1) 最新シーズン (hard_date 降順)。
    // 比較・ふるり値の対象は「完了したレイド」のみ。
    // - テストシーズン (is_test=true) は除外
    // - 進行中のアクティブシーズン (is_active=true) も除外 (まだ凸データが揃っていないため)
    //   → 🏁 シーズン終了ボタンで is_active=false にした時点で比較対象に組み込まれる
    const { data: seasons, error: sErr } = await supabase
        .from('seasons')
        .select('id, month_key, hard_date, union_rank, metadata')
        .eq('is_test', false)
        .eq('is_active', false)
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
    // avatar_url / avatar_character (mig 13) + strong_attributes (mig 15) は新規列。
    // 列未追加環境用に段階的に落ちるフォールバック。
    const minCols = 'id, name, is_temp, archived';
    const fullCols = minCols + ', avatar_url, avatar_character, strong_attributes';
    const midCols = minCols + ', avatar_url, avatar_character';
    let data, error;
    const tryQuery = async (cols) => {
        let q = supabase.from('players').select(cols).order('name', { ascending: true });
        if (!includeArchived) q = q.or('archived.is.null,archived.eq.false');
        return await q;
    };
    let r = await tryQuery(fullCols);
    if (r.error && /column .*strong_attributes/i.test(String(r.error?.message))) {
        r = await tryQuery(midCols);
    }
    if (r.error && /column .*avatar/i.test(String(r.error?.message))) {
        r = await tryQuery(minCols);
    }
    if (r.error) throw r.error;
    return (r.data || []).map(p => ({ strong_attributes: [], ...p }));
};

// 得意属性を上書き更新
window.supabaseUpdatePlayerStrongAttrs = async function (playerId, attrs) {
    if (!playerId) throw new Error('playerId 必須');
    const valid = new Set(['fire','water','electric','iron','wind']);
    const cleaned = (attrs || []).filter(a => valid.has(a));
    const { error } = await supabase
        .from('players')
        .update({ strong_attributes: cleaned })
        .eq('id', playerId);
    if (error) throw error;
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

// ============================================================================
// アバター: キャラ選択 or 独自アップロード
// ============================================================================
// 表示の優先度:
//   avatar_url が入っていれば最優先 (アップロード画像)
//   なければ avatar_character → nikke_characters.icon_paths[0] を参照
//   どちらも無ければ デフォルト 👤
// ============================================================================

// アバターの設定 (キャラ指定 or URL 直接設定 or 両方クリア)
// opts: { character?: string|null, url?: string|null }
window.supabaseUpdatePlayerAvatar = async function (playerId, opts = {}) {
    if (!playerId) throw new Error('playerId 必須');
    const patch = {};
    if ('character' in opts) patch.avatar_character = opts.character || null;
    if ('url' in opts) patch.avatar_url = opts.url || null;
    if (Object.keys(patch).length === 0) return;
    const { error } = await supabase.from('players').update(patch).eq('id', playerId);
    if (error) throw error;
};

// Supabase Storage の "avatars" バケットへ画像をアップロード。
// 戻り値: public URL (avatar_url にそのまま使える)
window.supabaseUploadAvatarImage = async function (playerId, file) {
    if (!playerId) throw new Error('playerId 必須');
    if (!file) throw new Error('ファイルが指定されていません');
    if (!/^image\//.test(file.type || '')) throw new Error('画像ファイルを選んでください');
    if (file.size > 5 * 1024 * 1024) throw new Error('5MB を超える画像は使えません');

    const ext = (file.name?.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'png';
    const path = `${playerId}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });
    if (upErr) throw new Error(`アップロード失敗: ${upErr.message}`);

    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) throw new Error('公開URL取得に失敗');
    return publicUrl;
};

// アバター URL を解決して返す (キャラ指定なら nikke_characters から icon_paths を引く)
// avatarCharacter は canonical_name 文字列
window.supabaseResolveAvatarUrl = async function ({ avatar_url, avatar_character }) {
    if (avatar_url) return avatar_url;
    if (!avatar_character) return null;
    try {
        const { data } = await supabase
            .from('nikke_characters')
            .select('icon_paths')
            .eq('canonical_name', avatar_character)
            .maybeSingle();
        return Array.isArray(data?.icon_paths) && data.icon_paths.length > 0 ? data.icon_paths[0] : null;
    } catch { return null; }
};

// プレイヤーを完全削除（過去の凸データもCASCADEで消える、危険操作）
window.supabaseDeletePlayer = async function (playerId) {
    const { error } = await supabase
        .from('players')
        .delete()
        .eq('id', playerId);
    if (error) throw error;
};

// ---- player_damages 書き込みヘルパー (21_player_damages_slots.sql の slot 対応) ----
// 適用後は主キーが (player_id, attribute, slot) になるため onConflict を切り替える。
// 未適用環境では slot 列を外して旧形式で再試行 (slot=2 の保存は適用が必須)。
async function _upsertPlayerDamages(rows) {
    const withSlot = rows.map(r => ({ slot: 1, ...r }));
    let res = await supabase.from('player_damages')
        .upsert(withSlot, { onConflict: 'player_id,attribute,slot' });
    if (!res.error) return res;
    if (/column .*characters/i.test(String(res.error?.message))) return res;   // characters 起因は呼び出し元で処理
    if (withSlot.some(r => r.slot === 2)) {
        throw new Error('2編成目の保存には supabase/21_player_damages_slots.sql の適用が必要です');
    }
    const legacy = withSlot.map(({ slot, ...rest }) => rest);
    return await supabase.from('player_damages')
        .upsert(legacy, { onConflict: 'player_id,attribute' });
}

// プレイヤーの属性別ダメージ登録を取得（1属性最大2編成、未登録は欠落。slot 昇順）
window.supabaseLoadPlayerDamages = async function (playerId) {
    // slot / characters カラム未マイグの環境でも壊れないよう多段フォールバック
    const selects = [
        'attribute, damage_b, updated_at, characters, slot',
        'attribute, damage_b, updated_at, characters',
        'attribute, damage_b, updated_at',
    ];
    for (const sel of selects) {
        try {
            const r = await supabase
                .from('player_damages')
                .select(sel)
                .eq('player_id', playerId);
            if (!r.error) {
                return (r.data || [])
                    .map(d => ({ ...d, slot: d.slot || 1 }))
                    .sort((a, b) => a.slot - b.slot);
            }
        } catch { /* fallthrough */ }
    }
    return [];
};

// プレイヤーの属性別ダメージを upsert (新規 or 上書き)。slot=2 で2編成目
window.supabaseSavePlayerDamage = async function (playerId, attribute, damageB, slot = 1) {
    const valid = ['fire','water','iron','electric','wind'];
    if (!valid.includes(attribute)) throw new Error(`invalid attribute: ${attribute}`);
    const value = Number(damageB);
    if (isNaN(value) || value < 0) throw new Error('damageB は0以上の数値で指定');
    const { error } = await _upsertPlayerDamages([
        { player_id: playerId, attribute, damage_b: value, slot, updated_at: new Date().toISOString() },
    ]);
    if (error) throw error;
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    window.supabaseLogActivity?.('mock_submit', `${ATTR_JP[attribute] || attribute}PT 模擬戦 ${value.toFixed(1)}B を提出${slot === 2 ? ' (2編成目)' : ''}`, { playerId });
};

// 2編成目の削除 (slot=2 の行のみ)
window.supabaseDeletePlayerDamageSlot = async function (playerId, attribute, slot) {
    const { error } = await supabase
        .from('player_damages')
        .delete()
        .eq('player_id', playerId)
        .eq('attribute', attribute)
        .eq('slot', slot);
    if (error) throw error;
};

// 旧スロット (morning/noon/evening/night/latenight) → 新hXX に展開
// 旧キーが残ったままでも自動展開してフィルタが動くようにする
const _LEGACY_SLOT_TO_HOURS = {
    morning:   ['h05','h06','h07','h08'],
    noon:      ['h09','h10','h11','h12','h13'],
    evening:   ['h14','h15','h16','h17'],
    night:     ['h18','h19','h20','h21','h22','h23'],
    latenight: ['h00','h01','h02','h03','h04'],
};
const _expandLegacySlots = (rawSlots) => {
    const out = new Set();
    (rawSlots || []).forEach(s => {
        if (typeof s !== 'string') return;
        if (s.startsWith('h') && s.length === 3) {
            out.add(s);
        } else if (_LEGACY_SLOT_TO_HOURS[s]) {
            _LEGACY_SLOT_TO_HOURS[s].forEach(h => out.add(h));
        }
    });
    return [...out];
};
const _isValidHourSlot = (s) => typeof s === 'string' && /^h(0[0-9]|1[0-9]|2[0-3])$/.test(s);

// プレイヤーの通知受信可能時間帯 (availability) を取得
// 戻り値: ['h05','h06',...] (空配列なら未登録)
// 旧 morning/noon 等の値は自動的に hXX に展開して返す。
window.supabaseLoadAvailability = async function (playerId) {
    const { data, error } = await supabase
        .from('availability')
        .select('time_slot')
        .eq('player_id', playerId);
    if (error) throw error;
    const raw = (data || []).map(d => d.time_slot);
    return _expandLegacySlots(raw);
};

// プレイヤーの availability を slots[] で上書き (hXX 形式のみ)
window.supabaseSaveAvailability = async function (playerId, slots) {
    const clean = (slots || []).filter(_isValidHourSlot);
    // 一旦全削除して入れ直し (旧キー も含めて全消去 → 新キーのみ保存される)
    const { error: dErr } = await supabase
        .from('availability')
        .delete()
        .eq('player_id', playerId);
    if (dErr) throw dErr;
    window.supabaseLogActivity?.('avail_change', `戦闘可能時間を更新 (${clean.length}枠)`, { playerId });
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
    // updated_at (HP鮮度表示用) は 20_bosses_updated_at.sql 適用後のみ存在 → 未適用環境はフォールバック
    let bosses = null;
    try {
        const r = await supabase
            .from('bosses')
            .select('boss_number, boss_code, name, attribute, weakness, tier, total_hp_raw, remaining_hp_raw, updated_at')
            .eq('season_id', season.id)
            .order('boss_number', { ascending: true });
        if (!r.error) bosses = r.data;
    } catch { /* fallthrough */ }
    if (bosses == null) {
        const { data, error: bErr } = await supabase
            .from('bosses')
            .select('boss_number, boss_code, name, attribute, weakness, tier, total_hp_raw, remaining_hp_raw')
            .eq('season_id', season.id)
            .order('boss_number', { ascending: true });
        if (bErr) throw bErr;
        bosses = data;
    }
    return { season, bosses: bosses || [] };
};

// ============================================================================
// 締め凸調整中アピール (#7) + リアルタイム協力可能ステータス (#8)
// ============================================================================
// 30分で自動失効。setMyFinishCoordination 呼び出し毎に expires_at が延長される。
const _FINISH_COORD_TTL_MIN = 30;

// 現在アクティブなステータスを全件取得 (有効期限内のみ)
// status='available' (今オンライン) / 'coordinating' (締め凸調整中)
// 戻り値: [{ player_id, name, status, boss_number, attribute, note, started_at, expires_at }]
window.supabaseGetActiveFinishCoordinations = async function () {
    const nowIso = new Date().toISOString();
    // status 列がまだ存在しない環境にも備える: 失敗時は select を縮退
    let data, error;
    try {
        const r = await supabase
            .from('finish_coordinations')
            .select('player_id, status, boss_number, attribute, note, started_at, expires_at, updated_at, players(name)')
            .gt('expires_at', nowIso)
            .order('updated_at', { ascending: false });
        data = r.data; error = r.error;
    } catch (e) { error = e; }
    if (error) {
        const r2 = await supabase
            .from('finish_coordinations')
            .select('player_id, boss_number, attribute, note, started_at, expires_at, updated_at, players(name)')
            .gt('expires_at', nowIso)
            .order('updated_at', { ascending: false });
        if (r2.error) throw r2.error;
        data = r2.data;
    }
    return (data || []).map(r => ({
        player_id: r.player_id,
        name: r.players?.name || `id${r.player_id}`,
        status: r.status || 'coordinating',
        boss_number: r.boss_number,
        attribute: r.attribute,
        note: r.note,
        started_at: r.started_at,
        expires_at: r.expires_at,
        updated_at: r.updated_at,
    }));
};

// 自分のステータスを ON / 更新 (upsert)。30分後に expires。
// opts: { status: 'available'|'coordinating', bossNumber?, attribute?, note? }
window.supabaseSetMyFinishCoordination = async function (playerId, opts = {}) {
    if (!playerId) throw new Error('playerId 必須');
    const expires = new Date(Date.now() + _FINISH_COORD_TTL_MIN * 60_000).toISOString();
    const valid = new Set(['available', 'practicing', 'coordinating']);
    const status = valid.has(opts.status) ? opts.status : 'coordinating';
    const row = {
        player_id: playerId,
        status,
        boss_number: status === 'coordinating' ? (opts.bossNumber || null) : null,
        attribute: status === 'coordinating' ? (opts.attribute || null) : null,
        note: (opts.note || '').slice(0, 120),
        expires_at: expires,
        updated_at: new Date().toISOString(),
    };
    // 既存があれば started_at は維持。ない場合は DEFAULT NOW() が入る。
    const { error } = await supabase
        .from('finish_coordinations')
        .upsert(row, { onConflict: 'player_id' });
    if (error) {
        // status 列が DB に未追加の環境では status を外して再試行
        if (/column.*status/i.test(String(error?.message))) {
            const { status: _drop, ...legacy } = row;
            const r2 = await supabase.from('finish_coordinations').upsert(legacy, { onConflict: 'player_id' });
            if (r2.error) throw r2.error;
            return;
        }
        throw error;
    }
};

// 自分の調整中宣言を解除 (即座に削除)
window.supabaseClearMyFinishCoordination = async function (playerId) {
    if (!playerId) return;
    const { error } = await supabase
        .from('finish_coordinations')
        .delete()
        .eq('player_id', playerId);
    if (error) throw error;
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

    // アクティビティログ (代理入力は proxy_attack + 入力者名を記録)
    window.supabaseLogActivity?.(
        opts.isProxy ? 'proxy_attack' : 'attack',
        `B${bossNumber} (${bossCode}) に ${(Math.round(damageRaw) / 1e9).toFixed(2)}B 凸 (${attackNumber}凸目)`,
        { playerId, actorName: opts.actorName || null }
    );

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

// 各 HARD LV の標準HP (raw 値)。supabaseCreateSeason の HARD_LV1_HP と一致させること
// lord (B1/B2/B4) が低HP、tyrant (B3/B5) が高HP
const _HARD_LEVEL_HP = {
    1: { lord: 99856279200, tyrant: 150841813600 },
    2: { lord: 149784418800, tyrant: 226262720400 },
    3: { lord: 292445295750, tyrant: 349230901500 },
};
// total_hp_raw からどのLVかを判定 (±5%許容で標準値にマッチさせる)
const _detectLevelFromHp = (tier, totalRaw, tolerance = 0.05) => {
    for (const [lvStr, hps] of Object.entries(_HARD_LEVEL_HP)) {
        const standard = hps[tier];
        if (!standard) continue;
        if (Math.abs(totalRaw - standard) / standard <= tolerance) return Number(lvStr);
    }
    return null;
};

// ボスHPを更新（remaining / total を raw 値で）
// 副作用: total_hp_raw が標準LVに合致した場合、season.current_level を最大値へ昇格 (レベルアップ自動化)
// ボス名の変更 (運営のボス編集パネルから)
window.supabaseUpdateBossName = async function (seasonId, bossNumber, name) {
    const clean = (name || '').trim();
    if (!seasonId || !bossNumber || !clean) return;
    const { error } = await supabase
        .from('bosses')
        .update({ name: clean })
        .eq('season_id', seasonId)
        .eq('boss_number', bossNumber);
    if (error) throw error;
};

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

    // LV自動判定 → 必要なら current_level を昇格
    try {
        const { data: bossRow } = await supabase
            .from('bosses').select('tier').eq('season_id', seasonId).eq('boss_number', bossNumber).maybeSingle();
        const detected = bossRow?.tier ? _detectLevelFromHp(bossRow.tier, totalRaw) : null;
        if (detected) {
            const { data: seasonRow } = await supabase
                .from('seasons').select('current_level').eq('id', seasonId).maybeSingle();
            const currentLevel = Number(seasonRow?.current_level) || 1;
            if (detected > currentLevel) {
                await supabase.from('seasons').update({ current_level: detected }).eq('id', seasonId);
            }
        }
    } catch (e) { console.warn('[updateBossHp] auto level detect failed:', e?.message || e); }
};

// ===== バックアップ: 全テーブル JSON エクスポート =====
// RLS が anon 全許可の内輪運用のため、誤操作・事故に備えた手動バックアップ手段。
// Supabase の行数上限(1000)を超えるテーブルに備えてページネーションで全件取得する。
const _BACKUP_TABLES = [
    'players', 'player_damages', 'seasons', 'bosses', 'player_sync_levels',
    'attacks', 'day_offs', 'availability', 'finish_claims', 'finish_coordinations',
    'fururi_simulation_scores', 'push_subscriptions', 'push_notifications_log',
    'nikke_characters',
];
window.supabaseExportAllData = async function (onProgress) {
    const PAGE = 1000;
    const dump = { exportedAt: new Date().toISOString(), tables: {} };
    for (let i = 0; i < _BACKUP_TABLES.length; i++) {
        const t = _BACKUP_TABLES[i];
        if (typeof onProgress === 'function') onProgress(t, i, _BACKUP_TABLES.length);
        const rows = [];
        for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase.from(t).select('*').range(from, from + PAGE - 1);
            if (error) {
                // テーブル未作成環境 (SQL未適用) はスキップして続行
                console.warn(`[backup] ${t}: ${error.message}`);
                dump.tables[t] = { error: error.message };
                break;
            }
            rows.push(...(data || []));
            if (!data || data.length < PAGE) { dump.tables[t] = rows; break; }
        }
    }
    return dump;
};

// ===== バックアップ復元: バックアップ時点へ全テーブルを巻き戻す =====
// 削除は子テーブル→親テーブルの順、投入は親→子の順で外部キー違反を避ける。
// [テーブル名, 全行マッチ用のNOT NULL列, 型('num'|'text')] を定義。
const _RESTORE_TABLES = [
    // [name, filterCol, kind]  ※ 配列順 = 投入順 (親が先)。削除はこの逆順。
    ['players', 'id', 'num'],
    ['seasons', 'id', 'num'],
    ['nikke_characters', 'canonical_name', 'text'],
    ['bosses', 'season_id', 'num'],
    ['player_damages', 'player_id', 'num'],
    ['player_sync_levels', 'season_id', 'num'],
    ['attacks', 'id', 'num'],
    ['day_offs', 'player_id', 'num'],
    ['availability', 'player_id', 'num'],
    ['finish_claims', 'season_id', 'num'],
    ['fururi_simulation_scores', 'season_id', 'num'],
    ['finish_coordinations', 'player_id', 'num'],
    ['push_subscriptions', 'id', 'num'],
    ['push_notifications_log', 'id', 'num'],
];
window.supabaseRestoreAllData = async function (dump, onProgress) {
    if (!dump || typeof dump.tables !== 'object') throw new Error('バックアップ形式が不正です');
    const notify = (phase, table) => { if (typeof onProgress === 'function') onProgress(phase, table); };
    const warnings = [];
    const inDump = ([name]) => Array.isArray(dump.tables[name]);

    // 1) 削除 (子→親)。dump に含まれるテーブルだけを対象にする
    //    (古いバックアップに無いテーブルまで消さない)
    const targets = _RESTORE_TABLES.filter(inDump);
    for (const [name, col, kind] of [...targets].reverse()) {
        notify('削除', name);
        const q = supabase.from(name).delete();
        const { error } = kind === 'num' ? await q.gte(col, -1) : await q.gte(col, '');
        if (error) throw new Error(`${name} の削除に失敗: ${error.message}`);
    }

    // 2) 投入 (親→子)。ペイロード上限対策で500行ずつチャンク
    const CHUNK = 500;
    let inserted = 0;
    for (const [name] of targets) {
        const rows = dump.tables[name];
        notify('投入', name);
        for (let i = 0; i < rows.length; i += CHUNK) {
            const { error } = await supabase.from(name).insert(rows.slice(i, i + CHUNK));
            if (error) throw new Error(`${name} の投入に失敗 (${i}行目〜): ${error.message}`);
        }
        inserted += rows.length;
    }

    // 3) 連番シーケンスを MAX(id)+1 に修正 (players/seasons/attacks 等)。
    //    supabase/12_restore_helpers.sql の RPC が必要。未適用なら警告のみ。
    notify('仕上げ', 'シーケンス修正');
    try {
        const { error } = await supabase.rpc('restore_fix_sequences');
        if (error) throw error;
    } catch (e) {
        warnings.push('ID採番の修正 (restore_fix_sequences) が実行できませんでした。' +
            'supabase/12_restore_helpers.sql を SQL Editor で適用してください。' +
            '未適用のままだと新規メンバー追加や凸報告が一時的にIDエラーになることがあります。');
    }
    return { inserted, warnings };
};

// ===== SLv (シンクロレベル) =====
// 読み込み: そのメンバーの「最新シーズン」の sync_level を引き継いで返す。
//   優先順位は アクティブシーズン → hard_date が新しい順。
//   どのシーズンにも登録が無ければ syncLevel:0 (未設定) を返す。
//   seasonId は「書き込み先(=アクティブシーズン)」を併せて返す。
window.supabaseLoadSyncLevel = async function (playerId) {
    const { data: seasons } = await supabase
        .from('seasons').select('id, hard_date, is_active')
        .order('hard_date', { ascending: false });
    const ordered = [...(seasons || [])].sort((a, b) => (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0));
    const activeId = (seasons || []).find(s => s.is_active)?.id || ordered[0]?.id || null;
    if (!playerId || !ordered.length) return { syncLevel: 0, seasonId: activeId };
    const rank = new Map(ordered.map((s, i) => [s.id, i]));
    const { data: slvs } = await supabase
        .from('player_sync_levels')
        .select('sync_level, season_id')
        .eq('player_id', playerId)
        .in('season_id', [...rank.keys()]);
    let best = Infinity, val = 0;
    (slvs || []).forEach(s => {
        const r = rank.get(s.season_id);
        if (r != null && r < best) { best = r; val = Number(s.sync_level) || 0; }
    });
    return { syncLevel: val, seasonId: activeId };
};

// 月次JSON (レイド終了後の正式データ) の確定SLvを player_sync_levels へ同期する。
// - 対象シーズン: month_key が一致する行 (無ければスキップ)
// - 値が既存と同じ行は書かない (冪等 — どのクライアントから何度呼んでも安全)
// - マイページのSLvは「最新シーズンの値を引き継ぐ」ため、同期後は自動で確定値が表示される
window.supabaseSyncSlvFromJson = async function (monthKey, jsonPlayers) {
    if (!monthKey || !Array.isArray(jsonPlayers) || jsonPlayers.length === 0) return { synced: 0, reason: 'no_input' };
    const { data: season } = await supabase
        .from('seasons').select('id')
        .eq('month_key', monthKey)
        .maybeSingle();
    if (!season) return { synced: 0, reason: 'no_season' };

    const [pRes, eRes] = await Promise.all([
        supabase.from('players').select('id, name'),
        supabase.from('player_sync_levels').select('player_id, sync_level').eq('season_id', season.id),
    ]);
    const idByName = new Map((pRes.data || []).map(p => [String(p.name).trim(), p.id]));
    const curById = new Map((eRes.data || []).map(r => [r.player_id, Number(r.sync_level) || 0]));

    const rows = [];
    jsonPlayers.forEach(p => {
        const slv = Math.round(Number(p.syncLevel) || 0);
        if (slv <= 0) return;
        const pid = idByName.get(String(p.player || '').trim());
        if (!pid) return;                        // PAD未登録の名前はスキップ
        if (curById.get(pid) === slv) return;    // 変化なし
        rows.push({ season_id: season.id, player_id: pid, sync_level: slv });
    });
    if (rows.length === 0) return { synced: 0, reason: 'up_to_date' };
    const { error } = await supabase
        .from('player_sync_levels')
        .upsert(rows, { onConflict: 'season_id,player_id' });
    if (error) throw error;
    window.supabaseLogActivity?.('ops', `シーズン ${monthKey} の確定SLvをJSONから同期 (${rows.length}名)`);
    return { synced: rows.length };
};

// 全プレイヤーの最新SLvを一括取得 (人気編成のふるり値トップ算出用)
// 戻り値: { [playerId]: syncLevel } — アクティブ優先 → hard_date 新しい順で引き継ぎ
window.supabaseLoadAllSyncLevels = async function () {
    const { data: seasons } = await supabase
        .from('seasons').select('id, hard_date, is_active')
        .order('hard_date', { ascending: false });
    const ordered = [...(seasons || [])].sort((a, b) => (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0));
    if (!ordered.length) return {};
    const rank = new Map(ordered.map((s, i) => [s.id, i]));
    const { data: slvs } = await supabase
        .from('player_sync_levels')
        .select('player_id, sync_level, season_id');
    const best = {};   // playerId -> { r, val }
    (slvs || []).forEach(s => {
        const r = rank.get(s.season_id);
        if (r == null) return;
        const cur = best[s.player_id];
        if (!cur || r < cur.r) best[s.player_id] = { r, val: Number(s.sync_level) || 0 };
    });
    const out = {};
    Object.entries(best).forEach(([pid, v]) => { out[pid] = v.val; });
    return out;
};

// 書き込み: アクティブシーズンに sync_level を upsert (手動更新)。
window.supabaseUpsertSyncLevel = async function (seasonId, playerId, syncLevel) {
    if (!seasonId || !playerId) throw new Error('シーズン/プレイヤーが不明です');
    const lvl = Math.max(0, Math.min(999, Math.round(Number(syncLevel) || 0)));
    const { error } = await supabase
        .from('player_sync_levels')
        .upsert({ season_id: seasonId, player_id: playerId, sync_level: lvl }, { onConflict: 'season_id,player_id' });
    if (error) throw error;
    return lvl;
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
// payload: { hardDate, monthKey, bosses: [...], isTest? }
// 注意: 本番シーズンの前回ダメージ引継ぎは廃止しました (空スタートが正しい挙動)。
//       模擬戦提出は各メンバーがシーズン期間中に行う運用です。
//       テストシーズン (isTest=true) のみ、動作確認・入力練習用に模擬戦データを
//       自動シードします (前回実績 + ランダム補完 / 終了時にスナップショットから復元)。
window.supabaseCreateSeason = async function (payload) {
    if (!payload.hardDate) throw new Error('hardDate 必須');
    if (!payload.monthKey) throw new Error('monthKey 必須');
    if (!Array.isArray(payload.bosses) || payload.bosses.length !== 5) throw new Error('boss は5体必要');

    const ATTR_FROM_CODE = { 'H.S.T.A.': 'fire', 'P.S.I.D.': 'water', 'D.M.T.R.': 'iron', 'Z.E.U.S.': 'electric', 'A.N.M.I.': 'wind' };
    const COUNTER = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
    const HARD_LV1_HP = { lord: 99856279200, tyrant: 150841813600 };   // lord=低HP / tyrant=高HP

    const isTest = !!payload.isTest;

    // テスト終了時に「テスト前の状態」へ正確に戻すため、テスト作成前に
    // アクティブだったシーズンの ID を記録しておく (運用前に手動で 🏁 終了されている場合は null)
    let previousActiveSeasonId = null;
    if (isTest) {
        const { data: prevActive } = await supabase
            .from('seasons')
            .select('id')
            .eq('is_active', true)
            .eq('is_test', false)
            .maybeSingle();
        previousActiveSeasonId = prevActive?.id || null;
    }

    // テストシーズン: 現在の player_damages (characters 含む) + nikke_characters の
    // キャノニカル名一覧をスナップショットして metadata に保存。テスト終了時に復元する。
    let metadata = {};
    if (isTest) {
        // characters カラムは player_damages にあとから足したスキーマなので、無い環境でも壊れないように
        let dmgs = null;
        for (const sel of [
            'player_id, attribute, damage_b, characters, slot',
            'player_id, attribute, damage_b, characters',
            'player_id, attribute, damage_b',
        ]) {
            try {
                const r = await supabase.from('player_damages').select(sel);
                if (!r.error) { dmgs = r.data || []; break; }
            } catch { /* fallthrough */ }
        }
        dmgs = dmgs || [];
        // キャラマスタは canonical_name 一覧のみ保存 (sighting_count 等の細部はロールバック対象外)
        let charNames = [];
        try {
            const { data: chars } = await supabase
                .from('nikke_characters')
                .select('canonical_name');
            charNames = (chars || []).map(c => c.canonical_name);
        } catch { /* テーブル未マイグ環境では空配列のまま */ }
        metadata = {
            is_test: true,
            damages_snapshot: dmgs,
            nikke_characters_snapshot: charNames,
            previous_active_season_id: previousActiveSeasonId,
        };
    }

    // 同じ月キーの既存シーズン (終了済 = is_active:false) があれば、
    // 凸記録が無い限り自動で削除して再作成可能にする
    const { data: existing } = await supabase
        .from('seasons')
        .select('id, month_key, is_active')
        .eq('month_key', payload.monthKey)
        .maybeSingle();
    if (existing) {
        const { count: atkCount } = await supabase
            .from('attacks')
            .select('id', { count: 'exact', head: true })
            .eq('season_id', existing.id);
        if ((atkCount || 0) > 0) {
            throw new Error(`月キー "${payload.monthKey}" のシーズンに既に ${atkCount} 件の凸記録があります。手動確認のため Supabase Dashboard で削除してください。`);
        }
        // 凸ゼロ → 安全に削除して再作成 (CASCADE で bosses も消える)
        const { error: delErr } = await supabase.from('seasons').delete().eq('id', existing.id);
        if (delErr) throw new Error(`既存の空シーズン削除に失敗: ${delErr.message}`);
    }

    // 残りのアクティブシーズンを is_active=false (同月以外で active のもの)
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

    // 模擬戦データ (player_damages) をクリア → メンバーが新シーズン期間中に再提出する運用
    // テストシーズンの場合は metadata.damages_snapshot に保存済みなのでテスト終了時に復元される。
    const { error: clrErr } = await supabase.from('player_damages').delete().gte('player_id', 0);
    if (clrErr) console.warn('[createSeason] player_damages クリアに失敗:', clrErr?.message);

    window.supabaseLogActivity?.('ops', `シーズン ${payload.monthKey} を作成${isTest ? ' (テスト)' : ''}`);

    // テストシーズンのみ: 模擬戦データをテスト用にシード (本番は空スタートを維持)
    let mockSeed = null;
    let attackSeed = null;
    if (isTest) {
        try {
            mockSeed = await window.supabaseSeedTestMockDamages(season.id, metadata.damages_snapshot || []);
        } catch (e) {
            console.warn('[createSeason] テスト用模擬戦データのシードに失敗:', e?.message || e);
        }
        // レイド中盤らしい状態: ランダムな数名を凸済みに (登録値を基準に使うので模擬戦シードの後)
        try {
            attackSeed = await window.supabaseSeedTestMockAttacks(season.id, season.hard_date);
        } catch (e) {
            console.warn('[createSeason] テスト用凸データのシードに失敗:', e?.message || e);
        }
    }

    return { ...season, mockSeed, attackSeed };
};

// 🧪 クイックテストシーズン: 1クリックで独立したテスト環境を作る
// プレースホルダのボス (テストボス1〜5) + 既存5コードのローテーション + 標準ティア配分
// 完全独立: 前回シーズンからのシードなし、終了時に player_damages と nikke_characters は復元される。
window.supabaseQuickCreateTestSeason = async function () {
    const codes = ['A.N.M.I.', 'D.M.T.R.', 'H.S.T.A.', 'P.S.I.D.', 'Z.E.U.S.'];
    const tiers = ['lord', 'lord', 'tyrant', 'lord', 'tyrant'];   // B1,2,4=lord / B3,5=tyrant
    const bosses = codes.map((code, i) => ({
        bossNumber: i + 1,
        bossCode: code,
        name: `テストボス${i + 1}`,
        tier: tiers[i],
    }));
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    return window.supabaseCreateSeason({
        hardDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
        monthKey: `TEST-${ts}`,
        bosses,
        isTest: true,
    });
};

// 前回レイドの実攻撃ダメージから各メンバーの属性別ダメージを初期登録
// 同じPT属性に複数回凸している場合は「最大値」を採用
// newSeasonId: 今作成したシーズン (除外用)
// ※本番シーズンの引継ぎ運用は廃止済み。現在はテストシーズンのシード
//   (supabaseSeedTestMockDamages) からのみ呼ばれる。
window.supabaseSeedDamagesFromPreviousSeason = async function (newSeasonId) {
    // 直近の本番シーズン候補 (新シーズンを除く、テストシーズン除外、hard_date 降順)
    const { data: seasons, error: sErr } = await supabase
        .from('seasons')
        .select('id, hard_date')
        .neq('id', newSeasonId)
        .eq('is_test', false)
        .order('hard_date', { ascending: false })
        .limit(6);
    if (sErr) throw sErr;
    if (!seasons || seasons.length === 0) return { seeded: 0, reason: 'no_previous' };

    // 凸記録のあるシーズンが見つかるまで新しい順に遡る
    // (作成直後で凸ゼロの本番シーズンなどはスキップ)
    let prevId = null;
    let atks = null;
    for (const s of seasons) {
        let rows = null;
        try {
            const r = await supabase
                .from('attacks').select('player_id, boss_code, damage_raw, characters').eq('season_id', s.id);
            if (!r.error) rows = r.data;
        } catch { /* fallthrough */ }
        if (rows == null) {
            // characters カラム未マイグ環境ではフォールバック
            const r2 = await supabase
                .from('attacks').select('player_id, boss_code, damage_raw').eq('season_id', s.id);
            rows = r2.data;
        }
        if (Array.isArray(rows) && rows.length > 0) {
            prevId = s.id;
            atks = rows;
            break;
        }
    }
    if (!prevId) return { seeded: 0, reason: 'no_attacks' };

    // 前シーズンのボス boss_code -> weakness(=PT属性)
    const { data: bosses } = await supabase
        .from('bosses').select('boss_code, weakness').eq('season_id', prevId);
    const weaknessByCode = new Map((bosses || []).map(b => [b.boss_code, b.weakness]));

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
        const r1 = await _upsertPlayerDamages(rows);
        if (r1.error) {
            const fallbackRows = rows.map(({ characters, ...rest }) => rest);
            const r2 = await _upsertPlayerDamages(fallbackRows);
            if (r2.error) throw r2.error;
        }
    }
    const charSeedCount = rows.filter(r => Array.isArray(r.characters) && r.characters.length > 0).length;
    return { seeded: rows.length, charactersSeeded: charSeedCount };
};

// 🧪 テストシーズン専用: 模擬戦データ (player_damages) をテスト用にシードする
// 1) 直近の凸記録がある本番シーズンから引き継ぎ (supabaseSeedDamagesFromPreviousSeason)
// 2) それでも埋まらない (プレイヤー × 属性) はランダム値で補完
//    基準値はそのプレイヤーの実績平均 → 無ければテスト直前の提出値 (snapshotRows) → 全体平均
// 本番シーズンでは呼ばないこと (空スタートが正しい挙動)。
window.supabaseSeedTestMockDamages = async function (newSeasonId, snapshotRows) {
    const ATTRS = ['fire', 'water', 'electric', 'iron', 'wind'];

    // 1) 前回本番の凸結果ベースで引き継ぎ
    let fromPrevious = 0;
    try {
        const r = await window.supabaseSeedDamagesFromPreviousSeason(newSeasonId);
        fromPrevious = r?.seeded || 0;
    } catch (e) {
        console.warn('[testSeed] 前回シーズンからの引き継ぎに失敗:', e?.message || e);
    }

    // 2) 全プレイヤー × 5属性 の不足分をランダム補完
    const { data: players, error: pErr } = await supabase.from('players').select('id');
    if (pErr) throw pErr;
    const { data: existing } = await supabase
        .from('player_damages')
        .select('player_id, attribute, damage_b');

    const have = new Set((existing || []).map(d => `${d.player_id}:${d.attribute}`));

    // プレイヤーごとの基準値: 引継ぎ済みの実績 + テスト直前の提出値 (スナップショット) の平均
    const sums = new Map();
    const addToSums = (d) => {
        const v = Number(d.damage_b) || 0;
        if (v <= 0) return;
        const s = sums.get(d.player_id) || { total: 0, n: 0 };
        s.total += v; s.n++;
        sums.set(d.player_id, s);
    };
    (existing || []).forEach(addToSums);
    (Array.isArray(snapshotRows) ? snapshotRows : []).forEach(addToSums);

    let globalTotal = 0, globalN = 0;
    for (const s of sums.values()) { globalTotal += s.total; globalN += s.n; }
    const globalAvg = globalN > 0 ? globalTotal / globalN : 20;  // 実績ゼロ環境のフォールバック (B単位)

    const rows = [];
    (players || []).forEach(p => {
        const s = sums.get(p.id);
        const base = s && s.n > 0 ? s.total / s.n : globalAvg;
        ATTRS.forEach(attr => {
            if (have.has(`${p.id}:${attr}`)) return;
            const dmg = base * (0.7 + Math.random() * 0.6);  // 基準値の 70〜130% でばらつかせる
            rows.push({
                player_id: p.id,
                attribute: attr,
                damage_b: Number(dmg.toFixed(3)),
                characters: [],
                updated_at: new Date().toISOString(),
            });
        });
    });

    if (rows.length > 0) {
        const r1 = await _upsertPlayerDamages(rows);
        if (r1.error) {
            // characters カラム未マイグ環境ではフォールバック
            const basicRows = rows.map(({ characters, ...rest }) => rest);
            const r2 = await _upsertPlayerDamages(basicRows);
            if (r2.error) throw r2.error;
        }
    }
    return { fromPrevious, randomFilled: rows.length };
};

// 🧪 テストシーズン専用: レイド中盤らしい状態を作るため、ランダムな数名を凸済みにする
// - メンバーの 30〜60% が 1〜3凸済み (1凸が多め)
// - ダメージは本人の登録模擬戦値の 85〜110% → ボス残HPにも反映 (削れた/倒れたボスができる)
// 本番シーズンでは呼ばないこと。supabaseSeedTestMockDamages の後に呼ぶ (登録値を基準に使うため)。
window.supabaseSeedTestMockAttacks = async function (seasonId, hardDate) {
    const { data: bosses, error: bErr } = await supabase
        .from('bosses')
        .select('boss_number, boss_code, weakness, remaining_hp_raw')
        .eq('season_id', seasonId);
    if (bErr) throw bErr;
    if (!bosses || bosses.length === 0) return { players: 0, attacks: 0 };

    const { data: players, error: pErr } = await supabase.from('players').select('id');
    if (pErr) throw pErr;
    const { data: dmgs } = await supabase
        .from('player_damages')
        .select('player_id, attribute, damage_b');
    const dmgOf = new Map();   // 'pid:attr' -> B
    (dmgs || []).forEach(d => dmgOf.set(`${d.player_id}:${d.attribute}`, Number(d.damage_b) || 0));

    // 30〜60% のメンバーを凸済みに。1凸:45% / 2凸:35% / 3凸:20%
    const ratio = 0.3 + Math.random() * 0.3;
    const chosen = (players || []).filter(() => Math.random() < ratio);
    const rows = [];
    const bossDamage = new Map();   // boss_number -> 合計 raw
    for (const p of chosen) {
        const roll = Math.random();
        const nAtk = roll < 0.45 ? 1 : (roll < 0.8 ? 2 : 3);
        const pool = [...bosses].sort(() => Math.random() - 0.5).slice(0, nAtk);
        pool.forEach((b, i) => {
            const base = dmgOf.get(`${p.id}:${b.weakness}`) || (12 + Math.random() * 12);
            const dmgB = base * (0.85 + Math.random() * 0.25);
            const raw = Math.max(1, Math.round(dmgB * 1e9));
            rows.push({
                season_id: seasonId,
                player_id: p.id,
                attack_date: hardDate,
                boss_number: b.boss_number,
                boss_code: b.boss_code,
                damage_raw: raw,
                attack_number: i + 1,
                level: 1,
                characters: [],
            });
            bossDamage.set(b.boss_number, (bossDamage.get(b.boss_number) || 0) + raw);
        });
    }
    if (rows.length === 0) return { players: 0, attacks: 0 };

    const { error: aErr } = await supabase.from('attacks').insert(rows);
    if (aErr) throw aErr;

    // ボス残HPに反映 (0 まで削れたボスは撃破扱いになる)
    for (const b of bosses) {
        const dealt = bossDamage.get(b.boss_number);
        if (!dealt) continue;
        const rem = Math.max(0, Number(b.remaining_hp_raw) - dealt);
        await supabase.from('bosses')
            .update({ remaining_hp_raw: rem })
            .eq('season_id', seasonId)
            .eq('boss_number', b.boss_number);
    }
    return { players: chosen.length, attacks: rows.length };
};

// ============ 凸プラン配信 ============
// 運営が算出したプランを published_plans に保存 → 全メンバーのマイページに表示。
// テーブルは supabase/17_published_plans.sql を SQL Editor で適用しておくこと。
window.supabasePublishPlan = async function (planObj, publishedBy, publishedByName) {
    const { data: season, error: sErr } = await supabase
        .from('seasons').select('id').eq('is_active', true).maybeSingle();
    if (sErr) throw sErr;
    if (!season) throw new Error('アクティブなシーズンがありません');
    const { data, error } = await supabase
        .from('published_plans')
        .insert({
            season_id: season.id,
            plan: planObj,
            published_by: publishedBy || null,
            published_by_name: publishedByName || null,
        })
        .select('id, published_at')
        .single();
    if (error) throw error;
    // 同一シーズンの古い配信は削除して最新1件だけ残す
    await supabase.from('published_plans').delete().eq('season_id', season.id).neq('id', data.id);
    window.supabaseLogActivity?.('ops', '凸プランを配信', { actorName: publishedByName || null });
    return data;
};

// シーズンの凸をプレイヤー別に集計 (提出漏れチェック用)
// 戻り値: { [playerId]: { count, damageRaw } }
window.supabaseLoadSeasonAttackStats = async function (seasonId) {
    const { data, error } = await supabase
        .from('attacks')
        .select('player_id, damage_raw')
        .eq('season_id', seasonId);
    if (error) throw error;
    const stats = {};
    (data || []).forEach(a => {
        const s = stats[a.player_id] || { count: 0, damageRaw: 0 };
        s.count++;
        s.damageRaw += Number(a.damage_raw) || 0;
        stats[a.player_id] = s;
    });
    return stats;
};

// 模擬戦の提出状況 (前日運用): プレイヤーごとの提出属性数と最終更新
// シーズン作成時に player_damages はクリアされるため、存在する行 = 今シーズンの提出
window.supabaseLoadMockSubmissionStatus = async function () {
    const [pRes, dRes] = await Promise.all([
        supabase.from('players').select('id, name').order('name'),
        supabase.from('player_damages').select('player_id, attribute, damage_b, updated_at'),
    ]);
    if (pRes.error) throw pRes.error;
    if (dRes.error) throw dRes.error;
    const byPlayer = new Map();
    (dRes.data || []).forEach(d => {
        if (!(Number(d.damage_b) > 0)) return;
        const s = byPlayer.get(d.player_id) || { attrs: new Set(), last: null };
        s.attrs.add(d.attribute);   // slot 2重複を数えない (属性の種類数)
        if (!s.last || d.updated_at > s.last) s.last = d.updated_at;
        byPlayer.set(d.player_id, s);
    });
    return (pRes.data || []).map(p => ({
        id: p.id,
        name: p.name,
        attrCount: byPlayer.get(p.id)?.attrs.size || 0,
        lastUpdated: byPlayer.get(p.id)?.last || null,
    }));
};

// 模擬提出のうち編成つきの行を取得 (人気編成の集計用)。attribute 省略で全属性
window.supabaseLoadTeamSubmissions = async function (attribute = null) {
    let q = supabase
        .from('player_damages')
        .select('player_id, attribute, damage_b, characters, players(name)');
    if (attribute) q = q.eq('attribute', attribute);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).filter(r => Array.isArray(r.characters) && r.characters.filter(Boolean).length > 0);
};

// シーズンの戦況 (凸/ボスHP) が最後に動いた時刻 (配信プランの陳腐化検知用)
window.supabaseGetSeasonLastChange = async function (seasonId) {
    let latest = null;
    try {
        const { data } = await supabase
            .from('attacks').select('reported_at')
            .eq('season_id', seasonId)
            .order('reported_at', { ascending: false })
            .limit(1).maybeSingle();
        if (data?.reported_at) latest = data.reported_at;
    } catch { /* noop */ }
    try {
        const { data } = await supabase
            .from('bosses').select('updated_at')
            .eq('season_id', seasonId)
            .order('updated_at', { ascending: false })
            .limit(1);
        const ts = data?.[0]?.updated_at;
        if (ts && (!latest || ts > latest)) latest = ts;
    } catch { /* updated_at 未マイグ環境 */ }
    return latest;
};

// アクティブシーズンの最新配信プランを取得 (無ければ null)
window.supabaseGetPublishedPlan = async function () {
    const { data: season } = await supabase
        .from('seasons').select('id, month_key').eq('is_active', true).maybeSingle();
    if (!season) return null;
    const { data, error } = await supabase
        .from('published_plans')
        .select('id, season_id, plan, published_by, published_by_name, published_at')
        .eq('season_id', season.id)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data ? { ...data, month_key: season.month_key } : null;
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

    // player_damages をスナップショットから復元 (characters カラムも一緒に)
    const snapshot = season.metadata?.damages_snapshot;
    if (Array.isArray(snapshot)) {
        await supabase.from('player_damages').delete().gte('player_id', 0);
        if (snapshot.length > 0) {
            // characters カラムが入っているかどうかで2回試行 (旧 snapshot との後方互換)
            const rowsWithChars = snapshot.map(s => ({
                player_id: s.player_id,
                attribute: s.attribute,
                damage_b: s.damage_b,
                slot: s.slot || 1,
                characters: Array.isArray(s.characters) ? s.characters : [],
            }));
            const r1 = await _upsertPlayerDamages(rowsWithChars);
            if (r1.error && /column.*characters/i.test(String(r1.error?.message))) {
                // characters 列が DB に存在しない環境にフォールバック
                const rowsBasic = snapshot.map(s => ({
                    player_id: s.player_id,
                    attribute: s.attribute,
                    damage_b: s.damage_b,
                    slot: s.slot || 1,
                }));
                await _upsertPlayerDamages(rowsBasic);
            }
        }
    }

    // nikke_characters: テスト中に追加された行のみ削除 (canonical_name 集合差分)
    let charsRemoved = 0;
    const charSnap = season.metadata?.nikke_characters_snapshot;
    if (Array.isArray(charSnap)) {
        try {
            const { data: nowChars } = await supabase
                .from('nikke_characters')
                .select('canonical_name');
            const beforeSet = new Set(charSnap);
            const addedDuringTest = (nowChars || [])
                .map(c => c.canonical_name)
                .filter(n => !beforeSet.has(n));
            if (addedDuringTest.length > 0) {
                const { error: cErr } = await supabase
                    .from('nikke_characters')
                    .delete()
                    .in('canonical_name', addedDuringTest);
                if (!cErr) charsRemoved = addedDuringTest.length;
            }
        } catch (e) { console.warn('[test cleanup] nikke_characters', e?.message || e); }
    }

    // テストシーズン削除 (CASCADE で bosses / attacks も消える)
    const { error: dErr } = await supabase.from('seasons').delete().eq('id', season.id);
    if (dErr) throw dErr;

    // テスト作成前にアクティブだったシーズンのみ復活させる。
    // 手動で 🏁 シーズン終了 していたなら restore せず、シーズン無しの状態に戻る。
    let restoredKey = null;
    const prevActiveId = season.metadata?.previous_active_season_id;
    if (prevActiveId) {
        const { data: prev } = await supabase
            .from('seasons').select('id, month_key, is_active')
            .eq('id', prevActiveId)
            .maybeSingle();
        if (prev) {
            await supabase.from('seasons').update({ is_active: true }).eq('id', prev.id);
            restoredKey = prev.month_key;
        }
    }
    return { ok: true, restoredKey, charsRemoved };
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
    // 先頭バースト記号 (I/II/III/IV/V + MAX) を、続きが日本語/コロンなら除去
    s = s.replace(/^(MAX|[IVXⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]{1,4})(?=[:぀-ヿ一-鿿])/, '');
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
// 共通接頭辞長 (Longest Common Prefix)
const _lcpLength = (a, b) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
    return len;
};
// 最長共通部分列長 (Longest Common Subsequence) - 順序保持・不連続OK
// 例: "グリッド:サイ" と "ブリッド:サイレントトラック" の LCS = "リッド:サイ" (6)
const _lcsLength = (a, b) => {
    const m = a.length, n = b.length;
    if (m === 0 || n === 0) return 0;
    let prev = new Array(n + 1).fill(0);
    let curr = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            curr[j] = (a[i-1] === b[j-1]) ? prev[j-1] + 1 : Math.max(prev[j], curr[j-1]);
        }
        const tmp = prev; prev = curr; curr = tmp;
        curr.fill(0);
    }
    return prev[n];
};
// 強化版類似度: 基本Levenshtein + LCP/LCS/部分文字列ボーナス
// LCS により先頭文字誤読ケース (グリッド ↔ ブリッド) も救済
const _similarityEnhanced = (a, b) => {
    if (!a || !b) return 0;
    if (a === b) return 1;
    let score = _similarity(a, b);
    const shortLen = Math.min(a.length, b.length);
    const lcp = _lcpLength(a, b);
    if (lcp >= 5) {
        const ratio = lcp / shortLen;
        if (ratio >= 0.7) score = Math.max(score, 0.88);
        else if (ratio >= 0.5) score = Math.max(score, 0.78);
    }
    const lcs = _lcsLength(a, b);
    if (lcs >= 5) {
        const ratio = lcs / shortLen;
        if (ratio >= 0.85) score = Math.max(score, 0.88);
        else if (ratio >= 0.7) score = Math.max(score, 0.78);
    }
    if (a.length >= 5 && b.includes(a)) score = Math.max(score, 0.92);
    if (b.length >= 5 && a.includes(b)) score = Math.max(score, 0.92);
    return score;
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

        // 2) ファジィ最近傍。閾値50%、LCP/部分文字列ボーナスで部分一致を救済
        // 入力が短すぎる(<4文字)場合は誤マッチを避けるため自動マージしない
        let best = null, bestScore = 0;
        for (const m of master) {
            const mNorm = _normalizeNikkeName(m.canonical_name) || '';
            const enh = _similarityEnhanced(norm, mNorm);
            const pre = _isPrefixMatch(norm, mNorm, 4) ? 0.92 : 0;
            const score = Math.max(enh, pre);
            if (score > bestScore) { bestScore = score; best = m; }
        }
        const minLenForMerge = 4;
        if (best && bestScore >= 0.50 && norm.length >= minLenForMerge) {
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
window.supabaseSaveTeamForAttribute = async function (playerId, attribute, characters, slot = 1) {
    if (!playerId || !attribute || !Array.isArray(characters)) return;
    const cleaned = characters.filter(c => typeof c === 'string' && c.trim().length > 0);
    try {
        await _upsertPlayerDamages([{
            player_id: playerId,
            attribute,
            slot,
            characters: cleaned,
            updated_at: new Date().toISOString(),
        }]);
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

// ➕ 新キャラの事前登録: 正式名だけ先にマスタへ入れておく (アイコンは後から自動学習)
// 実装直後の新キャラを OCR が誤解決しないよう、運営が名前を先回りで登録する用途。
window.supabaseRegisterNikkeCharName = async function (name) {
    const clean = (name || '').trim();
    if (!clean) throw new Error('キャラ名が空です');
    const { data: existing } = await supabase
        .from('nikke_characters')
        .select('canonical_name')
        .eq('canonical_name', clean)
        .maybeSingle();
    if (existing) return { canonical_name: clean, exists: true };
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from('nikke_characters').insert({
        canonical_name: clean,
        aliases: [],
        icon_paths: [],
        sighting_count: 0,
        is_confirmed: true,   // 運営の手動登録は確定扱い
        first_seen: nowIso,
        last_seen: nowIso,
    });
    if (error) throw error;
    return { canonical_name: clean, inserted: true };
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
    // flex_time/notify_all_hours は 18_availability_prefs.sql 適用後のみ存在 → フォールバック
    let players;
    {
        let r = await supabase
            .from('players')
            .select('id, name, archived, flex_time, notify_all_hours')
            .or('archived.is.null,archived.eq.false')
            .order('name', { ascending: true });
        if (r.error) {
            r = await supabase
                .from('players')
                .select('id, name, archived')
                .or('archived.is.null,archived.eq.false')
                .order('name', { ascending: true });
        }
        players = r.data;
    }
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
        flexTime: !!p.flex_time,             // ⏳ 隙間時間型 (時間帯0でも意図的)
        notifyAllHours: !!p.notify_all_hours,   // 🔔 通知はいつでも受け取る
        lastDmgUpdate: lastDmgByPlayer.get(p.id) || null,
    }));
};

// ============================================================================
// アクティビティログ (INSERT 専用 / supabase/19_activity_log.sql が前提)
// 失敗しても呼び出し元の処理は止めない (fire-and-forget)
// ============================================================================
window.supabaseLogActivity = async function (eventType, detail, opts = {}) {
    try {
        await supabase.from('activity_log').insert({
            event_type: eventType,
            player_id: opts.playerId || null,
            player_name: opts.playerName || null,
            actor_name: opts.actorName || null,
            detail: String(detail || ''),
        });
    } catch (e) {
        console.warn('[activityLog] skipped:', e?.message || e);
    }
};

// アクティビティログ取得。テーブル未作成環境では null を返す (呼び出し側でフォールバック)
window.supabaseLoadActivityLog = async function ({ limit = 200 } = {}) {
    try {
        const { data, error } = await supabase
            .from('activity_log')
            .select('id, event_type, player_id, player_name, actor_name, detail, created_at, players(name)')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    } catch {
        return null;
    }
};

// ============================================================================
// 設定タブ用: 最近のアクティビティを集約 (activity_log 未適用環境のフォールバック)
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

// (旧 callAiRecommend / 締め凸AI推薦 は廃止: 判定基準が決定的ルールだったため
//  システム側の候補ソートに吸収した。Edge Function 側の finish_recommend
//  プロンプト定義は再デプロイ不要のためそのまま残置している — 呼び出し元なし)

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

    // 1) アクティブメンバー (avatar + strong_attributes も同時取得、列未追加環境にはフォールバック)
    let players, pErr;
    {
        const tryQuery = async (cols) => {
            return await supabase
                .from('players')
                .select(cols)
                .or('archived.is.null,archived.eq.false')
                .order('name', { ascending: true });
        };
        let r = await tryQuery('id, name, archived, avatar_url, avatar_character, strong_attributes, flex_time, notify_all_hours');
        if (r.error && /column .*(flex_time|notify_all_hours)/i.test(String(r.error?.message))) {
            // 18_availability_prefs.sql 未適用環境
            r = await tryQuery('id, name, archived, avatar_url, avatar_character, strong_attributes');
        }
        if (r.error && /column .*strong_attributes/i.test(String(r.error?.message))) {
            r = await tryQuery('id, name, archived, avatar_url, avatar_character');
        }
        if (r.error && /column.*avatar/i.test(String(r.error?.message))) {
            r = await tryQuery('id, name, archived');
        }
        players = r.data; pErr = r.error;
    }
    if (pErr) throw pErr;

    // 2) 全プレイヤーの player_damages を一括取得 (characters 列はマイグ未適用なら無視)
    let dmgs = null;
    for (const sel of [
        'player_id, attribute, damage_b, updated_at, characters, slot',
        'player_id, attribute, damage_b, updated_at, characters',
        'player_id, attribute, damage_b, updated_at',
    ]) {
        try {
            const r = await supabase.from('player_damages').select(sel);
            if (!r.error) { dmgs = r.data; break; }
        } catch { /* fallthrough */ }
    }
    const dmgByPlayer = new Map();     // { player_id: { attr: 最大ダメージ } } (既存консюмер用)
    const teamByPlayer = new Map();    // { player_id: { attr: [chars] } } (slot1優先)
    const loadoutsByPlayer = new Map();// { player_id: { attr: [{dmgB, team, slot}] } } (ソルバーの2編成対応用)
    (dmgs || []).forEach(d => {
        const v = Number(d.damage_b) || 0;
        const slot = d.slot || 1;
        const team = (Array.isArray(d.characters) && d.characters.length > 0) ? d.characters : [];
        if (!dmgByPlayer.has(d.player_id)) dmgByPlayer.set(d.player_id, {});
        const dm = dmgByPlayer.get(d.player_id);
        if (v > (dm[d.attribute] || 0)) dm[d.attribute] = v;
        if (team.length > 0) {
            if (!teamByPlayer.has(d.player_id)) teamByPlayer.set(d.player_id, {});
            const tm = teamByPlayer.get(d.player_id);
            if (!tm[d.attribute] || slot === 1) tm[d.attribute] = team;
        }
        if (v > 0) {
            if (!loadoutsByPlayer.has(d.player_id)) loadoutsByPlayer.set(d.player_id, {});
            const lm = loadoutsByPlayer.get(d.player_id);
            if (!lm[d.attribute]) lm[d.attribute] = [];
            lm[d.attribute].push({ dmgB: v, team, slot });
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
    //    旧 morning/noon 形式は読み込み時に hXX (時刻別) に自動展開。
    const slotsByPlayer = new Map();
    const { data: avSlots } = await supabase
        .from('availability')
        .select('player_id, time_slot');
    const rawByPlayer = new Map();
    (avSlots || []).forEach(s => {
        if (!rawByPlayer.has(s.player_id)) rawByPlayer.set(s.player_id, []);
        rawByPlayer.get(s.player_id).push(s.time_slot);
    });
    rawByPlayer.forEach((raws, pid) => slotsByPlayer.set(pid, _expandLegacySlots(raws)));

    // 5) SLv: 各メンバーの「最新シーズン」の sync_level を引き継ぐ (前月引き継ぎ)。
    //    優先順位は アクティブシーズン → hard_date が新しい順。
    //    アクティブシーズンで手動更新した値が最優先になる。
    //    最適プランで「低レベルは低SLv、高レベルは高SLv」の割当に使う。
    const slvByPlayer = new Map();
    const { data: slvSeasons } = await supabase
        .from('seasons').select('id, hard_date, is_active')
        .order('hard_date', { ascending: false });
    // アクティブを先頭に寄せる (同 hard_date でも active を優先)
    const slvOrdered = [...(slvSeasons || [])].sort((a, b) => (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0));
    const slvSeasonRank = new Map(slvOrdered.map((s, i) => [s.id, i]));  // 0 = 最優先(最新)
    if (slvSeasonRank.size) {
        const { data: slvs } = await supabase
            .from('player_sync_levels')
            .select('player_id, sync_level, season_id')
            .in('season_id', [...slvSeasonRank.keys()]);
        const bestRank = new Map();  // player_id -> これまでで一番新しいランク
        (slvs || []).forEach(s => {
            const r = slvSeasonRank.get(s.season_id);
            if (r == null) return;
            if (!bestRank.has(s.player_id) || r < bestRank.get(s.player_id)) {
                bestRank.set(s.player_id, r);
                slvByPlayer.set(s.player_id, Number(s.sync_level) || 0);
            }
        });
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
            avatar_url: p.avatar_url || null,
            avatar_character: p.avatar_character || null,
            strong_attributes: Array.isArray(p.strong_attributes) ? p.strong_attributes : [],
            damagesByAttr: dmgByPlayer.get(p.id) || {},
            teamsByAttr: teamByPlayer.get(p.id) || {},
            loadoutsByAttr: loadoutsByPlayer.get(p.id) || {},   // 1属性最大2編成 (ソルバー用)
            attacks: attacksByPlayer.get(p.id) || [],
            attackCount: (attacksByPlayer.get(p.id) || []).length,
            syncLevel: known ? slvByPlayer.get(p.id) : estimateSlv(p.id),
            syncLevelEstimated: !known,
            availableSlots: slotsByPlayer.get(p.id) || [],
            flexTime: !!p.flex_time,           // ⏳ 隙間時間型 (時間指示なしで3凸する人)
            notifyAllHours: !!p.notify_all_hours,   // 🔔 通知はいつでも受け取る
        };
    });
    return { season, bosses, players: result };
};

// 戦闘可能時間の運用オプション (⏳隙間時間型 / 🔔いつでも通知) を保存
// 18_availability_prefs.sql 未適用環境ではエラーメッセージで適用を促す
window.supabaseUpdateAvailabilityPrefs = async function (playerId, { flexTime, notifyAllHours }) {
    if (!playerId) throw new Error('プレイヤー未選択');
    const patch = {};
    if (flexTime !== undefined) patch.flex_time = !!flexTime;
    if (notifyAllHours !== undefined) patch.notify_all_hours = !!notifyAllHours;
    if (Object.keys(patch).length === 0) return;
    const { error } = await supabase.from('players').update(patch).eq('id', playerId);
    if (error) {
        if (/column .*(flex_time|notify_all_hours)/i.test(String(error.message))) {
            throw new Error('supabase/18_availability_prefs.sql を SQL Editor で適用してください');
        }
        throw error;
    }
};

// 自分の運用オプションを取得 (未適用環境では両方 false)
window.supabaseLoadAvailabilityPrefs = async function (playerId) {
    if (!playerId) return { flexTime: false, notifyAllHours: false };
    const { data, error } = await supabase
        .from('players')
        .select('flex_time, notify_all_hours')
        .eq('id', playerId)
        .maybeSingle();
    if (error) return { flexTime: false, notifyAllHours: false };
    return { flexTime: !!data?.flex_time, notifyAllHours: !!data?.notify_all_hours };
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
