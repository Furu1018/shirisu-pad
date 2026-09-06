// ============================================================================
// 戦闘可能時間の保存キュー + 今季の確認 の実行テスト
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
].join('\n');

// ---- 依存スタブ ------------------------------------------------------------
const HOUR_ORDER = Array.from({ length: 24 }, (_, i) => i);
const _hourKey = (h) => `h${String(h).padStart(2, '0')}`;

let log = [];                 // 実際にサーバへ着地した順の記録
let saved = null;             // availability の最終状態 (最後に着地した保存)
let confirmRows = [];         // availability_confirmations への書き込み
let saveGate = null;          // 保存を止めておくためのフック

// innerHTML を代入するとボタン要素が作り直される箱 (実物と同じ挙動)。
// querySelectorAll('button') は「その瞬間の」ボタンを返す
function makeBox() {
    let buttons = [];
    return {
        style: {}, _buttons: () => buttons,
        set innerHTML(v) {
            buttons = [...String(v).matchAll(/<button\b/g)].map(() => ({ disabled: false, style: {} }));
        },
        get innerHTML() { return ''; },
        querySelectorAll: () => buttons,
    };
}

function makeEnv() {
    log = []; saved = null; confirmRows = []; saveGate = null;
    const box = makeBox();
    const env = {
        HOUR_ORDER, _hourKey,
        _availUI: { slots: new Array(24).fill(false), saveTimer: null },
        clearTimeout: () => { },
        getCurrentIdentity: () => ({ id: 7 }),
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
            },
        },
        _myAvailConfirm: null,
        // 保存の実体スタブ。押した瞬間の slots を読み、gate があればそこで待つ
        async _availDoSaveInner(opts = {}) {
            const slots = HOUR_ORDER.map((h, i) => env._availUI.slots[i] ? _hourKey(h) : null).filter(Boolean);
            const tag = slots.join('|') || '(空)';
            if (saveGate) { const g = saveGate; saveGate = null; await g.promise; }
            if (env._failNextSave) { env._failNextSave = false; log.push(`save(${tag}) 失敗`); if (opts.rethrow) throw new Error('通信断'); return; }
            saved = slots; log.push(`save(${tag})`);
        },
        _failNextSave: false,
    };
    // 切り出したコードを env のスコープで評価し、必要な関数を取り出す
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn { _availEnqueue, _availDoSave, _availConfirmSetBusy, _renderMyAvailConfirm,`
        + ` handleConfirmAvailability, get _myAvailConfirm(){return _myAvailConfirm;} };`);
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

console.log('戦闘可能時間の保存キュー:\n');

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
    assert.equal(env._myAvailConfirm, null, '画面側の状態も更新しない');
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
