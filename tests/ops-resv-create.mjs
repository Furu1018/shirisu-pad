// ============================================================================
// 🔒 運営発の予約 (🗣 運用の見直し 9b・2026-10-24) の実行テスト
//   node tests/ops-resv-create.mjs
// ----------------------------------------------------------------------------
// index.html から openOpsResvCreate / _opsResvCreatePick / _opsResvCreateRender / handleOpsResvCreateSubmit を切り出し、
// 通信 (予約の一覧・作成・遷移・通知) と DOM だけをスタブにして実際に走らせる。
// 守るのは: ① 人を選ぶと、その人の模擬 (対応するボスがある属性だけ) と 出られるブロック (出られないブロックは押せない) が描ける
//          ② 登録 = いまの予約で canPin → 📌 (pinned・ブロック・編成のキャラ・pinnedBy) を作る → すぐ 🔒 確定 (pinned → approved・ops_registered) → 本人に通知
//          ③ 置けなければ (3 凸済み) 作らない ④ 登録中は二重に押せない
// ★ テンプレートリテラルの中の未定義参照は実行しないと出ない — 画面を組み立てる関数なので実行テストが要る
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/raidBlocks.js';      // globalThis.raidBlocksDomain
import '../js/domain/reservations.js';    // globalThis.reservationsDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function cut(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} を index.html から切り出せませんでした (目印が変わった?)`); process.exit(2); }
    let paren = 0, bodyStart = -1;
    for (let k = html.indexOf('(', i); k < html.length; k++) {
        if (html[k] === '(') paren++;
        else if (html[k] === ')') { paren--; if (paren === 0) { bodyStart = html.indexOf('{', k); break; } }
    }
    let depth = 0, inStr = null, prev = '';
    for (let k = bodyStart; k < html.length; k++) {
        const ch = html[k];
        if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; }
        else if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); }
        prev = ch;
    }
    console.error(`NG: ${marker} の終端を判定できませんでした`); process.exit(2);
}
const SRC = [
    cut('        async function openOpsResvCreate('),
    cut('        function closeOpsResvCreate('),
    cut('        function _opsResvCreateSet('),
    cut('        function _opsResvCreatePick('),
    cut('        function _opsResvCreateRender('),
    cut('        async function handleOpsResvCreateSubmit('),
].join('\n');

const PT_ATTRS = [{ key: 'fire', name: '灼熱', icon: './i/fire.png' }, { key: 'water', name: '水冷', icon: './i/water.png' }, { key: 'wind', name: '風圧', icon: './i/wind.png' }];
function makeEnv(o = {}) {
    const created = [], transitions = [], notices = [], logs = [];
    let bodyHtml = '';
    const el = (id) => ({ id, style: {}, textContent: '', classList: { add() { }, remove() { } },
        set innerHTML(v) { if (id === 'opsResvCreateBody') bodyHtml = String(v); }, get innerHTML() { return id === 'opsResvCreateBody' ? bodyHtml : ''; } });
    const players = o.players || [
        { id: 9, name: 'B', attackCount: 0, availableSlots: ['h17', 'h18', 'h19', 'h20', 'h21', 'h22', 'h23', 'h00'], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 30, team: ['a', 'b', 'c', 'd', 'e'] }, { slot: 2, dmgB: 25, team: ['f', 'g', 'h', 'i', 'j'] }], water: [{ slot: 1, dmgB: 20, team: ['k', 'l', 'm', 'n', 'o'] }], wind: [{ slot: 1, dmgB: 10, team: [] }] } },
        { id: 10, name: 'C', attackCount: 3, availableSlots: [], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 40, team: ['p', 'q', 'r', 's', 't'] }] } },
        { id: 11, name: 'D', attackCount: 0, availableSlots: ['h05'], unavailableThisSeason: true, loadoutsByAttr: {} },
        { id: 12, name: 'E', attackCount: 0, availableSlots: ['h18'], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 30, team: ['a', 'b', 'c', 'd', 'e'] }] } },   // 夕方の一部 (18 時) だけ
    ];
    const bosses = [{ boss_number: 1, name: 'ボス1', weakness: 'fire', remaining_hp_raw: 10e9 }, { boss_number: 2, name: 'ボス2', weakness: 'water', remaining_hp_raw: 0 }];   // 風圧のボスは無い
    const env = {
        _opsResvCreate: { playerId: null, attr: null, slot: null, blockIdx: null, busy: false },
        _resv: { rows: o.rows || [] },
        _opsLastPlan: null,
        opsStore: {
            get: () => (env._boardNull ? null : { season: { id: 44, metadata: {} }, players, bosses }),
            // 実装と同じく load のたびに世代が進む。_raceOnce / _raceAlways = load の間に別の読み直し・invalidate が走った (世代がもう 1 つ進む)
            load: async () => { env.loads++; env.gen++; env._boardNull = false; if (env._raceAlways || env._raceOnce) { env.gen++; env._raceOnce = false; } return env._loadSnap || { season: { id: 44, metadata: {} }, players, bosses }; },
            generation: () => env.gen, isCurrentGeneration: (g) => g === env.gen,
        },
        _paintOpsReservations() { },
        weaknessPtOf: (b) => b.weakness,
        PT_ATTRS, SLOT_JP: { 1: '①', 2: '②' },
        escapeHtml: (x) => String(x),
        document: { getElementById: el },
        getCurrentIdentity: () => ({ id: 7, name: 'O' }),
        showNotification: (m) => { env.toasts.push(m); }, alert: (m) => { env.alerts.push(m); }, confirm: () => env._confirm,
        computeAndRenderOptimalPlan: () => { env.recomputed++; },
        window: {
            raidBlocksDomain: globalThis.raidBlocksDomain, reservationsDomain: globalThis.reservationsDomain,
            supabaseLoadReservations: async () => { env.resvLoads++; return env._resv.rows.slice(); },
            supabaseCreateReservation: async (row) => { const r = { id: 500 + created.length + 1, status: row.status, player_id: row.playerId, boss_number: row.bossNumber, loadout_slot: row.loadoutSlot, time_mode: row.block ? 'block' : 'fixed', block_from: row.block?.from ?? null, block_to: row.block?.to ?? null, characters_snapshot: row.characters, pinned_by: row.pinnedBy, player_name: 'B' }; created.push({ ...row }); return r; },
            supabaseLogActivity: (type, detail, opts) => { logs.push({ type, detail, opts }); },
        },
        _resvTransition: async (id, to, opts) => { transitions.push({ id, to, ...opts }); const r = env._resv.rows.find(x => Number(x.id) === Number(id)); if (r) r.status = env._transitionOk ? to : (env._releasedByOther ? 'released' : r.status); return env._transitionOk; },
        _notifyMemberResv: (row, title, body) => { notices.push({ playerId: row.player_id, title, body }); },
        created, transitions, notices, logs, toasts: [], alerts: [], recomputed: 0, _confirm: true, _transitionOk: true, _releasedByOther: false, _boardNull: false, _loadSnap: null, loads: 0, gen: 0, _raceOnce: false, _raceAlways: false, resvLoads: 0,
        body: () => bodyHtml,
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn { openOpsResvCreate, closeOpsResvCreate, _opsResvCreateSet, _opsResvCreatePick, _opsResvCreateRender, handleOpsResvCreateSubmit };`);
    return Object.assign(env, fn(...keys.map(k => env[k])));
}

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
console.log('🔒 運営発の予約 (9b):\n');

await test('★ 人を選ぶと、その人の模擬 (対応するボスがある属性だけ・ボス順) と 出られるブロック (出られないブロックは押せない) が描ける。今回は難しい人は候補に出ない', async () => {
    const env = makeEnv();
    await env.openOpsResvCreate();
    assert.ok(env.body().includes('<option value="9"') && env.body().includes('<option value="10"') && !env.body().includes('<option value="11"'), '人の候補 (今回は難しい D を除く)');
    env._opsResvCreateSet('playerId', '9');
    const b = env.body();
    assert.ok(b.includes("_opsResvCreateSet('lo', 'fire|1')") && b.includes("_opsResvCreateSet('lo', 'fire|2')") && b.includes("_opsResvCreateSet('lo', 'water|1')"), '編成の候補が無い');
    assert.ok(!b.includes("'wind|1'"), '対応するボスが無い属性 (風圧) を候補に出した');
    assert.ok(b.includes('→ B1 ボス1') && b.includes('→ B2 ボス2 (いまのレベルでは倒れています)'), '行き先のボスと「倒れている」の注記');
    const chips = [...b.matchAll(/class="avail-blk" data-state="(on|off)"[^>]*onclick="_opsResvCreateSet\('blockIdx', (\d)\)"/g)].map(m => [Number(m[2]), m[1]]);
    assert.deepEqual(chips.filter(c => c[1] === 'on').map(c => c[0]), [3, 4], '出られるブロック (D 夕方 17〜21・E 夜 21〜翌1) だけ押せる (2026-10-24 から 6 ブロック)');
    assert.ok(/data-state="off"[^>]*disabled/.test(b), '出られないブロックが押せる');
    assert.ok(/id="opsResvCreateSubmit" disabled/.test(b), '選び終える前に登録ボタンが押せる');
    env._opsResvCreateSet('lo', 'fire|2'); env._opsResvCreateSet('blockIdx', 3);
    assert.ok(env.body().includes('B さん: D 夕方 17〜21時 のどこかで 灼熱PT 編成② → B1') && !/id="opsResvCreateSubmit" disabled/.test(env.body()), '要約と登録ボタン');
});

await test('★ 登録 = いまの予約で canPin → 📌 (pinned・ブロック・編成のキャラ・pinnedBy) → すぐ 🔒 確定 (ops_registered) → 本人に通知 → 閉じる', async () => {
    const env = makeEnv();
    await env.openOpsResvCreate(9, 'fire', 2);            // 📸 の保存直後から (人・編成が入っている)
    assert.ok(env.body().includes('aria-pressed="true"'), '📸 から開いたときに編成が選ばれていない');
    env._opsResvCreateSet('blockIdx', 4);
    await env.handleOpsResvCreateSubmit();
    assert.equal(env.created.length, 1, '予約を作っていない: ' + JSON.stringify(env.alerts));
    const c = env.created[0];
    assert.equal(c.status, 'pinned'); assert.equal(c.pinnedBy, 'O'); assert.equal(c.playerId, 9); assert.equal(c.bossNumber, 1); assert.equal(c.loadoutSlot, 2);
    assert.deepEqual(c.block, { from: 21, to: 0 }, 'ブロックが入っていない'); assert.deepEqual(c.characters, ['f', 'g', 'h', 'i', 'j'], '編成のキャラが入っていない'); assert.equal(c.expectedDamageB, 25);
    assert.deepEqual(env.transitions.map(t => [t.id, t.to, t.expectFrom, t.reason]), [[501, 'approved', 'pinned', 'ops_registered']], '📌 → 🔒 確定 の遷移');
    assert.deepEqual(env.notices.map(n => [n.playerId, n.title]), [[9, '🔒 運営があなたの予約を登録しました']], '本人への通知');
    assert.ok(env.notices[0].body.includes('ボス1 21〜翌1時のどこか 編成②'), '通知の中身: ' + env.notices[0].body);
    assert.ok(env.logs.some(l => l.detail.includes('運営が代理で登録') && l.opts.actorName === 'O'), '活動ログ');
    assert.equal(env.alerts.length, 0);
    assert.equal(env.loads, 1, '置けるかを見る前に盤面 (凸数) を取り直していない');
    assert.deepEqual(env._resv.rows.map(r => r.id), [501], '取り直した予約 + 作った行 を _resv.rows にしていない');
});

await test('★ 置けないとき (3 凸済み) は作らない / キャンセルなら何もしない / 遷移に失敗したら知らせる', async () => {
    const env = makeEnv();
    await env.openOpsResvCreate(10, 'fire', 1); env._opsResvCreateSet('blockIdx', 0);   // C は 3 凸済み (ブロックは出られないが、ここでは canPin を見る)
    env._opsResvCreate.blockIdx = 0;   // 出られないブロックは画面では押せないので直接入れる
    await env.handleOpsResvCreateSubmit();
    assert.equal(env.created.length, 0, '3 凸済みの人に予約を作った');
    assert.ok(env.alerts.some(a => a.includes('登録できません')), '理由を知らせていない: ' + JSON.stringify(env.alerts));
    const env2 = makeEnv(); env2._confirm = false;
    await env2.openOpsResvCreate(9, 'fire', 1); env2._opsResvCreateSet('blockIdx', 4);
    await env2.handleOpsResvCreateSubmit();
    assert.equal(env2.created.length, 0, 'キャンセルしたのに作った');
    const env3 = makeEnv(); env3._transitionOk = false;
    await env3.openOpsResvCreate(9, 'fire', 1); env3._opsResvCreateSet('blockIdx', 4);
    await env3.handleOpsResvCreateSubmit();
    assert.equal(env3.created.length, 1); assert.equal(env3.notices.length, 0, '確定できていないのに通知した');
    assert.ok(env3.alerts.some(a => a.includes('仮置き (📌) までは置けました')), '確定の失敗を知らせていない');
});

await test('★ 登録中は二重に押せない (busy) / 既にある予約を一覧に出す', async () => {
    const env = makeEnv({ rows: [{ id: 1, player_id: 9, status: 'approved', boss_number: 2, loadout_slot: 1, time_mode: 'block', block_from: 17, block_to: 20 }] });
    await env.openOpsResvCreate(9, 'fire', 1); env._opsResvCreateSet('blockIdx', 4);
    assert.ok(env.body().includes('いまの予約・仮置き: ') && env.body().includes('ボス2 17〜21時のどこか 編成①'), '既にある予約が出ていない');
    let release; env.window.supabaseLoadReservations = () => new Promise(r => { release = () => r([]); });
    const p1 = env.handleOpsResvCreateSubmit();
    await new Promise(r => setImmediate(r));
    assert.equal(env._opsResvCreate.busy, true);
    assert.ok(/id="opsResvCreateSubmit" disabled/.test(env.body()) && env.body().includes('登録しています…'), '登録中にボタンが押せる');
    const p2 = env.handleOpsResvCreateSubmit();   // 二重押し
    release(); await Promise.all([p1, p2]);
    assert.equal(env.created.length, 1, '二重に作った');
    assert.equal(env._opsResvCreate.busy, false);
});

await test('★ Codex 9b: 置けるかは いまの盤面の凸数で (開いたときは 0 凸でも、取り直して 3 凸なら作らない) / 一部しか出られないブロックは押せない / 盤面が無ければ読んでから開く / 📌 が別の運営に外されていたら「📌 までは置けました」と言わない', async () => {
    const env = makeEnv();
    env._loadSnap = { season: { id: 44, metadata: {} }, bosses: env.opsStore.get().bosses, players: env.opsStore.get().players.map(p => p.id === 9 ? { ...p, attackCount: 3 } : p) };   // 開いたあとに 3 凸入った
    await env.openOpsResvCreate(9, 'fire', 1); env._opsResvCreateSet('blockIdx', 4);
    await env.handleOpsResvCreateSubmit();
    assert.equal(env.created.length, 0, '古い凸数 (0) で置けると判定した'); assert.ok(env.alerts.some(a => a.includes('登録できません')));
    // 一部しか出られないブロック (E は 18 時だけ) は押せない
    const env2 = makeEnv();
    await env2.openOpsResvCreate(12, 'fire', 1);
    assert.ok(/class="avail-blk" data-state="partial"[^>]*disabled[^>]*onclick="_opsResvCreateSet\('blockIdx', 3\)"/.test(env2.body()), '一部だけ出られるブロック (夕方) が押せる');
    assert.ok(env2.body().includes('一部 1/4時間 (不可)') && env2.body().includes('丸ごと ON にしてから'), '一部の案内が無い');
    // 盤面が無い (📸 の保存直後の invalidate) → 読んでから開く
    const env3 = makeEnv(); env3._boardNull = true;
    await env3.openOpsResvCreate(9, 'fire', 1);
    assert.equal(env3.loads, 1, '盤面が無いときに読み直していない'); assert.ok(env3.body().includes("_opsResvCreateSet('lo', 'fire|1')"), '盤面を読んだあとに開いていない'); assert.equal(env3.toasts.length, 0);
    // 確定に失敗 + 📌 は別の運営が外していた (released)
    const env4 = makeEnv(); env4._transitionOk = false; env4._releasedByOther = true;
    await env4.openOpsResvCreate(9, 'fire', 1); env4._opsResvCreateSet('blockIdx', 4);
    await env4.handleOpsResvCreateSubmit();
    assert.ok(env4.alerts.some(a => a.includes('別の運営が仮置きを外したか')) && !env4.alerts.some(a => a.includes('📌 までは置けました')), '外された 📌 を「残っている」と案内した: ' + JSON.stringify(env4.alerts));
    assert.equal(env4.resvLoads, 2, '確定に失敗したあと一覧を取り直していない (手元の _resv.rows は古いことがある)');
});

await test('★ Codex 9b 再監査: 盤面の取り直しの間に別の読み直しが走ったら (世代が進む) 1 回やり直す / 2 回とも動いていたら止める', async () => {
    const env = makeEnv(); env._raceOnce = true;
    await env.openOpsResvCreate(9, 'fire', 1); env._opsResvCreateSet('blockIdx', 4);
    await env.handleOpsResvCreateSubmit();
    assert.equal(env.loads, 2, '世代が進んでいたのにやり直していない'); assert.equal(env.created.length, 1, 'やり直して通るはず: ' + JSON.stringify(env.alerts));
    const env2 = makeEnv(); env2._raceAlways = true;
    await env2.openOpsResvCreate(9, 'fire', 1); env2._opsResvCreateSet('blockIdx', 4);
    await env2.handleOpsResvCreateSubmit();
    assert.equal(env2.created.length, 0, '盤面が動き続けているのに作った'); assert.ok(env2.alerts.some(a => a.includes('盤面が動いています')), '止めた理由が出ていない: ' + JSON.stringify(env2.alerts));
    assert.equal(env2.loads, 2, 'やり直しは 1 回だけ');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
