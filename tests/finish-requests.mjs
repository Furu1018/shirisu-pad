// ============================================================================
// 締め凸依頼の後片付け (_clearFinishRequestsFor) を index.html から切り出して実行テストする
// ----------------------------------------------------------------------------
// 第44回の実害: 「依頼中」「了承済み」がシーズン中ずっと残り、次のレベルの依頼と
// 見分けがつかなくなった。撃破・レベル進行で消すようにしたが、順序を間違えると
// 「通知は飛んだのに依頼が残る」「消したのに通知先が分からない」が起きる。
//
// ★ 守りたい契約:
//   1. 対象の確定 → 削除 → (実際に消せたときだけ) 活動ログ → 通知 の順。
//      ★ 削除より先にログを書くと、複数端末が同時検知したとき「2台が解除と記録したのに
//        消したのは1台」というログになる。実際に消せた端末だけが記録・通知する
//   2. 36 未適用 (skipped) では**何も消さない** — レベルで絞れないので別レベルを巻き込む
//   3. 通知は「了承した人」だけ (未返答の人は見ていない可能性が高い)
//   4. 消した内容は activity_log に残す (履歴テーブルを持たない代わり)
//   5. 失敗しても例外を投げない (撃破検知そのものを止めない)
// ============================================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const m = html.match(/\n        async function _clearFinishRequestsFor\([\s\S]*?\n        \}/);
if (!m) throw new Error('index.html から _clearFinishRequestsFor を切り出せませんでした (実装を変えたらこのテストも直す)');

let calls;
// order には呼ばれた順に名前を積む (ログ→削除→通知 の順序を検証するため)
let lastFound = null;
const makeApi = (findImpl, opts = {}) => {
    calls = { log: [], push: [], find: [], del: [], order: [] };
    lastFound = null;
    const win = {
        supabaseFindFinishRequestsToClear: async (seasonId, scope) => {
            calls.find.push({ seasonId, scope }); calls.order.push('find');
            const r = findImpl(seasonId, scope);
            lastFound = r.rows || null;
            return r;
        },
        supabaseLogActivityStrict: async (type, detail) => {
            calls.log.push({ type, detail }); calls.order.push('log');
            if (opts.logThrows) throw new Error('activity_log insert failed');
        },
        supabaseDeleteFinishRequests: async (ids) => {
            calls.del.push(ids); calls.order.push('delete');
            if (opts.deleteThrows) throw new Error('delete failed');
            // ★ 実装は「実際に消えた行」を返す。deletedRows で差し替えられるようにして、
            //   確定〜削除の間に status が変わったケースを再現する
            if (opts.deletedRows) return opts.deletedRows;
            return ids.map(id => {
                const r = (lastFound || []).find(x => x.id === id);
                return r ? { id, player_id: r.player_id, boss_number: r.boss_number, raid_level: r.raid_level, status: r.status } : null;
            }).filter(Boolean);
        },
        sendPushNotification: async (payload) => {
            calls.push.push(payload); calls.order.push('push');
            if (opts.pushThrows) throw new Error('push failed');
            return { sent: 1, target: 1 };
        },
    };
    return new Function('window', 'console', `${m[0]}\nreturn _clearFinishRequestsFor;`)(win, { warn() {} });
};

let passed = 0, failed = 0;
// ★ 逐次実行する。並行に走らせると makeApi が差し替える calls が混ざって、
//   別のテストの呼び出し回数を数えてしまう
const test = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const row = (id, name, status, boss = 3, lv = 2) =>
    ({ id, player_id: id * 10, name, status, boss_number: boss, raid_level: lv });

console.log('締め凸依頼の後片付け:');

await (async () => {

await test('了承した人にだけ解除を通知し、活動ログに全員を残す', async () => {
    const fn = makeApi(() => ({
        rows: [row(1, 'イオ', 'accepted'), row(2, 'TAC', 'pending'), row(3, 'ねむねこ', 'declined')],
        skipped: false,
    }));
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');
    assert.equal(calls.push.length, 1, '通知は1回');
    assert.deepEqual(calls.push[0].playerIds, [10], '了承した人だけ (未返答・不可には送らない)');
    assert.equal(calls.log.length, 1);
    assert.match(calls.log[0].detail, /モダニア/);
    assert.match(calls.log[0].detail, /3件/);
    assert.match(calls.log[0].detail, /イオ\(accepted\)/, '誰がどの返答だったかを残す');
    assert.match(calls.log[0].detail, /TAC\(pending\)/, '未返答の人も履歴には残す');
    assert.match(calls.log[0].detail, /Lv2B3/, 'どのレベルのどのボスか');
});

await test('★ 36未適用 (skipped) では何も消さず・何も送らない', async () => {
    // レベルで絞れない状態で消すと、別レベルの依頼まで巻き込む。
    // ★ removed に行が入っていても skipped が立っていたら無視すること —
    //   空配列だけで試すと「skipped を見ているか」を検出できない
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted')], skipped: true }));
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');
    assert.equal(calls.del.length, 0, '★ 削除しない (別レベルの依頼を巻き込むため)');
    assert.equal(calls.push.length, 0, '通知しない');
    assert.equal(calls.log.length, 0, '活動ログも書かない');
});

await test('★ 記録に失敗しても解除は成立させる (依頼は既に消えている)', async () => {
    // ログは監査用。書けなくても「消したのに依頼が残る」よりは良い。
    // ただし握り潰す supabaseLogActivity ではなく Strict 版を呼ぶこと (insert の error を見る)
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted')], skipped: false }), { logThrows: true });
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');   // 投げなければ合格
    assert.equal(calls.del.length, 1, '削除は済ませる');
    assert.equal(calls.push.length, 1, '通知も出す');
});

await test('消すものが無ければ通知もログも出さない', async () => {
    const fn = makeApi(() => ({ rows: [], skipped: false }));
    await fn(30, { belowLevel: 3 }, 'Lv2');
    assert.equal(calls.push.length, 0);
    assert.equal(calls.log.length, 0);
});

await test('了承者がいなければ通知は送らない (ログは残す)', async () => {
    const fn = makeApi(() => ({ rows: [row(1, 'TAC', 'pending')], skipped: false }));
    await fn(30, { bossNumber: 1, raidLevel: 1 }, 'レイタンス');
    assert.equal(calls.push.length, 0, '未返答だけなら通知しない');
    assert.equal(calls.log.length, 1, 'ログは残す');
});

await test('★ 対象の取得に失敗しても例外を投げない (撃破検知を止めない)', async () => {
    const fn = makeApi(() => { throw new Error('network'); });
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');   // 投げなければ合格
    assert.equal(calls.push.length, 0, '失敗したら通知もしない');
    assert.equal(calls.del.length, 0, '削除もしない');
});

await test('★ 通知が失敗しても例外を投げない (依頼は既に消えている)', async () => {
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted')], skipped: false }), { pushThrows: true });
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');   // 投げなければ合格
    assert.equal(calls.del.length, 1, '通知が失敗しても削除は済んでいる');
});

await test('★ 順序は 確定 → 削除 → ログ → 通知', async () => {
    // 削除より先にログを書くと、同時検知した全端末が「解除した」と記録してしまう
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted')], skipped: false }));
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');
    assert.deepEqual(calls.order, ['find', 'delete', 'log', 'push'], `順序: ${calls.order.join('→')}`);
});

await test('★ 削除に失敗したら通知しない (依頼はまだ有効)', async () => {
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted')], skipped: false }), { deleteThrows: true });
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');   // 投げなければ合格
    assert.equal(calls.push.length, 0, '消せていないのに「解除しました」と通知してはいけない');
});

await test('確定済みの id だけを削除に渡す (条件で消し直さない)', async () => {
    const fn = makeApi(() => ({ rows: [row(7, 'イオ', 'accepted'), row(9, 'TAC', 'pending')], skipped: false }));
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');
    assert.deepEqual(calls.del[0], [7, 9], '間に入った依頼を巻き込まないよう id 指定で消す');
});

await test('レベル進行では belowLevel でまとめて消す', async () => {
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted', 1, 1)], skipped: false }));
    await fn(30, { belowLevel: 2 }, 'Lv1');
    assert.deepEqual(calls.find[0].scope, { belowLevel: 2 });
});

// ---- 撃破とレベル開放が同時に起きたときの呼び分け --------------------------
// _checkRaidEvents は level に**新しい** current_level を持つ。レベルが上がった検知と
// 同時に撃破を個別クリアすると、倒れたのは旧レベルなのに新レベルの有効な依頼を消す
// (Codex指摘 2026-09-06)。呼び分けの条件そのものをソースから固定する
await test('★ 別の端末が先に消していたら (削除0件) 通知しない', async () => {
    // 複数端末が同時に検知すると、両方が同じ行を find してログまで進む。
    // 実際に消えた件数を見ないと、解除通知が同じ人に二重に飛ぶ
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'accepted')], skipped: false }), { deletedRows: [] });
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');
    assert.equal(calls.del.length, 1, '削除は試みる');
    assert.equal(calls.push.length, 0, '0件なら通知しない');
    assert.equal(calls.log.length, 0, '★ 0件ならログも書かない (二重に記録されるため)');
});

await test('★ 確定〜削除の間に本人が了承したら、削除時の status で通知する', async () => {
    // find した時点は pending でも、削除までの間に本人が了承することがある。
    // 確定した行をそのまま使うと「未返答」扱いで通知を飛ばさず、本人は解除に気づけない
    const fn = makeApi(() => ({ rows: [row(1, 'イオ', 'pending')], skipped: false }), {
        deletedRows: [{ id: 1, player_id: 10, boss_number: 3, raid_level: 2, status: 'accepted' }],
    });
    await fn(30, { bossNumber: 3, raidLevel: 2 }, 'モダニア');
    assert.equal(calls.push.length, 1, '削除時点で accepted なら通知する');
    assert.deepEqual(calls.push[0].playerIds, [10]);
    assert.match(calls.log[0].detail, /accepted/, 'ログも削除時の状態で書く');
});

await test('★ レベル開放時に「いま倒れているボス」の新レベル依頼を消さない', () => {
    // 撃破判定は残HP0かどうかだけ。運営がボスHPを1体ずつ手で更新すると、
    // 旧レベルのHP0のまま残っているボスを新レベルの撃破と誤認する (Codex指摘)。
    // 誤削除 (有効な依頼が消える) は取り残し (古い依頼が見える) より害が大きい
    const openBlock = html.match(/\/\/ ② レベル開放[\s\S]*?const ref = `L\$\{ev\.levelOpened\}`/);
    assert.ok(openBlock, 'レベル開放ブロックを切り出せませんでした');
    assert.doesNotMatch(openBlock[0], /for \(const bn of cur\.dead\)/,
        'cur.dead を回して個別クリアしてはいけない (手動HP更新で誤認する)');
    assert.match(openBlock[0], /belowLevel: ev\.levelOpened/, '旧レベルの一括クリアはすること');
});

await test('★ レベル開放と同時の撃破では、個別クリアを呼ばない', () => {
    const body = html.match(/\n                for \(const bn of ev\.defeated\) \{[\s\S]*?\n                \}/);
    assert.ok(body, '撃破ループを切り出せませんでした');
    assert.match(body[0], /if \(!levelJustOpened\) \{[\s\S]*?_clearFinishRequestsFor/,
        '撃破ループ内の個別クリアは levelJustOpened で守ること');
    assert.match(html, /const levelJustOpened = ev\.levelOpened != null;/,
        'levelJustOpened は「レベルが上がった検知と同時か」で決めること');
    // レベル開放側では belowLevel でまとめて消す
    assert.match(html, /_clearFinishRequestsFor\(cur\.seasonId, \{ belowLevel: ev\.levelOpened \}/,
        'レベル開放時は belowLevel でまとめて消すこと');
});

await test('関数が無い環境では何もしない', async () => {
    const fn = new Function('window', 'console', `${m[0]}\nreturn _clearFinishRequestsFor;`)({}, { warn() {} });
    await fn(30, { bossNumber: 1, raidLevel: 1 }, 'レイタンス');   // 投げなければ合格
});

})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
