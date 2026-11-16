// ============================================================================
// HP更新の鮮度ピル (_hpFreshHtml) の実行テスト
//   node tests/hp-fresh.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定は js/domain/opsLayout.js (hpFreshnessMin) の本物。
// 2026-11-16 までは「ホームの一目」(home-glance.mjs) の一部だった — ホームのボス状況カード・状態ボタン・
// 次の凸 (ボスタイル) は「従来の画面」と一緒に撤去したので、運営の ⚔️ ボス状況が使うこのピルだけ残した。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/opsLayout.js';    // globalThis.opsLayoutDomain

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
const SRC = cut('        function _hpFreshHtml(bosses)');
const env = { window: { opsLayoutDomain: globalThis.opsLayoutDomain }, console };
const keys = Object.keys(env);
const _hpFreshHtml = new Function(...keys, `${SRC}\nreturn _hpFreshHtml;`)(...keys.map(k => env[k]));

const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const bosses = [1, 2, 3, 4, 5].map(n => ({ boss_number: n, remaining_hp_raw: 50e9, total_hp_raw: 99.86e9, updated_at: ago(3) }));
const at = (min) => bosses.map(b => ({ ...b, updated_at: min == null ? null : ago(min) }));

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}

console.log('HP更新の鮮度ピル:\n');

test('★ HP更新の鮮度: 30分以上は warn (⚠️)、読めなければ空', () => {
    assert.ok(/^<span class="hp-fresh"[^>]*>HP更新 3分前<\/span>$/.test(_hpFreshHtml(bosses)));
    assert.ok(/class="hp-fresh warn"[^>]*>HP更新 45分前 ⚠️</.test(_hpFreshHtml(at(45))), '30分以上を警告にしていない');
    assert.ok(/HP更新 2時間前 ⚠️/.test(_hpFreshHtml(at(150))));
    // ★ 境界 (Codex指摘 2026-09-11): 30 分ちょうどで警告、29 分では警告しない (>= を > に変えると落ちる)
    assert.ok(/class="hp-fresh warn"[^>]*>HP更新 30分前 ⚠️</.test(_hpFreshHtml(at(30))), '30分ちょうどで警告していない');
    assert.ok(/class="hp-fresh"[^>]*>HP更新 29分前</.test(_hpFreshHtml(at(29))), '29分で警告している');
    assert.equal(_hpFreshHtml(at(null)), '', '読めないのに何か出している');
    assert.equal(_hpFreshHtml([]), '');
    assert.ok(!/undefined|NaN|\[object/.test(_hpFreshHtml(bosses)), '未定義参照');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
