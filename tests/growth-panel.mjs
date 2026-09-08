// ============================================================================
// 運営タブ「🧬 育成データの取り込み」の描画 (_growthPaint) の実行テスト
//   node tests/growth-panel.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定 (usedCharacters / wantedCodesFor / STATUS_JP) は js/domain/growth.js の本物を使う。
// テンプレートリテラルの未定義参照は実行しないと出ない (2026-09-07 の本番障害と同じ型)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/growth.js';   // globalThis.growthDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const dom = globalThis.growthDomain;

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
const SRC = cut('        function _growthPaint()');

const P = (id, name, openid = null, extra = {}) => ({ id, name, blabla_openid: openid, ...extra });
function run({ players = [], statusRows = [], used = ['ラピ'], wanted = { codes: [1007], missing: [] }, busy = false, msg = null } = {}) {
    const els = { opsGrowthBody: { innerHTML: '' }, opsGrowthCounts: { textContent: '' } };
    const env = {
        _growth: { gen: 0, seasonId: 1, players, statusRows, used, wanted, busy, msg },
        window: { growthDomain: dom },
        document: { getElementById: (id) => els[id] || null },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    };
    const keys = Object.keys(env);
    const paint = new Function(...keys, `${SRC}\nreturn _growthPaint;`)(...keys.map(k => env[k]));
    paint();
    return { html: () => els.opsGrowthBody.innerHTML, counts: () => els.opsGrowthCounts.textContent };
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object Object\]/.test(out),
    `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object Object\]).{40}/)?.[0]}`);

console.log('育成データの取り込みパネル:\n');

test('★ 4段すべて実際に描ける (名寄せ → 生成 → 貼り付け → 結果)', () => {
    const t = run({
        players: [P(1, 'あ', '123456'), P(2, 'い')],
        statusRows: [{ player_id: 1, status: 'ok', character_count: 5 }, { player_id: 2, status: 'no_openid' }],
    });
    const out = t.html();
    assert.equal((out.match(/class="gr-step/g) || []).length, 4, `段が4つでない: ${out.slice(0, 120)}`);
    assert.ok(out.includes('BlaBlaLINK の識別子をひも付ける'));
    assert.ok(out.includes('取り込み用のブックマークレットを作る'));
    assert.ok(out.includes('id="opsGrowthPaste"'), '貼り付け欄が無い');
    assert.ok(out.includes('取り込みの結果'));
    assert.equal(t.counts(), '紐づけ 1/2 · 対象 1体');
    noUndef(out);
});

test('★ 名寄せ: 済みは値つきで印がつき、未設定は空欄。保存はドメインを通す導線', () => {
    const t = run({ players: [P(1, 'あ', '123456'), P(2, 'い')] });
    const out = t.html();
    assert.ok(/<input[^>]*class="set"[^>]*value="123456"/.test(out), '済みの印か値が無い');
    assert.ok(/<input[^>]*class=""[^>]*value=""[^>]*placeholder="未設定"/.test(out), '未設定の欄が無い');
    assert.equal((out.match(/handleGrowthSetOpenid\(\d+, this\.value\)/g) || []).length, 2, '保存の導線が全員に無い');
    noUndef(out);
});

test('生成ボタン: 紐づけゼロ / 対象キャラゼロ なら押せない', () => {
    assert.ok(/handleGrowthCopySnippet\(\)"\s*>/.test(run({ players: [P(1, 'あ', '123456')] }).html()), '押せる状態にならない');
    assert.ok(/handleGrowthCopySnippet\(\)" disabled/.test(run({ players: [P(1, 'あ')] }).html()), '紐づけゼロで押せてしまう');
    assert.ok(/handleGrowthCopySnippet\(\)" disabled/.test(
        run({ players: [P(1, 'あ', '1')], wanted: { codes: [], missing: [] } }).html()), '対象ゼロで押せてしまう');
});

test('対応表に無いキャラは名指しで警告する (黙って対象から外さない)', () => {
    const t = run({ players: [P(1, 'あ', '123456')], wanted: { codes: [1007], missing: ['シフティー', 'シュエン'] } });
    const out = t.html();
    assert.ok(/gr-note warn[^>]*>対応表に無いキャラが 2 体あります \(シフティー・シュエン\)/.test(out), `警告が無い: ${out.slice(-400)}`);
    noUndef(out);
});

test('★ 43 未適用 (statusRows=null) は取り込みを押させず、適用を案内する', () => {
    const t = run({ players: [P(1, 'あ', '123456')], statusRows: null });
    const out = t.html();
    assert.ok(/handleGrowthImport\(\)" disabled/.test(out), '未適用なのに取り込みが押せる');
    assert.ok(out.includes('supabase/43_member_growth.sql'), '適用の案内が無い');
    assert.ok(!out.includes('取り込みの結果'), '結果の段を出している');
    // 列だけ落ちている環境 (growthUnsupported) も同じ扱い
    assert.ok(/handleGrowthImport\(\)" disabled/.test(run({ players: [P(1, 'あ', null, { growthUnsupported: true })] }).html()));
});

test('★ 結果: 取れなかった人だけ理由つきで出す / 全員取れたら done', () => {
    const t = run({
        players: [P(1, 'あ', '1'), P(2, 'い', '2'), P(3, 'う')],
        statusRows: [
            { player_id: 1, status: 'ok', character_count: 5 },
            { player_id: 2, status: 'private' },
            { player_id: 3, status: 'no_openid' },
        ],
    });
    const out = t.html();
    assert.ok(out.includes('取れた 1人 · 取れなかった 2人'));
    assert.ok(/class="st private"[^>]*>非公開</.test(out), '非公開の表示が無い');
    assert.ok(/title="本人が非公開にしています"/.test(out), 'ピルに詳しい言い方が付いていない');
    assert.ok(/class="st no_openid"[^>]*>未ひも付け</.test(out), '未ひも付けの表示が無い');
    assert.ok(!/class="st ok"/.test(out), '取れた人まで並べている (畳むこと)');
    const all = run({ players: [P(1, 'あ', '1')], statusRows: [{ player_id: 1, status: 'ok', character_count: 5 }] }).html();
    assert.ok(/gr-step done[^>]*>[\s\S]*?取り込みの結果/.test(all) && all.includes('全員ぶん取り込めています'));
    noUndef(out);
});

test('取り込み中はボタンと貼り付け欄を止める / 伝言はそのまま出る', () => {
    const t = run({ players: [P(1, 'あ', '1')], busy: true, msg: { kind: 'err', text: '<壊れた>' } });
    const out = t.html();
    assert.ok(out.includes('取り込み中…') && /class="gr-paste"[^>]*disabled/.test(out), '実行中に止めていない');
    assert.ok(out.includes('&lt;壊れた&gt;'), '伝言を素通しでHTMLにしている');
    noUndef(out);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
