// ============================================================================
// 📈 消化のペース / 🔁 直近の動き (運営ボード 当日・段階4) の描画の実行テスト
//   node tests/ops-pace.mjs
// ----------------------------------------------------------------------------
// index.html から renderOpsPace / renderOpsRecent とその小さな道具を切り出し、
// 依存をスタブして**実際に実行**する。判定は js/domain/pace.js の本物を使う。
// テンプレートリテラルの未定義参照は実行しないと出ない (2026-09-07 の本番障害と同じ型)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/pace.js';   // globalThis.paceDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const dom = globalThis.paceDomain;

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
const SRC = [
    cut('        const _opsHm = (msv) => {') + ';',
    cut('        function _opsRaidEndMs(season)'),
    cut('        function _opsFlatAttacks(snap)'),
    cut('        function renderOpsPace()'),
    cut('        function renderOpsRecent()'),
].join('\n');

const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
const jstHour = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false }).format(d));
};
// レイド日 = いまの 5 時間前の JST 日付 (5時〜翌4時59分が1日)。終わり (翌5時) が必ず未来になる
const raidDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 5 * 3600e3));
const iso = (dMin) => new Date(Date.now() + dMin * 60e3).toISOString();

function run({ snap, finishReqs = [] } = {}) {
    const els = {
        opsPaceBody: { innerHTML: '' }, opsPaceMeta: { textContent: 'x' },
        opsRecentBody: { innerHTML: '' }, opsRecentMeta: { textContent: 'x' },
    };
    const env = {
        document: { getElementById: (id) => els[id] || null },
        opsStore: { get: () => snap },
        window: { paceDomain: dom },
        HOUR_ORDER, _planJstHour: jstHour,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        DC_ATTR_COLORS: { fire: '#FF3D44', water: '#2E8BFF', electric: '#9B4DFF', iron: '#FF8A2B', wind: '#18C26B' },
        _FINISH_REQ_STATUS: {
            pending: { label: '確認中', color: 'var(--warn-deep)', bg: 'var(--warn-bg)' },
            accepted: { label: '了承済み', color: 'var(--ok-deep)', bg: 'var(--ok-bg)' },
            declined: { label: '不可', color: 'var(--t-muted)', bg: 'var(--s2)' },
        },
        _finishReqCache: finishReqs,
        console,
    };
    const keys = Object.keys(env);
    const api = new Function(...keys, `${SRC}\nreturn { renderOpsPace, renderOpsRecent, _opsRaidEndMs };`)(...keys.map(k => env[k]));
    return { ...api, els };
}
const season = { id: 45, hard_date: raidDate, current_level: 2 };
const bosses = [{ boss_number: 1, attribute: 'fire' }, { boss_number: 2, attribute: 'water' }, { boss_number: 3, attribute: 'iron' }];
const players = (atk) => [
    { id: 1, name: 'なべりうす', attacks: atk[0] || [] },
    { id: 2, name: '<b>x', attacks: atk[1] || [] },
    { id: 3, name: 'C', attacks: atk[2] || [] },
    { id: 4, name: 'D', attacks: [], unavailableThisSeason: true },
];

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]}`);

console.log('📈 消化のペース / 🔁 直近の動き:\n');

test('★ 📈 24本の棒・いまの印・消化/定員・使い切る見込みが実際に描ける', () => {
    const t = run({ snap: { season, bosses, players: players([
        [{ boss_number: 1, level: 2, damage_raw: 31.2e9, reported_at: iso(-50) }, { boss_number: 2, level: 2, damage_raw: 40e9, reported_at: iso(-20) }],
        [{ boss_number: 3, level: 2, damage_raw: 12e9, reported_at: iso(-5) }],
    ]) } });
    t.renderOpsPace();
    const out = t.els.opsPaceBody.innerHTML;
    noUndef(out);
    assert.equal((out.match(/<i class="/g) || []).length, 24, '24本の棒が出ていない');
    assert.equal((out.match(/class="[^"]*\bnow\b[^"]*" style="height/g) || []).length, 1, 'いまの時間帯の印が1本でない');
    assert.ok((out.match(/class="on/g) || []).length >= 1, '凸のある時間帯の棒が塗られていない');
    assert.equal(t.els.opsPaceMeta.textContent, '3 / 9凸', '消化 / 定員 (難しい人は数えない)');
    assert.ok(out.includes('残り <b>6凸</b>'), `残りが無い: ${out.slice(-260)}`);
    assert.ok(/に使い切る<\/b>見込み/.test(out), `見込み時刻が無い: ${out.slice(-260)}`);
    assert.ok(/<span class="">5<\/span>|<span class="now">5<\/span>/.test(out), '目盛りの 5 時が無い');
});

test('★ 📈 翌5時までに使い切れないときは赤で言う / 全部消化 / 直近に凸なし / 時刻不明の件数', () => {
    const three = [[{ boss_number: 1, level: 2, damage_raw: 1e9, reported_at: iso(-50) }, { boss_number: 2, level: 2, damage_raw: 1e9, reported_at: iso(-20) }, { boss_number: 3, level: 2, damage_raw: 1e9, reported_at: iso(-5) }]];
    const over = run({ snap: { season: { ...season, hard_date: '2020-01-01' }, bosses, players: players(three) } });
    over.renderOpsPace();
    assert.ok(/class="bad">このペースだと翌5時までに使い切れません/.test(over.els.opsPaceBody.innerHTML), '使い切れないことを言っていない');
    const full = run({ snap: { season, bosses, players: players([three[0], three[0], three[0]]) } });
    full.renderOpsPace();
    assert.ok(full.els.opsPaceBody.innerHTML.includes('<b>9凸すべて消化</b>'), '全部消化を言っていない');
    assert.equal(full.els.opsPaceMeta.textContent, '9 / 9凸');
    const stale = run({ snap: { season, bosses, players: players([[{ boss_number: 1, level: 2, damage_raw: 1e9, reported_at: iso(-300) }]]) } });
    stale.renderOpsPace();
    assert.ok(/直近 \d+ 分は凸がありません/.test(stale.els.opsPaceBody.innerHTML), 'ペース 0 の言い方が違う');
    const unk = run({ snap: { season, bosses, players: players([[{ boss_number: 1, level: 2, damage_raw: 1e9, reported_at: iso(-5) }, { boss_number: 1, level: 2, damage_raw: 1e9, reported_at: null }]]) } });
    unk.renderOpsPace();
    assert.ok(unk.els.opsPaceBody.innerHTML.includes('時刻の分からない凸 1'), '時刻不明の凸を黙って消している');
    noUndef(over.els.opsPaceBody.innerHTML + full.els.opsPaceBody.innerHTML + stale.els.opsPaceBody.innerHTML + unk.els.opsPaceBody.innerHTML);
    // 終わりの計算: ハード日の翌 5 時 JST。読めなければ null
    assert.equal(over._opsRaidEndMs({ hard_date: '2026-09-11' }), Date.parse('2026-09-12T05:00:00+09:00'));
    assert.equal(over._opsRaidEndMs({ hard_date: 'x' }), null);
    assert.equal(over._opsRaidEndMs(null), null);
});

test('★ 🔁 打診の状態 (名前 + 返事のチップ + 期限) が主役、直近の凸が添え。名前はエスケープ', () => {
    const finishReqs = [
        { id: 1, boss_number: 3, player_id: 1, name: 'なべりうす', status: 'pending',  requested_at: iso(-10), offer_id: 'o1', plan_key: 'p1', deadline_at: iso(5), raid_level: 2 },
        { id: 2, boss_number: 3, player_id: 2, name: '<b>x',      status: 'accepted', requested_at: iso(-10), offer_id: 'o1', plan_key: 'p1', deadline_at: iso(5), raid_level: 2 },
        { id: 3, boss_number: 2, player_id: 3, name: 'C',         status: 'declined', requested_at: iso(-30), raid_level: 2 },
    ];
    const t = run({ finishReqs, snap: { season, bosses, players: players([
        [{ boss_number: 1, level: 2, damage_raw: 34.2e9, reported_at: iso(-50) }],
        [{ boss_number: 3, level: 2, damage_raw: 12.05e9, reported_at: iso(-5) }],
    ]) } });
    t.renderOpsRecent();
    const out = t.els.opsRecentBody.innerHTML;
    noUndef(out);
    assert.equal(t.els.opsRecentMeta.textContent, '返事待ち 1');
    assert.ok(out.includes('🏁 締め凸の打診') && out.includes('⚔️ 直近の凸'), '2つの見出しが無い');
    assert.ok(/なべりうす<span class="st"[^>]*>確認中<\/span>/.test(out), '返事待ちのチップが無い');
    assert.ok(/&lt;b&gt;x<span class="st"[^>]*>了承済み<\/span>/.test(out), '名前をエスケープしていない / 了承のチップが無い');
    assert.ok(/C<span class="st"[^>]*>不可<\/span>/.test(out), '不可のチップが無い');
    assert.ok(/class="d bad">不可あり</.test(out), '不可の案を目立たせていない');
    assert.ok(/class="d ">〜\d{2}:\d{2}</.test(out), '期限の時刻が無い');
    assert.ok(out.includes('title="返事待ち · 同時打診"'), '同時打診の印が無い');
    // ボスのチップは属性色の薄い地 (B3 は鉄甲)
    assert.ok(out.includes('style="background:#FF8A2B1f;">B3</span>'), 'ボスの色が属性に合っていない');
    // 添えの凸: 新しい順 (B3 12.1B が先)
    const i1 = out.indexOf('12.1B'), i2 = out.indexOf('34.2B');
    assert.ok(i1 > 0 && i2 > i1, `直近の凸が新しい順でない: ${out.slice(out.indexOf('⚔️'))}`);
    assert.ok((out.match(/class="t">\d{2}:\d{2}</g) || []).length === 2, '凸の時刻が出ていない');
    // 打診が無いとき
    const none = run({ finishReqs: [], snap: { season, bosses, players: players([]) } });
    none.renderOpsRecent();
    assert.ok(none.els.opsRecentBody.innerHTML.includes('いま出している打診はありません'), '打診なしの言い方が無い');
    assert.ok(none.els.opsRecentBody.innerHTML.includes('まだ凸の報告がありません'), '凸なしの言い方が無い');
    assert.equal(none.els.opsRecentMeta.textContent, '');
    // 上限を超えたぶんは件数だけ
    const many = run({ finishReqs: Array.from({ length: 8 }, (_, i) => ({ id: i, boss_number: (i % 5) + 1, player_id: 10 + i, name: `P${i}`, status: 'pending', requested_at: iso(-i), offer_id: `o${i}`, plan_key: 'p', deadline_at: iso(9), raid_level: 2 })), snap: { season, bosses, players: players([]) } });
    many.renderOpsRecent();
    assert.ok(many.els.opsRecentBody.innerHTML.includes('ほか 2 件は締め凸候補検索で'), '溢れた件数を言っていない');
});

test('シーズン無し / 盤面未ロード は「始まると出る」に', () => {
    const t = run({ snap: null });
    t.renderOpsPace(); t.renderOpsRecent();
    assert.ok(t.els.opsPaceBody.innerHTML.includes('シーズンが始まると'));
    assert.ok(t.els.opsRecentBody.innerHTML.includes('シーズンが始まると'));
    assert.equal(t.els.opsPaceMeta.textContent, ''); assert.equal(t.els.opsRecentMeta.textContent, '');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
