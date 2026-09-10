// ============================================================================
// 見た目 (ライト / ダーク) の切り替えの実行テスト
//   node tests/theme-switch.mjs
// ----------------------------------------------------------------------------
// index.html から <head> の起動スクリプトと handleThemePick/syncThemeSeg を切り出し、
// localStorage / matchMedia / document をスタブして**実際に実行**する。
// ★ ここが壊れると「保存したはずのダークが起動時に戻る」「一瞬ライトが見える」が起きる。
//   どちらも実機を開くまで気づけない類なので、実行で押さえる。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function slice(from, to, what) {
    const a = html.indexOf(from);
    const b = html.indexOf(to, a);
    if (a < 0 || b < 0) { console.error(`NG: ${what} を切り出せません (目印が変わった?)`); process.exit(2); }
    return html.slice(a, b);
}
const BOOT = slice("        (function () {\n            var KEY = 'shirisuko_theme_v1';", '    </script>', '起動スクリプト');
const PICK = slice('        function handleThemePick(pref) {', '        window.addEventListener(\'DOMContentLoaded\'', '切り替えの処理');

// ---- 環境 ----------------------------------------------------------------
function makeEnv({ stored = null, osDark = false, cssBg = '' } = {}) {
    const store = new Map();
    if (stored) store.set('shirisuko_theme_v1', stored);
    const rootEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
    const meta = { attrs: { name: 'theme-color', content: '#F1F3F6' }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
    const buttons = ['auto', 'light', 'dark'].map(k => ({
        dataset: { themePick: k }, attrs: {},
        setAttribute(a, v) { this.attrs[a] = v; }, getAttribute(a) { return this.attrs[a]; },
    }));
    const mqListeners = [];
    const mq = { matches: osDark, addEventListener: (_t, fn) => mqListeners.push(fn) };
    const events = [];
    const win = {
        matchMedia: () => mq,
        dispatchEvent: (e) => { events.push(e); return true; },
        addEventListener: () => { },
    };
    const env = {
        window: win,
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        document: {
            documentElement: rootEl,
            querySelector: (sel) => (sel.includes('theme-color') ? meta : null),
            querySelectorAll: (sel) => (sel.includes('data-theme-pick') ? buttons : []),
        },
        getComputedStyle: () => ({ getPropertyValue: () => cssBg }),
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    };
    return { env, win, rootEl, meta, buttons, store, mqListeners, events };
}

function boot(opts) {
    const t = makeEnv(opts);
    const keys = Object.keys(t.env);
    // 起動スクリプトは window.x = ... で生やすので、window を env にも見せる
    new Function(...keys, BOOT + '\n' + PICK)(...keys.map(k => t.env[k]));
    return t;
}

let pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.log('  ❌ ' + name + '\n     ' + (e && e.message)); fail++; }
}

console.log('\n見た目 (ライト / ダーク) の切り替え:\n');

test('★ 何も保存されていない + 端末がライト → ライトで立ち上がる', () => {
    const t = boot({});
    assert.equal(t.rootEl.getAttribute('data-theme'), 'light');
    assert.equal(t.win.padThemePref(), 'auto');
});

test('★ 何も保存されていない + 端末がダーク → ダークで立ち上がる (auto が効く)', () => {
    const t = boot({ osDark: true });
    assert.equal(t.rootEl.getAttribute('data-theme'), 'dark');
    assert.equal(t.win.padThemePref(), 'auto');
});

test('★ ダークを保存済みなら、端末がライトでもダークで立ち上がる', () => {
    const t = boot({ stored: 'dark', osDark: false });
    assert.equal(t.rootEl.getAttribute('data-theme'), 'dark');
    assert.equal(t.win.padThemePref(), 'dark');
});

test('★ ライトを保存済みなら、端末がダークでもライトで立ち上がる', () => {
    const t = boot({ stored: 'light', osDark: true });
    assert.equal(t.rootEl.getAttribute('data-theme'), 'light');
});

test('★ 壊れた保存値は auto として扱う (落ちない)', () => {
    const t = boot({ stored: 'ダーク', osDark: true });
    assert.equal(t.win.padThemePref(), 'auto');
    assert.equal(t.rootEl.getAttribute('data-theme'), 'dark');
});

test('★ localStorage が使えなくても立ち上がる (プライベートモード)', () => {
    const t = makeEnv({ osDark: true });
    t.env.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    const keys = Object.keys(t.env);
    new Function(...keys, BOOT + '\n' + PICK)(...keys.map(k => t.env[k]));
    assert.equal(t.rootEl.getAttribute('data-theme'), 'dark');
    // 保存できなくても、その場の切り替えは効く
    t.env.window.handleThemePick ? t.env.window.handleThemePick('light') : null;
});

test('★ 選ぶと保存され、すぐ反映される / 「端末に合わせる」は保存を消す', () => {
    const t = boot({ osDark: true });
    const keys = Object.keys(t.env);
    const pick = new Function(...keys, BOOT + '\n' + PICK + '\nreturn handleThemePick;')(...keys.map(k => t.env[k]));
    pick('light');
    assert.equal(t.store.get('shirisuko_theme_v1'), 'light', '保存されていない');
    assert.equal(t.rootEl.getAttribute('data-theme'), 'light', '反映されていない');
    pick('auto');
    assert.equal(t.store.has('shirisuko_theme_v1'), false, '「端末に合わせる」で保存が消えていない');
    assert.equal(t.rootEl.getAttribute('data-theme'), 'dark', '端末 (ダーク) に戻っていない');
});

test('★ 3つのボタンのうち、いま選んでいる1つだけが押された状態になる', () => {
    const t = boot({ stored: 'dark' });
    const keys = Object.keys(t.env);
    const fns = new Function(...keys, BOOT + '\n' + PICK + '\nreturn { pick: handleThemePick, sync: syncThemeSeg };')(...keys.map(k => t.env[k]));
    fns.sync();
    assert.deepEqual(t.buttons.map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
    fns.pick('auto');
    assert.deepEqual(t.buttons.map(b => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
});

test('★ auto のあいだは端末設定の変化に追随する / 明示指定なら追随しない', () => {
    const t = boot({ osDark: false });
    assert.equal(t.mqListeners.length, 1, '端末設定の変化を見ていない');
    t.env.window.matchMedia().matches = true;
    t.mqListeners[0]();
    assert.equal(t.rootEl.getAttribute('data-theme'), 'dark', 'auto なのに追随しない');

    const u = boot({ stored: 'light', osDark: false });
    u.env.window.matchMedia().matches = true;
    u.mqListeners[0]();
    assert.equal(u.rootEl.getAttribute('data-theme'), 'light', '明示指定なのに端末に引っぱられた');
});

test('★ キャンバス/グラフへ「描き直して」の合図が出る', () => {
    const t = boot({});
    assert.equal(t.events.length, 1, '合図が出ていない');
    assert.equal(t.events[0].type, 'padthemechange');
    assert.equal(t.events[0].detail.mode, 'light');
});

test('★ ブラウザのUIの色は --bg を読む (色を二重に書かない)', () => {
    // <head> の時点では <style> がまだ無い → 何もしない (静的な meta の値のまま)
    const t = boot({});
    assert.equal(t.meta.getAttribute('content'), '#F1F3F6', '読めない時に空で上書きしてはいけない');
    // CSS が読めるようになったら --bg を写す
    const u = boot({ osDark: true, cssBg: '#0E1013' });
    u.env.window.padSyncThemeColor();
    assert.equal(u.meta.getAttribute('content'), '#0E1013');
});

test('★ 起動スクリプトは <style> より前にある (描画前に決まる = 一瞬ライトが見えない)', () => {
    const boot0 = html.indexOf("var KEY = 'shirisuko_theme_v1'");
    const style0 = html.indexOf('<style');
    assert.ok(boot0 > 0 && style0 > boot0, `起動スクリプトが <style> より後ろにある (${boot0} / ${style0})`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
