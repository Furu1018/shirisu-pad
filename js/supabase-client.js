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
// ★ boss_level (30_player_damages_level.sql) も同じ多段フォールバックに乗せる。
//   未適用環境で「レベルを指定した提出」を黙って落とすと、レベル無しとして保存され
//   ソルバーが全レベルで使えると誤認する = 過大評価につながるので、その場合はエラーにする。
async function _upsertPlayerDamages(rows) {
    // ★ levels (31_player_damages_levels.sql) の不変条件はここが唯一の維持点:
    //   damage_b = levels の最大値 / boss_level = そのキーの互換ミラー。
    //   levels を持つ行は upsert 前に必ず再計算する (呼び出し元の計算を信用しない)
    const ml = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
    const withSlot = rows.map(r => {
        const row = { slot: 1, ...r };
        if (!('levels' in row) || !ml) return row;
        const norm = ml.normLevels(row.levels, row.damage_b, row.boss_level);
        if (!norm) return { ...row, levels: null };   // 有効な測定なし
        const m = ml.maxEntry(norm);
        return { ...row, levels: norm, damage_b: m.value, boss_level: m.level };
    });
    // ★ 範囲チェックは**最初の upsert より前**に置くこと。後ろに置くと、
    //   32未適用のDB (CHECK がまだ 1|2|3) では slot=3 の書き込みが成功してしまい、
    //   画面にもソルバーにも見えない行を更新し続ける (Codex指摘 2026-08-12)
    if (withSlot.some(r => !isUsableSlot(r.slot))) {
        throw new Error(`模擬の編成スロットは 1〜${MOCK_SLOT_MAX} です (指定: ${withSlot.map(r => r.slot).join(',')})`);
    }
    let res = await supabase.from('player_damages')
        .upsert(withSlot, { onConflict: 'player_id,attribute,slot' });
    if (!res.error) return res;
    if (/column .*characters/i.test(String(res.error?.message))) return res;   // characters 起因は呼び出し元で処理
    // 31 未適用環境: levels を落として再試行 (ミラー列 damage_b/boss_level が残るので
    // 「ベスト測定1件」に劣化するだけで情報の意味は壊れない)
    let rows2 = withSlot;
    if (/levels/i.test(String(res.error?.message))) {
        rows2 = withSlot.map(({ levels, ...rest }) => rest);
        res = await supabase.from('player_damages')
            .upsert(rows2, { onConflict: 'player_id,attribute,slot' });
        if (!res.error) return res;
    }
    if (/boss_level/i.test(String(res.error?.message))) {
        if (rows2.some(r => r.boss_level != null)) {
            throw new Error('模擬のボスレベル指定には supabase/30_player_damages_level.sql の適用が必要です');
        }
        const noLevel = rows2.map(({ boss_level, ...rest }) => rest);
        res = await supabase.from('player_damages')
            .upsert(noLevel, { onConflict: 'player_id,attribute,slot' });
        if (!res.error) return res;
    }
    if (rows2.some(r => Number(r.slot) === 2)) {
        throw new Error('2編成目の保存には supabase/21_player_damages_slots.sql の適用が必要です');
    }
    const legacy = rows2.map(({ slot, boss_level, levels, ...rest }) => rest);
    return await supabase.from('player_damages')
        .upsert(legacy, { onConflict: 'player_id,attribute' });
}

// プレイヤーの属性別ダメージ登録を取得（1属性最大2編成、未登録は欠落。slot 昇順）
// boss_level = 測定したボスレベル (1〜4)。null = 未指定 = 全レベルで使える (移行互換)
// levels = レベル別測定値 {"0":14.2,"4":12.5} (31適用後)。未適用/旧行では
// (damage_b, boss_level) から正規化した1測定になる (mockLevelsDomain.normLevels)
window.supabaseLoadPlayerDamages = async function (playerId) {
    // slot / characters / boss_level / levels カラム未マイグの環境でも壊れないよう多段フォールバック
    const selects = [
        'attribute, damage_b, updated_at, characters, slot, boss_level, levels',
        'attribute, damage_b, updated_at, characters, slot, boss_level',
        'attribute, damage_b, updated_at, characters, slot',
        'attribute, damage_b, updated_at, characters',
        'attribute, damage_b, updated_at',
    ];
    const ml = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
    for (const sel of selects) {
        try {
            const r = await supabase
                .from('player_damages')
                .select(sel)
                .eq('player_id', playerId);
            if (!r.error) {
                return (r.data || [])
                    .filter(d => isUsableSlot(d.slot))   // 32未適用環境の slot=3 を全画面から締め出す
                    .map(d => ({
                        ...d,
                        slot: d.slot || 1,
                        boss_level: _normBossLevel(d.boss_level),
                        levels: ml ? ml.normLevels(d.levels, d.damage_b, d.boss_level) : (d.levels ?? null),
                    }))
                    .sort((a, b) => a.slot - b.slot);
            }
        } catch { /* fallthrough */ }
    }
    return [];
};

// 模擬の編成スロット上限 (supabase/32 で DB の CHECK も 1|2)。
// ★ 32 未適用の環境には slot=3 の行が残りうる。読み取り時にここで切り落として
//   「アプリ全体が2枠として一貫して振る舞う」ようにする。切らないと、
//   ソルバーは③を候補にするのに模擬タブは表示・編集できず、採用マークは③を①に丸めて
//   「使っていない①が採用済みに見える」という不整合になる (Codex指摘 2026-08-12)
export const MOCK_SLOT_MAX = 2;
export function isUsableSlot(v) { const n = Number(v) || 1; return n >= 1 && n <= MOCK_SLOT_MAX; }
window.MOCK_SLOT_MAX = MOCK_SLOT_MAX;

// player_damages を「使えるスロットだけ」で読む小ヘルパー。
// 集計系 (提出状況・人気編成・最終更新・活動ログ) も 2枠運用に合わせるために使う。
// slot 列が無い環境 (21未適用) では列を落として再試行する — その世界は全行が実質 slot1
async function _selectUsableDamages(cols, tune) {
    const run = (c) => { const q = supabase.from('player_damages').select(c); return tune ? tune(q) : q; };
    const r = await run(`${cols}, slot`);
    if (r.error && /slot/i.test(String(r.error?.message))) return await run(cols);
    if (r.error) return r;
    return { data: (r.data || []).filter(d => isUsableSlot(d.slot)), error: null };
}

// 模擬のボスレベル: 1〜4 の整数だけを通し、それ以外 (未指定・不正値) は null に倒す。
// ★ 0 や NaN を 1 に丸めない — 「未指定 (全レベル可)」と「Lv1 (Lv1でしか使えない)」は
//   意味が正反対なので、分からない値を Lv1 に倒すと割当対象から不当に外れる
export function _normBossLevel(v) {
    // ★ 型を先に絞る。Number(true) === 1 なので、真偽値を素通しすると Lv1 になってしまう
    //   (「未指定」であるべきものが「Lv1でしか使えない」に化ける = 割当対象から外れる)
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}
window._normBossLevel = _normBossLevel;

// 対象スロットの現在行を levels 付きで1件取得 (RMW用)。
// 31未適用 (levels 列なし) は legacy=true → 呼び出し元が旧動作へ倒す。
// それ以外の取得失敗は failed=true → 呼び出し元は**中断する**こと
// (「行なし」と誤認して既存の levels を単一測定で上書き破壊しないため — Codexレビュー指摘)
async function _loadDamageRowForMerge(playerId, attribute, slot) {
    try {
        const r = await supabase
            .from('player_damages')
            .select('attribute, damage_b, characters, slot, boss_level, levels')
            .eq('player_id', playerId).eq('attribute', attribute).eq('slot', slot)
            .maybeSingle();
        if (!r.error) return { legacy: false, failed: false, row: r.data || null };
        if (/levels/i.test(String(r.error?.message))) return { legacy: true, failed: false, row: null };
        return { legacy: false, failed: true, row: null, error: r.error };
    } catch (e) {
        return { legacy: false, failed: true, row: null, error: e };
    }
}

// 同属性の全スロットを levels 付きで取得 (提出時の同一編成照合用)。
// 戻り値の意味は _loadDamageRowForMerge と同じ3値 (legacy / failed / rows)
async function _loadDamageRowsForAttr(playerId, attribute) {
    try {
        const r = await supabase
            .from('player_damages')
            .select('attribute, damage_b, characters, slot, boss_level, levels')
            .eq('player_id', playerId).eq('attribute', attribute);
        // ★ 32未適用環境に残る slot=3 を混ぜない。混ぜると「同一編成だから」と
        //   画面にもソルバーにも見えない③へ書き戻してしまう (Codex指摘 2026-08-12)
        if (!r.error) return { legacy: false, failed: false, rows: (r.data || []).filter(d => isUsableSlot(d.slot)) };
        if (/levels/i.test(String(r.error?.message))) return { legacy: true, failed: false, rows: null };
        return { legacy: false, failed: true, rows: null, error: r.error };
    } catch (e) {
        return { legacy: false, failed: true, rows: null, error: e };
    }
}

// プレイヤーの属性別ダメージを upsert (新規 or 上書き)。slot=2 で2編成目
// 31適用後は「スロット内のレベル別測定値 (levels)」への追記として動く:
//   bossLevel 1〜4 → そのレベルの測定値を更新 (他レベルの測定は保持)
//   未指定 (省略)  → いま表示中の測定 (互換ミラーのレベル) の値を更新 —
//                    「ダメージだけ更新する」経路 (OCR等) が別レベルの測定を消したり
//                    古いレベルタグを引き継いだりしないため
//   null           → 「レベル未設定」の測定として保存 (旧: 行のレベルをクリア)
// 31未適用環境は従来の3値セマンティクス (undefined=列を送らない/null=クリア) に劣化
window.supabaseSavePlayerDamage = async function (playerId, attribute, damageB, slot = 1, bossLevel = undefined) {
    const valid = ['fire','water','iron','electric','wind'];
    if (!valid.includes(attribute)) throw new Error(`invalid attribute: ${attribute}`);
    const value = Number(damageB);
    if (isNaN(value) || value < 0) throw new Error('damageB は0以上の数値で指定');
    const ml = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
    if (value <= 0) {
        // 0 はクリア用途: 測定ごと消す (levels を残すとミラー不整合になる — Codexレビュー指摘)
        const { error } = await _upsertPlayerDamages([{
            player_id: playerId, attribute, slot,
            damage_b: 0, levels: null, boss_level: null,
            updated_at: new Date().toISOString(),
        }]);
        if (error) throw error;
        return;
    }
    const rmw = ml ? await _loadDamageRowForMerge(playerId, attribute, slot) : { legacy: true, failed: false, row: null };
    if (rmw.failed) throw (rmw.error || new Error('既存の提出を読めなかったため保存を中止しました (再試行してください)'));
    let lvForLog;
    if (!rmw.legacy && ml) {
        const existing = rmw.row || {};
        // 未指定 = 既存ミラーの測定を更新 / null = '0' (未設定) の測定 / 1〜4 = そのレベル
        const lv = bossLevel === undefined
            ? _normBossLevel(existing.boss_level)
            : _normBossLevel(bossLevel);
        lvForLog = lv;
        // 明示 null は「単一の未設定測定に戻す」旧セマンティクスを保つ (levels を仕切り直す)
        const base = (bossLevel === null) ? { characters: existing.characters } : existing;
        const merged = ml.mergeMeasurement(base, { damageB: value, level: lv });
        const { error } = await _upsertPlayerDamages([{
            player_id: playerId, attribute, slot,
            levels: merged.levels, damage_b: merged.damage_b, boss_level: merged.boss_level,
            updated_at: new Date().toISOString(),
        }]);
        if (error) throw error;
    } else {
        // 旧動作 (31未適用環境): 3値セマンティクス (undefined=列を送らない/null=クリア)
        const lv = bossLevel === undefined ? undefined : _normBossLevel(bossLevel);
        lvForLog = lv;
        const { error } = await _upsertPlayerDamages([
            {
                player_id: playerId, attribute, damage_b: value, slot,
                ...(lv === undefined ? {} : { boss_level: lv }),
                updated_at: new Date().toISOString(),
            },
        ]);
        if (error) throw error;
    }
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    const slotJp = Number(slot) >= 2 ? ` (${Number(slot)}編成目)` : '';
    window.supabaseLogActivity?.('mock_submit', `${ATTR_JP[attribute] || attribute}PT 模擬戦 ${value.toFixed(1)}B を提出${lvForLog ? ` [Lv${lvForLog}]` : ''}${slotJp}`, { playerId });
};

// ===== 模擬提出の主経路 (31以降): 同一編成の自動マージつき保存 =====
// characters 付きの提出は、同属性の既存スロットと編成照合 (sameTeam) し、
// 一致するスロットがあれば**そのスロットへ測定を追記**する (レベル違いで枠を食わない)。
// 一致が無ければ指定スロットへ保存。characters なしは照合不能なので従来動作。
// 戻り値: { slot, redirected, teamChanged, levels } — UI がフィードバック文言を組む用
// entries を渡すと Lv1〜Lv4 をまとめて登録できる (フォームの内容がそのまま保存結果になる)。
// 従来どおり damageB/level を渡せば1件だけの登録 (OCR・旧経路の互換)。
window.supabaseSaveMockSubmission = async function (playerId, attribute, { damageB, level = null, slot = 1, characters = null, entries = null } = {}) {
    const valid = ['fire','water','iron','electric','wind'];
    if (!valid.includes(attribute)) throw new Error(`invalid attribute: ${attribute}`);
    const multi = entries && typeof entries === 'object';
    // 一括登録では「フォームに入っている最大値」を代表値として扱う (互換ミラーの damage_b 用)
    const value = multi
        ? Math.max(0, ...Object.values(entries).map(v => Number(v)).filter(v => Number.isFinite(v)))
        : Number(damageB);
    if (!(value > 0)) throw new Error(multi ? '登録する測定値がありません' : 'damageB は正の数値で指定');
    const lv = _normBossLevel(level);
    const ml = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
    const cleaned = Array.isArray(characters)
        ? characters.filter(c => typeof c === 'string' && c.trim().length > 0) : null;

    // 照合用の取得は専用ローダーで行う — supabaseLoadPlayerDamages は失敗を [] に潰すため
    // 「取得失敗」を「行なし」と誤認して既存 levels を上書き破壊しうる (Codexレビュー指摘)
    const res = ml ? await _loadDamageRowsForAttr(playerId, attribute) : { legacy: true, failed: false, rows: null };
    if (res.failed) throw (res.error || new Error('既存の提出を読めなかったため保存を中止しました (再試行してください)'));
    if (!ml || res.legacy) {
        // 劣化経路 (31未適用): levels 列が無いのでレベル別に持てない。
        // 一括登録は「最大値 = そのレベル」の1件に潰して保存する (欠落より劣化を選ぶ)
        let legacyLv = lv;
        if (multi && ml) {
            const best = ml.maxEntry(ml.normLevels(entries, 0, null) || {});
            legacyLv = best && best.value > 0 ? best.level : lv;
        }
        await window.supabaseSavePlayerDamage(playerId, attribute, value, slot, legacyLv);
        if (cleaned && cleaned.length > 0) await window.supabaseSaveTeamForAttribute(playerId, attribute, cleaned, slot);
        return { slot, redirected: false, teamChanged: false, levels: null };
    }

    const attrRows = res.rows;
    let targetSlot = slot;
    let redirected = false;
    if (cleaned && cleaned.length > 0) {
        const hit = attrRows.find(r => ml.sameTeam(r.characters || [], cleaned));
        if (hit) { targetSlot = hit.slot; redirected = hit.slot !== slot; }
    }
    const existing = attrRows.find(r => r.slot === targetSlot) || null;
    const merged = multi
        ? ml.mergeMeasurements(existing || {}, { entries, characters: cleaned || undefined })
        : ml.mergeMeasurement(existing || {}, { damageB: value, level: lv, characters: cleaned || undefined });
    if (!merged) throw new Error('登録する測定値がありません');
    const basePayload = {
        player_id: playerId, attribute, slot: targetSlot,
        levels: merged.levels, damage_b: merged.damage_b, boss_level: merged.boss_level,
        updated_at: new Date().toISOString(),
    };
    let r1 = await _upsertPlayerDamages([{
        ...basePayload,
        ...(cleaned && cleaned.length > 0 ? { characters: cleaned } : {}),
    }]);
    if (r1.error && /column .*characters/i.test(String(r1.error?.message))) {
        // characters 列が無い環境: 編成抜きで再試行 (他の呼び出し元と同じ流儀)
        r1 = await _upsertPlayerDamages([basePayload]);
    }
    if (r1.error) throw r1.error;
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    const slotJp = Number(targetSlot) >= 2 ? ` (${Number(targetSlot)}編成目)` : '';
    window.supabaseLogActivity?.('mock_submit', `${ATTR_JP[attribute] || attribute}PT 模擬戦 ${value.toFixed(1)}B を提出${lv ? ` [Lv${lv}]` : ''}${slotJp}${redirected ? ' (同一編成のため統合)' : ''}`, { playerId });
    return { slot: targetSlot, redirected, teamChanged: merged.teamChanged, levels: merged.levels };
};

// レベル別測定値の1件削除。最後の測定を消したら行ごと削除
window.supabaseDeleteMockLevel = async function (playerId, attribute, slot, level) {
    const ml = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
    if (!ml) throw new Error('mockLevelsDomain が読み込まれていません');
    const rmw = await _loadDamageRowForMerge(playerId, attribute, slot);
    if (rmw.legacy) throw new Error('レベル別測定の編集には supabase/31_player_damages_levels.sql の適用が必要です');
    if (rmw.failed) throw (rmw.error || new Error('既存の提出を読めなかったため削除を中止しました (再試行してください)'));
    if (!rmw.row) return { deletedRow: false };
    const levels = ml.normLevels(rmw.row.levels, rmw.row.damage_b, rmw.row.boss_level) || {};
    delete levels[ml.levelKey(level)];
    if (Object.keys(levels).length === 0) {
        await window.supabaseDeletePlayerDamageSlot(playerId, attribute, slot);
        return { deletedRow: true };
    }
    const m = ml.maxEntry(levels);
    const { error } = await _upsertPlayerDamages([{
        player_id: playerId, attribute, slot,
        levels, damage_b: m.value, boss_level: m.level,
        updated_at: new Date().toISOString(),
    }]);
    if (error) throw error;
    return { deletedRow: false, levels };
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

// 古いスキーマで attacks.characters に画像パス (./character-images/xxx.webp) が
// 保存されているケースを除外。本物のキャラ名だけを通す。
// 最適プランのキャラ被り判定 (同キャラ1日1回) は名前で照合するため、
// 完了凸の characters を読む箇所は必ずこれを通すこと。
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

// 編成 (5キャラ) が「有効」か: 実キャラ名として通る5人が重複なく揃っていること。
// 空文字・画像パス混入・前後空白違いの同一キャラ・4人以下はすべて不正 (= テストシードの補完対象)。
// 正規化して比較するので ' ラピ ' と 'ラピ' は同一と判定する
const _isValidTeam5 = (arr) => {
    // 「ちょうど5要素」かつ「全要素が実キャラ名」かつ「重複なし」。
    // filter 後の件数だけを見ると「有効5人 + 画像パス」の6要素配列を通してしまう
    // Array.from で疎配列の穴を undefined として走査させる (every は穴を飛ばすため)
    if (!Array.isArray(arr) || arr.length !== 5) return false;
    const src = Array.from(arr);
    if (!src.every(_isLikelyCharName)) return false;
    const t = src.map(c => String(c).normalize('NFKC').trim().toLowerCase());
    return new Set(t).size === 5;
};

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
    // ※ 撃破の通知はここでは判定しない — 残HPを0にする経路は代理凸・ダメージ編集・
    //   運営の一括保存など複数あり、書き込み側でのフックは必ず漏れる。
    //   検知は盤面の変化を見る _checkRaidEvents 側に一本化してある
    let hpAfter = null;
    if (!opts.skipHpDecrement && damageRaw > 0) {
        try {
            const { data: boss } = await supabase
                .from('bosses')
                .select('remaining_hp_raw')
                .eq('season_id', seasonId)
                .eq('boss_number', bossNumber)
                .single();
            if (boss) {
                const before = Number(boss.remaining_hp_raw || 0);
                const newRem = Math.max(0, before - Math.round(damageRaw));
                const { error: uErr } = await supabase
                    .from('bosses')
                    .update({ remaining_hp_raw: newRem })
                    .eq('season_id', seasonId)
                    .eq('boss_number', bossNumber);
                if (uErr) throw uErr;   // 握り潰すと「削れたつもり」で先に進む
                hpAfter = newRem;
            }
        } catch (e) { console.warn('[boss hp auto-decrement] failed:', e?.message || e); }
    }

    // アクティビティログ (代理入力は proxy_attack + 入力者名を記録)
    window.supabaseLogActivity?.(
        opts.isProxy ? 'proxy_attack' : 'attack',
        `B${bossNumber} (${bossCode}) に ${(Math.round(damageRaw) / 1e9).toFixed(2)}B 凸 (${attackNumber}凸目)`,
        { playerId, actorName: opts.actorName || null }
    );

    return { ...data, _hpAfter: hpAfter };
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
// ===== 締め凸依頼のステータス管理 (22_finish_requests.sql が前提) =====
// 依頼バッチの記録: 同ボスの旧依頼は入れ替え (最後に送った相手だけ追跡)
window.supabaseSetFinishRequests = async function (seasonId, bossNumber, playerIds) {
    if (!seasonId || !bossNumber || !Array.isArray(playerIds) || playerIds.length === 0) return;
    await supabase.from('finish_requests').delete()
        .eq('season_id', seasonId).eq('boss_number', bossNumber);
    const { error } = await supabase.from('finish_requests').insert(
        playerIds.map(pid => ({ season_id: seasonId, boss_number: bossNumber, player_id: pid }))
    );
    if (error) {
        if (/finish_requests/.test(String(error.message))) {
            throw new Error('supabase/22_finish_requests.sql を SQL Editor で適用してください');
        }
        throw error;
    }
};
// シーズンの依頼一覧 (プレイヤー名つき)
window.supabaseLoadFinishRequests = async function (seasonId) {
    if (!seasonId) return [];
    try {
        const { data, error } = await supabase
            .from('finish_requests')
            .select('id, boss_number, player_id, status, requested_at, players(name)')
            .eq('season_id', seasonId)
            .order('requested_at', { ascending: true });
        if (error) throw error;
        return (data || []).map(r => ({ ...r, name: r.players?.name || '?' }));
    } catch { return []; }   // テーブル未適用環境では空扱い
};
// 依頼への返答 (メンバー本人)
window.supabaseRespondFinishRequest = async function (seasonId, bossNumber, playerId, status) {
    const { error } = await supabase
        .from('finish_requests')
        .update({ status, responded_at: new Date().toISOString() })
        .eq('season_id', seasonId).eq('boss_number', bossNumber).eq('player_id', playerId);
    if (error) throw error;
};

// ボスコード → ボス属性 / ボス属性 → 弱点PT属性。
// supabaseCreateSeason と シーズン確認・編集 (supabaseSaveSeasonEdits) が共有する唯一の定義
// (js/domain/attributes.js の WEAKNESS_BY_BOSS_ATTR と同一写像 — 画面側で再定義しないこと)
const SEASON_ATTR_FROM_CODE = { 'H.S.T.A.': 'fire', 'P.S.I.D.': 'water', 'D.M.T.R.': 'iron', 'Z.E.U.S.': 'electric', 'A.N.M.I.': 'wind' };
const SEASON_WEAKNESS_BY_ATTR = { fire: 'water', water: 'electric', iron: 'wind', electric: 'iron', wind: 'fire' };
// コード → {attribute, weakness}。未知コードは null (画面のセレクト生成・保存時の導出兼用)
window.seasonBossMetaFromCode = function (code) {
    const attribute = SEASON_ATTR_FROM_CODE[code];
    if (!attribute) return null;
    return { attribute, weakness: SEASON_WEAKNESS_BY_ATTR[attribute] };
};

// シーズン基本情報の変更 (運営のシーズン確認・編集モーダルから)。
// 編集対象はハード日と月キーのみ — ボス構成 (code/tier) は凸記録・ダメージと連動するため
// このAPIでは触らない (間違えた場合はシーズン作り直しの運用)
window.supabaseUpdateSeasonMeta = async function (seasonId, { monthKey, hardDate } = {}) {
    if (!seasonId) throw new Error('seasonId が必要です');
    const patch = {};
    if (monthKey) patch.month_key = monthKey;
    if (hardDate) patch.hard_date = hardDate;
    if (Object.keys(patch).length === 0) return;
    // is_active 条件付き更新: モーダルを開いている間にシーズンが終了された場合、
    // 終了済みシーズンを黙って書き換えない (Codexレビュー指摘)
    const { data, error } = await supabase
        .from('seasons')
        .update(patch)
        .eq('id', seasonId)
        .eq('is_active', true)
        .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
        throw new Error('対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください');
    }
    // ハード日変更時、記録済みの凸日付を追随させる。盤面ローダは attack_date = hard_date で
    // 絞るため、移行しないと既存凸が消えて見える。<> 条件なので冪等 (再保存で不整合も治る)
    if (hardDate) {
        const { error: aErr } = await supabase
            .from('attacks')
            .update({ attack_date: hardDate })
            .eq('season_id', seasonId)
            .neq('attack_date', hardDate);
        if (aErr) throw aErr;
    }
};

// シーズン確認・編集の一括保存。26/27_season_*_rpc.sql の RPC で
// アクティブ確認・メタ更新・凸日付移行・ボスコード(属性)修正・ボス名更新を原子的に実行する。
// bossCodes を含む保存は 27 (5引数版) が前提 — p_boss_codes を渡すのはコード変更があるときだけに
// して、26 のみ適用済みの環境でも通常保存 (4引数) は原子的なまま保つ。
// RPC 未適用の環境では従来の逐次更新へ静かにフォールバック (非原子的だが各ステップにガードと冪等性あり)
window.supabaseSaveSeasonEdits = async function (seasonId, { monthKey, hardDate, bossNames = [], bossCodes = [] } = {}) {
    if (!seasonId) throw new Error('seasonId が必要です');
    const args = {
        p_season_id: seasonId,
        p_month_key: monthKey,
        p_hard_date: hardDate,
        p_boss_names: bossNames.map(b => ({ boss_number: b.bossNumber, name: b.name })),
    };
    if (bossCodes.length > 0) {
        args.p_boss_codes = bossCodes.map(b => ({
            boss_number: b.bossNumber, boss_code: b.bossCode,
            attribute: b.attribute, weakness: b.weakness,
        }));
    }
    const { error } = await supabase.rpc('ops_update_season_meta', args);
    if (!error) return;
    // PGRST202 = 引数に合う関数がスキーマに無い (26/27 未適用)。それ以外 (RPC内の RAISE 等) はそのまま投げる
    const missing = error.code === 'PGRST202' || /Could not find the function/i.test(error.message || '');
    if (!missing) throw error;
    // ボスコード (属性) の変更は 27 RPC 必須。逐次フォールバックでやると、途中失敗で
    // 一時コードや模擬スコアの不整合が残り得るため、メタ情報を触る前にここで中断して案内する
    // (ハード日・月キー・ボス名のみの保存は従来どおりガード付き逐次で劣化動作)
    if (bossCodes.length > 0) {
        throw new Error('属性 (ボスコード) の変更には supabase/27_season_boss_edit_rpc.sql の適用が必要です。SQL Editor で実行してから再保存してください');
    }
    await window.supabaseAssertSeasonActive(seasonId);
    await window.supabaseUpdateSeasonMeta(seasonId, { monthKey, hardDate });
    for (const b of bossNames) await window.supabaseUpdateBossName(seasonId, b.bossNumber, b.name);
};

// シーズンがまだアクティブかの事前チェック (シーズン確認・編集モーダルの保存前ガード)
window.supabaseAssertSeasonActive = async function (seasonId) {
    const { data, error } = await supabase
        .from('seasons').select('id').eq('id', seasonId).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('対象シーズンは既にアクティブではありません (終了済みの可能性)。画面を更新してください');
};

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

    // LV自動判定 → 必要なら current_level を昇格。
    // 昇格したことは戻り値でも返すが、**通知の契機には使わない** —
    // 呼び出し元が複数あり戻り値を捨てる経路があるため (Codex指摘)。
    // 通知は盤面を見る _checkRaidEvents 側に一本化してある
    let levelUp = null;
    try {
        const { data: bossRow } = await supabase
            .from('bosses').select('tier').eq('season_id', seasonId).eq('boss_number', bossNumber).maybeSingle();
        const detected = bossRow?.tier ? _detectLevelFromHp(bossRow.tier, totalRaw) : null;
        if (detected) {
            const { data: seasonRow } = await supabase
                .from('seasons').select('current_level').eq('id', seasonId).maybeSingle();
            const currentLevel = Number(seasonRow?.current_level) || 1;
            if (detected > currentLevel) {
                const { error: lErr } = await supabase.from('seasons')
                    .update({ current_level: detected }).eq('id', seasonId);
                if (lErr) throw lErr;
                levelUp = { from: currentLevel, to: detected };
            }
        }
    } catch (e) { console.warn('[updateBossHp] auto level detect failed:', e?.message || e); }
    return { levelUp };
};

// ===== バックアップ: 全テーブル JSON エクスポート =====
// RLS が anon 全許可の内輪運用のため、誤操作・事故に備えた手動バックアップ手段。
// Supabase の行数上限(1000)を超えるテーブルに備えてページネーションで全件取得する。
const _BACKUP_TABLES = [
    'players', 'player_damages', 'seasons', 'bosses', 'player_sync_levels',
    'attacks', 'day_offs', 'availability', 'finish_claims', 'finish_coordinations',
    'fururi_simulation_scores', 'push_subscriptions', 'push_notifications_log',
    'nikke_characters', 'published_plans', 'plan_acks',
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
    // seasons の CASCADE で消えるので復元対象に必要。
    // plan_acks.plan_id は published_plans を指すので、必ず published_plans を先に戻すこと
    ['published_plans', 'season_id', 'num'],
    ['plan_acks', 'season_id', 'num'],
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
    //    supabase/23_restore_helpers.sql の RPC が必要。未適用なら警告のみ。
    notify('仕上げ', 'シーケンス修正');
    try {
        const { error } = await supabase.rpc('restore_fix_sequences');
        if (error) throw error;
    } catch (e) {
        warnings.push('ID採番の修正 (restore_fix_sequences) が実行できませんでした。' +
            'supabase/23_restore_helpers.sql を SQL Editor で適用してください。' +
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

    // bosses.attribute/weakness の発生源はファイル冒頭の共有マップ (シーズン確認・編集と同一定義)。
    // シーズン作成時にここで確定し、以降は ✏️編集での属性修正以外では不変。
    // 画面側はこの値を再計算せず boss.weakness / weaknessPtOf() を読むこと
    const ATTR_FROM_CODE = SEASON_ATTR_FROM_CODE;
    const COUNTER = SEASON_WEAKNESS_BY_ATTR;
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
        // ★ boss_level / levels を必ず含めること。テスト終了時にこのスナップショットで
        //   player_damages を**全削除して入れ替える**ので、抜けると全員の測定レベルが消える
        for (const sel of [
            'player_id, attribute, damage_b, characters, slot, boss_level, levels',
            'player_id, attribute, damage_b, characters, slot, boss_level',
            'player_id, attribute, damage_b, characters, slot',
            'player_id, attribute, damage_b, characters',
            'player_id, attribute, damage_b',
        ]) {
            try {
                const r = await supabase.from('player_damages').select(sel);
                if (!r.error) { dmgs = r.data || []; break; }
            } catch { /* fallthrough */ }
        }
        // ★ 2枠運用に合わせて slot>2 は最初からスナップショットに入れない。
        //   入れると復元側で落とすことになり、作成側と終了側で扱いがズレる (Codex指摘)
        dmgs = (dmgs || []).filter(d => isUsableSlot(d.slot));
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
        const dmgB = Number((v.dmg / 1e9).toFixed(3));
        rows.push({
            player_id: pid,
            attribute: attr,
            damage_b: dmgB,
            // 実凸ベースの引き継ぎはレベル未指定の1測定として明示 —
            // 既存行の古い boss_level タグを引き継がない (過大評価バグの修正)
            levels: { '0': dmgB },
            boss_level: null,
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
// 🧪 テスト用の「現実に寄せた編成」ジェネレータ。
// NIKKE の実際の傾向を再現する:
//   - B1/B2 (サポート) は環境で固定 = メンバー間・属性間で同じ数体を使い回す → 被りの主因
//   - B3 (アタッカー) は属性ごとに決まる → 属性が違えば別キャラ
// これにより「朝に鉄甲でラピを使ったら灼熱のラピ入り編成は出せない」という
// 実際のキャラ被り (同キャラ1日1回) がテストシーズンでも自然に発生する。
// 戻り値: (playerId, attr) => string[5]  (キャラマスタが薄い環境では [] を返す)
function _makeTestTeamGenerator(chars) {
    const byBurst = { B1: [], B2: [], B3: [] };
    (chars || []).forEach(c => {
        const b = c.burst;
        if (byBurst[b] && c.canonical_name) byBurst[b].push(c.canonical_name);
    });
    // 呼び出し側の order に依存しないよう、ここでも名前順に固定する (生成の決定性)
    Object.values(byBurst).forEach(a => a.sort());
    // 必要数の根拠: サポートは3グループに別々の B1/B2 を割り当てる → 各3体。
    // アタッカーは 5属性 × 3枠 = 15体を重複なしで配れると「3属性選べば被りなし」が成立する。
    // 満たせない薄いマスタ (新規/テストDB) では編成を作らない = 従来どおり [] で動く
    if (byBurst.B1.length < 3 || byBurst.B2.length < 3 || byBurst.B3.length < 15) return () => [];

    // 決定的な擬似乱数 (同じ入力なら同じ編成 = 再現性のためシード固定)
    const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
    const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
    // 環境トップの想定: B1/B2 の上位数体を「みんなが使うサポート」として共有プールにする
    const META_B1 = byBurst.B1.slice(0, 6);
    const META_B2 = byBurst.B2.slice(0, 6);
    const ATTR_IDX = { fire: 0, water: 1, electric: 2, iron: 3, wind: 4 };

    return (playerId, attr) => {
        const pSeed = hash(playerId);
        const aIdx = ATTR_IDX[attr] ?? 0;
        // サポート2枠: プレイヤーごとに好みは違うが、属性が変わっても同じ人を使いがち (=被りの種)。
        // ただし全属性で同じサポートにすると「被りなし3部隊」が1つも組めず、残り凸が常に
        // 詰まって最適プランの検証にならない。実際のプレイヤーも属性帯ごとに手持ちが違うため、
        // 5属性を3グループに分ける: これで「3属性を選べば被りなしで3凸できるが、
        // 選び方を誤ると被って出せない」= 最適プランが解くべき本来の問題が再現される
        const grp = aIdx % 3;   // fire/iron=0 / water/wind=1 / electric=2
        const s1 = pick(META_B1, pSeed + grp * 101);
        const s2 = pick(META_B2, pSeed + 7 + grp * 211);
        // アタッカー3枠: 属性ごとに完全に別の3体。プレイヤーごとに開始位置をずらしつつ、
        // 同一プレイヤー内では 5属性 × 3枠 = 15体が重複しないよう連続領域を割り当てる
        // (これで「3属性を選べば被りなし3凸」が成立する = プランが解くべき問題になる)
        const pool = byBurst.B3;
        const off = Math.abs(pSeed) % pool.length;
        const at = (n) => pool[(off + aIdx * 3 + n) % pool.length];
        const team = [...new Set([s1, s2, at(0), at(1), at(2)])];
        // サポートとアタッカーが偶然重なった場合の埋め合わせ (同キャラ2枠は不正)
        let k = 15;
        while (team.length < 5 && k < pool.length + 15) {
            const cand = pool[(off + k) % pool.length];
            if (!team.includes(cand)) team.push(cand);
            k++;
        }
        return team.length === 5 ? team : [];
    };
}

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
    // ⚠ 旧スキーマ互換: slot (21) / characters (07) が未適用の環境でも壊れないよう段階的に落とす。
    //    エラーを無視して existing を空にすると、引き継いだ実績をランダム値で上書きしてしまう
    let existing = null, lastErr = null;
    for (const cols of ['player_id, attribute, damage_b, characters, slot',
                        'player_id, attribute, damage_b, characters',
                        'player_id, attribute, damage_b']) {
        const r = await supabase.from('player_damages').select(cols);
        if (!r.error) { existing = r.data; break; }
        console.warn(`[testSeed] player_damages select 失敗 (${cols}):`, r.error.message);
        lastErr = r.error;
    }
    // 全て失敗したら中断する: 空配列で続行すると「既存の実績値をランダム値で上書き」してしまう
    if (existing === null) throw lastErr || new Error('player_damages を読めませんでした');
    existing = existing.filter(d => isUsableSlot(d.slot));   // 2枠運用に合わせる

    // 「編成が入っている行」だけを have 扱いにする。前シーズン引継ぎ分は編成が空のことがあり
    // (元の凸が characters 未記録だった等)、そのまま除外すると空編成のまま凸シードへ流れて
    // キャラ被りの検証ができない (今回の検証失敗の再発)。空/不完全な行は下で編成を補う
    const have = new Set();
    const needTeam = [];   // 編成が空の既存行 = 生成編成で埋める対象
    existing.forEach(d => {
        const key = `${d.player_id}:${d.attribute}`;
        if (_isValidTeam5(d.characters)) have.add(key);   // 有効な編成つき = そのまま使う
        else needTeam.push(d);                          // 編成なし/不正/不完全 = 補完対象
    });

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

    // 編成も現実に寄せて生成する (B1/B2共有・B3属性別)。
    // 編成が無いとキャラ被り (同キャラ1日1回) が起きず、最適プランの被り回避を検証できない
    // ⚠ order 必須: 返却順が変わると生成編成も変わり「決定的」でなくなる
    const { data: charMaster } = await supabase
        .from('nikke_characters')
        .select('canonical_name, burst')
        .order('canonical_name');
    const teamFor = _makeTestTeamGenerator(charMaster || []);

    const rows = [];
    // (a) 編成が空の既存行 (前シーズン引継ぎ分など) は、ダメージを保ったまま編成だけ補う
    needTeam.forEach(d => {
        const team = teamFor(d.player_id, d.attribute);
        if (team.length === 0) return;              // マスタが薄い環境では触らない
        const dmgKeep = Number(d.damage_b) || 0;
        rows.push({
            player_id: d.player_id,
            attribute: d.attribute,
            slot: d.slot || 1,                      // 既存行を更新する (別スロットを増やさない)
            damage_b: dmgKeep,                      // 引き継いだ実績値はそのまま
            // 編成を生成編成に差し替えるので、レベルタグは未指定に仕切り直す
            levels: dmgKeep > 0 ? { '0': dmgKeep } : null,
            boss_level: null,
            characters: team,
            updated_at: new Date().toISOString(),
        });
    });
    // (b) そもそも未登録の (player, attr) はダメージも編成もランダム生成
    (players || []).forEach(p => {
        const s = sums.get(p.id);
        const base = s && s.n > 0 ? s.total / s.n : globalAvg;
        ATTRS.forEach(attr => {
            if (have.has(`${p.id}:${attr}`)) return;
            if (needTeam.some(d => d.player_id === p.id && d.attribute === attr)) return;  // (a)で処理済み
            const dmg = base * (0.7 + Math.random() * 0.6);  // 基準値の 70〜130% でばらつかせる
            const dmgB = Number(dmg.toFixed(3));
            rows.push({
                player_id: p.id,
                attribute: attr,
                damage_b: dmgB,
                levels: { '0': dmgB },
                boss_level: null,
                characters: teamFor(p.id, attr),
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

    const { data: players, error: pErr } = await supabase.from('players').select('id, name');
    if (pErr) throw pErr;
    // 模擬の登録編成も一緒に読む: 凸には「実際に使った編成」を記録する必要がある。
    // これが無いと完了凸のキャラ消費が判定できず、最適プランのキャラ被り回避
    // (同キャラ1日1回 — 朝に鉄甲でラピを使ったら灼熱のラピ入りは出せない) を検証できない
    // 旧スキーマ互換 (slot/characters 未適用環境) — 読めた範囲で動く
    let dmgs = null, lastDmgErr = null;
    for (const cols of ['player_id, attribute, damage_b, characters, slot',
                        'player_id, attribute, damage_b, characters',
                        'player_id, attribute, damage_b']) {
        const r = await supabase.from('player_damages').select(cols);
        if (!r.error) { dmgs = r.data; break; }
        lastDmgErr = r.error;
    }
    // 読めないまま続行すると編成なし・ランダムダメージの凸になり検証にならない
    if (dmgs === null) throw lastDmgErr || new Error('player_damages を読めませんでした');
    dmgs = dmgs.filter(d => isUsableSlot(d.slot));   // 2枠運用に合わせる
    // ⚠ ダメージと編成は「同じ行」から取ること。1属性2編成 (slot=1|2) があるため、
    //    別々に上書きすると「slot2のダメージ + slot1の編成」という食い違いが起きる。
    //    slot 1 (主編成) を優先し、無ければ最初に見つかった行を使う
    const loOf = new Map();     // 'pid:attr' -> {dmg, team}
    (dmgs || []).forEach(d => {
        const k = `${d.player_id}:${d.attribute}`;
        const cur = loOf.get(k);
        const slot = Number(d.slot) || 1;
        if (cur && !(slot === 1 && cur.slot !== 1)) return;   // 既存が slot1 なら据え置き
        loOf.set(k, {
            slot,
            dmg: Number(d.damage_b) || 0,
            team: Array.isArray(d.characters) ? d.characters : [],
        });
    });

    // 30〜60% のメンバーを凸済みに。1凸:45% / 2凸:35% / 3凸:20%
    // ※ 基準者 (ふるり) はテストで締め凸依頼フローを自分宛てに確認できるよう
    //    常に凸済みシードから除外し、3凸フル残し = 締凸候補に必ず入る状態にする
    const baseName = globalThis.fururiBasePlayerName || 'ふるり';
    const ratio = 0.3 + Math.random() * 0.3;
    const chosen = (players || []).filter(p => p.name !== baseName && Math.random() < ratio);
    const rows = [];
    const bossDamage = new Map();   // boss_number -> 合計 raw
    for (const p of chosen) {
        const roll = Math.random();
        const nAtk = roll < 0.45 ? 1 : (roll < 0.8 ? 2 : 3);
        const pool = [...bosses].sort(() => Math.random() - 0.5).slice(0, nAtk);
        pool.forEach((b, i) => {
            const lo = loOf.get(`${p.id}:${b.weakness}`);
            const base = (lo && lo.dmg > 0) ? lo.dmg : (12 + Math.random() * 12);
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
                // その属性で登録している編成を「実際に使った編成」として記録。
                // → 最適プランがこのキャラを使用済みとして扱い、他属性の同キャラ編成を提案しなくなる
                characters: (lo && _isValidTeam5(lo.team)) ? lo.team : [],
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
// seasonId を渡すとそのシーズンへ配信する。省略時のみアクティブシーズンを引く。
// 呼び出し側が「事前に読んだ確認済み一覧」と同じシーズンへ確実に配信するために必要
// (シーズン切替と競合すると、旧シーズンの確認者へ新シーズンの更新通知を送ってしまう)
window.supabasePublishPlan = async function (planObj, publishedBy, publishedByName, seasonId = null) {
    let sid = seasonId;
    if (!sid) {
        const { data: season, error: sErr } = await supabase
            .from('seasons').select('id').eq('is_active', true).maybeSingle();
        if (sErr) throw sErr;
        if (!season) throw new Error('アクティブなシーズンがありません');
        sid = season.id;
    }
    const { data, error } = await supabase
        .from('published_plans')
        .insert({
            season_id: sid,
            plan: planObj,
            published_by: publishedBy || null,
            published_by_name: publishedByName || null,
        })
        .select('id, published_at')
        .single();
    if (error) throw error;
    // 同一シーズンの古い配信を掃除する。
    // ★ neq ではなく lt を使うこと — 運営が2人同時に配信すると neq では互いの INSERT を
    //   削除し合い、配信プランが0件になる順序がある。lt なら「自分より古い行」しか消さないので
    //   最後に入った行は必ず残る (id は BIGSERIAL = 単調増加)。
    // ※ INSERT と DELETE が別リクエストなので「常に1件だけ」は保証できない
    //   (同時配信では両方残り得る)。**読む側は id 降順で1件を選ぶ**ので表示は常に最新になり、
    //   残った古い行は次の配信で掃除される。完全な原子性が要るならサーバ側 RPC 化すること
    const delRes = await supabase.from('published_plans').delete().eq('season_id', sid).lt('id', data.id);
    if (delRes.error) console.warn('[publish] 旧配信の掃除に失敗 (表示は最新が出る):', delRes.error.message);
    window.supabaseLogActivity?.('ops', '凸プランを配信', { actorName: publishedByName || null });
    return data;
};

// 配信の中止 (取り下げ): そのシーズンの配信プランを全削除し、メンバーの画面から消す。
// plan_acks は published_plans への FK を持たない (28_plan_acks.sql) ので、
// 宙に浮いた「確認済み」を残さないよう同シーズンぶんを一緒に掃除する。
// 戻り値: 削除した配信の件数 (0 = もともと配信なし)。
window.supabaseUnpublishPlan = async function (seasonId, actorName = null) {
    const sid = Number(seasonId);
    if (!sid) throw new Error('シーズンが特定できないため中止できません');
    const { data, error } = await supabase
        .from('published_plans').delete().eq('season_id', sid).select('id');
    if (error) throw error;
    // acks の掃除は「いま消した配信ぶん」に限定する。season 全体で消すと、
    // 2人目の運営がこの2リクエストの間に配信していた場合その確認済みまで巻き込む (Codex指摘)。
    // 失敗しても中止自体は成立している (配信は消えている) ので警告どまり
    const removedIds = (data || []).map(r => r.id);
    if (removedIds.length > 0) {
        const ackRes = await supabase.from('plan_acks').delete().eq('season_id', sid).in('plan_id', removedIds);
        if (ackRes.error) console.warn('[unpublish] 確認済みの掃除に失敗:', ackRes.error.message);
    }
    window.supabaseLogActivity?.('ops', '凸プランの配信を中止', { actorName: actorName || null });
    return (data || []).length;
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
        _selectUsableDamages('player_id, attribute, damage_b, updated_at'),
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
    // ★ 人気編成・キャラ採用率も 2枠運用に合わせる (32未適用環境の③を混ぜない)
    const { data, error } = await _selectUsableDamages('player_id, attribute, damage_b, characters, players(name)',
        (q) => (attribute ? q.eq('attribute', attribute) : q));
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
    // ★ error を見ないと、取得失敗を「配信プランなし」と混同する (Codex指摘)。
    //   撃破通知の宛先計算で「割当ゼロ」に化けて通知が消えるため throw する
    const { data: season, error: sErr } = await supabase
        .from('seasons').select('id, month_key').eq('is_active', true).maybeSingle();
    if (sErr) throw sErr;
    if (!season) return null;
    const { data, error } = await supabase
        .from('published_plans')
        .select('id, season_id, plan, published_by, published_by_name, published_at')
        .eq('season_id', season.id)
        // id 降順まで指定する: 同時配信で複数行が残ったとき published_at だけでは
        // どちらを表示するか不定になる。id は挿入順なので必ず最新が決まる
        .order('published_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data ? { ...data, month_key: season.month_key } : null;
};

// ============ 戦況の通知 (撃破 / レベル開放) ============
// 「そのボスに関係する人だけ」に絞る (ユーザー判断 2026-08-09)。
// 全員配信にすると凸報告だけで1日90通になり、通知を切る人が出るため。

// 通知の確保: 一意制約で「まだ誰も送っていない」ことを確定させる。
// INSERT が通った1人だけが true を受け取り、送信する。
// これで「残HPを0にする経路が複数ある」「同時に2人が気づく」の両方に耐える。
// 29_raid_event_notices.sql 未適用なら false を返す (通知は出ないが本処理は壊さない)
const RAID_NOTICE_LEASE_MS = 90 * 1000;
let _raidNoticeWarned = false;   // 恒久エラーの警告は1回だけ   // 確保したまま送信されない状態を引き継ぐまでの猶予
window.supabaseClaimRaidNotice = async function (seasonId, kind, ref, byPlayerId) {
    if (!seasonId || !kind || !ref) return false;
    // 戻り値は3値。★ 単なる true/false にすると、呼び出し側が
    //   「送信済みだから諦める」と「誰かが確保中だから後で再挑戦」を区別できず、
    //   完了済みのイベントにも毎回のポーリングで INSERT を投げ続ける (Codex指摘)
    //     'claimed' = 送信権を取った / 'done' = 送信済み (もう何もしない)
    //     'held'    = 誰かが確保中 (まだ未送信。後でリースが切れたら引き継げる)
    const { error } = await supabase.from('raid_event_notices')
        .insert({ season_id: seasonId, kind, ref, notified_by: byPlayerId || null });
    if (!error) return 'claimed';
    if (error.code !== '23505') {   // 23505 = unique_violation (正常な競合)
        // ★ 恒久的なエラー (テーブル未適用・権限不足など) を 'held' で返すと、
        //   呼び出し側が毎回のポーリングで再挑戦し、失敗リクエストと警告が出続ける。
        //   直らない類のものは 'done' 扱いにして諦め、警告も1回だけにする (Codex指摘)
        const permanent = ['42P01', '42501', '42703'].includes(error.code);   // 未定義テーブル/権限不足/未定義列
        if (permanent) {
            if (!_raidNoticeWarned) {
                _raidNoticeWarned = true;
                console.warn('[raid notice] 通知の確保ができません (supabase/29_raid_event_notices.sql は適用済みですか?):', error.message);
            }
            return 'done';   // これ以上試しても直らない → 諦める (通知が出ないだけ)
        }
        console.warn('[raid notice] 確保に失敗 (一時的とみなして後で再挑戦):', error.message);
        return 'held';
    }
    // 既に行がある。送信まで終わっているなら何もしない。
    // 送信前のまま放置されている (確保した端末が落ちた等) なら引き継ぐ
    const { data: row, error: rErr } = await supabase.from('raid_event_notices')
        .select('sent, claimed_at').eq('season_id', seasonId).eq('kind', kind).eq('ref', ref).maybeSingle();
    if (rErr || !row) return 'held';
    if (row.sent) return 'done';
    const age = Date.now() - new Date(row.claimed_at).getTime();
    if (!(age > RAID_NOTICE_LEASE_MS)) return 'held';   // まだ送信中かもしれない
    // 引き継ぎ: claimed_at がさっき読んだ値のままの行だけ更新する (取り合いの排他)
    const { data: took } = await supabase.from('raid_event_notices')
        .update({ claimed_at: new Date().toISOString(), notified_by: byPlayerId || null })
        .eq('season_id', seasonId).eq('kind', kind).eq('ref', ref)
        .eq('claimed_at', row.claimed_at).eq('sent', false)
        .select('ref');
    if (took && took.length > 0) {
        console.log(`[raid notice] 放置された確保を引き継ぎます (${kind}/${ref})`);
        return 'claimed';
    }
    return 'held';
};

// 送信まで完了したことを記録する (これが立つと以後は誰も引き継がない)
window.supabaseMarkRaidNoticeSent = async function (seasonId, kind, ref) {
    if (!seasonId || !kind || !ref) return;
    const { error } = await supabase.from('raid_event_notices')
        .update({ sent: true })
        .eq('season_id', seasonId).eq('kind', kind).eq('ref', ref);
    if (error) console.warn('[raid notice] 送信済みの記録に失敗:', error.message);
};

// 確保の取り消し。
// ★ 確保 → 送信 の順なので、送信に失敗したら確保を戻さないと
//   「送っていないのに通知済み」になってその撃破は永久に通知されない (Codex指摘)。
//   戻せば次の検知 (ポーリング等) でもう一度誰かが確保して送り直せる
window.supabaseReleaseRaidNotice = async function (seasonId, kind, ref) {
    if (!seasonId || !kind || !ref) return;
    const { error } = await supabase.from('raid_event_notices').delete()
        .eq('season_id', seasonId).eq('kind', kind).eq('ref', ref);
    if (error) console.warn('[raid notice] 確保の取り消しに失敗:', error.message);
};

// ボス撃破の通知先: そのボスで凸を無駄にしそうな人。
//   ① そのボスに交戦宣言中の人 (いま撃ちに行こうとしている = 最も無駄になる)
//   ② 配信プランでそのボスを割り当てられていて、まだ報告していない人
// 本人 (撃破した人) は除く。
window.supabaseBossDefeatNotifyTargets = async function (seasonId, bossNumber, excludePlayerId, level) {
    // ★ 取得に失敗したら throw する。握り潰して「宛先ゼロ」にすると、
    //   送っていないのに完了扱いになり、その撃破は誰にも通知されない (Codex指摘)。
    //   throw すれば呼び出し側が確保を戻し、次の検知でやり直せる
    const targets = new Set();
    // ① 交戦宣言中
    const coords = await window.supabaseGetActiveFinishCoordinations();
    (coords || []).forEach(c => {
        if (Number(c.boss_number) === Number(bossNumber)) targets.add(c.player_id);
    });
    // ② 配信プランの割当 (未報告のみ)
    {
        const pub = await window.supabaseGetPublishedPlan();
        if (pub?.plan && Number(pub.season_id) === Number(seasonId)) {
            // ★ **いま撃破されたレベルの割当だけ**を見る。
            //   全レベルぶんを拾うと、次のレベルで同じボスを担当する人まで
            //   「もう凸できません」と通知されてしまう (実データで1撃破あたり10〜13名になった)
            const assigned = new Set(), assignedCount = new Map();
            (pub.plan.levels || []).forEach(lv => {
                if (level != null && Number(lv.level) !== Number(level)) return;
                (lv.bosses || []).forEach(b => {
                    if (Number(b.bossNumber) !== Number(bossNumber)) return;
                    (b.attacks || []).forEach(a => {
                        if (a.memberId == null) return;
                        assigned.add(a.memberId);
                        assignedCount.set(a.memberId, (assignedCount.get(a.memberId) || 0) + 1);
                    });
                });
            });
            if (assigned.size > 0) {
                // 「このレベルのこのボスへ既に報告済み」の人は外す。
                // ★ level も見ること — season+boss だけで判定すると、Lv1 で同じボスを
                //   報告した人が Lv2 の担当でも「報告済み」と誤認されて通知が届かない。
                //   同レベル同ボスに2凸割当の人は、割当数より報告数が少なければ対象に残す
                const q = supabase.from('attacks')
                    .select('player_id').eq('season_id', seasonId).eq('boss_number', bossNumber);
                const { data, error: aErr } = await (level != null ? q.eq('level', level) : q);
                // 取得に失敗したら「全員未報告」とみなして報告済みの人にも通知してしまう
                if (aErr) throw aErr;
                const doneCount = new Map();
                (data || []).forEach(x => doneCount.set(x.player_id, (doneCount.get(x.player_id) || 0) + 1));
                assignedCount.forEach((need, pid) => {
                    if ((doneCount.get(pid) || 0) < need) targets.add(pid);
                });
            }
        }
    }
    if (excludePlayerId != null) targets.delete(excludePlayerId);
    return [...targets];
};

// レベル開放の通知先: まだ凸が残っている人 (動ける人だけに知らせる)
window.supabaseLevelOpenNotifyTargets = async function (seasonId) {
    try {
        const [pRes, aRes] = await Promise.all([
            supabase.from('players').select('id').or('archived.is.null,archived.eq.false'),
            supabase.from('attacks').select('player_id').eq('season_id', seasonId),
        ]);
        if (pRes.error) throw pRes.error;
        // ★ attacks の取得失敗を握り潰すと、全員を「0凸」とみなして全員に通知してしまう
        if (aRes.error) throw aRes.error;
        const used = new Map();
        (aRes.data || []).forEach(a => used.set(a.player_id, (used.get(a.player_id) || 0) + 1));
        return (pRes.data || []).map(p => p.id).filter(id => (used.get(id) || 0) < 3);
    } catch (e) {
        // ここも握り潰さない — 宛先ゼロと取得失敗を混同すると通知が消える
        console.warn('[levelup notify] 対象の取得に失敗:', e?.message || e);
        throw e;
    }
};

// ============ 配信プランの「確認しました」 (28_plan_acks.sql) ============
// メンバーが「確認しました」を押した時点の published_plans.id を記録する。
// 運営が再配信すると id が変わるので、「確認済みの id ≠ 最新の id」= 更新あり と判定できる。
// 1シーズン1人1行 (最新の確認だけ持つ)。未適用環境ではエラーメッセージで適用を促す。
window.supabaseAckPlan = async function (playerId, seasonId, planId) {
    if (!playerId || !seasonId || !planId) throw new Error('確認の記録に必要な情報が足りません');
    const { error } = await supabase
        .from('plan_acks')
        .upsert({ season_id: seasonId, player_id: playerId, plan_id: planId, acked_at: new Date().toISOString() },
                { onConflict: 'season_id,player_id' });
    if (error) {
        if (/plan_acks/.test(error.message || '')) {
            throw new Error('plan_acks テーブルが未適用です。supabase/28_plan_acks.sql を SQL Editor で実行してください');
        }
        throw error;
    }
    return true;
};

// 自分が確認済みのプランID (未確認なら null)。テーブル未適用なら静かに null (機能を殺さない)
window.supabaseGetMyPlanAck = async function (playerId, seasonId) {
    if (!playerId || !seasonId) return null;
    const { data, error } = await supabase
        .from('plan_acks')
        .select('plan_id, acked_at')
        .eq('season_id', seasonId).eq('player_id', playerId)
        .maybeSingle();
    if (error) { console.warn('[plan ack] 取得skip:', error.message); return null; }
    return data || null;
};

// このシーズンで「確認しました」を押した人の一覧 (再配信時の通知対象)。
// 未適用環境では空配列 = 通知を飛ばさないだけで配信自体は成功させる
window.supabaseLoadPlanAcks = async function (seasonId) {
    if (!seasonId) return [];
    const { data, error } = await supabase
        .from('plan_acks')
        .select('player_id, plan_id, acked_at')
        .eq('season_id', seasonId);
    if (error) { console.warn('[plan ack] 一覧取得skip:', error.message); return []; }
    return data || [];
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
            // boss_level / levels は「スナップショットに入っていれば」戻す。
            // 旧スナップショット (30/31 適用前に作ったテストシーズン) には無いので undefined →
            // その場合は列ごと落として旧挙動のまま復元する
            const hasLevel = snapshot.some(s => s.boss_level !== undefined);
            const hasLevels = snapshot.some(s => s.levels !== undefined);
            // ★ 32 適用後は slot>=3 が CHECK 違反になる。古いテストシーズンの
            //   スナップショットに③が入っていると、**全削除したあとの復元がまるごと失敗し
            //   模擬データが消えたまま終了処理が進む**ため、ここで落とす (Codex指摘 2026-08-12)
            const kept = snapshot.filter(s => isUsableSlot(s.slot));
            const dropped = snapshot.length - kept.length;
            if (dropped > 0) console.warn(`[endTestSeason] slot>${MOCK_SLOT_MAX} の ${dropped} 行はスナップショットから除外して復元します`);
            const rowsWithChars = kept.map(s => ({
                player_id: s.player_id,
                attribute: s.attribute,
                damage_b: s.damage_b,
                slot: s.slot || 1,
                characters: Array.isArray(s.characters) ? s.characters : [],
                ...(hasLevel ? { boss_level: _normBossLevel(s.boss_level) } : {}),
                ...(hasLevels ? { levels: s.levels ?? null } : {}),
            }));
            const r1 = await _upsertPlayerDamages(rowsWithChars);
            if (r1.error && /column.*characters/i.test(String(r1.error?.message))) {
                // characters 列が DB に存在しない環境にフォールバック
                const rowsBasic = kept.map(s => ({
                    player_id: s.player_id,
                    attribute: s.attribute,
                    damage_b: s.damage_b,
                    slot: s.slot || 1,
                    ...(hasLevel ? { boss_level: _normBossLevel(s.boss_level) } : {}),
                    ...(hasLevels ? { levels: s.levels ?? null } : {}),
                }));
                const r2 = await _upsertPlayerDamages(rowsBasic);
                if (r2.error) throw r2.error;
            } else if (r1.error) {
                // ★ 復元は「全削除 → 入れ直し」なので、ここで黙って進むと模擬データが消える。
                //   characters 列以外の失敗も必ず表に出す (Codex指摘 2026-08-12)
                throw r1.error;
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

// player_damages の characters カラムを更新 (該当行が無ければ upsert で作成)。
// ★ 編成が変わる場合はレベル別測定を仕切り直す (levels = {"0": 現damage_b})。
//   旧編成で測った値のレベルタグを新編成に相続させないため (過大評価の温床)。
//   値そのものは「登録済みダメージ」として残す — 人気編成の反映や凸報告の焼き戻しは
//   「編成だけ差し替える」操作であり、数値まで消すとユーザーの提出が失われる
window.supabaseSaveTeamForAttribute = async function (playerId, attribute, characters, slot = 1) {
    if (!playerId || !attribute || !Array.isArray(characters)) return;
    const cleaned = characters.filter(c => typeof c === 'string' && c.trim().length > 0);
    try {
        const ml = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
        const rmw = ml ? await _loadDamageRowForMerge(playerId, attribute, slot) : { legacy: true, failed: false, row: null };
        const payload = {
            player_id: playerId,
            attribute,
            slot,
            characters: cleaned,
            updated_at: new Date().toISOString(),
        };
        // 取得失敗時は旧動作 (編成のみの upsert) に倒す — 編成保存自体を落とさない。
        // レベルタグの仕切り直しは次の levels 対応保存時に DB トリガーが整合させる
        if (!rmw.legacy && !rmw.failed && ml && rmw.row) {
            const exChars = Array.isArray(rmw.row.characters) ? rmw.row.characters : [];
            const changed = cleaned.length > 0
                && (exChars.length === 0 || !ml.sameTeam(cleaned, exChars));
            if (changed) {
                const d = Number(rmw.row.damage_b) || 0;
                payload.levels = d > 0 ? { '0': d } : null;
                payload.damage_b = d;
                payload.boss_level = null;
            }
        }
        await _upsertPlayerDamages([payload]);
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
window.supabaseRegisterCharacterWithIcon = async function (canonicalName, iconPath, burst = null) {
    if (!canonicalName || typeof canonicalName !== 'string') throw new Error('canonical_name 必須');
    if (!iconPath || typeof iconPath !== 'string') throw new Error('icon_path 必須');
    const name = canonicalName.trim();
    if (!name) throw new Error('canonical_name 空不可');
    // 既存をチェック ('*' なので burst_alt 未マイグレ環境では単に生えてこないだけ)
    const { data: existing } = await supabase
        .from('nikke_characters')
        .select('*')
        .eq('canonical_name', name)
        .maybeSingle();

    // burst は選択されたときだけ書く (未選択なら列に触れない = burst未マイグレ環境でも動く)
    const burstPatch = burst ? { burst } : {};
    // 新しい主バーストが既存のサブと同値になるとサブが無意味 & 25 の CHECK 制約に違反する → 落とす
    if (burst && existing?.burst_alt && existing.burst_alt === burst) burstPatch.burst_alt = null;

    const nowIso = new Date().toISOString();
    if (existing) {
        const paths = Array.isArray(existing.icon_paths) ? [...existing.icon_paths] : [];
        if (!paths.includes(iconPath)) paths.push(iconPath);
        // error を握り潰すと「登録できた」と表示したまま実際は保存されない → 必ず投げる
        const { error: updErr } = await supabase.from('nikke_characters').update({
            icon_paths: paths,
            is_confirmed: true,   // 運営が手動でひも付けたのは確定扱い
            last_seen: nowIso,
            ...burstPatch,
        }).eq('canonical_name', name);
        if (updErr) throw updErr;
        return { canonical_name: name, updated: true, icon_count: paths.length };
    }
    // 新規登録
    const { error: insErr } = await supabase.from('nikke_characters').insert({
        canonical_name: name,
        aliases: [],
        icon_paths: [iconPath],
        sighting_count: 0,
        is_confirmed: true,
        first_seen: nowIso,
        last_seen: nowIso,
        ...burstPatch,
    });
    if (insErr) throw insErr;
    return { canonical_name: name, inserted: true, icon_count: 1 };
};

// ➕ 新キャラの事前登録: 正式名だけ先にマスタへ入れておく (アイコンは後から自動学習)
// 実装直後の新キャラを OCR が誤解決しないよう、運営が名前を先回りで登録する用途。
window.supabaseRegisterNikkeCharName = async function (name, burst = null) {
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
        ...(burst ? { burst } : {}),   // 選択時のみ書く
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

// PostgREST が「そんな列は無い」と言っているかの判定 (25_nikke_burst_alt.sql 未適用環境の検出用)
function _isMissingColumnErr(error, col) {
    if (!error || !col) return false;
    const blob = `${error.code || ''} ${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
    if (!blob.includes(col)) return false;
    // 制約違反 (23514: 制約名に burst_alt を含む) を「列が無い」と誤読しないよう文言は絞る
    return error.code === 'PGRST204' || error.code === '42703'
        || /could not find .*column|column .* does not exist|schema cache/i.test(blob);
}

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
        // burst は patch指定を優先、なければ新旧行の値を保持
        const mergedBurst = (patch.burst !== undefined) ? (patch.burst || null) : (existing?.burst ?? old.burst ?? null);
        const rawAlt = (patch.burst_alt !== undefined) ? (patch.burst_alt || null) : (existing?.burst_alt ?? old.burst_alt ?? null);
        // サブは「主があって、主と別値」のときだけ有効 (25 の CHECK 制約に合わせる)
        const mergedAlt = (mergedBurst && rawAlt && rawAlt !== mergedBurst) ? rawAlt : null;
        const row = {
            canonical_name: newCanonical,
            aliases: mergedAliases,
            sighting_count: mergedCount,
            is_confirmed: (isConfirmed != null ? !!isConfirmed : (existing?.is_confirmed || old.is_confirmed)),
            first_seen: old.first_seen,
            last_seen: new Date().toISOString(),
            ...(mergedBurst ? { burst: mergedBurst } : {}),
            ...(mergedAlt ? { burst_alt: mergedAlt } : {}),
        };
        const { error: upErr } = await supabase.from('nikke_characters').upsert(row);
        // 未マイグレ環境では引き継ぎ元の burst_alt も undefined なので、ここでこのエラーが出るのは
        // 「呼び出し側が明示的にサブを保存しようとした」ときだけ。黙って捨てず案内する
        if (upErr && mergedAlt && _isMissingColumnErr(upErr, 'burst_alt')) {
            throw new Error('サブバーストの保存には supabase/25_nikke_burst_alt.sql の適用が必要です (Supabase → SQL Editor で実行してください)');
        }
        if (upErr) throw upErr;
        // 旧行を削除
        await supabase.from('nikke_characters').delete().eq('canonical_name', oldCanonical);
        return { renamed: true, canonical_name: newCanonical };
    }
    // 通常更新
    const update = {};
    if (newAliases != null) update.aliases = newAliases;
    if (isConfirmed != null) update.is_confirmed = !!isConfirmed;
    if (Array.isArray(patch.icon_paths)) update.icon_paths = patch.icon_paths.filter(Boolean);
    if (patch.burst !== undefined) update.burst = patch.burst || null;   // '' → null で未設定に戻せる
    if (patch.burst_alt !== undefined) update.burst_alt = patch.burst_alt || null;

    // 主・サブの整合を取る (25 の CHECK: サブは「主があって、主と別値」のときだけ許される)。
    // 片方だけ更新する呼び出しだと据え置き側と衝突して制約違反で落ちうるので、現在値を読んで潰す。
    // 例: burst だけ B1 に変える → 既存 burst_alt='B1' が同値になり違反 → サブを null にする
    if (('burst' in update) || ('burst_alt' in update)) {
        let cur = null;
        if (('burst' in update) !== ('burst_alt' in update)) {
            // 片方だけの更新 → 据え置き側の現在値が要る (両方来ているなら読む必要はない)
            try {
                const { data } = await supabase.from('nikke_characters')
                    .select('*').eq('canonical_name', oldCanonical).maybeSingle();
                cur = data || null;
            } catch { /* 読めなければ整合チェックは諦め、DB の CHECK 制約に委ねる */ }
        }
        // 未マイグレ環境では cur.burst_alt が undefined → null 扱いになり、何も足さない
        const finalBurst = ('burst' in update) ? update.burst : (cur?.burst ?? null);
        const finalAlt = ('burst_alt' in update) ? update.burst_alt : (cur?.burst_alt ?? null);
        const okAlt = (finalBurst && finalAlt && finalAlt !== finalBurst) ? finalAlt : null;
        if (okAlt !== finalAlt) update.burst_alt = okAlt;   // 無効化が必要なときだけ明示的に書く
    }
    if (Object.keys(update).length === 0) return { unchanged: true };
    let { error } = await supabase.from('nikke_characters').update(update).eq('canonical_name', oldCanonical);
    if (error && 'burst_alt' in update && _isMissingColumnErr(error, 'burst_alt')) {
        // 25_nikke_burst_alt.sql 未適用。サブを実際に設定しようとしたなら黙って捨てず案内する
        if (update.burst_alt) {
            throw new Error('サブバーストの保存には supabase/25_nikke_burst_alt.sql の適用が必要です (Supabase → SQL Editor で実行してください)');
        }
        // 空のサブを消そうとしただけ → 列抜きでリトライ
        const { burst_alt: _drop, ...rest } = update;
        if (Object.keys(rest).length === 0) return { unchanged: true };
        ({ error } = await supabase.from('nikke_characters').update(rest).eq('canonical_name', oldCanonical));
    }
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
    const { data: dmgs } = await _selectUsableDamages('player_id, updated_at');

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

    const { data: dmgRows } = await _selectUsableDamages('attribute, damage_b, updated_at, players(name)',
        (q) => q.order('updated_at', { ascending: false }).limit(15));
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
    // ★ order は必須。ソルバーは同ダメージの編成を「列挙順 (ord)」で安定タイブレークするので、
    //   DB の返却順が揺れると同じ盤面でも別のプランが出る = 配信の前提が崩れる
    //   (Codex指摘 2026-08-10。レベル違いの並行登録で同値が増えるため顕在化しやすい)
    // ★★ order の列は**その段の select に存在する列だけ**にすること。
    //   全段で slot を order すると、slot 未適用環境では最後の旧列フォールバックまで失敗し、
    //   dmgs が null のまま「登録ダメージ無し」の空盤面になる (Codex指摘 2026-08-10)
    for (const [sel, orderCols] of [
        ['player_id, attribute, damage_b, updated_at, characters, slot, boss_level, levels', ['player_id', 'attribute', 'slot']],
        ['player_id, attribute, damage_b, updated_at, characters, slot, boss_level', ['player_id', 'attribute', 'slot']],
        ['player_id, attribute, damage_b, updated_at, characters, slot', ['player_id', 'attribute', 'slot']],
        ['player_id, attribute, damage_b, updated_at, characters', ['player_id', 'attribute']],
        ['player_id, attribute, damage_b, updated_at', ['player_id', 'attribute']],
    ]) {
        try {
            let q = supabase.from('player_damages').select(sel);
            for (const c of orderCols) q = q.order(c, { ascending: true });
            const r = await q;
            if (!r.error) { dmgs = r.data; break; }
        } catch { /* fallthrough */ }
    }
    const dmgByPlayer = new Map();     // { player_id: { attr: 最大ダメージ } } (既存консюмер用)
    const teamByPlayer = new Map();    // { player_id: { attr: [chars] } } (slot1優先)
    // { player_id: { attr: [{dmgB, team, slot, level}] } } (ソルバーの2編成 + レベル対応用)
    // level = 模擬で測定したボスレベル (1〜4)。null = 未指定 = 全レベルで使える (移行互換)
    const loadoutsByPlayer = new Map();
    const mlDom = (typeof window !== 'undefined' && window.mockLevelsDomain) || null;
    (dmgs || []).forEach(d => {
        // 32未適用環境に残る slot=3 はここでも締め出す。
        // 落とさないと「ソルバーは③を使うのに模擬タブは編集できない」不整合になる
        if (!isUsableSlot(d.slot)) return;
        const v = Number(d.damage_b) || 0;
        const slot = d.slot || 1;
        const level = _normBossLevel(d.boss_level);
        // levels = スロット内のレベル別測定値 (31)。未適用/旧行は (damage_b, boss_level) の
        // 1測定に正規化される — ソルバーは常に levels を読めばよい
        const levels = mlDom ? mlDom.normLevels(d.levels, d.damage_b, d.boss_level) : null;
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
            lm[d.attribute].push({ dmgB: v, team, slot, level, levels });
        }
    });

    // 3) アクティブシーズンの全凸を一括取得
    let attacksByPlayer = new Map();
    if (season) {
        // characters = その凸で実際に使った5キャラ。最適プランが「同キャラ1日1回」の
        // 被り判定に使う (朝に鉄甲でラピを使ったら灼熱のラピ入り編成は出せない)。
        // 未記録 (代理凸・一括登録) の場合は [] のままで best-effort 扱い。
        // ⚠ characters 列が無い環境 (新規プロジェクト等) でも運営盤面全体が落ちないよう、
        //   列エラーなら旧列構成で取り直す (被り判定だけ静かに劣化する)
        const ATK_COLS = 'id, player_id, attack_number, boss_number, boss_code, damage_raw, level';
        let { data: atks, error: aErr } = await supabase
            .from('attacks')
            .select(`${ATK_COLS}, characters`)
            .eq('season_id', season.id)
            .eq('attack_date', season.hard_date);
        // 再試行は「characters 列が無い」ときだけ。通信断・RLS・タイムアウト等で
        // 無条件に再試行すると、障害時のリクエストと待ち時間が倍になり本来の原因も隠れる。
        // 判定は既存の _isMissingColumnErr (列名を必ず含むことを要求する) を再利用
        if (aErr && _isMissingColumnErr(aErr, 'characters')) {
            console.warn('[ops] attacks.characters 列が無いため旧列構成で再試行 (キャラ被り判定は劣化):', aErr.message);
            ({ data: atks, error: aErr } = await supabase
                .from('attacks')
                .select(ATK_COLS)
                .eq('season_id', season.id)
                .eq('attack_date', season.hard_date));
        }
        if (aErr) throw aErr;
        (atks || []).forEach(a => {
            if (!attacksByPlayer.has(a.player_id)) attacksByPlayer.set(a.player_id, []);
            // 旧スキーマの画像パス混入を除去してキャラ名だけ通す (照合は名前で行うため)
            attacksByPlayer.get(a.player_id).push({
                ...a,
                characters: (Array.isArray(a.characters) ? a.characters : []).filter(_isLikelyCharName),
            });
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
            loadoutsByAttr: loadoutsByPlayer.get(p.id) || {},   // 1属性最大2編成 + 測定レベル (ソルバー用)
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
