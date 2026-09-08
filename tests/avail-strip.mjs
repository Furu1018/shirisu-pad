// ============================================================================
// ホーム「⏰ あなたの戦闘可能時間」の帯 (renderMyAvailStrip) の実行テスト
//   node tests/avail-strip.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 要約 (labelOf) は js/domain/availability.js の本物を使う。
// テンプレートリテラルの未定義参照は実行しないと出ない (2026-09-07 の本番障害と同じ型)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/availability.js';   // globalThis.availabilityDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const dom = globalThis.availabilityDomain;

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
const SRC = cut('        async function renderMyAvailStrip(identity)');

const H = (...hs) => hs.map(h => `h${String(h).padStart(2, '0')}`);
function run({ slots = [], prefs = { flexTime: false, notifyAllHours: false }, nowSlot = 'h13', fail = false, badgeText = '今季 確認済み' } = {}) {
    const els = {
        myAvailStripCard: { style: { display: 'none' } },
        myAvailStripBody: { innerHTML: '' },
        myAvailStripBadge: { style: {}, textContent: '' },
        myAvailConfirmBadge: { style: { display: 'inline-block', color: '#0E9455', background: 'x' }, textContent: badgeText },
    };
    const env = {
        document: { getElementById: (id) => els[id] || null },
        window: {
            availabilityDomain: dom,
            supabaseLoadAvailability: async () => { if (fail) throw new Error('boom'); return slots; },
            supabaseLoadAvailabilityPrefs: async () => prefs,
        },
        getCurrentSlotJST: () => nowSlot,
        HOUR_ORDER: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4],
        _hourKey: (h) => `h${String(h).padStart(2, '0')}`,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        _loadMyAvailConfirm: async () => { },
        _availStripSeq: 0,
        console,
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn renderMyAvailStrip;`)(...keys.map(k => env[k]));
    return { render: fn, els };
}

let pass = 0, fail = 0;
async function test(name, f) {
    try { await f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}

console.log('ホームの戦闘可能時間の帯:\n');

await test('★ 要約・24コマ・いまの時刻・確認バッジが実際に描ける', async () => {
    const t = run({ slots: H(5, 6, 7, 8, 9, 21, 22, 23, 0, 1, 2), nowSlot: 'h07' });
    await t.render({ id: 7 });
    const out = t.els.myAvailStripBody.innerHTML;
    assert.ok(out.includes('5〜9時・21〜翌2時 (11時間)'), `要約が無い: ${out.slice(0, 200)}`);
    assert.ok(out.includes('いま (7時) は戦闘可能時間です — 5〜9時'), '今の時刻の説明が無い');
    assert.equal((out.match(/height:14px/g) || []).length, 24, '24コマ出ていない');
    assert.equal((out.match(/outline:2px solid #FF3D44/g) || []).length, 1, 'いまの時刻の印が1つでない');
    assert.equal((out.match(/background:#6C42F0/g) || []).length, 11, 'ON のコマ数が違う');
    assert.equal(t.els.myAvailStripCard.style.display, '');
    assert.equal(t.els.myAvailStripBadge.textContent, '今季 確認済み');
    assert.ok(!/undefined|NaN/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN).{40}/)?.[0]}`);
});

await test('時間外 / 未登録 / 隙間型 の説明が出る', async () => {
    const a = run({ slots: H(21, 22), nowSlot: 'h13' }); await a.render({ id: 1 });
    assert.ok(a.els.myAvailStripBody.innerHTML.includes('いま (13時) は時間外です'));
    const b = run({ slots: [], nowSlot: 'h13' }); await b.render({ id: 1 });
    assert.ok(b.els.myAvailStripBody.innerHTML.includes('未登録'));
    assert.ok(b.els.myAvailStripBody.innerHTML.includes('時間帯が未登録です'));
    const c = run({ slots: [], prefs: { flexTime: true }, nowSlot: 'h13' }); await c.render({ id: 1 });
    assert.ok(c.els.myAvailStripBody.innerHTML.includes('隙間時間型'));
});

await test('プレイヤー未選択 / 取得失敗 は帯を隠す', async () => {
    const a = run({}); await a.render(null);
    assert.equal(a.els.myAvailStripCard.style.display, 'none');
    const b = run({ fail: true }); await b.render({ id: 1 });
    assert.equal(b.els.myAvailStripCard.style.display, 'none');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
