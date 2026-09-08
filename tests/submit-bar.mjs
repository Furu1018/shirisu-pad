// ============================================================================
// 模擬提出シートの提出バー (_renderTeamEditBar) の実行テスト
//   node tests/submit-bar.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 2026-09-08 の再設計 (モック a3a7b6e9) で、提出バーは「要約 + 足りないもの + ボタンの状態」を
// 編成・ダメージの変更のたびに描き直す。テンプレートの未定義参照は実行しないと出ない。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function cut(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} を切り出せません (目印が変わった?)`); process.exit(2); }
    let paren = 0, bodyStart = -1;
    for (let k = html.indexOf('(', i); k < html.length; k++) {
        if (html[k] === '(') paren++;
        else if (html[k] === ')') { paren--; if (!paren) { bodyStart = html.indexOf('{', k); break; } }
    }
    let d = 0, inStr = null, prev = '';
    for (let k = bodyStart; k < html.length; k++) {
        const ch = html[k];
        if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; }
        else if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '{') d++;
        else if (ch === '}') { d--; if (!d) return html.slice(i, k + 1); }
        prev = ch;
    }
    console.error(`NG: ${marker} の終端を判定できません`); process.exit(2);
}
const SRC = [cut('        function _renderTeamEditBar()'), cut('        function _teDamageValue()')].join('\n');

function run({ names = [], dmg = '', submitted = 0, slot = 1, openedTeam = 0 } = {}) {
    const sum = { innerHTML: '' };
    const btn = { disabled: false, textContent: '', _cls: new Set(), classList: { toggle: (c, on) => { if (on) btn._cls.add(c); else btn._cls.delete(c); } } };
    const dmgInput = { value: String(dmg) };
    const env = {
        document: { getElementById: (id) => ({ myTeamEditBarSum: sum, myTeamEditSubmit: btn, myTeamEditDamage: dmgInput }[id] || null) },
        PT_ATTRS: [{ key: 'fire', name: '灼熱' }], SLOT_JP: { 1: '①', 2: '②' },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        _myTeamEditAttr: 'fire', _myTeamEditSlot: slot, _myTeamEditSubmittedB: submitted, _myTeamEditOpenedTeamCount: openedTeam,
        _teNames: () => { const a = names.slice(); while (a.length < 5) a.push(''); return a; },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn _renderTeamEditBar;`)(...keys.map(k => env[k]));
    fn();
    return { sum: sum.innerHTML, btn };
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}

console.log('模擬提出シートの提出バー:\n');

test('★ 5人 + ダメージ = 「提出できます」で黒く点灯', () => {
    const r = run({ names: ['a', 'b', 'c', 'd', 'e'], dmg: '33.1' });
    assert.ok(r.sum.includes('灼熱PT 編成①'), r.sum);
    assert.ok(r.sum.includes('33.1B'));
    assert.ok(r.sum.includes('提出できます'));
    assert.equal(r.btn.disabled, false);
    assert.equal(r.btn._cls.has('partial'), false, '完成しているのに暗い');
    assert.equal(r.btn.textContent, '提出する');
    assert.ok(!/undefined|NaN/.test(r.sum), r.sum);
});
test('足りないものを1つだけ言う: 人数 / ダメージ', () => {
    const a = run({ names: ['a', 'b'], dmg: '33.1' });
    assert.ok(a.sum.includes('あと3人'), a.sum);
    assert.equal(a.btn.disabled, false, 'ダメージがあれば編成が足りなくても提出はできる');
    assert.ok(a.btn._cls.has('partial'), '未完成なのに黒');
    const b = run({ names: ['a', 'b', 'c', 'd', 'e'], dmg: '' });
    assert.ok(b.sum.includes('ダメージが未入力です'), b.sum);
    assert.equal(b.btn.textContent, '編成だけ提出する');
    const c = run({ names: ['a'], dmg: '' });
    assert.ok(c.sum.includes('あと4人とダメージで提出できます'));
});
test('何も無ければ押せない / 提出値があれば「クリアして提出」', () => {
    const a = run({});
    assert.equal(a.btn.disabled, true);
    assert.ok(a.sum.includes('編成とダメージを入れてください'));
    const b = run({ submitted: 30 });
    assert.equal(b.btn.disabled, false);
    assert.equal(b.btn.textContent, '測定をクリアして提出');
    assert.ok(b.sum.includes('30B → 未入力'));
});
test('ダメージ無しで編成だけ提出していた人は、全員外して空で提出できる (編成のクリア — Codex指摘)', () => {
    const r = run({ names: [], dmg: '', submitted: 0, openedTeam: 5 });
    assert.equal(r.btn.disabled, false, '空で提出する経路が塞がれている');
    assert.equal(r.btn.textContent, '編成をクリアして提出');
    assert.ok(r.sum.includes('空で提出すると編成をクリアします'), r.sum);
});
test('提出済みと違う値は「33.1B → 35B」と両方出す (ユーザー決定 D)', () => {
    const r = run({ names: ['a', 'b', 'c', 'd', 'e'], dmg: '35', submitted: 33.1 });
    assert.ok(r.sum.includes('33.1B → 35B'), r.sum);
    const same = run({ names: ['a', 'b', 'c', 'd', 'e'], dmg: '33.1', submitted: 33.1 });
    assert.ok(!same.sum.includes('→'), '同じ値なのに矢印が出る');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
