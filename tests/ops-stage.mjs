// ============================================================================
// 運営タブの段階ヘッダ・ヒーロー・チェックリスト (_opsStageBarHtml / _opsStageHeroHtml / _opsStageListHtml) の実行テスト
//   node tests/ops-stage.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 段階の判定・チェックリスト・ヒーローの中身は js/domain/opsStage.js の本物を使う。
// テンプレートリテラルの未定義参照は実行しないと出ない (2026-09-07 の本番障害と同じ型)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/opsStage.js';   // globalThis.opsStageDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const dom = globalThis.opsStageDomain;

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
const SRC = [cut('        function _opsStageBarHtml('), cut('        function _opsStageHeroHtml('), cut('        function _opsStageListHtml(')].join('\n');
const env = {
    window: { opsStageDomain: dom },
    escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
};
const keys = Object.keys(env);
const fns = new Function(...keys, `${SRC}\nreturn { bar: _opsStageBarHtml, hero: _opsStageHeroHtml, list: _opsStageListHtml };`)(...keys.map(k => env[k]));

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]}`);

console.log('運営タブの段階 (ヘッダ・ヒーロー・チェックリスト):\n');
const season = { id: 7, is_active: true, hard_date: '2026-09-11', month_key: '2026-09' };

test('★ 段階ヘッダ: シーズン名・ハード日・4つのセグメント (いまの段階が押された状態)・自動判定の注記', () => {
    const st = dom.detect({ season, now: Date.parse('2026-09-10T12:00:00+09:00') });
    const out = fns.bar(st, season);
    assert.ok(out.includes('2026-09 · 9/11(金)'), `シーズン名とハード日が無い: ${out.slice(0, 160)}`);
    assert.equal((out.match(/handleOpsStageOverride\('(prep|pre|day|end)'\)/g) || []).length, 4, 'セグメントが4つでない');
    assert.equal((out.match(/aria-pressed="true"/g) || []).length, 1);
    assert.ok(/aria-pressed="true"[^>]*onclick="handleOpsStageOverride\('pre'\)"/.test(out), '前日が押された状態でない');
    assert.ok(out.includes('自動判定'), '自動判定の注記が無い');
    assert.ok(!out.includes('に戻す'), '上書きしていないのに「戻す」が出ている');
    noUndef(out);
});

test('段階ヘッダ: 手動で上書き中は「自動 (○○) に戻す」ボタン / シーズン無しは「未作成」', () => {
    const st = dom.detect({ season, now: Date.parse('2026-09-10T12:00:00+09:00'), override: 'day' });
    const out = fns.bar(st, season);
    assert.ok(/手動で「当日」にしています · 自動 \(前日\) に戻す/.test(out), `戻す導線が無い: ${out.slice(-300)}`);
    assert.ok(/onclick="handleOpsStageOverride\(null\)"/.test(out));
    const none = fns.bar(dom.detect({ season: null }), null);
    assert.ok(none.includes('シーズン未作成'));
    noUndef(none);
});

test('★ ヒーロー: 文言・理由・導線 (onclick に action) / 無ければ空', () => {
    const h = dom.hero({ stage: 'pre', rows: dom.checklist({ stage: 'pre', season, bosses: [], mbRows: null, reservations: { pending: 2 }, published: false }), reservations: { pending: 2 } });
    const out = fns.hero(h, 'pre');
    assert.ok(out.includes('承認待ちの予約が 2 件あります'), '文言が無い');
    assert.ok(/onclick="_opsStageAct\('reserve'\)"/.test(out), '導線が無い');
    assert.ok(/class="ops-stage-hero pre"/.test(out));
    assert.equal(fns.hero({ lead: '' }, 'pre'), '');
    const day = fns.hero(dom.hero({ stage: 'day', freshMin: 45 }), 'day');
    assert.ok(day.includes('HP 更新が 45分前 です') && /_opsStageAct\('hp'\)/.test(day));
    noUndef(out); noUndef(day);
});

test('★ チェックリスト: 済み/未完/読み込み中/任意 の印、値、催促ボタンは未完で催促できる行だけ', () => {
    const bosses = [1, 2, 3, 4, 5].map(n => ({ boss_number: n, attribute: 'fire', weakness: 'water', total_hp_raw: 100 }));
    const mbRows = [
        { mockOk: true, availSupported: true, availConfirmed: true, push: true, reasons: [] },
        { mockOk: false, availSupported: true, availConfirmed: false, push: false, reasons: [{ key: 'mock' }, { key: 'availConfirm' }] },
    ];
    const rows = dom.checklist({ stage: 'pre', season, bosses, mbRows, reservations: null, published: false });
    const out = fns.list(rows, 'pre');
    assert.ok(out.includes('配信までにやること'));
    assert.ok(/class="row done"[\s\S]*?ボスの属性と HP[\s\S]*?5\/5/.test(out), 'ボス設定が済みになっていない');
    assert.ok(/class="row todo"[\s\S]*?模擬の提出[\s\S]*?1\/2[\s\S]*?_opsStageAct\('nudge:mock'\)/.test(out), '模擬の行に催促が無い');
    assert.ok(/class="row pending"[\s\S]*?予約の承認[\s\S]*?—/.test(out), '未ロードの予約が「—」でない');
    assert.equal((out.match(/>催促</g) || []).length, 2, '催促ボタンは 模擬 と 時間帯 の2つ');
    assert.ok(!/class="row done"[^]*?>催促</.test(out.split('模擬の提出')[0]), '済みの行に催促が付いている');
    const end = fns.list(dom.checklist({ stage: 'end', season }), 'end');
    assert.ok(end.includes('終了までにやること') && /class="row opt"/.test(end), '終了のリストに任意の行が無い');
    assert.equal(fns.list([], 'day'), '');
    noUndef(out); noUndef(end);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
