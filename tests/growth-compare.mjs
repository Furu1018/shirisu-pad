// ============================================================================
// 🧬 育成くらべ (分析タブのビュー) の実行テスト
//   node tests/growth-compare.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定・並び・順位 (compare / rankSquad / unionRanking / usedTeams) は
// js/domain/growth.js の本物を使う。
//
// ★ この画面が守るべきこと (2026-09-09 実機FB とモックで決めた):
//   ① 「どのレイドを見ているか」を画面が持つ — 最大シーズンに張り付くと、
//      テスト回に取り込みの跡が1件あるだけで本番の全員が「未取得」に見える
//   ② 編成は**その回の凸記録**から作る — 盤面 (loadoutsByAttr) はアクティブ
//      シーズンの模擬なので、終わったレイドの振り返りには使えない
//   ③ 相手は「メンバー」か「ユニオン全体」。全体なら同じ画面が順位表になる
//   ④ キャラ名・メンバー名を onclick に埋めない (引用符で壊れる / 注入できる)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/growth.js';   // globalThis.growthDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const dom = globalThis.growthDomain;

const FROM = '        function handleGrowthAnaSeason(id) {';
const TO = '        // ===== 🧬 育成データの取り込み (43 / 2026-09-09) =====';
const a = html.indexOf(FROM), b = html.indexOf(TO);
if (a < 0 || b < 0 || b < a) { console.error('NG: 目印を切り出せません (関数名が変わった?)'); process.exit(2); }
const SRC = html.slice(a, b);

const RETURN = ['_gvPaint', '_gvViewPT', '_gvViewChar', '_gvUnionCard', '_gvCharCard', '_gcCls',
    'handleGrowthAnaSeason', 'handleGrowthAnaWho', 'handleGrowthAnaView', 'handleGrowthAnaBase',
    'handleGrowthAnaChar', 'handleGrowthAnaSort', 'handleGrowthAnaBurst', 'handleGrowthAnaSearch',
    'handleGrowthAnaOpen', 'handleGrowthAnaRoster', 'openGrowthCompare'];

// 育成1行ぶん。省略した項目は null (未取得) として扱われる
const row = (o = {}) => ({
    character_name: 'ラピ', grade: 3, core: 0, lv: 200, skill1_lv: 7, skill2_lv: 7, ulti_skill_lv: 7,
    combat: 500000, attractive_lv: 20, harmony_cube_lv: 10, favorite_item_lv: 5, overload: null, ...o,
});
const growthRow = (pid, name, o = {}) => ({ player_id: pid, ...row({ character_name: name, ...o }) });
const atk = (pid, team, o = {}) => ({
    player_id: pid, boss_number: 1, boss_code: 'Z.E.U.S.', characters: team, damage_raw: 2e10, ...o,
});

const BURSTS = new Map([['ラピ', 'B2'], ['クラウン', 'B2'], ['モラン', 'B1'], ['ヘルム', 'B3'], ['紅蓮', 'B3']]);

function build({
    players = [{ id: 1, name: 'ふるり' }, { id: 2, name: 'なべりうす' }, { id: 3, name: 'ゆき' }],
    rows = [], teams = [], status = [], me = { id: 1, name: 'ふるり' },
    seasons = [
        { id: 33, month_key: 'TEST-2026', hard_date: '2026-09-08', is_test: true, ok: 1 },
        { id: 30, month_key: '2026-09', hard_date: '2026-09-05', is_test: false, ok: 14 },
    ],
    seasonId = 30, them = null, view = 'pt', base = 'mine', charIdx = -1, q = '', burst = 'all',
    sort = 'combat', open = [], rosterOpen = false,
} = {}) {
    let out = '';
    const els = { growthAnaBody: { set innerHTML(v) { out = v; }, get innerHTML() { return out; } } };
    const calls = { reload: 0 };
    const _gv = {
        gen: 0, seasons, players, seasonId, byPl: dom.byPlayerCharacter(rows),
        chars: dom.charactersIn(rows), status, teams, them, view, base, charIdx, q, burst, sort,
        open: new Set(open.map(String)), rosterOpen, focusQ: false,
    };
    const env = {
        _gv,
        _growthNames: new Map(players.map(p => [String(p.id), p.name])),
        window: { growthDomain: dom },
        document: { getElementById: (id) => els[id] || null },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        getCurrentIdentity: () => me,
        renderAvatarHtml: (p) => `<span class="av">${p && p.name ? p.name[0] : '?'}</span>`,
        resolveNikkeChar: (n) => ({ canonical: n, iconPath: `./character-images/${encodeURIComponent(n)}.webp` }),
        _nikkeCharsByName: new Map([...BURSTS].map(([n, burst]) => [n, { canonical_name: n, burst }])),
        renderGrowthAnalysis: () => { calls.reload++; },
        _gotoSlvView: (v) => { calls.goto = v; },
    };
    const keys = Object.keys(env);
    const fns = new Function(...keys, `${SRC}\nreturn { ${RETURN.join(', ')} };`)(...keys.map(k => env[k]));
    return { ...fns, state: _gv, calls, paint: () => { fns._gvPaint(); return out; } };
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object Object\]/.test(out),
    `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object Object\]).{40}/)?.[0]}`);

const TEAM = ['ラピ', 'クラウン', 'モラン', 'ヘルム', '紅蓮'];
const fullRows = (pid, mul) => TEAM.map(n => growthRow(pid, n, { combat: 400000 * mul, lv: 700 + mul }));
const BASE = {
    rows: [...fullRows(1, 1), ...fullRows(2, 2), ...fullRows(3, 3)],
    teams: [atk(1, TEAM), atk(2, TEAM, { damage_raw: 3e10 })],
    status: [{ player_id: 1, status: 'ok', character_count: 5 }, { player_id: 2, status: 'ok', character_count: 5 },
        { player_id: 3, status: 'ok', character_count: 5 }],
};

console.log('育成くらべ (分析タブ):\n');

test('★ 実際に描ける: レイド選択・相手えらび・見方タブ・編成カード', () => {
    const t = build({ ...BASE, them: 2 });
    const out = t.paint();
    noUndef(out);
    assert.ok(/どのレイドの育成か/.test(out), 'レイド選択が無い');
    assert.ok(/くらべる相手/.test(out), '相手えらびが無い');
    assert.ok(/使った編成でくらべる/.test(out) && /キャラ別にくらべる/.test(out), '見方タブが無い');
    assert.ok(/class="gv-pt"/.test(out), '編成カードが出ていない');
    assert.equal((out.match(/class="gv-tm"/g) || []).length, 5, '5体そろっていない');
});

test('★ ① レイドは選べる。テスト回も本番回も並び、いま見ている回が選ばれている', () => {
    const out = build({ ...BASE, them: 2 }).paint();
    assert.ok(/<option value="33"[^>]*>TEST-2026/.test(out), 'テスト回が出ていない');
    assert.ok(/<option value="30" selected>2026-09/.test(out), '見ている回が選ばれていない');
    assert.ok(/取り込み 14人/.test(out), '何人取り込めた回かが分からない');
    // ★ 既定は「取り込めた人がいる**本番**の最新回」— ドメインが決める
    assert.equal(dom.defaultGrowthSeason([
        { id: 33, is_test: true, ok: 1 }, { id: 30, is_test: false, ok: 14 },
    ]), 30, 'テスト回に張り付いている (実機FB 2026-09-09 の再発)');
});

test('★ ② 編成は「その回の凸記録」から作る (盤面の模擬編成を使わない)', () => {
    const t = build({ ...BASE, them: 2, base: 'them' });
    const out = t.paint();
    assert.ok(/300\.0億/.test(out), '凸記録のダメージが出ていない (相手の編成を見ていない)');
    // 凸記録が無い人は「編成が残っていない」と言う (模擬で埋めない)
    const none = build({ ...BASE, them: 2, teams: [atk(2, TEAM)] }).paint();
    assert.ok(/編成が残っていません/.test(none), '凸記録が無いのに編成が出ている');
    assert.ok(!/loadoutsByAttr|squadsFor/.test(SRC), '盤面の模擬編成をまだ見ている');
});

test('★ ③ ユニオン全体を選ぶと、同じ画面が順位表になる', () => {
    const t = build({ ...BASE, them: null, view: 'pt', open: ['pt0'] });
    const out = t.paint();
    noUndef(out);
    assert.ok(/ユニオン内の順位/.test(out), '順位の見出しが無い');
    assert.ok(/3\/3位/.test(out), '自分の順位が出ていない (自分がいちばん低い育成)');
    assert.ok(/class="gv-rk/.test(out), '順位表が開かない');
    assert.ok(/class="gv-rk me"/.test(out), '自分の行が分からない');
});

test('★ ④ 名前・キャラ名を onclick に埋めない (引用符で壊れる / 注入できる)', () => {
    const evil = 'ラピ" onmouseenter="alert(1)';
    const t = build({
        rows: [growthRow(1, evil), growthRow(2, evil)],
        teams: [atk(1, [evil])], them: 2, view: 'char', charIdx: 0,
        players: [{ id: 1, name: 'ふるり' }, { id: 2, name: '"><img src=x onerror=alert(1)>' }],
    });
    const out = t.paint();
    assert.ok(!/onclick="handleGrowthAnaChar\([^)]*[^0-9)]/.test(out), 'キャラ名を onclick に渡している');
    assert.ok(!/onmouseenter="alert/.test(out), '属性が壊れている (名前をそのまま埋めた)');
    assert.ok(!/<img src=x onerror/.test(out), 'メンバー名から注入できる');
    assert.ok(/&quot;/.test(out), 'エスケープされていない');
});

test('キャラ別: 検索とバースト絞り込みが効く', () => {
    const t = build({ ...BASE, them: 2, view: 'char' });
    const all = t.paint();
    assert.equal((all.match(/class="gv-tile/g) || []).length, 5, 'キャラが5体出ていない');
    t.handleGrowthAnaBurst('B3');
    const b3 = t.paint();
    assert.equal((b3.match(/class="gv-tile/g) || []).length, 2, 'B3 で絞れていない (ヘルムと紅蓮)');
    t.handleGrowthAnaBurst('all');
    t.handleGrowthAnaSearch('クラ');
    const q = t.paint();
    assert.equal((q.match(/class="gv-tile/g) || []).length, 1, '名前でさがせていない');
    assert.ok(/クラウン/.test(q));
    t.handleGrowthAnaSearch('いない子');
    assert.ok(/みつかりません/.test(t.paint()), '0件のときに何も言わない');
});

test('キャラ別 × ユニオン全体: 並べ替えが効く (順位が入れ替わる)', () => {
    const rows = [
        growthRow(1, 'ラピ', { combat: 900000, lv: 100 }),
        growthRow(2, 'ラピ', { combat: 100000, lv: 900 }),
    ];
    const t = build({ rows, teams: [], them: null, view: 'char', charIdx: 0, sort: 'combat' });
    const byCombat = t.paint();
    // ★ 相手えらびにも class="nm" があるので、順位表の行だけを見る
    const order = (s) => [...s.matchAll(/class="gv-rk[^>]*">[\s\S]*?class="nm">([^<]+)/g)].map(m => m[1]);
    assert.deepEqual(order(byCombat).slice(0, 2), ['ふるり', 'なべりうす'], '戦闘力順になっていない');
    t.handleGrowthAnaSort('lv');
    const byLv = t.paint();
    assert.deepEqual(order(byLv).slice(0, 2), ['なべりうす', 'ふるり'], 'レベル順に並べ替えられない');
    assert.ok(/レベル順/.test(byLv), '何順なのか書いていない');
});

test('★ 相手・見方・並べ替えを変えても取り直さない (レイドを変えたときだけ読む)', () => {
    const t = build({ ...BASE, them: 2 });
    t.handleGrowthAnaWho(3); t.handleGrowthAnaView('char'); t.handleGrowthAnaSort('lv');
    t.handleGrowthAnaBase('them'); t.handleGrowthAnaBurst('B2'); t.handleGrowthAnaOpen('pt0');
    assert.equal(t.calls.reload, 0, '相手を変えただけで取り直している');
    t.handleGrowthAnaSeason(30);
    assert.equal(t.calls.reload, 0, '同じレイドを選び直しただけで取り直している');
    t.handleGrowthAnaSeason(33);
    assert.equal(t.calls.reload, 1, 'レイドを変えたのに取り直していない');
    assert.equal(t.state.byPl, null, '前の回のデータが残っている');
    assert.equal(t.state.them, null, '前の回の相手が残っている (その回に居ないかもしれない)');
});

test('自分が未取り込み / 名乗っていない ときは、そう言う', () => {
    const noMe = build({ ...BASE, them: 2, rows: [...fullRows(2, 2), ...fullRows(3, 3)] }).paint();
    assert.ok(/自分の育成が取り込まれていません/.test(noMe), '自分のぶんが無いことを言っていない');
    const anon = build({ ...BASE, them: 2, me: null }).paint();
    assert.ok(/ホームで自分のプレイヤーを選ぶ/.test(anon), '名乗る前の案内が無い');
});

test('取り込みの内訳: 折り畳みを開くと、誰が取れていないか分かる', () => {
    const st = [{ player_id: 1, status: 'ok', character_count: 5 }, { player_id: 2, status: 'private' },
        { player_id: 3, status: 'no_openid' }];
    const shut = build({ ...BASE, status: st, them: null }).paint();
    assert.ok(/育成が取れたのは/.test(shut), '内訳の要約が無い');
    assert.ok(!/本人が非公開にしています/.test(shut), '畳んでいるのに中身が出ている');
    const open = build({ ...BASE, status: st, them: null, rosterOpen: true }).paint();
    assert.ok(/本人が非公開にしています/.test(open) && /識別子が未設定です/.test(open), '理由が出ていない');
});

test('編成カードを開くと、差の大きい順に1体ずつ出る', () => {
    const rows = [
        growthRow(1, 'ラピ', { combat: 500000 }), growthRow(2, 'ラピ', { combat: 500000 }),
        growthRow(1, 'クラウン', { combat: 100000 }), growthRow(2, 'クラウン', { combat: 900000 }),
    ];
    const t = build({ rows, teams: [atk(1, ['ラピ', 'クラウン'])], them: 2, open: ['pt0'] });
    const out = t.paint();
    noUndef(out);
    const cards = [...out.matchAll(/class="cn">([^<]+)/g)].map(m => m[1]);
    assert.deepEqual(cards, ['クラウン', 'ラピ'], '差の大きい順になっていない');
    assert.ok(/\+80\.0万/.test(out), '差が出ていない');
    assert.ok(!/class="gc-tbl"/.test(out), '全項目を畳んでいない');
    t.handleGrowthAnaOpen('pt0_0');
    assert.ok(/class="gc-tbl"/.test(t.paint()), '全項目を開けない');
});

test('キャラのアイコンを出す (名前だけだと編成が読めない)', () => {
    const out = build({ ...BASE, them: 2 }).paint();
    assert.ok(/class="gv-ic [^"]*" src="\.\/character-images\//.test(out), 'アイコンが出ていない');
    const ch = build({ ...BASE, them: 2, view: 'char' }).paint();
    assert.ok(/class="gv-bg">B[0-9Λ]<\/span>/.test(ch), 'バーストのバッジが無い');
});

test('運営タブの名前から開くと、その人を相手にして分析タブへ送る', () => {
    const t = build({ ...BASE });
    t.openGrowthCompare(2);
    assert.equal(t.state.them, 2, '相手が選ばれていない');
    assert.equal(t.calls.goto, 'growth', '育成ビューに送っていない');
    assert.equal(t.state.base, 'them', 'その人が使った編成を出していない');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
