// ============================================================================
// 戦闘可能時間の保存キュー + 今期の確認 の実行テスト
//   node tests/avail-save.mjs
// ----------------------------------------------------------------------------
// index.html から _availEnqueue / _availDoSave / handleConfirmAvailability を切り出し、
// 保存を **遅延させられるスタブ** に差し替えて実際に走らせる。
//
// なぜ実行テストが要るか (Codex指摘 2026-09-07):
//   ソース文字列の検査 (「_availSaveChain.then が書いてあるか」) は、
//   「実際に前の保存の完了を待っているか」「rethrow が呼び出し元に届くか」を保証しない。
//   ここで守るのは次の3つ:
//     1. 自動保存が通信中に確認を押しても、**古い保存が後から着地して巻き戻らない**
//     2. 保存が失敗してもキューが詰まらない (次の保存は必ず走る)
//     3. 確認の二重クリックで確認レコードが2回書かれない
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/raidBlocks.js';   // globalThis.raidBlocksDomain (🧱 凸数の詰め直し)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---- 切り出し (波括弧の対応で終端を決める。目印方式は間に関数を足すと壊れる) ----
// ⚠ 本体の `{` から数え始めること。引数のデフォルト値 (`opts = {}`) を本体と誤認すると
//   1行だけ切り出して「Unexpected token」になる
function cut(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} を index.html から切り出せませんでした (目印が変わった?)`); process.exit(2); }
    // 引数リストの `)` を対応で探し、その後ろの `{` を本体の開始とする
    let paren = 0, bodyStart = -1;
    for (let k = html.indexOf('(', i); k < html.length; k++) {
        if (html[k] === '(') paren++;
        else if (html[k] === ')') { paren--; if (paren === 0) { bodyStart = html.indexOf('{', k); break; } }
    }
    if (bodyStart < 0) { console.error(`NG: ${marker} の引数リストを判定できませんでした`); process.exit(2); }
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
    // index.html 側で関数の外に置いてある状態 (キューと二重クリックよけ)
    'let _availSaveChain = Promise.resolve();',
    'let _availConfirmBusy = false;',
    cut('        function _availEnqueue('),
    cut('        function _availDoSave('),
    cut('        function _availConfirmSetBusy('),
    // ★ 再描画も**実装のもの**を使う。スタブに置き換えると「再描画のあとに busy を貼り直すか」を
    //   テスト側の作り物で確かめることになり、実装の保証にならない
    cut('        function _renderMyAvailConfirmBadge('),
    cut('        function _renderMyAvailConfirm('),
    cut('        async function handleConfirmAvailability('),
    cut('        function _availTarget('),   // 🗣 9a: 誰のぶんか (forPlayer か本人)
].join('\n');

// ---- 依存スタブ ------------------------------------------------------------
const HOUR_ORDER = Array.from({ length: 24 }, (_, i) => i);
const _hourKey = (h) => `h${String(h).padStart(2, '0')}`;

let log = [];                 // 実際にサーバへ着地した順の記録
let saved = null;             // availability の最終状態 (最後に着地した保存)
let confirmRows = [];         // availability_confirmations への書き込み
let saveGate = null;          // 保存を止めておくためのフック
let saveTargets = [];         // 🗣 9a: 保存に渡された相手 (opts.target) の id

// innerHTML を代入するとボタン要素が作り直される箱 (実物と同じ挙動)。
// querySelectorAll('button') は「その瞬間の」ボタンを返す
function makeBox() {
    let buttons = [], html = '';
    return {
        style: {}, _buttons: () => buttons, _html: () => html,
        set innerHTML(v) {
            html = String(v);
            buttons = [...html.matchAll(/<button\b/g)].map(() => ({ disabled: false, style: {} }));
        },
        get innerHTML() { return ''; },
        querySelectorAll: () => buttons,
    };
}

function makeEnv() {
    log = []; saved = null; confirmRows = []; saveGate = null; saveTargets = [];
    const box = makeBox();
    const env = {
        HOUR_ORDER, _hourKey,
        _availUI: { slots: new Array(24).fill(false), saveTimer: null, counts: null },
        clearTimeout: () => { },
        getCurrentIdentity: () => ({ id: 7, name: 'me' }),
        ensureActiveSeasonLoaded: async () => ({ season: { id: 44 } }),
        opsStore: { invalidate() { } },
        escapeHtml: (x) => String(x),
        document: {
            getElementById: (id) => id === 'myAvailConfirmBox' ? box
                : id === 'myAvailConfirmBadge' ? { style: {}, textContent: '' }
                : { style: {}, textContent: '' },
        },
        box,
        window: {
            supabaseConfirmAvailability: async (seasonId, playerId, opt) => {
                confirmRows.push({ seasonId, playerId, ...opt });
                log.push(`confirm(${opt.unavailable ? 'NG' : opt.slots.join('|')})`);
                return env._confirmResult;   // 53 未適用なら { blockCountsDropped: true }
            },
            raidBlocksDomain: globalThis.raidBlocksDomain,
        },
        _confirmResult: undefined,
        _myAvailConfirm: null,
        // 保存の実体スタブ。実装と同じく **走り出した時点の** slots を読み、
        // 通信 (gate) を挟んでから着地し、**実際に載せた slots を返す**。
        // ★ 戻り値は確認スナップショットの正 — 契約が変わったらここも直すこと
        async _availDoSaveInner(opts = {}) {
            saveTargets.push(opts.target ? opts.target.id : null);   // 🗣 9a: 相手が渡っているか
            const slots = HOUR_ORDER.map((h, i) => env._availUI.slots[i] ? _hourKey(h) : null).filter(Boolean);
            const tag = slots.join('|') || '(空)';
            if (saveGate) { const g = saveGate; saveGate = null; await g.promise; }
            if (env._failNextSave) { env._failNextSave = false; log.push(`save(${tag}) 失敗`); if (opts.rethrow) throw new Error('通信断'); return null; }
            saved = slots; log.push(`save(${tag})`);
            env._renderMyAvailConfirm?.();   // 実装は保存成功のたびに再描画する
            return slots;
        },
        _failNextSave: false,
    };
    // 切り出したコードを env のスコープで評価し、必要な関数を取り出す
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn { _availEnqueue, _availDoSave, _availConfirmSetBusy, _renderMyAvailConfirm,`
        + ` handleConfirmAvailability, _myAvailConfirmRef: () => _myAvailConfirm };`);
    return Object.assign(env, fn(...keys.map(k => env[k])));
}

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// キューに積んだ関数が走り出す (= その時点の slots を読む) まで進める。
// ★ 積んだ直後は .then のマイクロタスク待ちでまだ何も読んでいない
const tick = () => new Promise(r => setImmediate(r));
const setSlots = (env, hours) => { env._availUI.slots = new Array(24).fill(false); hours.forEach(h => { env._availUI.slots[h] = true; }); };

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log('参加可能時間の保存キュー:\n');

await test('★ 自動保存が通信中でも、後から押した確認の内容が最後に残る (巻き戻らない)', async () => {
    const env = makeEnv();
    setSlots(env, [21]);
    const gate = defer(); saveGate = gate;      // 自動保存Aを通信中で止める
    const autoSave = env._availDoSave();        // A: h21 を送信
    await tick();                               // Aが走り出し、h21 を読んで通信中になる
    setSlots(env, [22]);                        // 本人が時間を h22 に変更して…
    const confirm = env.handleConfirmAvailability(false);   // …確認を押す
    gate.resolve();                             // Aの通信がここでようやく完了
    await Promise.all([autoSave, confirm]);
    assert.deepEqual(saved, ['h22'], `最後に着地した保存が h22 でない (${JSON.stringify(saved)})`);
    assert.deepEqual(confirmRows[0].slots, ['h22'], '確認のスナップショットが h22 でない');
    assert.deepEqual(log, ['save(h21)', 'save(h22)', 'confirm(h22)'], `着地順が違う: ${log.join(' → ')}`);
});

await test('★ 確認の書き込みは自分の保存の直後に来る (間に自動保存が割り込まない)', async () => {
    const env = makeEnv();
    setSlots(env, [21]);
    const gate = defer(); saveGate = gate;
    const first = env._availDoSave();                        // 先行する自動保存 (通信中)
    await tick();
    setSlots(env, [22]);
    const confirm = env.handleConfirmAvailability(false);    // 確認 (保存+書き込みで1単位)
    await tick();
    setSlots(env, [23]);
    const later = env._availDoSave();                        // 確認の後にもう一度なぞった
    gate.resolve();
    await Promise.all([first, confirm, later]);
    const j = log.findIndex(x => x.startsWith('confirm'));
    assert.ok(j > 0, `確認が記録されていない: ${log.join(' → ')}`);
    // 守りたいのは「確認したスナップショット == サーバに載っている availability」。
    // キューの中で保存と書き込みが隣り合っていれば、間に自動保存が割り込めない
    const snap = confirmRows[0].slots.join('|');
    assert.equal(log[j - 1], `save(${snap})`, `確認の直前が自分の保存でない (間に割り込まれた): ${log.join(' → ')}`);
    assert.deepEqual(saved, confirmRows[0].slots, '確認した内容とサーバの availability がずれている');
    assert.equal(log[log.length - 1], 'save(h23)', `後からの自動保存が最後に来ていない: ${log.join(' → ')}`);
});

await test('★ 🗣 9a 運営が本人の代わりに登録: 確認と保存は forPlayer の人に書き、活動ログ用に actorName を渡す / 本人のときは actorName なし', async () => {
    const env = makeEnv();
    env._availUI.forPlayer = { id: 9, name: 'B' };   // 運営 (id 7) が B さん (id 9) のぶんを開いている
    setSlots(env, [21]);
    await env.handleConfirmAvailability(false);
    assert.equal(confirmRows[0].playerId, 9, `確認を名乗っている本人 (7) に書いた: ${JSON.stringify(confirmRows[0])}`);
    assert.equal(confirmRows[0].actorName, 'me', '運営が代理で登録した印 (actorName) が無い');
    assert.deepEqual(saveTargets, [9], `確認の保存に相手 (9) が渡っていない: ${JSON.stringify(saveTargets)}`);
    // 本人のとき
    const env2 = makeEnv();
    setSlots(env2, [21]);
    await env2.handleConfirmAvailability(false);
    assert.equal(confirmRows[0].playerId, 7); assert.equal(confirmRows[0].actorName, null, '本人の確認に actorName が付いている');
    assert.deepEqual(saveTargets, [7]);
    // 保存のデバウンスから来た相手も通す
    await env2._availDoSave({ target: { id: 9 } });
    assert.deepEqual(saveTargets, [7, 9], '_availDoSave の opts.target が _availDoSaveInner に渡っていない');
});

await test('★ 確認の保存中に時間を変えても、記録は「実際に保存した内容」と一致する', async () => {
    // Codex指摘 2026-09-07: 保存の後で _availUI.slots を読み直すと、
    // availability は h21 なのに確認済みの記録は h22 という状態が残る
    const env = makeEnv();
    setSlots(env, [21]);
    const gate = defer(); saveGate = gate;
    const p = env.handleConfirmAvailability(false);
    await tick();                       // 確認の保存が走り出し、h21 を読んで通信中になる
    setSlots(env, [22]);                // 通信中に本人が時間を変えた
    gate.resolve(); await p;
    assert.deepEqual(saved, ['h21'], 'サーバに載ったのは h21 のはず');
    assert.deepEqual(confirmRows[0].slots, ['h21'], `確認の記録が保存内容とずれている (${JSON.stringify(confirmRows[0].slots)})`);
    assert.equal(confirmRows[0].slotCount, 1);
    assert.deepEqual(env._myAvailConfirmRef().slots_snapshot, ['h21'], '画面側の記録もずれてはいけない');
});

await test('保存が失敗してもキューは詰まらない (次の保存は走る)', async () => {
    const env = makeEnv();
    setSlots(env, [21]); env._failNextSave = true;
    await env._availDoSave();                   // rethrow なしなので投げない
    setSlots(env, [22]);
    await env._availDoSave();
    assert.deepEqual(saved, ['h22'], '失敗のあとの保存が着地していない');
    assert.deepEqual(log, ['save(h21) 失敗', 'save(h22)']);
});

await test('★ 保存に失敗したら確認レコードを書かない (rethrow が呼び出し元に届く)', async () => {
    const env = makeEnv();
    setSlots(env, [21]); env._failNextSave = true;
    await env.handleConfirmAvailability(false);
    assert.equal(confirmRows.length, 0, '保存が失敗したのに確認だけ書かれた (古い時間帯のまま確認済みになる)');
    assert.equal(env._myAvailConfirmRef(), null, '画面側の状態も更新しない');
});

await test('★ 二重クリックしても確認は1回だけ書かれる', async () => {
    const env = makeEnv();
    setSlots(env, [21]);
    const gate = defer(); saveGate = gate;
    const a = env.handleConfirmAvailability(false);
    await tick();
    const b = env.handleConfirmAvailability(true);    // 処理中に「今回は難しい」を連打
    gate.resolve();
    await Promise.all([a, b]);
    assert.equal(confirmRows.length, 1, `確認が ${confirmRows.length} 回書かれた`);
    assert.equal(confirmRows[0].unavailable, false, '後から押した方が勝ってはいけない (押した1回だけを通す)');
});

await test('処理中はボタンを押せなくする / 終わったら戻す', async () => {
    const env = makeEnv();
    setSlots(env, [21]);
    const gate = defer(); saveGate = gate;
    const p = env.handleConfirmAvailability(false);
    await tick();
    assert.ok(env.box._buttons().every(b => b.disabled), '処理中にボタンが押せる');
    gate.resolve(); await p;
    assert.ok(env.box._buttons().every(b => !b.disabled), '終わってもボタンが戻らない');
});

await test('★ 保存中に確認ブロックが再描画されてもボタンは押せないまま', async () => {
    // _availDoSaveInner は保存成功のたびに _renderMyAvailConfirm を呼ぶ = ボタンが作り直される。
    // 貼り直しを忘れると「処理中なのに押せる」状態に戻る
    const env = makeEnv();
    setSlots(env, [21]);
    const gate = defer(); saveGate = gate;
    const p = env.handleConfirmAvailability(false);
    await tick();
    env._renderMyAvailConfirm();          // 実装の再描画 (保存成功時に _availDoSaveInner が呼ぶのと同じ)
    assert.ok(env.box._buttons().length > 0, '再描画でボタンが作られていない (テストの前提が崩れた)');
    assert.ok(env.box._buttons().every(b => b.disabled), '作り直されたボタンが押せる状態に戻っている');
    gate.resolve(); await p;
    assert.ok(env.box._buttons().every(b => !b.disabled), '終わってもボタンが戻らない');

    // ★ 確認ブロックには「未確認」と「確認済み」の2つの描画分岐がある。
    //   1回確認したあとは「確認済み」側が描かれるので、そちらでも貼り直しを確かめる
    const gate2 = defer(); saveGate = gate2;
    const p2 = env.handleConfirmAvailability(false);
    await tick();
    env._renderMyAvailConfirm();
    assert.ok(env.box._buttons().length > 0, '確認済みの描画でボタンが作られていない');
    assert.ok(env.box._buttons().every(b => b.disabled), '確認済み側の再描画でボタンが押せる状態に戻っている');
    gate2.resolve(); await p2;
    assert.ok(env.box._buttons().every(b => !b.disabled), '終わってもボタンが戻らない');
});

await test('「今回は難しい」は枠を送らない (slots/slotCount とも null)', async () => {
    const env = makeEnv();
    setSlots(env, [21, 22]);
    await env.handleConfirmAvailability(true);
    assert.equal(confirmRows[0].unavailable, true);
    assert.equal(confirmRows[0].slots, null);
    assert.equal(confirmRows[0].slotCount, null);
});

// ---- 🧱 段階 2: 凸数 (SQL 53) --------------------------------------------------
// 既定のブロック: 朝 5〜8 / 午前 9〜11 / 昼 12〜14 / 午後 15〜17 / 夕方 18〜20 / 夜 21〜23 / 深夜 0〜4
const ASA = [5, 6, 7, 8], YUU = [18, 19, 20];

await test('★ 凸数は実際に保存した時間帯で詰め直して送る (OFF のブロックの凸数は送らない)', async () => {
    const env = makeEnv();
    setSlots(env, ASA);                          // 朝だけ ON
    env._availUI.counts = { '5-8': 1, '18-20': 2 };   // 夕方は OFF なのに凸数が残っている
    await env.handleConfirmAvailability(false);
    assert.deepEqual(confirmRows[0].blockCounts, { '5-8': 1 }, `送った凸数: ${JSON.stringify(confirmRows[0].blockCounts)}`);
    assert.deepEqual(env._myAvailConfirmRef().block_counts, { '5-8': 1 });
});

await test('★ 確認の保存を待つ間に −/+ を押しても、この確認には押した時点の凸数が入る (Codex指摘)', async () => {
    const env = makeEnv();
    setSlots(env, [...ASA, ...YUU]);
    env._availUI.counts = { '5-8': 1 };
    const gate = defer(); saveGate = gate;
    const p = env.handleConfirmAvailability(false);
    await tick();                                      // 時間帯の保存が通信中
    env._availUI.counts = { '5-8': 1, '18-20': 2 };   // 待っている間に夕方を +2
    gate.resolve(); await p;
    assert.deepEqual(confirmRows[0].blockCounts, { '5-8': 1 }, `押したあとの凸数が混ざった: ${JSON.stringify(confirmRows[0].blockCounts)}`);
    env._renderMyAvailConfirm();
    assert.ok(env.box._html().includes('確認したあとに凸数を変えました'), 'あとから変えた凸数を「確認しなおして」と言っていない');
});

await test('★ 確認したあとに凸数を変えたら「確認しなおして」と出す / 元に戻したら消える', async () => {
    const env = makeEnv();
    setSlots(env, [...ASA, ...YUU]);
    env._availUI.counts = { '5-8': 1, '18-20': 2 };
    await env.handleConfirmAvailability(false);
    env._renderMyAvailConfirm();
    assert.ok(env.box._html().includes('今回のレイドの確認が済んでいます'), '確認した直後なのに済んだ表示でない');
    env._availUI.counts = { '5-8': 2, '18-20': 1 };   // 時間はそのまま・凸数だけ変えた
    env._renderMyAvailConfirm();
    assert.ok(env.box._html().includes('確認したあとに凸数を変えました'), '凸数を変えたのに知らせていない');
    env._availUI.counts = { '18-20': 2, '5-8': 1 };   // 鍵の順だけ違う = 同じ中身
    env._renderMyAvailConfirm();
    assert.ok(env.box._html().includes('今回のレイドの確認が済んでいます'), '同じ凸数に戻したのに「変えました」のまま');
});

await test('★ 53 未適用で凸数が落ちたら、確認の記録に凸数を持たない (「凸数を変えました」を出し続けない)', async () => {
    const env = makeEnv();
    setSlots(env, ASA);
    env._availUI.counts = { '5-8': 1 };
    env._confirmResult = { blockCountsDropped: true };
    await env.handleConfirmAvailability(false);
    assert.ok(!('block_counts' in env._myAvailConfirmRef()), '保存できなかった凸数を記録に持っている');
    env._renderMyAvailConfirm();
    assert.ok(env.box._html().includes('今回のレイドの確認が済んでいます'), `確認できたのに「変えました」が出る`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
