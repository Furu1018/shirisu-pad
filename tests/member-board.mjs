// ============================================================================
// 👥 メンバー状況ボード (_mbPaint) の実行テスト
//   node tests/member-board.mjs
// ----------------------------------------------------------------------------
// index.html から _mbPaint の本体を切り出し、DOM と依存をスタブして**実際に描画を実行**する。
// 判定ロジック (js/domain/memberStatus.js) は run-tests.mjs で検証済みなので、ここは
// 「行が組み立てられる」「名前がエスケープされる」「ボタンの出し分け」「undefined が混ざらない」
// といった実行経路だけを見る (plan-hp-modal.mjs と同じ方式・波括弧対応で終端を決める)。
// index.html 側のシグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import '../js/domain/memberStatus.js';   // globalThis.memberStatusDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extract(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker.trim()} を index.html から切り出せませんでした (目印が変わった?)`); process.exit(2); }
    let depth = 0, end = -1, inStr = null, prev = '';
    for (let k = html.indexOf('{', i); k < html.length; k++) {
        const ch = html[k];
        if (inStr) {
            if (ch === inStr && prev !== '\\') inStr = null;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            inStr = ch;
        } else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
        prev = ch;
    }
    if (end < 0) { console.error(`NG: ${marker.trim()} の終端を判定できませんでした`); process.exit(2); }
    return html.slice(i, end);
}

// ---- 依存スタブ (index.html 側の実装に合わせる) ----
const els = {};
const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
globalThis.document = { getElementById: (id) => el(id) };
globalThis.escapeHtml = (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.DC_ATTR_COLORS = { fire: '#FF3D44', water: '#2E8BFF', electric: '#9B4DFF', iron: '#FF8A2B', wind: '#18C26B' };
globalThis.window = globalThis;
globalThis._mb = { phase: null, filter: 'todo', sort: 'why', rows: [], players: null, extras: null, season: null, loading: false };

const _mbPaint = eval(`(${extract('        function _mbPaint(').trim()})`);

const dom = globalThis.memberStatusDomain;
const P = (o) => ({ id: 1, name: 'A', damagesByAttr: {}, attacks: [], syncLevel: 0, syncLevelEstimated: true, availableSlots: [], flexTime: false, notifyAllHours: false, strong_attributes: [], ...o });
const players = [
    P({ id: 1, name: '<script>x</script>', damagesByAttr: { fire: 1 }, strong_attributes: ['fire'] }),
    P({ id: 2, name: '完了さん', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, availableSlots: ['h21', 'h22'], avatar_url: 'https://x/y.png' }),
    P({ id: 3, name: '当日残凸', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 610, syncLevelEstimated: false, flexTime: true, attacks: [{ level: 1, boss_number: 1 }] }),
];
const extras = { pushPlayerIds: [2, 3], slvThisSeasonIds: [2, 3], finishRequests: [{ player_id: 3, status: 'pending' }], proxyEvents: [{ player_id: 3 }] };

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}
console.log('member-board (_mbPaint):');

test('前日・未完のみ: 未完の行だけ描画され、名前はエスケープ、Push未購読の催促は disabled', () => {
    _mb.filter = 'todo'; _mb.sort = 'why';
    _mb.rows = dom.buildRows({ players, extras, phase: 'pre' });
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(!out.includes('<script>'), '名前が生のまま出ている');
    assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'), 'エスケープ済みの名前が出ていない');
    assert.ok(!out.includes('完了さん'), '完了の人が「未完のみ」に出ている');
    assert.ok(/handleOpsMemberNudge\(1\)[^>]*disabled/.test(out), 'Push未購読の催促ボタンが disabled になっていない');
    assert.ok(!out.includes('handleOpsMemberProxy'), '前日に代理凸ボタンが出ている');
    assert.ok(!/undefined|NaN|\[object/.test(out), `描画に undefined/NaN が混ざっている: ${out.slice(0, 200)}`);
    assert.ok(el('opsMbSummary').innerHTML.includes('模擬 5属性'), '前日の集計が出ていない');
    assert.equal(el('opsMbFilterTodo').textContent, '未完のみ (1)');
    assert.equal(el('opsMbFilterAll').textContent, '全員 (3)');
    assert.equal(el('opsMbPhasePre').attrs['aria-pressed'], 'true');
});

test('前日・全員: 完了の行は ✓ で出る / アバター画像は src がエスケープされる', () => {
    _mb.filter = 'all';
    _mbPaint('pre');
    const out = el('opsMbRows').innerHTML;
    assert.ok(out.includes('完了さん'));
    assert.ok(out.includes('src="https://x/y.png"'));
    assert.ok(out.includes('⏳隙間型'), '隙間型の表示が無い');
    assert.ok(out.includes('dc-mb-strip'), '時間帯バーが無い');
});

test('当日: 凸 L1 表示・代理バッジ・締め凸未返答・代理凸ボタン (凸3未満のみ)', () => {
    _mb.filter = 'todo';
    _mb.rows = dom.buildRows({ players, extras, phase: 'day' });
    _mbPaint('day');
    const out = el('opsMbRows').innerHTML;
    assert.ok(out.includes('<i class="d">L1</i>'), '凸の Lv が出ていない');
    assert.ok(out.includes('代理'), '代理バッジが無い');
    assert.ok(out.includes('締め凸 未返答'));
    assert.ok(out.includes('handleOpsMemberProxy(3)'), '当日の代理凸ボタンが無い');
    assert.ok(out.includes('handleOpsMemberProxy(2)'), '当日は凸0/3の人も要対応 (代理凸ボタンあり)');
    // 3凸完了の人には代理凸ボタンを出さない
    _mb.rows = dom.buildRows({ players: [P({ id: 9, name: '三凸', damagesByAttr: { fire: 1, water: 1, electric: 1, iron: 1, wind: 1 }, syncLevel: 600, syncLevelEstimated: false, availableSlots: ['h21'], attacks: [{ level: 1 }, { level: 2 }, { level: 3 }] })], extras: { ...extras, pushPlayerIds: [9], slvThisSeasonIds: [9] }, phase: 'day' });
    _mb.filter = 'all';
    _mbPaint('day');
    const out2 = el('opsMbRows').innerHTML;
    assert.ok(!out2.includes('handleOpsMemberProxy(9)'), '3凸完了の人に代理凸ボタンが出ている');
    assert.ok(out2.includes('<i class="d">L3</i>'));
    _mb.filter = 'todo';
    _mb.rows = dom.buildRows({ players, extras, phase: 'day' });
    _mbPaint('day');
    assert.ok(el('opsMbSummary').innerHTML.includes('3凸 完了'), '当日の集計が出ていない');
    assert.equal(el('opsMbPhaseDay').attrs['aria-pressed'], 'true');
    assert.ok(!/undefined|NaN/.test(out));
});

test('行が0件のときは案内文だけ', () => {
    _mb.rows = dom.buildRows({ players: [players[1]], extras, phase: 'pre' });
    _mb.filter = 'todo';
    _mbPaint('pre');
    assert.ok(el('opsMbRows').innerHTML.includes('要対応のメンバーはいません'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
