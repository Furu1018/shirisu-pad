// ============================================================================
// 本人のホーム「📘 登録された模擬」の実行テスト
//   node tests/home-mocks.mjs
// ----------------------------------------------------------------------------
// index.html から renderMyMocksReadonly を切り出し、依存をスタブして**実際に実行**する。
// 行の組み立ては js/domain/mockIntake.js (readonlyRows) の本物を使う。
//
// なぜ要るか: テンプレートリテラルの中の未定義参照は実行しないと出ない (2026-09-07 の本番障害)。
// 2026-11-16 まではホームの 3 枠 (あなたの3凸) のテストと同じファイル (home-slots.mjs) だった — 3 枠は「従来の画面」と一緒に撤去した。
//
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import '../js/domain/mockIntake.js';     // globalThis.mockIntakeDomain (📘 登録された模擬の行)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// 波括弧の対応で終端を決める。★ 引数のデフォルト値を本体と誤認しないよう `)` を先に探す
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

const ATTRS = [
    { key: 'fire', name: '灼熱' }, { key: 'water', name: '水冷' }, { key: 'electric', name: '電撃' },
    { key: 'iron', name: '鉄甲' }, { key: 'wind', name: '風圧' },
];

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}

console.log('ホームの 📘 登録された模擬:\n');

// ---- 📘 登録された模擬 (🧱 段階 1・2026-10-22): renderMyMocksReadonly を切り出して実際に走らせる ----
const SRC_MOCKS = cut('        async function renderMyMocksReadonly(identity)');
function runMocks({ lite = true, load = async () => [], who = { id: 7 } } = {}) {
    const els = { myMocksCard: { style: { display: 'none' } }, myMocksBody: { innerHTML: '' }, myMocksMeta: { textContent: '' } };
    const holder = { who };
    const env = {
        window: { mockIntakeDomain: globalThis.mockIntakeDomain, supabaseLoadPlayerDamages: load },
        document: { getElementById: (id) => els[id] || null },
        _memberLite: () => lite,
        getCurrentIdentity: () => holder.who,
        mockDamageOf: (r) => Number(r.damage_b) || 0,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        renderTeamSnippet: (team) => `<i class="team">${team.join(',')}</i>`,
        DC_ATTR_COLORS: Object.fromEntries(ATTRS.map(a => [a.key, '#123456'])), SLOT_JP: { 1: '①', 2: '②' },
        console: { warn: () => { } }, _myMocksSeq: 0,
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC_MOCKS}\nreturn renderMyMocksReadonly;`)(...keys.map(k => env[k]));
    return { fn, els, holder };
}
const MOCK_ROWS = [
    { attribute: 'wind', slot: 1, characters: ['c', 'd', 'e', 'f', 'g'], damage_b: 28.1 },
    { attribute: 'wind', slot: 2, characters: ['a', 'b', 'h', 'i', 'j'], damage_b: 21.4 },
    { attribute: 'water', slot: 1, characters: ['k', 'l', 'm', 'n', 'o'], damage_b: 19.8 },
];

await test('★ 📘 登録された模擬: lite のとき 運営が登録した模擬を 属性 × 編成① / ② で描く (無い属性は「未登録」・メタは N / 5 属性)', async () => {
    const t = runMocks({ load: async () => MOCK_ROWS });
    await t.fn({ id: 7 });
    assert.equal(t.els.myMocksCard.style.display, '', 'カードが出ていない');
    const out = t.els.myMocksBody.innerHTML;
    assert.ok(!/undefined|NaN|\[object/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]}`);
    assert.ok(out.includes('風圧PT') && out.includes('28.1') && out.includes('21.4') && out.includes('編成①') && out.includes('編成②'), '風圧の 2 編成が出ていない');
    assert.ok(out.includes('<i class="team">c,d,e,f,g</i>'), '編成のアイコンが出ていない');
    assert.equal((out.match(/未登録/g) || []).length, 3, '無い属性 (灼熱・電撃・鉄甲) が「未登録」になっていない');
    assert.equal(t.els.myMocksMeta.textContent, '2 / 5 属性');
});
await test('📘 登録された模擬: 模擬タブがあるとき (full / 運営) は出さない / 取れなかった (null) ときは隠す (「未登録」に偽装しない)', async () => {
    const a = runMocks({ lite: false, load: async () => MOCK_ROWS });
    await a.fn({ id: 7 });
    assert.equal(a.els.myMocksCard.style.display, 'none'); assert.equal(a.els.myMocksBody.innerHTML, '');
    const b = runMocks({ load: async () => null });
    await b.fn({ id: 7 });
    assert.equal(b.els.myMocksCard.style.display, 'none', '取れなかったのに出している'); assert.equal(b.els.myMocksBody.innerHTML, '');
    const c = runMocks({ load: async () => { throw new Error('通信'); } });
    await c.fn({ id: 7 });
    assert.equal(c.els.myMocksCard.style.display, 'none', '例外で出している');
    const d = runMocks();
    await d.fn(null);
    assert.equal(d.els.myMocksCard.style.display, 'none');
});
await test('★ 📘 登録された模擬: 待っている間に名乗り直されたら書かない / 追い越された古い取得は捨てる', async () => {
    // 名乗り直し: 取得の間に別の人になった
    const t = runMocks({ load: async () => { t.holder.who = { id: 8 }; return MOCK_ROWS; } });
    await t.fn({ id: 7 });
    assert.equal(t.els.myMocksCard.style.display, 'none', '別の人の模擬を描いている'); assert.equal(t.els.myMocksBody.innerHTML, '');
    // 追い越し: 1 回目の取得が遅く、2 回目が先に終わる → 1 回目の結果は捨てる
    let release = null;
    const slow = new Promise(r => { release = r; });
    let n = 0;
    const u = runMocks({ load: async () => (++n === 1 ? (await slow, [{ attribute: 'fire', slot: 1, characters: ['x'], damage_b: 99.9 }]) : MOCK_ROWS) });
    const p1 = u.fn({ id: 7 });
    await u.fn({ id: 7 });
    assert.ok(u.els.myMocksBody.innerHTML.includes('28.1'), '2 回目が描けていない');
    release(); await p1;
    assert.ok(!u.els.myMocksBody.innerHTML.includes('99.9'), '追い越された古い取得で上書きしている');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
