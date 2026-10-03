// ============================================================================
// 🎮 練習モードの実行テスト
//   node tests/practice.mjs
// ----------------------------------------------------------------------------
// 練習モードは「本番の画面と js/supabase-client.js の関数をそのまま動かし、通信だけ端末の中の偽のサーバで受ける」。
// ここでは実際に動かして、次の約束を固定する:
//   1. 偽のサーバ (js/practice/server.js) が、本番のサーバと同じ答えを返す
//      (問い合わせの口 / 主キー・一意制約 / 予約のトリガー / RPC = supabase/39・40・45・47 の写し)
//   2. **本物の** js/supabase-client.js の関数が、偽のサーバ相手に最後まで動く (時間の確認 → 模擬 → 予約 → 承認 → 凸報告 → 締め凸)
//   3. 練習中は本物の DB へ書かない (本物のクライアントを作らない・通信は GET 1 回だけ・端末の通知設定に触れない)
//   4. 起動 (js/practice/boot.js) が、印が無ければ何もせず、あれば 端末の記憶・時計 を練習用に差し替える
// ★ ブラウザでの通し確認 (案内の枠だけを押して最後まで進める) は tests/practice-e2e.mjs (Chrome が要る)
// ============================================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// js/ は package.json を持たない (ブラウザ用)。ESM として読むために、型つきの一時フォルダへ写してから import する
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-practice-'));
fs.mkdirSync(path.join(TMP, 'js/practice'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}');
for (const f of ['js/supabase-client.js', 'js/practice/session.js', 'js/practice/server.js', 'js/practice/seed.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f));
}
const imp = (f) => import(pathToFileURL(path.join(TMP, f)).href);
const { createPracticeClient, SCHEMA, BUILDER_METHODS } = await imp('js/practice/server.js');
const { buildSeed, IDS, ME_NAME, OPS_NAME, NOT_SUBMITTED, FALLBACK_CHARACTERS } = await imp('js/practice/seed.js');

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const clean = (v) => { const s = JSON.stringify(v); assert.ok(!/undefined|NaN/.test(s), `undefined / NaN が混ざっている: ${s.slice(0, 200)}`); return v; };

// ---- 小さな盤面 ----
const T0 = 1790000000000;   // 練習の時計 (固定)
const mini = () => createPracticeClient({
    now: () => T0,
    tables: {
        seasons: [{ id: 1, month_key: '2026-10', hard_date: '2026-10-03', is_active: true }],
        players: [{ id: 10, name: 'あ' }, { id: 11, name: 'い' }, { id: 12, name: 'う', archived: true }],
        bosses: [1, 2, 3, 4, 5].map(n => ({ season_id: 1, boss_number: n, boss_code: 'B' + n, attribute: 'fire', weakness: 'water', tier: 'lord', total_hp_raw: 100e9, remaining_hp_raw: 100e9 })),
    },
});
const resvRow = (o = {}) => ({ season_id: 1, player_id: 10, boss_number: 1, loadout_slot: 1, time_mode: 'fixed', time_slot: 'h21', requested_by: 'あ', ...o });

// ============================== 1. 問い合わせの口 ==============================
test('select: 絞り込み・並び・件数・1件取り (本番の PostgREST と同じ答え)', async () => {
    const sb = mini();
    let r = await sb.from('players').select('id, name').eq('archived', false).order('id', { ascending: false });
    assert.deepEqual(r.data, [{ id: 11, name: 'い' }, { id: 10, name: 'あ' }]);
    assert.equal(r.error, null);
    r = await sb.from('players').select('*').eq('id', '10').single();          // 数字の文字列でも一致する
    assert.equal(r.data.name, 'あ');
    assert.equal(r.data.finish_alert, true, '既定値が入っていない');
    r = await sb.from('players').select('id').eq('id', 999).maybeSingle();
    assert.deepEqual([r.data, r.error], [null, null], 'maybeSingle は 0 件でエラーにしない');
    r = await sb.from('players').select('id').eq('id', 999).single();
    assert.equal(r.error.code, 'PGRST116', 'single は 0 件でエラー');
    r = await sb.from('players').select('id').single();
    assert.equal(r.error.code, 'PGRST116', 'single は 複数件でエラー');
    r = await sb.from('bosses').select('id', { count: 'exact', head: true }).eq('season_id', 1);
    assert.deepEqual([r.data, r.count], [null, 5], 'head:true は件数だけ');
    r = await sb.from('bosses').select('boss_number').order('boss_number').range(1, 2);
    assert.deepEqual(r.data.map(x => x.boss_number), [2, 3]);
    r = await sb.from('bosses').select('boss_number').order('boss_number', { ascending: false }).limit(2);
    assert.deepEqual(r.data.map(x => x.boss_number), [5, 4]);
    r = await sb.from('bosses').select('boss_number').in('boss_number', [2, '4', 9]).gt('boss_number', 2).lte('boss_number', 4);
    assert.deepEqual(r.data.map(x => x.boss_number), [4]);
    r = await sb.from('players').select('id').neq('name', 'あ').lt('id', 12).gte('id', 11);
    assert.deepEqual(r.data, [{ id: 11 }]);
    r = await sb.from('players').select('id').or('archived.is.null,archived.eq.true');
    assert.deepEqual(r.data, [{ id: 12 }]);
    r = await sb.from('players').select('id').is('notes', null).eq('id', 10);
    assert.equal(r.data.length, 1);
    r = await sb.from('players').select('id').eq('notes', null);
    assert.equal(r.data.length, 0, 'eq(列, null) は SQL と同じく何にも一致しない');
});
test('select: 埋め込み players(name)・無い列は null・返した行を書き換えても DB は変わらない', async () => {
    const sb = mini();
    await sb.from('attacks').insert({ season_id: 1, player_id: 11, attack_date: '2026-10-03', attack_number: 1, damage_raw: 5 });
    let r = await sb.from('attacks').select('attack_number, nope, players(name)');
    assert.deepEqual(r.data, [{ attack_number: 1, nope: null, players: { name: 'い' } }]);
    r = await sb.from('players').select('strong_attributes').eq('id', 10).single();
    r.data.strong_attributes.push('fire');
    const again = await sb.from('players').select('strong_attributes').eq('id', 10).single();
    assert.deepEqual(again.data.strong_attributes, [], '返した配列が DB の中身とつながっている');
    const all = await sb.from('players').select('*').eq('id', 10).single();          // 列を選ばない (*) ときも同じ
    all.data.strong_attributes.push('water');
    assert.deepEqual((await sb.from('players').select('*').eq('id', 10).single()).data.strong_attributes, [], 'select(*) で返した配列が DB の中身とつながっている');
    r = await sb.from('nikke_characters').insert({ canonical_name: 'X', icon_paths: ['a.webp', 'b.webp'] });
    r = await sb.from('nikke_characters').select('canonical_name').contains('icon_paths', ['b.webp']);
    assert.equal(r.data.length, 1);
    r = await sb.from('attacks').select('id, seasons(month_key), bosses(name)');
    assert.equal(r.error.code, 'PGRST200', '知らない埋め込みを黙って通している');
});
test('書き込み: 連番・既定値・必須の列・一意制約・upsert・絞り込みの無い更新/削除は拒否', async () => {
    const sb = mini();
    let r = await sb.from('players').insert({ name: 'え' }).select().single();
    assert.equal(r.data.id, 13, '連番が種データの続きになっていない');
    assert.equal(r.data.created_at, new Date(T0).toISOString(), '時刻が練習の時計でない');
    r = await sb.from('players').insert({ name: 'あ' });
    assert.equal(r.error.code, '23505', '名前の重複を通している');
    r = await sb.from('players').insert({ notes: 'x' });
    assert.equal(r.error.code, '23502', '必須の列 (name) が無いのに通している');
    r = await sb.from('players').insert([{ name: 'お' }, { name: 'お' }]);
    assert.equal(r.error.code, '23505');
    assert.equal((await sb.from('players').select('id').eq('name', 'お')).data.length, 0, '失敗した 1 文の途中までが残っている (巻き戻していない)');
    // upsert: 主キーで / onConflict で
    r = await sb.from('player_sync_levels').upsert({ season_id: 1, player_id: 10, sync_level: 600 });
    r = await sb.from('player_sync_levels').upsert({ season_id: 1, player_id: 10, sync_level: 610 }).select().single();
    assert.equal(r.data.sync_level, 610);
    assert.equal((await sb.from('player_sync_levels').select('*')).data.length, 1, 'upsert が 2 行にしている');
    await sb.from('push_subscriptions').upsert({ player_id: 10, endpoint: 'e1', p256dh: 'a', auth: 'a' }, { onConflict: 'endpoint' });
    await sb.from('push_subscriptions').upsert({ player_id: 11, endpoint: 'e1', p256dh: 'b', auth: 'b' }, { onConflict: 'endpoint' });
    r = await sb.from('push_subscriptions').select('player_id, p256dh');
    assert.deepEqual(r.data, [{ player_id: 11, p256dh: 'b' }]);
    // update / delete
    r = await sb.from('players').update({ notes: 'memo' }).eq('id', 10).select('notes, updated_at').single();
    assert.equal(r.data.notes, 'memo');
    r = await sb.from('players').update({ notes: 'all' });
    assert.equal(r.error.code, '21000', '絞り込みの無い update を通している');
    r = await sb.from('players').delete();
    assert.equal(r.error.code, '21000', '絞り込みの無い delete を通している');
    r = await sb.from('players').update({ name: 'い' }).eq('id', 10);
    assert.equal(r.error.code, '23505', '更新での重複を通している');
    // 親を消したら子も消える (ON DELETE CASCADE)
    await sb.from('attacks').insert({ season_id: 1, player_id: 11, attack_date: '2026-10-03', attack_number: 1 });
    await sb.from('players').delete().eq('id', 11);
    assert.equal((await sb.from('attacks').select('id')).data.length, 0, 'プレイヤーを消しても凸が残っている');
    // 知らない表 / 知らない RPC は本番と同じコードで返す (クライアントの「未適用」判定が読む)
    assert.equal((await sb.from('no_such_table').select('*')).error.code, 'PGRST205');
    assert.equal((await sb.rpc('no_such_fn', {})).error.code, 'PGRST202');
});

// ============================== 2. 予約のトリガーと RPC ==============================
test('予約: 残凸の枠 (生きている予約 + 実凸 ≤ 3) を超えたら断る (39 capacity)', async () => {
    const sb = mini();
    for (const b of [1, 2, 3]) assert.equal((await sb.from('plan_reservations').insert(resvRow({ boss_number: b }))).error, null);
    let r = await sb.from('plan_reservations').insert(resvRow({ boss_number: 4 }));
    assert.equal(r.error.code, '23514');
    assert.match(r.error.message, /残凸を超える予約はできません \(生きている予約 3 件 \+ 実凸 0 件\)/);
    // 実凸も数える
    const sb2 = mini();
    await sb2.from('attacks').insert({ season_id: 1, player_id: 10, attack_date: '2026-10-03', attack_number: 1 });
    await sb2.from('attacks').insert({ season_id: 1, player_id: 10, attack_date: '2026-10-03', attack_number: 2 });
    assert.equal((await sb2.from('plan_reservations').insert(resvRow({ boss_number: 1 }))).error, null);
    r = await sb2.from('plan_reservations').insert(resvRow({ boss_number: 2 }));
    assert.match(r.error.message, /生きている予約 1 件 \+ 実凸 2 件/);
    // 同じカード (同じ人・ボス・編成枠) に生きている予約は 1 つ
    const sb3 = mini();
    await sb3.from('plan_reservations').insert(resvRow());
    assert.equal((await sb3.from('plan_reservations').insert(resvRow({ time_slot: 'h22' }))).error.code, '23505');
    // 時刻の形
    assert.equal((await sb3.from('plan_reservations').insert(resvRow({ boss_number: 2, time_slot: '21時' }))).error.code, '23514');
    assert.equal((await sb3.from('plan_reservations').insert(resvRow({ boss_number: 2, time_mode: 'flex', time_slot: null }))).error, null);
});
test('予約: 状態は RPC 経由でしか変えられない / 遷移表は 47 と同じ / 承認後は中身を変えられない', async () => {
    const sb = mini();
    const id = (await sb.from('plan_reservations').insert(resvRow()).select('id').single()).data.id;
    let r = await sb.from('plan_reservations').update({ status: 'approved' }).eq('id', id);
    assert.match(r.error.message, /reservation_set_status\(\) 経由で変更してください/);
    r = await sb.rpc('reservation_set_status', { p_id: id, p_to: 'approved' });
    assert.match(r.error.message, /p_expect_from\) は必須/);
    r = await sb.rpc('reservation_set_status', { p_id: id, p_to: 'approved', p_expect_from: 'approved' });
    assert.equal(r.error.code, '40001', '期待と違う状態からの遷移を通している');
    r = await sb.rpc('reservation_set_status', { p_id: id, p_to: 'fulfilled', p_expect_from: 'requested' });
    assert.match(r.error.message, /許可されていない状態遷移です \(requested → fulfilled\)/);
    r = await sb.rpc('reservation_set_status', { p_id: 999, p_to: 'approved', p_expect_from: 'requested' });
    assert.equal(r.error.code, 'P0002');
    r = await sb.rpc('reservation_set_status', { p_id: id, p_to: 'approved', p_expect_from: 'requested', p_actor: '運営', p_expected_b: 30.5, p_characters: ['a', 'b'] });
    assert.equal(r.error, null);
    assert.deepEqual([r.data.status, r.data.approved_by, r.data.expected_damage_b, r.data.characters_snapshot], ['approved', '運営', 30.5, ['a', 'b']]);
    assert.equal(r.data.approved_at, new Date(T0).toISOString());
    // 履歴: 作成 + 承認
    const ev = (await sb.from('plan_reservation_events').select('from_status, to_status, actor_name, reason').order('id')).data;
    assert.deepEqual(ev, [{ from_status: null, to_status: 'requested', actor_name: 'あ', reason: 'created' }, { from_status: 'requested', to_status: 'approved', actor_name: '運営', reason: null }]);
    assert.equal((await sb.from('plan_reservation_events').update({ reason: 'x' }).eq('reservation_id', id)).error.code, '23514', '履歴を書き換えられる');
    assert.equal((await sb.from('plan_reservation_events').delete().eq('reservation_id', id)).error.code, '23514', '履歴を消せる');
    // 承認後は 誰が・ボス・時刻・編成 を変えられない
    r = await sb.from('plan_reservations').update({ time_slot: 'h22' }).eq('id', id);
    assert.match(r.error.message, /承認済みの予約の内容/);
    assert.equal((await sb.from('plan_reservations').update({ asked_at: new Date(T0).toISOString() }).eq('id', id)).error, null, '約束に関係ない列まで止めている');
    // 全ての組み合わせを 47 の表と突き合わせる
    const ALLOW = { requested: ['approved', 'rejected', 'cancel_requested'], approved: ['cancel_requested', 'fulfilled', 'released'], cancel_requested: ['released', 'approved'], pinned: ['approved', 'released'] };
    const ALL = ['requested', 'approved', 'cancel_requested', 'fulfilled', 'released', 'rejected', 'pinned'];
    for (const from of ALL) for (const to of ALL) {
        const s = createPracticeClient({ now: () => T0, tables: { seasons: [{ id: 1, month_key: 'm', hard_date: '2026-10-03' }], players: [{ id: 10, name: 'あ' }],
            plan_reservations: [resvRow({ id: 1, status: from, approved_at: from === 'cancel_requested' ? null : undefined })] } });
        const res = await s.rpc('reservation_set_status', { p_id: 1, p_to: to, p_expect_from: from, p_actor: 'x' });
        assert.equal(!res.error, (ALLOW[from] || []).includes(to), `${from} → ${to} の扱いが 47 と違う`);
    }
});
test('📌 運営の固定: 約束 + 固定 + 実凸 ≤ 3 (47 pin_check) / 承認の瞬間に同じカードの 📌 を外す', async () => {
    const sb = mini();
    const pin = (b, extra = {}) => sb.from('plan_reservations').insert(resvRow({ boss_number: b, status: 'pinned', pinned_by: '運営', ...extra })).select('id').single();
    for (const b of [1, 2, 3]) assert.equal((await pin(b)).error, null);
    let r = await pin(4);
    assert.match(r.error.message, /運営の固定が残凸を超えます \(約束・固定 3 件 \+ 実凸 0 件\)/);
    // 同じカードに 📌 は 1 つ (枠に余裕がある盤面で見る — 枠が埋まっていると pin_check が先に断る。本番もトリガーが一意索引より先)
    const sbDup = mini();
    await sbDup.from('plan_reservations').insert(resvRow({ status: 'pinned', pinned_by: '運営' }));
    assert.equal((await sbDup.from('plan_reservations').insert(resvRow({ status: 'pinned', pinned_by: '運営', time_slot: 'h22' }))).error.code, '23505', '同じカードに 📌 を 2 つ置ける');
    // 固定は動かせる (約束ではない)
    assert.equal((await sb.from('plan_reservations').update({ time_slot: 'h23' }).eq('boss_number', 1)).error, null);
    // 本人の申請を承認 → 同じカードの 📌 は同じ処理の中で外れる (約束 1 + 📌 3 を 4 件と数えない)
    const req = (await sb.from('plan_reservations').insert(resvRow({ boss_number: 1 })).select('id').single()).data.id;
    r = await sb.rpc('reservation_set_status', { p_id: req, p_to: 'approved', p_expect_from: 'requested', p_actor: '運営' });
    assert.equal(r.error, null, `同じカードの 📌 を数えて承認を断っている: ${r.error?.message}`);
    const rows = (await sb.from('plan_reservations').select('boss_number, status, release_reason').order('id')).data;
    assert.deepEqual(rows.filter(x => x.boss_number === 1).map(x => [x.status, x.release_reason]), [['released', 'superseded'], ['approved', null]]);
    // 別のカードの 📌 が埋まっていれば、承認は断る
    const req4 = (await sb.from('plan_reservations').insert(resvRow({ boss_number: 4 })).select('id').single()).data.id;
    r = await sb.rpc('reservation_set_status', { p_id: req4, p_to: 'approved', p_expect_from: 'requested', p_actor: '運営' });
    assert.match(r.error.message, /約束が残凸を超えます/);
    assert.equal((await sb.from('plan_reservations').select('status').eq('id', req4).single()).data.status, 'requested', '断った承認の途中までが残っている');
});
test('凸報告 (report_attack): 採番・残HP・予約の消し込み・3凸済み・予約とのずれ (40 の写し)', async () => {
    const sb = mini();
    const args = (o = {}) => ({ p_season_id: 1, p_player_id: 10, p_attack_date: '2026-10-03', p_boss_number: 1, p_boss_code: 'B1', p_damage_raw: 30e9, p_level: 1, p_characters: ['a', 'b'], ...o });
    const rid = (await sb.from('plan_reservations').insert(resvRow({ characters_snapshot: ['b', 'a'] })).select('id').single()).data.id;
    let r = await sb.rpc('report_attack', args({ p_reservation_id: rid }));
    assert.match(r.error.message, /固定されている予約ではありません \(いま requested\)/);
    await sb.rpc('reservation_set_status', { p_id: rid, p_to: 'approved', p_expect_from: 'requested', p_actor: '運営' });
    r = await sb.rpc('report_attack', args({ p_reservation_id: rid, p_boss_number: 2 }));
    assert.match(r.error.message, /予約のボス \(B1\) と凸のボス \(B2\) が違います/);
    r = await sb.rpc('report_attack', args({ p_reservation_id: rid, p_actor: 'あ' }));
    clean(r.data);
    assert.deepEqual([r.data.attack_number, r.data.hp_after, r.data.reservation_id, r.data.over_capacity], [1, 70e9, rid, 0]);
    assert.equal(r.data.mismatch, 'レベルが違う (予約 Lv / 実際 Lv1)'.replace('Lv /', 'Lv /'), 'レベル無しの予約は「レベルが違う」と記録される (本番の IS DISTINCT FROM と同じ)');
    const res = (await sb.from('plan_reservations').select('status, release_reason').eq('id', rid).single()).data;
    assert.deepEqual(res, { status: 'fulfilled', release_reason: 'fulfilled' });
    assert.equal((await sb.from('attacks').select('reservation_id').single()).data.reservation_id, rid);
    // 残HP は 0 で止まる / 減らさない指定
    r = await sb.rpc('report_attack', args({ p_damage_raw: 999e9 }));
    assert.deepEqual([r.data.attack_number, r.data.hp_after], [2, 0]);
    r = await sb.rpc('report_attack', args({ p_boss_number: 2, p_boss_code: 'B2', p_skip_hp_decrement: true }));
    assert.deepEqual([r.data.attack_number, r.data.hp_after], [3, null]);
    assert.equal((await sb.from('bosses').select('remaining_hp_raw').eq('boss_number', 2).single()).data.remaining_hp_raw, 100e9);
    r = await sb.rpc('report_attack', args());
    assert.match(r.error.message, /既に3凸済みです/);
    assert.equal((await sb.from('attacks').select('id')).data.length, 3, '断った凸が入っている');
    // 予約を押さえたまま別の凸をしたら、守れなくなる予約を返す (新しいものから)
    const sb2 = mini();
    for (const b of [1, 2, 3]) await sb2.from('plan_reservations').insert(resvRow({ boss_number: b }));
    r = await sb2.rpc('report_attack', args({ p_boss_number: 4, p_boss_code: 'B4' }));
    assert.deepEqual([r.data.over_capacity, r.data.reservations_at_risk], [1, [3]]);
    // 編成が違えば記録に残る
    const sb3 = mini();
    const id3 = (await sb3.from('plan_reservations').insert(resvRow({ raid_level: 1, characters_snapshot: ['x', 'y'] })).select('id').single()).data.id;
    await sb3.rpc('reservation_set_status', { p_id: id3, p_to: 'approved', p_expect_from: 'requested' });
    r = await sb3.rpc('report_attack', args({ p_reservation_id: id3 }));
    assert.equal(r.data.mismatch, '編成が違う');
    assert.equal((await sb3.from('plan_reservation_events').select('reason').eq('to_status', 'fulfilled').single()).data.reason, '凸報告により実行済み (編成が違う)');
});
test('通知 (send-push) は送ったことにして控える / 画像の読み取りと画像の保存は使えないと返す', async () => {
    const got = [];
    const sb = createPracticeClient({ now: () => T0, onPush: (x) => got.push(x), tables: { players: [{ id: 10, name: 'あ' }, { id: 11, name: 'い' }, { id: 12, name: 'う', archived: true }] } });
    let r = await sb.functions.invoke('send-push', { body: { title: 'T', body: 'B', playerIds: [11] } });
    assert.deepEqual(r, { data: { ok: true, sent: 1, target: 1, practice: true }, error: null });
    r = await sb.functions.invoke('send-push', { body: { title: '全員へ' } });
    assert.equal(r.data.target, 2, '全員あては書庫の人を除く');
    assert.deepEqual(got.map(x => [x.title, x.playerIds]), [['T', [11]], ['全員へ', null]]);
    assert.equal(sb.__db.outbox.length, 2);
    r = await sb.functions.invoke('dynamic-service', { body: {} });
    assert.ok(r.error && /練習モード/.test(r.error.message));
    assert.ok((await sb.storage.from('avatars').upload('a', 'b')).error);
});
test('途中経過: 書き込みのたびに知らせる / dump → restore で続きから (連番も)', async () => {
    let n = 0;
    const sb = createPracticeClient({ now: () => T0, onChange: () => n++, tables: { players: [{ id: 10, name: 'あ' }] } });
    await sb.from('players').insert({ name: 'い' });
    await sb.from('players').select('*');
    assert.equal(n, 1, '読むだけで「変わった」と知らせている / 書いても知らせていない');
    await sb.from('players').insert({ name: 'あ' });
    assert.equal(n, 1, '失敗した書き込みで知らせている');
    const sb2 = createPracticeClient({ now: () => T0 });
    assert.equal(sb2.__db.restore(sb.__db.dump()), true);
    assert.equal((await sb2.from('players').insert({ name: 'う' }).select('id').single()).data.id, 12);
    assert.equal(sb2.__db.restore('{"v":2}'), false, '形の違う控えを受け入れている');
});

// ============================== 3. 種データ ==============================
test('種データ: 架空の 31 人・何度作っても同じ・自分は灼熱だけ未提出・同じ人の編成はキャラが被らない', async () => {
    const a = buildSeed({ hardDate: '2026-10-03' }), b = buildSeed({ hardDate: '2026-10-03' });
    assert.deepEqual(a, b, '作るたびに違う盤面になる (乱数を使っている)');
    clean(a);
    assert.equal(a.players.length, 31);
    assert.deepEqual(a.players.slice(0, 2).map(p => [p.id, p.name]), [[IDS.me, ME_NAME], [IDS.ops, OPS_NAME]]);
    assert.equal(new Set(a.players.map(p => p.name)).size, 31, '名前が重なっている');
    assert.deepEqual(a.seasons[0], { id: IDS.season, month_key: '2026-10', hard_date: '2026-10-03', current_level: 1, is_active: true, is_test: false });
    const mine = a.player_damages.filter(d => d.player_id === IDS.me);
    assert.deepEqual(mine.map(d => d.attribute).sort(), ['electric', 'iron', 'water', 'wind'], '自分の模擬 (灼熱だけ未提出) が違う');
    assert.ok(!a.availability_confirmations.some(r => r.player_id === IDS.me), '自分の今期の確認が最初から済んでいる');
    assert.deepEqual(a.availability.filter(r => r.player_id === IDS.me).map(r => r.time_slot), ['h19', 'h20', 'h21', 'h22', 'h23']);
    // 模擬がまだの人 (運営編の催促の相手)
    const none = a.players.filter(p => p.id >= IDS.firstMember && !a.player_damages.some(d => d.player_id === p.id));
    assert.deepEqual(none.map(p => p.name), ['ミケ', 'ハチ', 'コトラ', 'シロ']);
    assert.equal(none.length, NOT_SUBMITTED);
    // 通知の購読は全員 (未提出の人が購読していないと、運営編の催促が押せない)
    assert.equal(a.push_subscriptions.length, 31, '通知を購読していない人がいる (運営編の催促の相手にならない)');
    assert.ok(none.every(p => a.push_subscriptions.some(s => s.player_id === p.id)), '模擬がまだの人が通知を購読していない');
    for (const p of a.players) {
        const teams = a.player_damages.filter(d => d.player_id === p.id);
        for (const t of teams) assert.equal(new Set(t.characters).size, 5, `${p.name} の ${t.attribute} が 5 人でない`);
        const all = teams.flatMap(t => t.characters);
        assert.equal(new Set(all).size, all.length, `${p.name} の編成どうしでキャラが被っている (3凸ぶん組めない)`);
    }
    // ボス: 弱点は js/supabase-client.js の表と同じ / HP はシーズン作成と同じ
    const client = rd('js/supabase-client.js');
    const attrOf = Function(`return ${client.match(/const SEASON_ATTR_FROM_CODE = (\{[^}]*\});/)[1]}`)();
    const weakOf = Function(`return ${client.match(/const SEASON_WEAKNESS_BY_ATTR = (\{[^}]*\});/)[1]}`)();
    const hp = Function(`return ${client.match(/const HARD_LV1_HP = (\{[^}]*\});/)[1]}`)();
    assert.equal(a.bosses.length, 5);
    for (const x of a.bosses) {
        assert.equal(x.attribute, attrOf[x.boss_code], `${x.boss_code} の属性が本番の表と違う`);
        assert.equal(x.weakness, weakOf[x.attribute], `${x.boss_code} の弱点が本番の表と違う`);
        assert.deepEqual([x.total_hp_raw, x.remaining_hp_raw], [hp[x.tier], hp[x.tier]]);
    }
    // そのまま偽のサーバに入る / 本物のキャラ表を渡せばそれを使う
    createPracticeClient({ tables: a });
    const real = FALLBACK_CHARACTERS.map((c, i) => ({ ...c, canonical_name: '本物' + i, icon_paths: ['./x.webp'] }));
    const c = buildSeed({ hardDate: '2026-10-03', characters: real });
    assert.ok(c.player_damages.every(d => d.characters.every(n => n.startsWith('本物'))));
    assert.throws(() => buildSeed({ hardDate: '10/3' }), /hardDate/);
});

// ============================== 4. 起動 (boot.js) ==============================
function bootEnv({ flag = null, realNow = Date.UTC(2026, 9, 2, 3, 0, 0), search = '', fullAt = null } = {}) {   // 2026-10-02 12:00 JST
    class Storage {
        constructor() { this._m = new Map(); }
        getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
        // fullAt: この文字列を含む鍵への書き込みで「置き場が一杯」(QuotaExceededError) を起こす
        setItem(k, v) { if (fullAt && String(k).includes(fullAt)) throw new Error('QuotaExceededError'); this._m.set(k, String(v)); }
        removeItem(k) { this._m.delete(k); }
        key(i) { return [...this._m.keys()][i] ?? null; }
        get length() { return this._m.size; }
    }
    const RealDate = class extends Date { static now() { return realNow; } constructor(...a) { if (a.length) super(...a); else super(realNow); } };
    const written = [], navigated = [];
    const win = { Storage, localStorage: new Storage(), sessionStorage: new Storage(), Date: RealDate, URL,
        location: { href: 'https://example.test/app/index.html' + search, search, replace: (u) => navigated.push(['replace', u]), reload: () => navigated.push(['reload']) },
        document: { documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }, write: (h) => written.push(h) } };
    win.window = win;
    if (flag) win.sessionStorage._m.set('shirisuko_practice_v1', flag);
    win.localStorage._m.set('shirisuPad.currentPlayer', JSON.stringify({ id: 24, name: '本物の人' }));
    win.localStorage._m.set('shirisuko_theme_v1', 'dark');
    const orig = { get: Storage.prototype.getItem, set: Storage.prototype.setItem, del: Storage.prototype.removeItem };
    vm.createContext(win);
    vm.runInContext(rd('js/practice/boot.js'), win);
    return { win, written, navigated, RealDate, realNow, Storage, orig };
}
test('起動: 印が無ければ何もしない (本番は 1 つも差し替えない)', () => {
    for (const flag of [null, 'yes', '1']) {
        const { win, written, RealDate } = bootEnv({ flag });
        assert.equal(win.PAD_PRACTICE, undefined, `印「${flag}」で練習モードに入っている`);
        assert.equal(win.Date, RealDate, '時計を差し替えている');
        assert.equal(JSON.parse(win.localStorage.getItem('shirisuPad.currentPlayer')).id, 24, '名乗りが変わっている');
        assert.deepEqual(written, []);
        assert.equal(win.document.documentElement.attrs['data-practice'], undefined);
    }
});
test('起動: 置き場が一杯などで準備に失敗したら、**何も差し替えずに**印を消して終わる (半端な差し替えで本物に繋がない)', () => {
    // ★ 途中で止まると「記憶は差し替わったのに PAD_PRACTICE が無い」→ js/supabase-client.js が本物のクライアントを作る (Codex指摘 2026-10-02)
    for (const fullAt of ['shirisuko_practice_v1:hard', 'shirisuko_practice_v1:clock', 'pm::shirisuPad.currentPlayer', 'pm::shirisuPad.tourCompleted']) {
        const { win, written, RealDate, Storage, orig } = bootEnv({ flag: 'member', fullAt });
        assert.equal(win.PAD_PRACTICE, undefined, `${fullAt} で失敗したのに練習モードになっている`);
        assert.equal(win.Date, RealDate, `${fullAt}: 時計だけ差し替わっている`);
        assert.deepEqual([Storage.prototype.getItem, Storage.prototype.setItem, Storage.prototype.removeItem], [orig.get, orig.set, orig.del], `${fullAt}: 端末の記憶だけ差し替わっている`);
        assert.equal(win.sessionStorage._m.has('shirisuko_practice_v1'), false, `${fullAt}: 印が残っている (次に開いても同じ失敗を繰り返す)`);
        assert.equal(JSON.parse(win.localStorage.getItem('shirisuPad.currentPlayer')).id, 24, `${fullAt}: 本物の名乗りが読めない`);
        assert.deepEqual(written, [], `${fullAt}: 案内を読み込んでいる`);
        assert.equal(win.document.documentElement.attrs['data-practice'], undefined);
    }
    // 時計を進めるときの控えに失敗しても、進めること自体は成功する
    const { win } = bootEnv({ flag: 'member' });
    const SS = win.sessionStorage; const set0 = SS._m.set.bind(SS._m);
    SS._m.set = (k, v) => { if (String(k).endsWith(':clock')) throw new Error('QuotaExceededError'); return set0(k, v); };
    win.PAD_PRACTICE.clock.set('hard', 21);
    assert.equal(new Date(win.Date.now() + 9 * 3600000).toISOString().slice(0, 13), '2026-10-03T21');
});
test('起動: 端末の記憶を分ける (本番の名乗り・設定に触れない) / 見た目だけは共有 / 練習の人で名乗る', () => {
    const { win, written } = bootEnv({ flag: 'member' });
    const P = win.PAD_PRACTICE;
    assert.equal(P.role, 'member');
    assert.deepEqual(JSON.parse(win.localStorage.getItem('shirisuPad.currentPlayer')), { id: IDS.me, name: ME_NAME }, '練習の人で名乗っていない');
    assert.deepEqual([P.me.id, P.me.name, P.ops.id, P.ops.name], [IDS.me, ME_NAME, IDS.ops, OPS_NAME], 'boot.js と seed.js で人の番号・名前が違う');
    assert.equal(win.localStorage.getItem('shirisuPad.tourCompleted'), '1', '練習中に使い方ツアーが自動で始まる');
    win.localStorage.setItem('shirisuko_ops_mode_v1', '1');
    win.localStorage.removeItem('shirisuko_sim_kill_v1');
    // 本物の置き場 (差し替え前の口で読む) には何も増えていない・消えていない
    const raw = win.localStorage._m;
    assert.deepEqual([...raw.keys()].sort(), ['shirisuPad.currentPlayer', 'shirisuko_theme_v1']);
    assert.equal(JSON.parse(raw.get('shirisuPad.currentPlayer')).id, 24, '本物の名乗りを書き換えた');
    assert.equal(win.sessionStorage._m.get('pm::shirisuko_ops_mode_v1'), '1', '練習の記憶が別の置き場に入っていない');
    // 見た目 (ライト/ダーク) だけは本番と共有する
    assert.equal(win.localStorage.getItem('shirisuko_theme_v1'), 'dark');
    win.localStorage.setItem('shirisuko_theme_v1', 'light');
    assert.equal(raw.get('shirisuko_theme_v1'), 'light');
    // sessionStorage そのものは差し替えない
    win.sessionStorage.setItem('k', 'v');
    assert.equal(win.sessionStorage._m.get('k'), 'v');
    assert.equal(win.document.documentElement.attrs['data-practice'], 'member');
    assert.ok(written.length === 1 && /<script defer src="\.\/js\/practice\/guide\.js"><\/script>/.test(written[0]), '案内 (guide.js) を読み込んでいない');
    // 運営役で入ったら運営役で名乗る
    assert.deepEqual(JSON.parse(bootEnv({ flag: 'ops' }).win.localStorage.getItem('shirisuPad.currentPlayer')), { id: IDS.ops, name: OPS_NAME });
});
test('起動: 練習の時計は「レイド前日の 20 時」から始まり、自分で進められる / 再読み込みしても続き', () => {
    const { win, realNow } = bootEnv({ flag: 'member' });
    const P = win.PAD_PRACTICE, D = win.Date;
    assert.equal(P.hardDate, '2026-10-03', 'レイド日 = 始めた日の翌日 でない');
    const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 16);
    assert.equal(jst(D.now()), '2026-10-02T20:00', '前日の 20 時から始まっていない');
    assert.equal(jst(new D().getTime()), '2026-10-02T20:00', '引数なしの new Date() が練習の時計でない');
    assert.equal(new D('2026-01-01T00:00:00Z').getTime(), Date.UTC(2026, 0, 1), '日時を指定した new Date は本物と同じはず');
    assert.equal(new D(2026, 0, 5).getDate(), 5);
    assert.ok(new D() instanceof D && D.parse('2026-01-01T00:00:00Z') === Date.UTC(2026, 0, 1), 'Date の基本の口が欠けている');
    P.clock.set('hard', 21);
    assert.equal(jst(D.now()), '2026-10-03T21:00', '当日の 21 時に進められない');
    P.clock.set('eve', 9);
    assert.equal(jst(D.now()), '2026-10-02T09:00');
    assert.equal(P.clock.RealDate.now(), realNow, '本物の時計を取り出せない');
    // ずれを読む / 戻す (「〜したことにする」が途中で失敗したとき、時計も押す前へ戻す)
    const was = P.clock.get();
    P.clock.set('hard', 21);
    P.clock.put(was);
    assert.equal(jst(D.now()), '2026-10-02T09:00', '時計を押す前へ戻せない');
    assert.equal(Number(win.sessionStorage.getItem('shirisuko_practice_v1:clock')), was, '戻した時計を控えていない');
    P.clock.put('abc'); assert.equal(P.clock.get(), was, '数でない値で時計を壊せる');
    // 再読み込み (同じ sessionStorage でもう一度起動) しても レイド日 と 時計 は変わらない
    P.clock.set('hard', 21);
    const ss = win.sessionStorage;
    const again = bootEnv({ flag: 'member', realNow: realNow + 3 * 86400000 });   // 3 日後に始めたら別のレイド日になる
    assert.equal(again.win.PAD_PRACTICE.hardDate, '2026-10-06');
    const keep = { hard: ss.getItem('shirisuko_practice_v1:hard'), clock: Number(ss.getItem('shirisuko_practice_v1:clock')) };
    assert.equal(keep.hard, '2026-10-03');
    assert.equal(jst(realNow + keep.clock), '2026-10-03T21:00', '時計を控えていない (再読み込みで前日に戻る)');
    // 深夜 (日付が変わった直後) に始めても、日本時間の「今日の翌日」
    assert.equal(bootEnv({ flag: 'member', realNow: Date.UTC(2026, 9, 2, 15, 30, 0) }).win.PAD_PRACTICE.hardDate, '2026-10-04', '日本時間で日付を見ていない');
});
test('起動: 印は編の id。役と開始時刻は編ごと (ops-eve = 運営役・前日 20 時 / ops-day = 運営役・当日 20 時) / 古い印 ops は ops-eve', () => {
    const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 16);
    let e = bootEnv({ flag: 'ops-eve' });
    assert.deepEqual([e.win.PAD_PRACTICE.role, e.win.PAD_PRACTICE.scenario, jst(e.win.Date.now())], ['ops', 'ops-eve', '2026-10-02T20:00']);
    assert.deepEqual(JSON.parse(e.win.localStorage.getItem('shirisuPad.currentPlayer')), { id: IDS.ops, name: OPS_NAME });
    e = bootEnv({ flag: 'ops-day' });
    assert.deepEqual([e.win.PAD_PRACTICE.role, e.win.PAD_PRACTICE.scenario, jst(e.win.Date.now())], ['ops', 'ops-day', '2026-10-03T20:00'], '当日の運営編が当日の 20 時から始まらない');
    e = bootEnv({ flag: 'ops' });
    assert.deepEqual([e.win.PAD_PRACTICE.role, e.win.PAD_PRACTICE.scenario], ['ops', 'ops-eve'], '古い印 (ops) を前日の運営編と読めない');
    e = bootEnv({ flag: 'member' });
    assert.deepEqual([e.win.PAD_PRACTICE.role, e.win.PAD_PRACTICE.scenario, jst(e.win.Date.now())], ['member', 'member', '2026-10-02T20:00']);
    assert.equal(bootEnv({ flag: 'ops-night' }).win.PAD_PRACTICE, undefined, '知らない編で練習モードに入っている');
    // 途中の課題から: restart(編, 課題) が印の隣に start を置く
    e.win.PAD_PRACTICE.restart('member', 'attack');
    assert.equal(e.win.sessionStorage._m.get('shirisuko_practice_v1:start'), 'attack');
    assert.equal(e.win.sessionStorage._m.get('shirisuko_practice_v1'), 'member');
});
test('起動: やめる = 練習の記憶をすべて捨てて本番へ / やり直す = 印は残して最初から', () => {
    const { win, navigated } = bootEnv({ flag: 'member', search: '?practice=member&tab=ops' });
    const P = win.PAD_PRACTICE;
    win.localStorage.setItem('x', '1'); P.store.set('db', '{}'); win.sessionStorage.setItem('other', 'keep');
    P.restart('member');
    assert.deepEqual([...win.sessionStorage._m.keys()].sort(), ['other', 'shirisuko_practice_v1'], 'やり直しで練習の記憶が残っている');
    assert.deepEqual(navigated.pop(), ['reload']);
    win.localStorage.setItem('x', '1'); P.store.set('db', '{}');
    assert.equal(P.closed, true, 'やり直しのあと「閉じた」印が立っていない (画面を離れるときに途中経過を書き戻す)');
    P.closed = false;
    P.exit();
    assert.equal(P.closed, true, 'やめたあと「閉じた」印が立っていない');
    assert.deepEqual([...win.sessionStorage._m.keys()], ['other'], 'やめても練習の印や記憶が残っている (次に開いたときも練習のまま)');
    const [how, url] = navigated.pop();
    assert.equal(how, 'replace');
    assert.ok(!/practice=/.test(url) && /tab=ops/.test(url), `?practice= を付けたまま戻っている: ${url}`);
});

// ============================== 5. 本物の js/supabase-client.js を偽のサーバ相手に動かす ==============================
const fetched = [];
const mem = new Map();
let exited = 0;
globalThis.window = globalThis;
globalThis.PAD_PRACTICE = { role: 'member', hardDate: '2026-10-03', db: null, me: { id: IDS.me, name: ME_NAME }, ops: { id: IDS.ops, name: OPS_NAME },
    store: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, String(v)), del: (k) => mem.delete(k) }, exit() { exited++; } };
const events = [];
globalThis.dispatchEvent = (e) => { events.push(e); return true; };
const listeners = {};
globalThis.addEventListener = (type, fn) => { listeners[type] = fn; };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
globalThis.fetch = async (url, o) => { fetched.push({ url: String(url), o }); return { ok: true, status: 200, json: async () => FALLBACK_CHARACTERS.map(c => ({ ...c, icon_paths: ['./i.webp'] })) }; };
const origLog = console.log; console.log = () => { };   // 接続確認の 1 行を黙らせる
await imp('js/supabase-client.js');
console.log = origLog;
const W = globalThis;
const DB = () => W.PAD_PRACTICE.db.tables;

test('本物のクライアント: 132 の関数がそろい、本物のクライアントは作らない / 通信は キャラ表の GET 1 回だけ', async () => {
    const fns = Object.keys(W).filter(k => k.startsWith('supabase') && typeof W[k] === 'function');
    const declared = (rd('js/supabase-client.js').match(/^window\.supabase[A-Za-z0-9_]* = /gm) || []).length;
    assert.equal(fns.length, declared, '練習モードで定義されない関数がある');
    assert.ok(declared >= 130);
    assert.equal(fetched.length, 1, `本物への通信が ${fetched.length} 回`);
    assert.match(fetched[0].url, /\/rest\/v1\/nikke_characters\?select=\*$/);
    assert.ok(!fetched[0].o.method && !fetched[0].o.body, 'GET 以外・本文つきの通信をしている');
    assert.equal(exited, 0);
    assert.equal(W.PAD_PRACTICE.db.isPractice, true);
    assert.ok(mem.get('db'), '最初の盤面を控えていない');
    const board = await W.supabaseLoadOpsDashboardData();
    assert.equal(board.players.length, 31);
    assert.equal(board.bosses.length, 5);
    assert.equal(board.season.id, IDS.season);
});
test('本物のクライアント: 時間の確認 → 模擬 → 予約 → 承認 → 配信 → 凸報告 → 締め凸 が偽のサーバで最後まで動く', async () => {
    const S = IDS.season, ME = IDS.me;
    // ① 今期の時間の確認
    await W.supabaseConfirmAvailability(S, ME, { slotCount: 5, slots: ['h19', 'h20', 'h21', 'h22', 'h23'] });
    const conf = await W.supabaseLoadMyAvailabilityConfirmation(S, ME);
    assert.deepEqual([conf.unavailable, conf.slot_count], [false, 5]);
    // ② 模擬の提出 (灼熱PT)
    await W.supabaseSavePlayerDamage(ME, 'fire', 33.1, 1);
    const dmg = await W.supabaseLoadPlayerDamages(ME);
    assert.ok(JSON.stringify(dmg).includes('33.1'), `灼熱の模擬が読めない: ${JSON.stringify(dmg).slice(0, 200)}`);
    // ③ 予約の申請 (メンバー発はレベル無し)
    const made = await W.supabaseCreateReservation({ seasonId: S, playerId: ME, bossNumber: 3, timeSlot: 'h21', loadoutSlot: 1, characters: ['a', 'b', 'c', 'd', 'e'], expectedDamageB: 33.1, requestedBy: ME_NAME });
    const rid = made?.id ?? DB().plan_reservations[0].id;
    let mine = await W.supabaseLoadMyReservations(S, ME);
    assert.deepEqual(mine.map(r => [r.status, r.boss_number, r.time_slot, r.raid_level]), [['requested', 3, 'h21', null]]);
    // ④ 運営が承認 (RPC)
    await W.supabaseSetReservationStatus(rid, 'approved', { expectFrom: 'requested', actor: OPS_NAME });
    mine = await W.supabaseLoadMyReservations(S, ME);
    assert.deepEqual([mine[0].status, mine[0].approved_by], ['approved', OPS_NAME]);
    // ★ 偽のサーバの断り文を、本物のクライアントが本番と同じ日本語に読み替える (文面が違うと素のエラーが出る)
    await assert.rejects(() => W.supabaseSetReservationStatus(rid, 'approved', { expectFrom: 'requested', actor: OPS_NAME }), /この予約は別の運営が操作しました/);
    await assert.rejects(() => W.supabaseSetReservationStatus(rid, 'rejected', { expectFrom: 'approved', actor: OPS_NAME }), /この予約はもう変更できません/);
    // ⑤ 配信
    const pub = await W.supabasePublishPlan({ levels: [], seasonId: S }, IDS.ops, OPS_NAME, S, 2);
    const got = await W.supabaseGetPublishedPlan();
    assert.deepEqual([got.season_id, got.published_by_name, got.plan.seasonId], [S, OPS_NAME, S]);
    assert.ok(pub);
    // ⑥ 凸報告 (予約つき) → 予約は実行済み・ボスの残りが減る
    const before = DB().bosses.find(b => b.boss_number === 3).remaining_hp_raw;
    const atk = await W.supabaseAddAttack({ seasonId: S, playerId: ME, attackDate: '2026-10-03', bossNumber: 3, bossCode: 'A.N.M.I.', damageRaw: 34.2e9, level: 1, characters: ['a', 'b', 'c', 'd', 'e'] }, { reservationId: rid, actorName: ME_NAME });
    assert.equal(atk.attack_number, 1);
    assert.equal(DB().bosses.find(b => b.boss_number === 3).remaining_hp_raw, before - 34.2e9);
    assert.equal((await W.supabaseLoadMyReservations(S, ME))[0]?.status ?? 'fulfilled', 'fulfilled');
    assert.equal((await W.supabaseLoadMyAttacks(ME, S, '2026-10-03')).length, 1);
    // ⑦ 締め凸のお願い → 返事
    await W.supabaseSetFinishRequests(S, 1, [ME], 1);
    let fr = await W.supabaseLoadFinishRequests(S, 1);
    assert.equal(fr.filter(r => r.player_id === ME && r.status === 'pending').length, 1);
    await W.supabaseRespondFinishRequest(S, 1, ME, 'accepted', 1, fr.find(r => r.player_id === ME).id);
    fr = await W.supabaseLoadFinishRequests(S, 1);
    assert.equal(fr.find(r => r.player_id === ME).status, 'accepted');
    // ⑧ 通知は送ったことにして控える (本物の Edge Function は呼ばない)
    const n0 = W.PAD_PRACTICE.db.outbox.length;
    const sent = await W.sendPushNotification({ title: 'テスト', body: '本文', playerIds: [ME] });
    assert.equal(sent.practice, true);
    assert.equal(W.PAD_PRACTICE.db.outbox.length, n0 + 1);
    assert.ok(events.some(e => e.type === 'padpractice' && e.detail.type === 'push' && e.detail.item.title === 'テスト'), '通知の見本を画面へ知らせていない');
    assert.equal(DB().push_notifications_log.filter(r => r.title === 'テスト').length, 1, '通知の履歴 (受け取った通知) に残っていない');
    assert.ok(events.some(e => e.detail.type === 'change'), '書き込みを画面へ知らせていない');
    // ★ 控えは少し遅れて書かれる。読み込み直す前は P.save() で待たずに書ける (待っている間に読み込み直すと直前の書き込みが消える)
    await W.supabaseSavePlayerDamage(ME, 'water', 99.9, 1);
    assert.ok(!mem.get('db').includes('99.9'), '(前提) 書き込みの直後はまだ控えていない');
    W.PAD_PRACTICE.save();
    assert.ok(mem.get('db').includes('99.9'), 'P.save() で途中経過を待たずに控えられない');
    assert.ok(listeners.pagehide === W.PAD_PRACTICE.save, '画面を離れる前に控えていない (pagehide)');
    // やめたあとは控えない (画面を離れるときの控えが、消したばかりの記憶を書き戻す → 次に開いたときも練習の盤面が残る)
    mem.delete('db'); W.PAD_PRACTICE.closed = true;
    W.PAD_PRACTICE.save();
    assert.equal(mem.get('db'), undefined, 'やめたあとに途中経過を書き戻している');
    W.PAD_PRACTICE.closed = false;
    assert.equal(fetched.length, 1, '途中で本物へ通信している');
});
test('本物のクライアント: 練習中は端末の通知設定に触れない (解除すると本番の通知が届かなくなる)', async () => {
    let touched = 0;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get serviceWorker() { touched++; return { ready: Promise.resolve({ pushManager: { getSubscription: async () => { touched++; return null; } } }) }; } } });
    globalThis.PushManager = function () { }; globalThis.Notification = { permission: 'granted', requestPermission: async () => { touched++; return 'granted'; } };
    await assert.rejects(() => W.subscribeToPush(IDS.me), /練習モードでは通知の設定は変えられません/);
    await assert.rejects(() => W.unsubscribeFromPush(IDS.me), /練習モードでは通知の設定は変えられません/);
    await assert.rejects(() => W.showLocalTestNotification(), /練習モードでは通知の設定は変えられません/, 'テスト通知で端末の通知許可を求めている');
    await assert.rejects(() => W.registerPushServiceWorker(), /練習モードでは通知の設定は変えられません/, '練習中に Service Worker を登録している');
    // ホームが毎回読む「通知の状態」も、端末に触れずに「非対応」と同じ答えを返す (Service Worker を登録しない)
    assert.deepEqual(await W.getPushSubscriptionStatus(), { supported: false, practice: true });
    assert.equal(touched, 0, '断る前に端末の通知・Service Worker に触れている');
});

// ============================== 6. 本番とのずれを見張る (ソースの突き合わせ) ==============================
const HTML = rd('index.html'), CLIENT = rd('js/supabase-client.js'), GUIDE = rd('js/practice/guide.js'), SERVER = rd('js/practice/server.js');
const sqlFiles = fs.readdirSync(path.join(ROOT, 'supabase')).filter(f => /^\d+_.*\.sql$/.test(f) && !f.startsWith('99')).sort();
const sqlOf = (f) => rd('supabase/' + f).replace(/--[^\n]*/g, '');

test('見張り: 偽のサーバの表・列・主キーが supabase/*.sql と一致する (SQL に列を足したら練習側も足す)', () => {
    const splitTop = (b) => { const out = []; let d = 0, buf = ''; for (const ch of b) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(buf); buf = ''; } else buf += ch; } out.push(buf); return out.map(x => x.trim()).filter(Boolean); };
    const cols = {}, pks = {};
    for (const f of sqlFiles) {
        const s = sqlOf(f);
        for (const m of s.matchAll(/CREATE TABLE IF NOT EXISTS\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
            const t = cols[m[1]] ??= new Set();
            for (const it of splitTop(m[2])) {
                const w = it.split(/\s+/)[0];
                const pk = it.match(/^PRIMARY KEY\s*\(([^)]*)\)/i);
                if (pk) { pks[m[1]] = pk[1].split(',').map(x => x.trim()); continue; }
                if (/^(UNIQUE|CHECK|CONSTRAINT|FOREIGN)$/i.test(w)) continue;
                t.add(w);
                if (/PRIMARY KEY/i.test(it)) pks[m[1]] = [w];
            }
        }
        for (const m of s.matchAll(/ALTER TABLE\s+(?:public\.)?(\w+)\s+([^;]*?);/gi)) {
            for (const c of m[2].matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)) (cols[m[1]] ??= new Set()).add(c[1]);
            for (const c of m[2].matchAll(/DROP COLUMN IF EXISTS\s+(\w+)/gi)) cols[m[1]]?.delete(c[1]);
            const pk = m[2].match(/ADD PRIMARY KEY\s*\(([^)]*)\)/i);
            if (pk) pks[m[1]] = pk[1].split(',').map(x => x.trim());
        }
    }
    assert.ok(Object.keys(cols).length >= 25, `SQL から表を読めていない (${Object.keys(cols).length})`);
    assert.deepEqual(Object.keys(SCHEMA).sort(), Object.keys(cols).sort(), '表の顔ぶれが SQL と違う');
    for (const [t, sqlCols] of Object.entries(cols)) {
        const sc = SCHEMA[t];
        const mine = new Set([...sc.pk, ...(sc.required || []), ...Object.keys(sc.defaults || {})]);
        assert.deepEqual([...mine].sort(), [...sqlCols].sort(), `${t} の列が SQL と違う`);
        assert.deepEqual(sc.pk, pks[t], `${t} の主キーが SQL と違う`);
    }
});
test('見張り: 予約の遷移表・断り文が supabase/47 と一致する / 凸報告の断り文が 40 と一致する', () => {
    const sql47 = sqlOf('47_approval_counts_pins.sql'), sql40 = sqlOf('40_attack_with_reservation_rpc.sql'), sql39 = sqlOf('39_plan_reservations.sql');
    const fromSql = {}, fromJs = {};
    for (const m of sql47.matchAll(/\(v_from = '(\w+)'\s+AND p_to IN \(([^)]*)\)\)/g)) fromSql[m[1]] = m[2].match(/'(\w+)'/g).map(x => x.slice(1, -1));
    for (const m of SERVER.matchAll(/\(from === '(\w+)' && \[([^\]]*)\]\.includes\(to\)\)/g)) fromJs[m[1]] = m[2].match(/'(\w+)'/g).map(x => x.slice(1, -1));
    assert.equal(Object.keys(fromSql).length, 4, '47 から遷移表を読めていない');
    assert.deepEqual(fromJs, fromSql, '遷移表が 47 と違う');
    // 断り文: クライアントは文面で読み替える (js/supabase-client.js) ので、SQL と一字一句そろえる
    const said = (sql, re) => [...sql.matchAll(re)].map(m => m[1].replace(/\s*\(.*$/, '').replace(/ — .*$/, ''));
    const msgs = [...said(sql47, /RAISE EXCEPTION '([^']*)'/g), ...said(sql40, /RAISE EXCEPTION '([^']*)'/g), ...said(sql39, /RAISE EXCEPTION '([^']*)'/g)];
    assert.ok(msgs.length >= 12, `断り文を読めていない (${msgs.length})`);
    for (const head of new Set(msgs)) assert.ok(SERVER.includes(head), `偽のサーバに「${head}」の断り文が無い (SQL と文面がずれた)`);
});
test('見張り: js/supabase-client.js が使う 表・RPC・問い合わせの口 を、偽のサーバがすべて知っている', () => {
    const tables = new Set([...CLIENT.matchAll(/supabase\s*\.from\('([a-z_]+)'\)|\.from\('([a-z_]+)'\)/g)].map(m => m[1] || m[2]));
    tables.delete('avatars');   // storage.from('avatars') (画像の置き場。練習では保存できないと返す)
    assert.ok(tables.size >= 20);
    for (const t of tables) assert.ok(SCHEMA[t], `本番が使う表 ${t} を偽のサーバが知らない`);
    const rpcs = new Set([...CLIENT.matchAll(/\.rpc\('([a-z_0-9]+)'/g)].map(m => m[1]));
    const implemented = [...SERVER.matchAll(/\n        ([a-z_]+)\(a\) \{/g)].map(m => m[1]);
    // 練習で使えない RPC (運営の シーズン編集・復元)。「見つからない」と返す → クライアントは未適用として扱う
    const NOT_IN_PRACTICE = ['ops_update_season_meta', 'restore_fix_sequences'];
    assert.deepEqual([...rpcs].sort(), [...implemented, ...NOT_IN_PRACTICE].sort(), '本番が使う RPC と、偽のサーバの対応が食い違っている');
    // 問い合わせの口: PostgREST の口のうち本番が使っているもの ⊆ 偽のサーバが持つもの
    const POSTGREST = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'likeAllOf', 'likeAnyOf', 'ilikeAllOf', 'ilikeAnyOf',
        'is', 'in', 'contains', 'containedBy', 'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent', 'overlaps', 'textSearch', 'match', 'not', 'or',
        'order', 'limit', 'range', 'abortSignal', 'single', 'maybeSingle', 'csv', 'geojson', 'explain', 'rollback', 'returns', 'throwOnError'];
    const used = new Set([...CLIENT.matchAll(/\.\s*([A-Za-z]+)\(/g)].map(m => m[1]).filter(n => POSTGREST.includes(n)));
    used.delete('match');   // String.prototype.match (正規表現)。PostgREST の .match({…}) は使っていない (下で確かめる)
    assert.ok(!/\)\s*\.match\(\{/.test(CLIENT) && !/\.filter\(\s*['"`]/.test(CLIENT), 'PostgREST の .match({…}) / .filter(列, …) を使い始めた (偽のサーバに無い)');
    for (const n of used) assert.ok(BUILDER_METHODS.includes(n), `本番が使う問い合わせの口 .${n}() を偽のサーバが持たない`);
    const sb = createPracticeClient();
    for (const n of BUILDER_METHODS) assert.equal(typeof sb.from('players')[n], 'function', `BUILDER_METHODS にあるのに実装が無い: ${n}`);
    // 埋め込みは players(…) だけ / or() の演算子は is・eq・neq だけ
    const embeds = new Set([...CLIENT.matchAll(/[,`'\s]([a-z_]+)\(name/g)].map(m => m[1]));
    assert.deepEqual([...embeds], ['players'], `select の埋め込みが players 以外にも出た: ${[...embeds]}`);
    for (const m of CLIENT.matchAll(/\.or\('([^']*)'\)/g)) for (const part of m[1].split(',')) assert.ok(['is', 'eq', 'neq'].includes(part.split('.')[1]), `or() の ${part} を偽のサーバが読めない`);
});
test('見張り: 本番では練習のファイルを 1 つも読まない / 練習では本物のクライアントを作らない・倒さない', () => {
    // index.html: <head> のいちばん先頭のスクリプトが印を見て、あるときだけ boot.js を読む
    const first = HTML.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(HTML.indexOf('<script') === first.index, '練習の印を見るスクリプトが、いちばん先頭でない (差し替えより先に動くスクリプトがある)');
    assert.match(first[1], /if \(sessionStorage\.getItem\('shirisuko_practice_v1'\)\) \{ window\.__padPracticeWanted = true; document\.write\('<script src="\.\/js\/practice\/boot\.js"><\\\/script>'\); \}/);
    // ★ 2 つ目のスクリプト: 練習を始めたつもりなのに練習モードになっていないとき (boot.js を読めない・置き場が一杯) は、印を消して必ず知らせる
    const second = HTML.slice(first.index + first[0].length).match(/<script>([\s\S]*?)<\/script>/);
    assert.match(second[1], /if \(window\.__padPracticeWanted && !window\.PAD_PRACTICE\) \{\s*try \{ sessionStorage\.removeItem\('shirisuko_practice_v1'\); \}/, '始められなかったときに印を消していない');
    assert.match(second[1], /alert\('練習モードを始められませんでした。[^']*いま開いているのは「本番」の画面です/, '始められなかったことを知らせていない (練習のつもりで本番を触る)');
    assert.ok(HTML.indexOf(second[0]) < HTML.indexOf("var KEY = 'shirisuko_theme_v1';"), '知らせるスクリプトが 2 番目でない');
    assert.match(first[1], /if \(\/\^\(member\|ops-eve\|ops-day\)\$\/\.test\(_pmQ \|\| ''\)\) \{\s*sessionStorage\.setItem\('shirisuko_practice_v1', _pmQ\);/, 'URL から入れる編が一覧と違う');
    assert.match(first[1], /if \(\/\^\[a-z\]\+\$\/\.test\(_pmS \|\| ''\)\) sessionStorage\.setItem\('shirisuko_practice_v1:start', _pmS\);/, 'URL の start (途中の課題) を素通しで受けている');
    assert.match(first[1], /^\s*try \{[\s\S]*\} catch \(_\) \{/, 'sessionStorage が使えない環境で起動が止まる');
    assert.ok(!/<script[^>]*src="[^"]*practice\//.test(HTML.replace(first[0], '')), '練習のファイルを本番でも読み込んでいる (印を見るスクリプト以外から)');
    assert.ok(!/practice/.test(rd('sw.js')), 'Service Worker が練習のファイルを扱っている');
    // 入口: 同じ印を立てて読み込み直す
    const sp = HTML.match(/function startPractice\(scenario, startAt\) \{[\s\S]*?\n        \}/)[0];
    assert.match(sp, /sessionStorage\.setItem\('shirisuko_practice_v1', r\);[\s\S]*location\.reload\(\);/);
    assert.match(sp, /const at = \/\^\[a-z\]\+\$\/\.test\(startAt \|\| ''\) \? startAt : '';/, '途中の課題の指定を素通しで受けている');
    assert.match(sp, /if \(window\.PAD_PRACTICE\) \{\s*if \(confirm\('練習を最初からやり直しますか？[^']*'\)\) window\.PAD_PRACTICE\.restart\(r, at\);\s*return;\s*\}/, '練習中にもう一度入ると、確かめずにやり直す / 練習の中で印を立て直すだけになる');
    assert.match(HTML, /onclick="startPractice\('member'\)">メンバー編<\/button>\s*<button class="tour-guide-launcher" onclick="startPractice\('ops-eve'\)">運営編・前日<\/button>/, 'ヘルプに入口 (メンバー編・運営編・前日) が無い');
    assert.equal((HTML.match(/onclick="startPractice\('member'\)"/g) || []).length, 2, 'メンバー編の入口は ヘルプ と 設定 › ガイド の 2 つ');
    assert.equal((HTML.match(/onclick="startPractice\('ops-eve'\)"/g) || []).length, 2, '運営編・前日の入口は ヘルプ と 設定 › ガイド の 2 つ');
    assert.equal((HTML.match(/onclick="startPractice\('ops-day'\)"/g) || []).length, 2, '運営編・当日の入口は ヘルプ と 設定 › ガイド の 2 つ');
    // 練習中は端末の状態 (通知タップの行き先・キャッシュ) を本番と取り合わない
    assert.match(HTML, /async function _consumePendingNav\(\) \{\s*(?:\/\/[^\n]*\s*)*if \(window\.PAD_PRACTICE\) return;/, '練習中に本物の通知タップの行き先を消費している');
    assert.match(HTML, /msgEl\.textContent = '';\s*(?:\/\/[^\n]*\s*)*if \(window\.PAD_PRACTICE\) \{\s*statusEl\.innerHTML = '[^']*練習モードでは通知の設定は変えられません[^']*';\s*actionsEl\.innerHTML = '';\s*return;/, '練習中の通知設定シートに、押しても断られるボタンが並ぶ');
    assert.match(HTML, /async function handleSettingsClearCache\(\) \{\s*if \(window\.PAD_PRACTICE\) \{ showNotification\('🎮 練習モードでは使えません[^']*'\); return; \}/, '練習中に端末のキャッシュを消せる');
    assert.match(rd('js/practice/boot.js'), /var KEY = 'shirisuko_practice_v1';/);
    // js/supabase-client.js: 練習では CDN から本物を読まず、偽のサーバを使う。失敗しても本物へ倒さない
    assert.match(CLIENT, /const PRACTICE = \(typeof window !== 'undefined' && window\.PAD_PRACTICE\) \|\| null;/);
    assert.match(CLIENT, /if \(!PRACTICE\) \{\s*try \{\s*\(\{ createClient \} = await import\('https:\/\/esm\.sh/);
    assert.match(CLIENT, /export const supabase = PRACTICE \? await _practiceClient\(\) : createClient\(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, \{/);
    const pc = CLIENT.match(/async function _practiceClient\(\) \{[\s\S]*?\n\}/)[0];
    assert.match(pc, /catch \(e\) \{[\s\S]*PRACTICE\.exit\(\);\s*await new Promise\(\(\) => \{/, '練習の準備に失敗したとき、やめて読み込み直していない');
    assert.ok(!/createClient\(/.test(pc), '練習の準備に失敗したら本物のクライアントへ倒している (練習の操作が本番に入る)');
    assert.equal((CLIENT.match(/createClient\(/g) || []).length, 1, 'createClient の呼び出しが増えた');
    assert.equal((CLIENT.match(/if \(PRACTICE\) throw new Error\('練習モードでは通知の設定は変えられません/g) || []).length, 4, '通知の 購読・解除・テスト通知・Service Worker の登録 の 4 つで止めていない');
    // navigator.serviceWorker / Notification / pushManager に触れる関数は、どれも先頭で練習モードを見る
    for (const m of CLIENT.matchAll(/\nwindow\.(\w+) = async function \([^)]*\) \{\n([\s\S]*?)\n\};/g)) {
        if (!/navigator\.serviceWorker|Notification\.|pushManager/.test(m[2])) continue;
        const head = m[2].split('\n').filter(l => l.trim() && !l.trim().startsWith('//'))[0];
        assert.match(head, /^\s*if \(PRACTICE\) (throw new Error|return \{ supported: false, practice: true \})/, `${m[1]} が練習中に端末の通知・Service Worker に触れ得る`);
    }
    // 練習のファイル: 本物のクライアントを作らない / 本物への通信はキャラ表の GET 1 つだけ
    for (const f of ['boot.js', 'guide.js', 'server.js', 'seed.js', 'session.js']) {
        const src = rd('js/practice/' + f).replace(/\/\/[^\n]*/g, '');
        assert.ok(!/createClient\(|esm\.sh|supabase-js/.test(src), `${f} が本物のクライアントを作ろうとしている`);
        assert.equal((src.match(/\bfetch\(/g) || []).length, f === 'session.js' ? 1 : 0, `${f} の通信の数が違う`);
        assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket/.test(src), `${f} に別の通信の口がある`);
    }
    const sess = rd('js/practice/session.js');
    assert.match(sess, /await fetch\(`\$\{url\}\/rest\/v1\/nikke_characters\?select=\*`, \{ headers: \{ apikey: key, Authorization: `Bearer \$\{key\}` \} \}\);/, 'キャラ表の読み方が変わった (GET で読むだけのはず)');
});

// 案内 (guide.js) を、画面なしで読み込んで 押す場所 と 課題 を取り出す
function loadGuide() {
    const P = { role: 'member', hardDate: '2026-10-03', db: null, me: { id: IDS.me }, ops: { id: IDS.ops, name: OPS_NAME },
        store: { get: () => null, set: () => { }, del: () => { } }, clock: { now: () => T0, RealDate: Date } };
    const win = { PAD_PRACTICE: P, addEventListener() { }, document: { readyState: 'loading', addEventListener() { } } };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(GUIDE, win);
    return P;
}
test('見張り: 案内が指す「押す場所」が、本物の画面 (index.html) に実在する', () => {
    const P = loadGuide();
    const names = Object.keys(P.selectors);
    assert.ok(names.length >= 15);
    const hasClass = (c) => new RegExp(`class="[^"]*\\b${c}\\b|class=\\\\?"${c}[\\s$"\\\\]|\\.${c}\\b[^{]*\\{`).test(HTML);
    for (const name of names) for (const sel of P.selectors[name]) {
        for (const m of sel.matchAll(/#([A-Za-z][\w-]*)/g)) assert.ok(HTML.includes(`id="${m[1]}"`), `${name}: #${m[1]} が画面に無い`);
        for (const m of sel.matchAll(/\[data-tab="([a-z-]+)"\]/g)) assert.ok(HTML.includes(`data-tab="${m[1]}"`), `${name}: data-tab="${m[1]}" が画面に無い`);
        // onclick="fn(" が静的にあるか、btn('…', `fn(${…})`) のように関数名から組み立てているか
        for (const m of sel.matchAll(/\[onclick(\^=|=)"([A-Za-z_]\w*)\(/g)) assert.ok(HTML.includes(`onclick="${m[2]}(`) || HTML.includes('`' + m[2] + '('), `${name}: onclick="${m[2]}(…)" のボタンが画面に無い (関数名が変わった?)`);
        for (const m of sel.matchAll(/\.([a-z][\w-]*)/g)) assert.ok(hasClass(m[1]), `${name}: .${m[1]} が画面に無い`);
    }
    // 生成されるボタンの引数の形 (selector が頼っている部分) も確かめる
    assert.match(HTML, /onclick="handleMyTeamEdit\('\$\{[^}]+\}', \$\{[^}]+\}\)"/, "模擬カードの onclick の形が変わった (handleMyTeamEdit('fire', 1) で指している)");
    assert.match(HTML, /_resvReqPick\('time', '\$\{/, "申請シートの時刻ボタンの onclick の形が変わった (_resvReqPick('time', 'h21') で指している)");
    assert.match(HTML, /handleConfirmAvailability\(false\)/);
    assert.match(HTML, /class="te-tile\$\{isUsed \? ' used' : ''\}\$\{isDup \? ' dup' : ''\}"/, '選んだキャラの印 (.used / .dup) が変わった');
    assert.match(HTML, /id="myTeamEditFields"/, '編成の 5 つの入力欄 (#myTeamEditFields) が無い');
    assert.match(HTML, /id="myAttackManualForm"/);
    assert.match(HTML, /handleMyFinishRequestRespond\(\$\{r\.boss_number\}, 'accepted'/, "了承ボタンの onclick の形が変わった ('accepted' で指している)");
    assert.match(HTML, /handleMyFinishRequestRespond\(\$\{r\.boss_number\}, 'declined'/, "「今回は難しい」の onclick の形が変わった ('declined' で指している)");
});
test('見張り: 課題の形 / 「〜したことにする」は自動では起きない / 案内の文が引く画面の言葉が実在する', () => {
    const P = loadGuide();
    const steps = P.steps.member;
    assert.deepEqual(Array.from(steps, s => s.key), ['avail', 'mock', 'resv', 'ack', 'attack', 'finish']);   // (別の実行環境の配列なので写してから比べる)
    assert.deepEqual(Array.from(P.steps['ops-eve'], s => s.key), ['nudge', 'compute', 'pin', 'request', 'publish']);
    assert.deepEqual(Array.from(P.steps['ops-day'], s => s.key), ['hp', 'console', 'offer', 'confirm', 'kill'], '運営編・当日は HP更新 → コンソール → 同時打診 → 確定 → 撃破');
    // 編の並び (次は ○○ →): メンバー → 運営・前日 → 運営・当日 → メンバー
    assert.deepEqual(['member', 'ops-eve', 'ops-day'].map(k => P.scenarios[k].next), ['ops-eve', 'ops-day', 'member']);
    for (const k of Object.keys(P.scenarios)) assert.ok(P.scenarios[k].diff && P.scenarios[k].diff.length > 30, `${k} の「本番とのちがい」が無い`);
    for (const sc of Object.keys(P.steps)) for (const s of P.steps[sc]) assert.ok(s.title && typeof s.done === 'function' && typeof s.guide === 'function', `${sc}/${s.key} の形が違う`);
    // 編の一覧は boot.js / guide.js / index.html (URL と入口) で同じ
    const ids = Object.keys(P.scenarios).sort();
    const bootIds = [...rd('js/practice/boot.js').match(/var SCENARIOS = \{([^}]*\}[^}]*\}[^}]*\})/)[1].matchAll(/'([a-z-]+)': \{ role:/g)].map(m => m[1]).sort();
    assert.deepEqual(bootIds, ids, 'boot.js の編の一覧が guide.js と違う');
    assert.deepEqual(Object.keys(P.steps).sort(), ids, '課題の無い編 / 一覧に無い課題がある');
    assert.equal((HTML.match(/\^\(member\|ops-eve\|ops-day\)\$/g) || []).length, 2, 'index.html (URL の印 と 入口) の編の一覧が違う');
    for (const id of ids) assert.ok(P.scenarios[id].title && P.scenarios[P.scenarios[id].next], `${id} の名前か「次の編」が無い`);
    // 途中の課題から: 手前を**本物の関数**で済ませる (FF の鍵は課題の鍵)
    const ffKeys = [...GUIDE.matchAll(/\n        (\w+): async function \(c\) \{/g)].map(m => m[1]);
    assert.deepEqual(ffKeys, ['avail', 'mock', 'resv', 'ack', 'attack'], '手前を済ませる手順が課題と合わない (finish は最後なので手順が要らない)');
    assert.match(GUIDE, /attack: async function \(c\) \{[\s\S]*?await window\.supabaseAddAttack\(\{[^}]*\}, \{ reservationId: res\.id, actorName: P\.me\.name \}\);/, '手前の「凸報告」を本物の関数で済ませていない (start=finish が attack から始まる)');
    // ★ 途中で失敗したら全部戻して最初から (半端に済んだ状態で始めない: Codex指摘 2026-10-03)
    assert.match(GUIDE, /async function fastForward\(startKey\) \{[\s\S]*?var snap = P\.db\.dump\(\), clockWas = P\.clock\.get\(\);[\s\S]*?if \(!list\[i\]\.done\(context\(\)\)\) throw new Error[\s\S]*?catch \(e\) \{[\s\S]*?P\.db\.restore\(snap\); P\.clock\.put\(clockWas\);[\s\S]*?return false;/, '途中の課題から始める処理が、失敗しても途中まで書いた盤面を残す');
    assert.match(GUIDE, /fastForward\(startAt\)\.then\(function \(ok\) \{[\s\S]*?if \(ok\) store\.set\('ff:done', '1'\); else store\.del\('start'\);/, '失敗しても「済んだ」印を付けている / 「途中から」をやめていない');
    for (const fn of ['supabaseConfirmAvailability', 'supabaseSaveMockSubmission', 'supabaseCreateReservation', 'supabaseAckPlan']) assert.ok(new RegExp(`var FF = \\{[\\s\\S]*?window\\.${fn}\\(`).test(GUIDE), `手前を済ませるのに本物の ${fn} を使っていない`);
    // 編の開始状態 (SETUP): 運営編・当日だけ。本物の配信 (opsPublish) + 20 時までの凸 (advanceWorld) で作り、失敗したら全部戻して知らせる (半端な盤面で始めない)
    assert.deepEqual([...GUIDE.matchAll(/\n        '([a-z-]+)': async function \(c\) \{/g)].map(m => m[1]), ['ops-day'], '開始の盤面を作る編が増えた/減った');
    assert.match(GUIDE, /var SETUP = \{[\s\S]*?await opsPublish\('day'\);[\s\S]*?advanceWorld\(context\(\), pub && pub\.plan, 20, \{ 1: 0\.45 \}\);[\s\S]*?store\.set\('ops-day:setupAt', new Date\(\)\.toISOString\(\)\);/, '当日の盤面の作り方が変わった (配信 → 20 時までの凸 → HP 更新の時刻)');
    assert.match(GUIDE, /async function runSetup\(\) \{[\s\S]*?var snap = P\.db\.dump\(\), clockWas = P\.clock\.get\(\);[\s\S]*?store\.set\('setup:done', '1'\);[\s\S]*?catch \(e\) \{[\s\S]*?P\.db\.restore\(snap\); P\.clock\.put\(clockWas\);[\s\S]*?store\.set\('setup:err'/, '開始の盤面を作れなかったとき、戻して知らせていない');
    assert.match(GUIDE, /if \(SETUP\[SC\] && store\.get\('setup:done'\) !== '1'\) \{[\s\S]*?runSetup\(\)\.then\(function \(\) \{ if \(typeof P\.save === 'function'\) P\.save\(\); location\.reload\(\); \}\);/, '盤面を作ったあと、控えてから読み込み直していない');
    // 当日の仮定: 了承は本物のメンバー側の手順 (枠を取ってから伝える) / 締め凸の報告は本物の凸報告 → 本物の検知
    assert.match(GUIDE, /finishAnswers: async function \(\) \{[\s\S]*?await _reserveForFinishRequest\(ctx, who, bn, m\.rowId\);\s*await window\.supabaseRespondFinishRequest\(c\.season\.id, bn, m\.id, 'accepted', level, m\.rowId\);\s*await _notifyOps\(\{ title: '🗡 締め凸を了承'/, '了承の仮定が本物の手順 (枠 → 返事 → 運営あての通知) でない');
    assert.match(GUIDE, /finishKill: async function \(\) \{[\s\S]*?await window\.supabaseAddAttack\(\{[^}]*\}, \{ reservationId: r\.id, actorName: [^}]*\}\);[\s\S]*?await _checkRaidEvents\(\);/, '締め凸の報告の仮定が 本物の凸報告 (予約つき) → 本物の撃破の検知 でない');
    // 当日の課題の判定は、撃破で依頼の行が消えたあとも「済んだ」のまま (撃破の通知・実行済みの約束で見る)
    assert.match(GUIDE, /key: 'confirm'[\s\S]*?return settled \|\| c\.allResv\.some\(function \(r\) \{ return r\.source_type === 'finish_request' && r\.status === 'fulfilled'; \}\) \|\| c\.notices\.some\(function \(r\) \{ return r\.kind === 'boss_defeated'; \}\);/, '確定の判定が、撃破で依頼が消えると「まだ」に戻る');
    assert.match(GUIDE, /key: 'offer'[\s\S]*?done: function \(c\) \{ return c\.offer\.length > 0 \|\| c\.pushLog\.some\(/, '同時打診の判定が、撃破で依頼が消えると「まだ」に戻る');
    assert.match(GUIDE, /fastForward\(startAt\)\.then\([\s\S]*?location\.reload\(\)/, '手前を済ませたあと読み込み直していない (画面が古いまま)');
    const used = [...GUIDE.matchAll(/assume: \['(\w+)'/g)].map(m => m[1]);
    assert.deepEqual([...new Set(used)].sort(), [...P.assumeKeys].sort(), '「〜したことにする」の顔ぶれが課題と合わない');
    // ★ 相手の動き (承認・時間・お願い) を自動で起こさない (ユーザー要望 2026-10-02: 本番で「練習ではすぐ返事が来たのに」とならないように)。
    //   時間で動くのは 画面の見直し (setInterval(update)) と 入力のあとの見直し (schedule) だけ
    const code = GUIDE.replace(/\/\/[^\n]*/g, '');
    assert.deepEqual((code.match(/set(?:Timeout|Interval)\(([A-Za-z_.]+)/g) || []).sort(), ['setInterval(update', 'setTimeout(update'], '時間で勝手に進む処理が増えた');
    // (途中の課題から始める fastForward だけは、利用者が指定した「手前を済ませる」ので仮定を呼んでよい)
    assert.ok(!/ASSUME\[[^\]]+\]\(\)|ASSUME\.\w+\(\)/.test(code.replace(/var FF = \{[\s\S]*?\n    \};/, '')), '「〜したことにする」をボタン以外から呼んでいる');
    assert.match(code, /if \(k === 'assume' && !busy\) \{\s*var fn = ASSUME\[b\.getAttribute\('data-k'\)\];/);
    // ★ 途中で失敗したら押す前の盤面へ戻す (承認だけ済んで配信が無い、のような半端を残さない → 押し直せる)
    assert.match(code, /var snap = P\.db\.dump\(\), feedWas = feedId, clockWas = P\.clock\.get\(\);[\s\S]*?Promise\.resolve\(\)\.then\(fn\)\.catch\(function \(e\) \{[\s\S]*?P\.db\.restore\(snap\); P\.clock\.put\(clockWas\); if \(typeof P\.save === 'function'\) P\.save\(\);[\s\S]*?\}\)\.then\(refreshScreen\)/, '仮定が途中で失敗しても盤面・時計を戻していない');
    assert.match(code, /var snap = P\.db\.dump\(\), feedWas = feedId, clockWas = P\.clock\.get\(\);/);
    assert.match(code, /saveFeed\(\);\s*P\.clock\.set\('hard', 21\);[^\n]*\n\s*if \(typeof P\.save === 'function'\) P\.save\(\);/, '当日に進めるとき、失敗し得る処理より先に時計を動かしている');
    // どの仮定も「練習だけの仮定」と出す。★ 関数ごとに切り出して見る (まとめて探すと、ほかの仮定の note で通ってしまう)
    for (const key of P.assumeKeys) {
        const body = GUIDE.match(new RegExp(`\\n        ${key}: async function \\(\\) \\{([\\s\\S]*?)\\n        \\},`))?.[1] || '';
        assert.ok(body.length > 50, `${key} の中身を切り出せない`);
        assert.ok(/note\('assume', [^\n]*仮定しました/.test(body), `${key}: 「練習だけの仮定」と出していない`);
    }
    assert.ok((GUIDE.match(/real: '/g) || []).length >= 10, '「本番では」の断りが減っている');
    // ⏩ 仮定のある場面には、必ず「本番では」の断りが付いている (同じ guide の中に real: と assume: が並ぶ)
    for (const m of GUIDE.matchAll(/assume: \['(\w+)'/g)) {
        const around = GUIDE.slice(Math.max(0, m.index - 400), m.index);
        assert.ok(/real: '/.test(around), `${m[1]} の仮定に「本番では」の断りが付いていない`);
    }
    // 相手役が送る通知は、本番の文面と同じ (本番の文面を変えたら練習も直す) / 本物の送り方で送る
    for (const w of ['🔒 予約が承認されました', '固定されました。プランは運営が組み直して配信します', 'PT 締め凸候補', '凸お願いできる方いますか🙏', './?tab=mypage&focus=finishreq', '🗡 締め凸を了承', "tag: 'ops-finish-answer'"]) {
        assert.ok(GUIDE.includes(w) && HTML.includes(w), `通知の文面「${w}」が 本番 と 練習 でそろっていない`);
    }
    assert.match(code, /function pushAsOps\(payload\) \{\s*return window\.sendPushNotification\(payload, \{ senderPlayerId: P\.ops\.id \}\)/, '相手役の通知を本物の送り方で送っていない (受け取った通知の一覧に残らない)');
    assert.ok(!/note\('push'/.test(code.replace(/function note[\s\S]*?\n    \}/, '').replace(/note\('push', d\.item\.title/, '')), '通知の見本を手書きで出している (本物の文面とずれる)');
    assert.match(GUIDE, /<b>本番とのちがい<\/b>/, '最後のまとめに本番との違いが無い');
    // 案内の要所 (どれもブラウザの通し確認で踏んだ穴)
    assert.deepEqual(Array.from(P.selectors.mockTile), ['#myTeamEditModal .te-tile:not(.used):not(.dup)'], '選んだキャラをもう一度指している (押すと外れて、いつまでも 5 人にならない)');
    assert.match(code, /var hit = document\.elementFromPoint\(cx, cy\);\s*return !!hit && \(hit === el \|\| el\.contains\(hit\) \|\| hit\.contains\(el\)\);/, '固定の帯の裏にあるボタンにも枠を出している (押すと別のボタンに当たる)');
    assert.match(code, /if \(typeof P\.save === 'function'\) P\.save\(\);\s*location\.reload\(\);/, '当日に進めるとき、読み込み直す前に控えていない (入れた凸が消える)');
    assert.match(code, /if \(pid == null \|\| eq\(pid, c\.me\) \|\| a\.flex\) return;/, 'ほかのメンバーの凸に、自分のぶんを混ぜている');
    assert.match(code, /if \(!\(dmg > 0\) \|\| Number\(boss\.remaining_hp_raw\) - dmg < keep\) return;/, '練習の世界でボスを倒し切る (レベルが進むと案内が合わなくなる)');
    assert.match(code, /P\.db\.rpc\('reservation_set_status', \{ p_id: row\.id, p_to: 'approved', p_expect_from: 'requested', p_actor: P\.ops\.name \}\);\s*await opsPublish\(/, '承認したことにする が 承認 → 組み直して配信 の順でない');
    assert.match(code, /plan = computeOptimalPlan\(\{ reservations: rows, previousPlan: [^}]*\}, snapshot\);/, '運営役の組み直しが本物のソルバーでない');
    assert.match(code, /return window\.supabasePublishPlan\(plan, P\.ops\.id, P\.ops\.name, c\.season\.id, schema\);/, '運営役の配信が本物の関数でない');
    assert.match(GUIDE, /html\[data-practice\] \.player-select-modal > \*:not\(#_\):not\(#_\)[^{]*\{max-height:calc\(100vh - var\(--pm-top,0px\) - 8px\) !important\}/, 'シートを案内の下に収めていない (「閉じる」が帯に隠れる)');
    assert.match(GUIDE, /#pmRing\{position:fixed;[^}]*pointer-events:none;/, '枠が本物のボタンへのタップを奪う');
    assert.match(GUIDE, /html\[data-practice\] \.header\{display:none !important\}/, '練習中も上の帯 (ロゴ・名乗り) が出て、案内の直下で指したマスと重なる');
    // ★ アプリの知らせ (トースト・更新の帯・互換ゲートの帯) は案内の裏に隠れない (実機 2026-10-03: 断られた理由が見えなかった)
    assert.match(GUIDE, /html\[data-practice\] \.notification\{top:calc\(env\(safe-area-inset-top,0px\) \+ 12px \+ var\(--pm-top,0px\)\) !important\}/, 'トーストが案内の裏に隠れる');
    assert.match(GUIDE, /html\[data-practice\] #appUpdateBanner,html\[data-practice\] #clientGateBanner\{top:calc\(env\(safe-area-inset-top,8px\) \+ 8px \+ var\(--pm-top,0px\)\) !important\}/, '更新・互換ゲートの帯が案内の裏に隠れる');
    assert.match(HTML, /b\.id = 'clientGateBanner'/); assert.match(HTML, /getElementById\('appUpdateBanner'\)/);
    assert.match(HTML, /\.notification \{\s*position: fixed;\s*top: calc\(env\(safe-area-inset-top, 0px\) \+ 12px\);/, 'トーストの位置の決め方が変わった (練習の上書きが効かない)');
    // 残り凸が無いときは「今回は難しい」を指す (了承は断られる)
    assert.match(code, /if \(held \+ c\.mine\('attacks'\)\.length >= 3\) \{[\s\S]*?target: pick\('finishDecline'\)/, '残り凸が無いのに了承を指している');
    // ↩ 1つ前に戻る: 課題の区切りごとに控え、戻すときは 盤面・時計・知らせ を戻して読み込み直す。戻った先より後の控えは捨てる
    assert.match(code, /function trackStep\(i\) \{\s*if \(i === stepIdx\) return;\s*if \(i > stepIdx && !hasSnap\(i\)\) saveSnap\(i\);/, '課題が進んだ瞬間に控えていない');
    assert.match(code, /function goBack\(toIdx\) \{[\s\S]*?if \(!P\.db\.restore\(snap\.db\)\) return false;\s*P\.clock\.put\(snap\.clock\);\s*feed = [^\n]*\n\s*saveFeed\(\);\s*for \(var i = toIdx \+ 1; i < 20; i\+\+\) store\.del\('snap:' \+ i\);[\s\S]*?store\.set\('db', P\.db\.dump\(\)\);[\s\S]*?P\.closed = true;[\s\S]*?location\.reload\(\);/, '戻るときに 盤面・時計・知らせ を戻して**控えてから**閉じて読み込み直していない (閉じると置き場に書けない)');
    assert.match(rd('js/practice/boot.js'), /set: function \(k, v\) \{\s*(?:\/\/[^\n]*\s*)*if \(window\.PAD_PRACTICE && window\.PAD_PRACTICE\.closed\) return;/, 'やめたあとも置き場に書ける (進み具合の鍵が残る)');
    assert.match(code, /if \(k === 'back'\) \{[\s\S]*?if \(!window\.confirm\('課題 ' \+ \(to \+ 1\) \+ '「' \+ st\.title \+ '」の最初に戻りますか？/, '戻る前に確かめていない');
    assert.match(code, /if \(c\.finish\.some\(function \(r\) \{ return r\.status === 'pending'; \}\)\) return;/, '締め凸のお願いを二重に出せる');
    // 案内の文が「」で引いている画面の言葉は、画面に実在する (ボタンの名前を変えたら案内も直す)
    const quoted = new Set([...GUIDE.matchAll(/text: '([^']*)'/g)].flatMap(m => [...m[1].matchAll(/「([^」]+)」/g)].map(x => x[1])));
    const NOT_ON_SCREEN = ['申請中'];   // 状態の呼び名 (画面では「承認待ち」などの文で出る)
    assert.ok(quoted.size >= 10, `案内の文から画面の言葉を読めていない (${quoted.size})`);
    // 画面の言葉は index.html のほか、js/domain/*.js (運営タブの段階ヘッダなど) にもある
    const SCREEN = HTML + fs.readdirSync(path.join(ROOT, 'js/domain')).filter(f => f.endsWith('.js')).map(f => rd('js/domain/' + f)).join('\n');
    for (const w of quoted) {
        if (NOT_ON_SCREEN.includes(w)) continue;
        assert.ok(SCREEN.includes(w.replace(/^[＋⏰🔒] ?/, '').replace(/ ›$/, '')), `案内が引く「${w}」が画面に無い (ボタンの名前が変わった?)`);
    }
});

for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 6).join('\n     ')}`); }
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
