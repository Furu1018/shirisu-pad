// アプリの確認 (padAlert / padConfirm / padPrompt = ブラウザの alert / confirm / prompt の代わり・2026-11-25 段階 2 の後半) の実行テスト。
//   index.html から本物の関数を切り出し、小さな偽の DOM で走らせる: 答え (OK / キャンセル / Esc / 外を押す / Enter) ・列 (同時に 2 つ) ・
//   ほかの道で閉じた (Android の戻る = open が外れる) ・文は textContent ・danger の付け外し ・シートが無ければブラウザのものに倒す
//   node tests/pad-dialog.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const a = HTML.indexOf('        function _padDlgState() {');
const b = HTML.indexOf('        // ===== モーダルが開いている間は本体をスクロールさせない');
assert.ok(a > 0 && b > a, 'アプリの確認の関数を切り出せない');
const SRC = HTML.slice(a, b);

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise(r => setTimeout(r, 0));

// ---- 小さな偽の DOM ----
function makeEnv({ noModal = false } = {}) {
    const observers = [];
    const docListeners = [];
    const mk = (id, tag = 'div') => {
        const el = {
            id, tagName: tag.toUpperCase(), textContent: '', value: '', hidden: false, placeholder: '', isConnected: true, focused: 0, selected: 0, listeners: {},
            classList: null,
            addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
            focus() { env.document.activeElement = this; this.focused++; },
            select() { this.selected++; },
            click() { for (const fn of this.listeners.click || []) fn({ target: this }); if (this !== env.els.padDialog) for (const fn of env.els.padDialog.listeners.click || []) fn({ target: this }); },
            querySelectorAll() { return ['padDialogInput', 'padDialogCancel', 'padDialogOk'].map(k => env.els[k]).filter(e => !e.hidden); },
        };
        const set = new Set();
        el.classList = {
            add(c) { const had = set.has(c); set.add(c); if (!had) notify(el); },
            remove(c) { const had = set.delete(c); if (had) notify(el); },
            contains(c) { return set.has(c); },
            toggle(c, on) { const want = on === undefined ? !set.has(c) : !!on; if (want) this.add(c); else this.remove(c); return want; },
        };
        return el;
    };
    // MutationObserver は非同期 (マイクロタスク) — 本物と同じく、変わったあとにまとめて呼ぶ
    const notify = (el) => { for (const o of observers) if (o.target === el) { if (!o.pending) { o.pending = true; queueMicrotask(() => { o.pending = false; o.cb([{ target: el }]); }); } } };
    const env = {
        els: {}, log: { alert: [], confirm: [], prompt: [] }, nativeAnswer: { confirm: true, prompt: 'X' },
        document: {
            activeElement: null,
            getElementById: (id) => env.els[id] || null,
            addEventListener: (type, fn, capture) => docListeners.push({ type, fn, capture }),
        },
        keydown(key, target, extra = {}) {
            const ev = { key, target: target || env.document.activeElement, isComposing: false, shiftKey: false, prevented: false, stopped: false, ...extra,
                preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
            for (const l of docListeners.filter(l => l.type === 'keydown' && l.capture)) { l.fn(ev); if (ev.stopped) return ev; }
            for (const l of docListeners.filter(l => l.type === 'keydown' && !l.capture)) l.fn(ev);
            return ev;
        },
    };
    if (!noModal) for (const [id, tag] of [['padDialog'], ['padDialogTitle', 'h2'], ['padDialogMsg', 'p'], ['padDialogInput', 'input'], ['padDialogOk', 'button'], ['padDialogCancel', 'button']]) env.els[id] = mk(id, tag);
    const win = {
        alert: (m) => { env.log.alert.push(m); },
        confirm: (m) => { env.log.confirm.push(m); return env.nativeAnswer.confirm; },
        prompt: (m, v) => { env.log.prompt.push([m, v]); return env.nativeAnswer.prompt; },
    };
    class MO { constructor(cb) { this.cb = cb; } observe(target) { observers.push({ target, cb: this.cb, pending: false }); } }
    const api = new Function('window', 'document', 'MutationObserver', 'setTimeout', SRC + '\nreturn { padAlert, padConfirm, padPrompt, _padDlgState };')(win, env.document, MO, (fn) => fn());
    return { env, ...api, open: () => !!env.els.padDialog && env.els.padDialog.classList.contains('open') };
}

test('padConfirm: 文・ボタンの名前を出し、OK で true / キャンセルで false。閉じたら open が外れる', async () => {
    const t = makeEnv();
    const p = t.padConfirm('消しますか？\n(戻せません)', { ok: '消す', cancel: 'やめる', danger: true });
    assert.ok(t.open(), '開かない');
    const E = t.env.els;
    assert.equal(E.padDialogMsg.textContent, '消しますか？\n(戻せません)');
    assert.equal(E.padDialogOk.textContent, '消す'); assert.equal(E.padDialogCancel.textContent, 'やめる');
    assert.equal(E.padDialogCancel.hidden, false); assert.equal(E.padDialogInput.hidden, true); assert.equal(E.padDialogTitle.hidden, true, '題が無いのに見出しが出る');
    assert.ok(E.padDialogOk.classList.contains('danger'), 'danger の色にならない');
    assert.ok(E.padDialogOk.focused > 0, 'OK に焦点を置かない (Enter で答えられない)');
    E.padDialogOk.click();
    assert.equal(await p, true); assert.ok(!t.open(), 'OK のあとも開いたまま');
    const q = t.padConfirm('もう一度？');
    assert.ok(!E.padDialogOk.classList.contains('danger'), '前の danger が残っている');
    assert.equal(E.padDialogOk.textContent, 'OK'); assert.equal(E.padDialogCancel.textContent, 'キャンセル');
    E.padDialogCancel.click();
    assert.equal(await q, false);
});

test('Esc = キャンセル (下のシートの「Esc で閉じる」まで届かせない) / 外を押す = キャンセル / alert は キャンセルが無く Esc でも閉じる', async () => {
    const t = makeEnv();
    const p = t.padConfirm('A');
    const ev = t.env.keydown('Escape');
    assert.equal(await p, false);
    assert.ok(ev.stopped && ev.prevented, 'Esc を止めていない (下のシートも閉じる)');
    const q = t.padConfirm('B');
    t.env.els.padDialog.click();   // 外 (シートの地) を押す
    assert.equal(await q, false);
    const r = t.padAlert('お知らせ');
    assert.equal(t.env.els.padDialogCancel.hidden, true, 'alert にキャンセルが出る');
    t.env.keydown('Escape');
    assert.equal(await r, undefined); assert.ok(!t.open());
    // 開いていないときの Esc は止めない
    const ev2 = t.env.keydown('Escape');
    assert.ok(!ev2.stopped, '閉じているのに Esc を止めている');
});

test('padPrompt: 欄に初めの値・Enter で入れた文字 / キャンセルで null / 日本語入力の確定の Enter は答えにしない', async () => {
    const t = makeEnv();
    const E = t.env.els;
    const p = t.padPrompt('新しい名前', { value: 'ふるり', placeholder: '名前' });
    assert.equal(E.padDialogInput.hidden, false); assert.equal(E.padDialogInput.value, 'ふるり'); assert.equal(E.padDialogInput.placeholder, '名前');
    assert.ok(E.padDialogInput.focused > 0 && E.padDialogInput.selected > 0, '欄に焦点を置いて選んでいない');
    E.padDialogInput.value = 'ふるり2';
    t.env.keydown('Enter', E.padDialogInput, { isComposing: true });
    assert.ok(t.open(), '日本語入力の確定の Enter で閉じた');
    t.env.keydown('Enter', E.padDialogInput);
    assert.equal(await p, 'ふるり2');
    const q = t.padPrompt('理由');
    assert.equal(E.padDialogInput.value, '', '前の答えが欄に残っている');
    E.padDialogCancel.click();
    assert.equal(await q, null);
    const r = t.padPrompt('空でも');
    E.padDialogOk.click();
    assert.equal(await r, '', 'OK で空の文字を返さない (null と区別できない)');
});

test('同時に呼ばれたら順に出す (列) — 1 つ目に答えるまで 2 つ目の文で上書きしない', async () => {
    const t = makeEnv();
    const E = t.env.els;
    const p1 = t.padConfirm('1 つ目'), p2 = t.padConfirm('2 つ目', { ok: '二' });
    assert.equal(E.padDialogMsg.textContent, '1 つ目', '2 つ目が 1 つ目を上書きした');
    E.padDialogOk.click();
    assert.equal(await p1, true);
    assert.ok(t.open() && E.padDialogMsg.textContent === '2 つ目' && E.padDialogOk.textContent === '二', '2 つ目が出ない');
    E.padDialogCancel.click();
    assert.equal(await p2, false); assert.ok(!t.open());
});

test('ほかの道で閉じた (Android の戻る = 履歴の仕組みが open を外す) → キャンセルとして返し、列の次へ進む', async () => {
    const t = makeEnv();
    const p1 = t.padConfirm('戻るで閉じる'), p2 = t.padAlert('次');
    t.env.els.padDialog.classList.remove('open');   // 外から閉じる
    assert.equal(await p1, false, '外から閉じたのに答えが返らない (待っている処理が止まったまま)');
    await tick();
    assert.ok(t.open() && t.env.els.padDialogMsg.textContent === '次', '列の次が出ない');
    t.env.els.padDialogOk.click();
    assert.equal(await p2, undefined);
    // 自分で閉じたとき (OK) は、見張りが 2 回目の答えを返さない
    const st = t._padDlgState();
    assert.equal(st.cur, null); assert.equal(st.queue.length, 0);
});

test('文は textContent (HTML にしない) / Tab の焦点はシートの中を回る', async () => {
    const t = makeEnv();
    const evil = '<img src=x onerror=alert(1)>';
    const p = t.padConfirm(evil, { title: '<b>題</b>' });
    assert.equal(t.env.els.padDialogMsg.textContent, evil);
    assert.equal(t.env.els.padDialogTitle.textContent, '<b>題</b>'); assert.equal(t.env.els.padDialogTitle.hidden, false);
    assert.ok(!/innerHTML/.test(SRC), 'アプリの確認が innerHTML で文を入れている');
    const order = [];
    for (let i = 0; i < 3; i++) { const ev = t.env.keydown('Tab'); assert.ok(ev.prevented, 'Tab をシートの外へ出している'); order.push(t.env.document.activeElement.id); }
    assert.deepEqual(order, ['padDialogCancel', 'padDialogOk', 'padDialogCancel'], 'Tab の焦点がシートの中を回らない (OK → キャンセル → OK)');
    t.env.els.padDialogCancel.click();
    assert.equal(await p, false);
});

test('シートが無い (読み込みの途中など) → ブラウザのものに倒す (確認を飛ばして進めない)', async () => {
    const t = makeEnv({ noModal: true });
    t.env.nativeAnswer.confirm = false;
    assert.equal(await t.padConfirm('飛ばさない'), false);
    assert.deepEqual(t.env.log.confirm, ['飛ばさない']);
    t.env.nativeAnswer.prompt = '入力';
    assert.equal(await t.padPrompt('名前', { value: '初め' }), '入力');
    assert.deepEqual(t.env.log.prompt, [['名前', '初め']]);
    await t.padAlert('知らせ');
    assert.deepEqual(t.env.log.alert, ['知らせ']);
});

for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ✅ ' + name); }
    catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + (e && e.message || e)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
