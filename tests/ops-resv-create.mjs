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
    cut('        function openOpsResvCreate('),
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
        { id: 9, name: 'B', attackCount: 0, availableSlots: ['h18', 'h19', 'h20', 'h21'], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 30, team: ['a', 'b', 'c', 'd', 'e'] }, { slot: 2, dmgB: 25, team: ['f', 'g', 'h', 'i', 'j'] }], water: [{ slot: 1, dmgB: 20, team: ['k', 'l', 'm', 'n', 'o'] }], wind: [{ slot: 1, dmgB: 10, team: [] }] } },
        { id: 10, name: 'C', attackCount: 3, availableSlots: [], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 40, team: ['p', 'q', 'r', 's', 't'] }] } },
        { id: 11, name: 'D', attackCount: 0, availableSlots: ['h05'], unavailableThisSeason: true, loadoutsByAttr: {} },
    ];
    const bosses = [{ boss_number: 1, name: 'ボス1', weakness: 'fire', remaining_hp_raw: 10e9 }, { boss_number: 2, name: 'ボス2', weakness: 'water', remaining_hp_raw: 0 }];   // 風圧のボスは無い
    const env = {
        _opsResvCreate: { playerId: null, attr: null, slot: null, blockIdx: null, busy: false },
        _resv: { rows: o.rows || [] },
        _opsLastPlan: null,
        opsStore: { get: () => ({ season: { id: 44, metadata: {} }, players, bosses }) },
        weaknessPtOf: (b) => b.weakness,
        PT_ATTRS, SLOT_JP: { 1: '①', 2: '②' },
        escapeHtml: (x) => String(x),
        document: { getElementById: el },
        getCurrentIdentity: () => ({ id: 7, name: 'O' }),
        showNotification: (m) => { env.toasts.push(m); }, alert: (m) => { env.alerts.push(m); }, confirm: () => env._confirm,
        computeAndRenderOptimalPlan: () => { env.recomputed++; },
        window: {
            raidBlocksDomain: globalThis.raidBlocksDomain, reservationsDomain: globalThis.reservationsDomain,
            supabaseLoadReservations: async () => env._resv.rows.slice(),
            supabaseCreateReservation: async (row) => { const r = { id: 500 + created.length + 1, status: row.status, player_id: row.playerId, boss_number: row.bossNumber, loadout_slot: row.loadoutSlot, time_mode: row.block ? 'block' : 'fixed', block_from: row.block?.from ?? null, block_to: row.block?.to ?? null, characters_snapshot: row.characters, pinned_by: row.pinnedBy, player_name: 'B' }; created.push({ ...row }); return r; },
            supabaseLogActivity: (type, detail, opts) => { logs.push({ type, detail, opts }); },
        },
        _resvTransition: async (id, to, opts) => { transitions.push({ id, to, ...opts }); const r = env._resv.rows.find(x => Number(x.id) === Number(id)); if (r) r.status = to; return env._transitionOk; },
        _notifyMemberResv: (row, title, body) => { notices.push({ playerId: row.player_id, title, body }); },
        created, transitions, notices, logs, toasts: [], alerts: [], recomputed: 0, _confirm: true, _transitionOk: true,
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
    env.openOpsResvCreate();
    assert.ok(env.body().includes('<option value="9"') && env.body().includes('<option value="10"') && !env.body().includes('<option value="11"'), '人の候補 (今回は難しい D を除く)');
    env._opsResvCreateSet('playerId', '9');
    const b = env.body();
    assert.ok(b.includes("_opsResvCreateSet('lo', 'fire|1')") && b.includes("_opsResvCreateSet('lo', 'fire|2')") && b.includes("_opsResvCreateSet('lo', 'water|1')"), '編成の候補が無い');
    assert.ok(!b.includes("'wind|1'"), '対応するボスが無い属性 (風圧) を候補に出した');
    assert.ok(b.includes('→ B1 ボス1') && b.includes('→ B2 ボス2 (いまのレベルでは倒れています)'), '行き先のボスと「倒れている」の注記');
    const chips = [...b.matchAll(/class="avail-blk" data-state="(on|off)"[^>]*onclick="_opsResvCreateSet\('blockIdx', (\d)\)"/g)].map(m => [Number(m[2]), m[1]]);
    assert.deepEqual(chips.filter(c => c[1] === 'on').map(c => c[0]), [4, 5], '出られるブロック (夕方 18〜20・夜 21〜23) だけ押せる');
    assert.ok(/data-state="off"[^>]*disabled/.test(b), '出られないブロックが押せる');
    assert.ok(/id="opsResvCreateSubmit" disabled/.test(b), '選び終える前に登録ボタンが押せる');
    env._opsResvCreateSet('lo', 'fire|2'); env._opsResvCreateSet('blockIdx', 4);
    assert.ok(env.body().includes('B さん: 夕方 18〜20時 のどこかで 灼熱PT 編成② → B1') && !/id="opsResvCreateSubmit" disabled/.test(env.body()), '要約と登録ボタン');
});

await test('★ 登録 = いまの予約で canPin → 📌 (pinned・ブロック・編成のキャラ・pinnedBy) → すぐ 🔒 確定 (ops_registered) → 本人に通知 → 閉じる', async () => {
    const env = makeEnv();
    env.openOpsResvCreate(9, 'fire', 2);            // 📸 の保存直後から (人・編成が入っている)
    assert.ok(env.body().includes('aria-pressed="true"'), '📸 から開いたときに編成が選ばれていない');
    env._opsResvCreateSet('blockIdx', 5);
    await env.handleOpsResvCreateSubmit();
    assert.equal(env.created.length, 1, '予約を作っていない: ' + JSON.stringify(env.alerts));
    const c = env.created[0];
    assert.equal(c.status, 'pinned'); assert.equal(c.pinnedBy, 'O'); assert.equal(c.playerId, 9); assert.equal(c.bossNumber, 1); assert.equal(c.loadoutSlot, 2);
    assert.deepEqual(c.block, { from: 21, to: 23 }, 'ブロックが入っていない'); assert.deepEqual(c.characters, ['f', 'g', 'h', 'i', 'j'], '編成のキャラが入っていない'); assert.equal(c.expectedDamageB, 25);
    assert.deepEqual(env.transitions.map(t => [t.id, t.to, t.expectFrom, t.reason]), [[501, 'approved', 'pinned', 'ops_registered']], '📌 → 🔒 確定 の遷移');
    assert.deepEqual(env.notices.map(n => [n.playerId, n.title]), [[9, '🔒 運営があなたの予約を登録しました']], '本人への通知');
    assert.ok(env.notices[0].body.includes('ボス1 21〜23時のどこか 編成②'), '通知の中身: ' + env.notices[0].body);
    assert.ok(env.logs.some(l => l.detail.includes('運営が代理で登録') && l.opts.actorName === 'O'), '活動ログ');
    assert.equal(env.alerts.length, 0);
});

await test('★ 置けないとき (3 凸済み) は作らない / キャンセルなら何もしない / 遷移に失敗したら知らせる', async () => {
    const env = makeEnv();
    env.openOpsResvCreate(10, 'fire', 1); env._opsResvCreateSet('blockIdx', 0);   // C は 3 凸済み (ブロックは出られないが、ここでは canPin を見る)
    env._opsResvCreate.blockIdx = 0;   // 出られないブロックは画面では押せないので直接入れる
    await env.handleOpsResvCreateSubmit();
    assert.equal(env.created.length, 0, '3 凸済みの人に予約を作った');
    assert.ok(env.alerts.some(a => a.includes('登録できません')), '理由を知らせていない: ' + JSON.stringify(env.alerts));
    const env2 = makeEnv(); env2._confirm = false;
    env2.openOpsResvCreate(9, 'fire', 1); env2._opsResvCreateSet('blockIdx', 4);
    await env2.handleOpsResvCreateSubmit();
    assert.equal(env2.created.length, 0, 'キャンセルしたのに作った');
    const env3 = makeEnv(); env3._transitionOk = false;
    env3.openOpsResvCreate(9, 'fire', 1); env3._opsResvCreateSet('blockIdx', 4);
    await env3.handleOpsResvCreateSubmit();
    assert.equal(env3.created.length, 1); assert.equal(env3.notices.length, 0, '確定できていないのに通知した');
    assert.ok(env3.alerts.some(a => a.includes('仮置き (📌) までは置けました')), '確定の失敗を知らせていない');
});

await test('★ 登録中は二重に押せない (busy) / 既にある予約を一覧に出す', async () => {
    const env = makeEnv({ rows: [{ id: 1, player_id: 9, status: 'approved', boss_number: 2, loadout_slot: 1, time_mode: 'block', block_from: 18, block_to: 20 }] });
    env.openOpsResvCreate(9, 'fire', 1); env._opsResvCreateSet('blockIdx', 4);
    assert.ok(env.body().includes('いまの予約・仮置き: ') && env.body().includes('ボス2 18〜20時のどこか 編成①'), '既にある予約が出ていない');
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
