// 運営モードを「名乗っている人ごとに」覚える (2026-09-10 ユーザー決定)。
//   「ふるり で名乗ったら運営ON、OFF にしたら次回も OFF」。
//   ★ 端末ごとではなく人ごと — 同じ端末で別の人が名乗ったときに混ざらないこと。
//   ★ 名乗っていないうちは覚えない (誰の設定か決められない)。
// index.html から実装を切り出して**実際に動かす**。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** 関数/定数を波括弧の対応で切り出す */
function cut(sig) {
    const i = SRC.indexOf(sig);
    assert.ok(i >= 0, `実装が見つからない: ${sig}`);
    let depth = 0;
    for (let k = SRC.indexOf('{', i); k < SRC.length; k += 1) {
        if (SRC[k] === '{') depth += 1;
        else if (SRC[k] === '}') { depth -= 1; if (depth === 0) return SRC.slice(i, k + 1); }
    }
    throw new Error(`閉じ括弧が見つからない: ${sig}`);
}

function build() {
    const key = /const OPS_MODE_KEY = '([^']+)'/.exec(SRC);
    assert.ok(key, 'OPS_MODE_KEY が無い');
    const src = [`const OPS_MODE_KEY = '${key[1]}';`,
        cut('function _opsModeMap()'), cut('function _opsModeForCurrent()'), cut('function _rememberOpsMode(on)')].join('\n');
    const store = {};
    const env = {
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        getCurrentIdentity: () => env._who,
        _who: null,
    };
    const keys = Object.keys(env);
    const fns = new Function(...keys, `${src}\nreturn { _opsModeForCurrent, _rememberOpsMode };`)(...keys.map((k) => env[k]));
    return { ...fns, env, store, KEY: key[1], as: (who) => { env._who = who; } };
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass += 1; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); fail += 1; }
}

console.log('運営モードの記憶:');

test('名乗った人ごとに覚える / 他人の ON を引き継がない', () => {
    const t = build();
    t.as({ id: 1, name: 'ふるり' });
    assert.equal(t._opsModeForCurrent(), false, '初回から ON になっている');
    t._rememberOpsMode(true);
    assert.equal(t._opsModeForCurrent(), true, '覚えていない');
    // ★ 同じ端末で別の人が名乗っても引き継がない
    t.as({ id: 2, name: 'なべりうす' });
    assert.equal(t._opsModeForCurrent(), false, '他人の ON を引き継いでいる');
    t._rememberOpsMode(true);
    t.as({ id: 1, name: 'ふるり' });
    assert.equal(t._opsModeForCurrent(), true, '他人の操作で自分の記憶が消えている');
});

test('OFF に戻したら次回も OFF (記憶から消える)', () => {
    const t = build();
    t.as({ id: 1 });
    t._rememberOpsMode(true);
    t._rememberOpsMode(false);
    assert.equal(t._opsModeForCurrent(), false, 'OFF が覚えられていない');
    assert.equal(JSON.parse(t.store[t.KEY])['1'], undefined, 'OFF を true のまま残している');
});

test('★ 名乗っていないときは覚えない・常に OFF', () => {
    const t = build();
    t.as(null);
    assert.equal(t._opsModeForCurrent(), false);
    t._rememberOpsMode(true);
    assert.equal(t.store[t.KEY], undefined, '誰の設定か決められないのに覚えている');
    t.as({ id: null });
    t._rememberOpsMode(true);
    assert.equal(t.store[t.KEY], undefined, 'id が無いのに覚えている');
});

test('★ 記憶が壊れていても落ちない (配列・文字列・空)', () => {
    for (const bad of ['こわれてる', '[]', 'null', '"x"', '', '123']) {
        const t = build();
        t.store[t.KEY] = bad;
        t.as({ id: 1 });
        assert.doesNotThrow(() => t._opsModeForCurrent(), `${bad} で落ちた`);
        assert.equal(t._opsModeForCurrent(), false, `${bad} を ON と読んでいる`);
        // 壊れていても書き直せること
        assert.doesNotThrow(() => t._rememberOpsMode(true));
        assert.equal(t._opsModeForCurrent(), true, '壊れた記憶から復帰できない');
    }
});

test('★ localStorage が使えなくても落ちない (プライベートモード)', () => {
    const t = build();
    t.env.localStorage.getItem = () => { throw new Error('denied'); };
    t.env.localStorage.setItem = () => { throw new Error('denied'); };
    t.as({ id: 1 });
    assert.doesNotThrow(() => t._opsModeForCurrent());
    assert.equal(t._opsModeForCurrent(), false);
    assert.doesNotThrow(() => t._rememberOpsMode(true));
});

test('★ 身元を切り替えたら、その人の記憶に合わせ直す', () => {
    // setCurrentIdentity から _applyOpsModeForIdentity を呼んでいること
    assert.ok(/_applyOpsModeForIdentity\(\);/.test(SRC), '身元切替で運営モードを切り替えていない');
    const fn = cut('function _applyOpsModeForIdentity()');
    assert.ok(/_opsModeForCurrent\(\)/.test(fn), 'その人の記憶を読んでいない');
    assert.ok(!/_rememberOpsMode\(/.test(fn), '切り替えのときに記憶を書き換えている (読むだけのはず)');
    // 起動時にも当てる
    assert.ok(/_opsMode = _opsModeForCurrent\(\);\s*\n\s*_applyOpsMode\(\);/.test(SRC), '起動時に記憶を当てていない');
});

test('★ トーストは自分で押したときだけ (復元では出さない)', () => {
    const toggle = cut('function toggleOpsMode()');
    assert.ok(/showNotification\(_opsMode \?/.test(toggle), '押したときに知らせていない');
    const after = cut('function _afterOpsModeChanged()');
    assert.ok(!/showNotification\(/.test(after), '復元でもトーストが出る (何が起きたか分からない)');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
