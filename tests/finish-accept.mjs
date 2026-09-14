// ============================================================================
// 締め凸の了承 (handleMyFinishRequestRespond / _reserveForFinishRequest) の実行テスト
//   node tests/finish-accept.mjs
// ----------------------------------------------------------------------------
// 全体監査 2026-09-14 #2: これまでは「伝えてから予約」で、予約が作れなくても accepted が残った。
// その accepted は予約の指紋にも planDiff にも現れず、配信プランが了承を知らないまま 3 凸を配っていた。
// また approved を直接 INSERT していて、📌 が 3 件ある人にも 4 件目の固定ができた。
//
// ★ 守りたい契約:
//   1. 了承は **枠を取ってから** 伝える (順序: 予約を読む → canApprove → 作る → 伝える)
//   2. 枠が無い (約束 + 📌 + 実凸 ≥ 3) なら**了承しない** (accepted を残さない・作らない)
//   3. 伝えられなかった (返答済み・解除済み) なら取った枠を返す (approved だけ残さない)
//   4. 同じボスに生きている予約があれば作らない / 39 未適用なら作らずに了承だけ成立 (従来どおり)
//   5. 「難しい」は予約を読みも作りもしない
// index.html 側のシグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../js/domain/reservations.js';   // globalThis.reservationsDomain (本物の canApprove を通す)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const cut = (name) => {
    const m = html.match(new RegExp(`\\n        async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n        \\}`));
    if (!m) throw new Error(`index.html から ${name} を切り出せませんでした (実装を変えたらこのテストも直す)`);
    return m[0];
};
const SRC = cut('_reserveForFinishRequest') + cut('handleMyFinishRequestRespond');

// 依存を api で差し替えて実行する
const build = (opts = {}) => {
    const calls = { order: [], create: [], respond: [], setStatus: [], notif: [], log: [] };
    const mine = opts.mine === undefined ? [] : opts.mine;
    const api = {
        getCurrentIdentity: () => ({ id: 7, name: 'ふるり' }),
        ensureActiveSeasonLoaded: async () => ({ season: { id: 1, current_level: 2, hard_date: '2026-09-14' }, bosses: [{ boss_number: 3, weakness: 'fire' }] }),
        _myBestLoadoutFor: async () => ({ slot: 1, characters: ['ラピ', 'アニス'], dmgB: 12 }),
        renderMyReservations: () => { calls.order.push('renderResv'); },
        _refreshFinishRequests: async () => { calls.order.push('refresh'); },
        _notifyOps: () => { calls.order.push('notifyOps'); },
        renderMyFinishRequestBanner: () => {},
        showNotification: (m) => { calls.notif.push(m); },
        window: {
            reservationsDomain: globalThis.reservationsDomain,
            supabaseLoadMyReservations: async () => { calls.order.push('load'); if (opts.loadThrows) throw new Error('network'); return mine; },
            supabaseLoadMyAttacks: async () => opts.attacks || [],
            supabaseCreateReservation: async (o) => { calls.order.push('create'); calls.create.push(o); if (opts.createThrows) throw new Error(opts.createThrows); return { id: 99, ...o, status: 'approved' }; },
            supabaseRespondFinishRequest: async (...a) => { calls.order.push('respond'); calls.respond.push(a); if (opts.respondThrows) throw new Error(opts.respondThrows); return 1; },
            supabaseSetReservationStatus: async (id, to, o) => { calls.order.push('setStatus'); calls.setStatus.push({ id, to, ...o }); if (opts.setStatusThrows) throw new Error('network'); return {}; },
            supabaseLogActivity: async (...a) => { calls.order.push('log'); calls.log.push(a); },
        },
    };
    const fn = new Function('api', 'console', `
        const { getCurrentIdentity, ensureActiveSeasonLoaded, _myBestLoadoutFor, renderMyReservations, _refreshFinishRequests, _notifyOps, renderMyFinishRequestBanner, showNotification, window } = api;
        ${SRC}
        return handleMyFinishRequestRespond;`)(api, { warn() {}, log() {} });
    return { fn, calls };
};
const P = (id, status, boss, slot = 1) => ({ id, player_id: 7, status, boss_number: boss, loadout_slot: slot, characters_snapshot: [] });

let passed = 0, failed = 0;
const test = async (name, f) => {
    try { await f(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};

await test('了承: 予約を読む → 作る → 伝える の順 (伝えてから作らない)。予約に依頼の id と finish_request を残す', async () => {
    const { fn, calls } = build({ mine: [] });
    await fn(3, 'accepted', 55);
    assert.deepEqual(calls.order.slice(0, 3), ['load', 'create', 'respond'], `順序が違う: ${calls.order.join(' → ')}`);
    assert.equal(calls.create[0].status, 'approved');
    assert.equal(calls.create[0].sourceType, 'finish_request');
    assert.equal(calls.create[0].sourceFinishRequestId, 55, '依頼の id を予約に残していない');
    assert.equal(calls.create[0].bossNumber, 3);
    assert.deepEqual(calls.respond[0].slice(0, 4), [1, 3, 7, 'accepted']);
    assert.ok(calls.order.includes('renderResv'), '作ったのに本人の予約を描き直していない');
    assert.equal(calls.setStatus.length, 0, '成功したのに枠を返している');
});
await test('★ 📌 が 3 件ある人は了承できない: 作らない・伝えない・accepted を残さない (監査 #2)', async () => {
    const { fn, calls } = build({ mine: [P(1, 'pinned', 1), P(2, 'pinned', 2), P(4, 'pinned', 4)] });
    await fn(3, 'accepted', 55);
    assert.equal(calls.create.length, 0, '4 件目の固定を作っている');
    assert.equal(calls.respond.length, 0, '枠が無いのに accepted を伝えている (指紋にも planDiff にも出ない了承が残る)');
    assert.ok(calls.notif.some(m => /了承できません/.test(m)), `本人に理由を出していない: ${calls.notif.join(' / ')}`);
    assert.ok(calls.notif.some(m => /📌/.test(m)), '📌 が原因だと分からない');
});
await test('★ 約束 2 件 + 実凸 1 件 = 3 → 了承できない (実凸を数える)', async () => {
    const { fn, calls } = build({ mine: [P(1, 'approved', 1), P(2, 'approved', 2)], attacks: [{ id: 1 }] });
    await fn(3, 'accepted', 55);
    assert.equal(calls.create.length, 0); assert.equal(calls.respond.length, 0);
});
await test('約束 2 件 + 実凸 0 → 3 件目として了承できる', async () => {
    const { fn, calls } = build({ mine: [P(1, 'approved', 1), P(2, 'approved', 2)] });
    await fn(3, 'accepted', 55);
    assert.equal(calls.create.length, 1); assert.equal(calls.respond.length, 1);
});
await test('★ 伝えられなかった (返答済み・解除済み) → 取った枠を返す (approved だけ残さない) (監査 #3 #5)', async () => {
    const { fn, calls } = build({ mine: [], respondThrows: 'この締め凸依頼はすでに返答済みか、解除されています' });
    await fn(3, 'accepted', 55);
    assert.deepEqual(calls.order.slice(0, 4), ['load', 'create', 'respond', 'setStatus'], calls.order.join(' → '));
    assert.equal(calls.setStatus[0].id, 99); assert.equal(calls.setStatus[0].to, 'released');
    assert.equal(calls.setStatus[0].expectFrom, 'approved'); assert.equal(calls.setStatus[0].reason, 'finish_request_gone');
    assert.ok(calls.notif.some(m => /送信失敗/.test(m)), '失敗を本人に出していない');
});
await test('同じボスに生きている予約があれば作らない (了承は伝える)', async () => {
    const { fn, calls } = build({ mine: [P(1, 'requested', 3)] });
    await fn(3, 'accepted', 55);
    assert.equal(calls.create.length, 0); assert.equal(calls.respond.length, 1);
    assert.equal(calls.setStatus.length, 0);
});
await test('39 未適用 (予約が null) → 作らずに了承だけ成立 (従来どおり)', async () => {
    const { fn, calls } = build({ mine: null });
    await fn(3, 'accepted', 55);
    assert.equal(calls.create.length, 0); assert.equal(calls.respond.length, 1);
});
await test('予約を読めなかった (通信断) → 了承しない (accepted だけ先に届く状態を作らない)', async () => {
    const { fn, calls } = build({ loadThrows: true });
    await fn(3, 'accepted', 55);
    assert.equal(calls.create.length, 0); assert.equal(calls.respond.length, 0);
    assert.ok(calls.notif.some(m => /了承できません/.test(m)));
});
await test('DB が拒否した (SQL 47: 約束が残凸を超える) → 了承しない・文言を出す', async () => {
    const { fn, calls } = build({ mine: [], createThrows: '残りの凸数を超える約束はできません (📌 の固定を外してから承認してください)' });
    await fn(3, 'accepted', 55);
    assert.equal(calls.respond.length, 0, 'DB に弾かれたのに accepted を伝えている');
    assert.ok(calls.notif.some(m => /📌/.test(m)));
});
await test('「難しい」は予約を読みも作りもしない', async () => {
    const { fn, calls } = build({ mine: [P(1, 'pinned', 1), P(2, 'pinned', 2), P(4, 'pinned', 4)] });
    await fn(3, 'declined', 55);
    assert.deepEqual(calls.order.filter(x => x === 'load' || x === 'create'), []);
    assert.equal(calls.respond.length, 1); assert.equal(calls.respond[0][3], 'declined');
});

await test('★ 枠を返せなかった (通信断が続く) → 1 回やり直し、それでもだめなら本人に予約 id を出し activity_log に残す (握りつぶさない)', async () => {
    const { fn, calls } = build({ mine: [], respondThrows: 'すでに返答済み', setStatusThrows: true });
    await fn(3, 'accepted', 55);
    assert.equal(calls.setStatus.length, 2, `やり直していない (${calls.setStatus.length} 回)`);
    assert.ok(calls.notif.some(m => /#99/.test(m) && /運営/.test(m)), `予約 id つきで本人に知らせていない: ${calls.notif.join(' / ')}`);
    assert.equal(calls.log.length, 1, 'activity_log に残していない (運営が気づけない)');
    assert.match(String(calls.log[0][1]), /#99/);
});
await test('枠を返せた (1 回目で成功) → やり直さない・警告しない', async () => {
    const { fn, calls } = build({ mine: [], respondThrows: 'すでに返答済み' });
    await fn(3, 'accepted', 55);
    assert.equal(calls.setStatus.length, 1);
    assert.equal(calls.log.length, 0);
    assert.ok(!calls.notif.some(m => /運営に外して/.test(m)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
