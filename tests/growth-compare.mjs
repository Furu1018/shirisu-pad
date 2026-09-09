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
    'handleGrowthAnaOpen', 'handleGrowthAnaRoster', 'openGrowthCompare', 'handleGrowthAnaAttr', 'handleGrowthAnaDps', 'handleGrowthAnaDpsOnly', '_gvBurstInk', '_gvBurstColor'];

// 育成1行ぶん。省略した項目は null (未取得) として扱われる
const row = (o = {}) => ({
    character_name: 'ラピ', grade: 3, core: 0, lv: 200, skill1_lv: 7, skill2_lv: 7, ulti_skill_lv: 7,
    combat: 500000, attractive_lv: 20, favorite_item_lv: 5,
    // ★ くらべの基準は 2026-09-09 にオーバーロード合計 (有利コード＋攻撃) へ移った。
    //   戦闘力はシンクロレベルの差がそのまま出るだけなので、上下の基準には使わない
    overload: { 有利コード: 5, 攻撃力: 5 }, ...o,
});
/** 有利コード＋攻撃 が n% になるオーバーロード */
const ol = (n) => ({ overload: { 有利コード: n / 2, 攻撃力: n / 2 } });
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
    seasonId = 30, them = null, view = 'pt', base = 'mine', charIdx = -1, q = '', burst = 'all', attr = 'all',
    sort = null, open = [], rosterOpen = false, bursts = null, elems, burstColors = null,   // null = growthDomain.DEFAULT_SORT (オーバーロード合計)
} = {}) {
    let out = '';
    const els = { growthAnaBody: { set innerHTML(v) { out = v; }, get innerHTML() { return out; } } };
    const calls = { reload: 0 };
    const _gv = {
        gen: 0, seasons, players, seasonId, byPl: dom.byPlayerCharacter(rows),
        chars: dom.charactersIn(rows), status, teams, them, view, base, charIdx, q, burst, attr, sort,
        // 属性は data/blabla-name-codes.json 由来。テストでは固定の表を渡す (elems で差し替えられる)
        elems: elems === undefined ? new Map([['ラピ', 'fire'], ['クラウン', 'water'], ['モラン', 'wind'], ['ヘルム', 'iron'], ['紅蓮', 'fire']])
            : (elems ? new Map(Object.entries(elems)) : null),
        open: new Set(open.map(String)), rosterOpen, focusQ: false, dps: null, tmNames: [], dpsOnly: false,
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
        _nikkeCharsByName: new Map([...BURSTS, ...Object.entries(bursts || {})].map(([n, burst]) => [n, { canonical_name: n, burst }])),
        TE_BURST_COLOR: burstColors || { B1: '#1FA95C', B2: '#F2B705', B3: '#E5484D', 'BΛ': '#8B5CF6' },
        PT_ATTRS: [
            { key: 'fire', name: '灼熱', icon: './属性アイコン/灼熱.png', color: '#FF3B30' },
            { key: 'water', name: '水冷', icon: './属性アイコン/水冷.png', color: '#007AFF' },
            { key: 'electric', name: '電撃', icon: './属性アイコン/電撃.png', color: '#8E44AD' },
            { key: 'iron', name: '鉄甲', icon: './属性アイコン/鉄甲.png', color: '#FF9500' },
            { key: 'wind', name: '風圧', icon: './属性アイコン/風圧.png', color: '#34C759' },
        ],
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

// 編成の1枠ぶんを読む。★ アイコンとクイックが**同じ枠に入っているか**を見る
function tmCells(out) {
    return out.split('class="gv-tm').slice(1).map((chunk) => ({
        name: chunk.match(/alt="([^"]+)"/)?.[1] || '',
        dps: chunk.startsWith(' dps'),
        q: [...chunk.matchAll(/class="q ([a-z]+)"><i>([^<]+)<\/i>([^<]*)</g)]
            .map(m => ({ short: m[2], text: m[3], lead: m[1] })),
        miss: chunk.match(/class="g none">([^<]+)</)?.[1] || null,
    }));
}
const qOf = (c, short) => c.q.find(x => x.short === short) || {};

const TEAM = ['ラピ', 'クラウン', 'モラン', 'ヘルム', '紅蓮'];
const fullRows = (pid, mul) => TEAM.map(n => growthRow(pid, n, { combat: 400000 * mul, lv: 700 + mul, ...ol(10 * mul) }));
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
    assert.equal(tmCells(out).length, 5, '5体そろっていない');
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
    // ★ 並べ替えはオーバーロードだけ (2026-09-09 ユーザー要望)
    const rows = [
        growthRow(1, 'ラピ', { overload: { 有利コード: 20, 攻撃力: 2 } }),
        growthRow(2, 'ラピ', { overload: { 有利コード: 1, 攻撃力: 30 } }),
    ];
    const t = build({ rows, teams: [], them: null, view: 'char', charIdx: 0 });
    // ★ 相手えらびにも class="nm" があるので、順位表の行だけを見る
    const order = (s) => [...s.matchAll(/class="gv-rk[^>]*">[\s\S]*?class="nm">([^<]+)/g)].map(m => m[1]);
    // 既定は合計 (22 vs 31) → なべりうすが上
    assert.deepEqual(order(t.paint()).slice(0, 2), ['なべりうす', 'ふるり'], '合計順になっていない');
    t.handleGrowthAnaSort(dom.OL_PREFIX + '有利コード');
    const byElem = t.paint();
    assert.deepEqual(order(byElem).slice(0, 2), ['ふるり', 'なべりうす'], '有利コード順に並べ替えられない');
    assert.ok(/有利コード順/.test(byElem), '何順なのか書いていない');
    // 選べなくなったキーを渡しても既定に倒れる (押されていないのに別の順で並ばない)
    t.handleGrowthAnaSort('combat');
    assert.equal(t.state.sort, dom.DEFAULT_SORT, '古いキーをそのまま覚えている');
    assert.deepEqual(order(t.paint()).slice(0, 2), ['なべりうす', 'ふるり']);
});

test('★ 並べ替えのピルはオーバーロードだけ', () => {
    const rows = [growthRow(1, 'ラピ'), growthRow(2, 'ラピ')];
    const out = build({ rows, teams: [], them: null, view: 'char', charIdx: 0 }).paint();
    const pills = /class="gv-pills gv-sorts"[^>]*>([\s\S]*?)<\/div>/.exec(out)?.[1] || '';
    const labels = [...pills.matchAll(/>([^<]+)<\/button>/g)].map(m => m[1]);
    assert.equal(labels.length, 10, `並べ替えの数が違う: ${labels.join('/')}`);
    assert.equal(labels[0], '有利コード＋攻撃');
    for (const gone of ['戦闘力', '突破', 'レベル', '好感度']) {
        assert.ok(!labels.includes(gone), `${gone} が並べ替えに残っている`);
    }
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
        growthRow(1, 'ラピ', ol(10)), growthRow(2, 'ラピ', ol(10)),
        growthRow(1, 'クラウン', ol(4)), growthRow(2, 'クラウン', ol(30)),
    ];
    const t = build({ rows, teams: [atk(1, ['ラピ', 'クラウン'])], them: 2, open: ['pt0'] });
    const out = t.paint();
    noUndef(out);
    const cards = [...out.matchAll(/class="cn">([^<]+)/g)].map(m => m[1]);
    assert.deepEqual(cards, ['クラウン', 'ラピ'], '差の大きい順になっていない');
    assert.ok(/\+26\.00%/.test(out), '差が出ていない');
    assert.ok(!/class="gc-tbl"/.test(out), '全項目を畳んでいない');
    t.handleGrowthAnaOpen('pt0_0');
    assert.ok(/class="gc-tbl"/.test(t.paint()), '全項目を開けない');
});

test('★ キャラ別: 属性でも絞れる (バーストだけでは PT を組む基準に足りない)', () => {
    const rows = TEAM.flatMap(n => [growthRow(1, n), growthRow(2, n)]);
    const all = build({ rows, teams: [], them: 2, view: 'char' }).paint();
    assert.ok(/data-attr="fire"/.test(all), '属性の絞り込みが出ていない');
    const names = (out) => [...out.matchAll(/class="gv-tile[^"]*"[\s\S]*?class="cn">([^<]+)</g)].map(m => m[1]);
    assert.equal(names(all).length, TEAM.length, '絞る前から全部出ていない');

    // 灼熱はラピと紅蓮の2体 (ハーネスの固定表)
    const fire = build({ rows, teams: [], them: 2, view: 'char', attr: 'fire' }).paint();
    assert.deepEqual(names(fire).sort(), ['ラピ', '紅蓮'].sort(), '属性で絞れていない');
    assert.ok(/data-attr="fire"[^>]*aria-pressed="true"/.test(fire), '選んだ属性が押された状態になっていない');

    // 属性 × バースト の重ねがけ (ラピは B2 / 紅蓮は B3)
    const fireB3 = build({ rows, teams: [], them: 2, view: 'char', attr: 'fire', burst: 'B3' }).paint();
    assert.deepEqual(names(fireB3), ['紅蓮'], '属性とバーストを重ねられていない');
    // 該当なしはそう言う
    assert.ok(/みつかりません/.test(build({ rows, teams: [], them: 2, view: 'char', attr: 'water', burst: 'B3' }).paint()));
});

test('★ 知らない属性キーでキャラ一覧を空にしない', () => {
    // どのキャラとも一致せず全部消える = 画面が壊れたように見える (Codex指摘 2026-09-09)
    const rows = TEAM.flatMap(n => [growthRow(1, n), growthRow(2, n)]);
    const names = (out) => [...out.matchAll(/class="gv-tile[^"]*"[\s\S]*?class="cn">([^<]+)</g)].map(m => m[1]);
    for (const bad of ['なにこれ', '', null, undefined, 'FIRE']) {
        const out = build({ rows, teams: [], them: 2, view: 'char', attr: bad }).paint();
        assert.equal(names(out).length, TEAM.length, `attr=${JSON.stringify(bad)} でキャラが消えた`);
        assert.ok(/data-attr="all"[^>]*aria-pressed="true"/.test(out), `attr=${JSON.stringify(bad)} で「すべて」が押されていない`);
    }
    // 押したときも同じ — 知らない値は受け付けずに「すべて」に倒す
    const t = build({ rows, teams: [], them: 2, view: 'char' });
    t.handleGrowthAnaAttr('なにこれ');
    assert.equal(t.state.attr, 'all', '知らない値をそのまま覚えている');
    assert.equal(names(t.paint()).length, TEAM.length);
});

test('★ 属性表が読めなくても画面は出る (絞り込みが出ないだけ)', () => {
    const rows = TEAM.flatMap(n => [growthRow(1, n), growthRow(2, n)]);
    const t = build({ rows, teams: [], them: 2, view: 'char' });
    t.state.elems = new Map();          // 静的ファイルの読み込みに失敗した状態
    const out = t.paint();
    assert.ok(!/data-attr=/.test(out), '引けないのに属性の絞り込みを出している');
    const names = [...out.matchAll(/class="gv-tile[^"]*"[\s\S]*?class="cn">([^<]+)</g)].map(m => m[1]);
    assert.equal(names.length, TEAM.length, '属性が引けないとキャラが消えてしまう');
});

test('キャラのアイコンを出す (名前だけだと編成が読めない)', () => {
    const out = build({ ...BASE, them: 2 }).paint();
    assert.ok(/class="gv-ic [^"]*" src="\.\/character-images\//.test(out), 'アイコンが出ていない');
    const ch = build({ ...BASE, them: 2, view: 'char' }).paint();
    assert.ok(/class="gv-bg" style="--b-c:#[0-9A-Fa-f]{6};--b-ink:#[0-9A-Fa-f]{6};">B[0-9Λ]<\/span>/.test(ch),
        'バーストのバッジが無い / 色か文字色が付いていない');
    assert.ok(/class="gv-b" style="--b-c:#[0-9A-Fa-f]{6};"[^>]*><i class="dot"><\/i>B/.test(ch),
        'バーストのピルに色の点が無い');
});

test('★ 記録が無い人 (overload: null) を 0 として比べない', () => {
    // {} は「取り込めたが1枠も無い」= 本当に 0。null は記録そのものが無い — 別物
    const rows = [
        growthRow(1, 'ラピ', { overload: null }), growthRow(2, 'ラピ', ol(20)),
        growthRow(1, 'モラン', { overload: {} }), growthRow(2, 'モラン', ol(20)),
    ];
    const out = build({ rows, teams: [atk(1, ['ラピ', 'モラン'])], them: 2 }).paint();
    const [lapi, moran] = tmCells(out);
    assert.equal(qOf(lapi, '攻').text, '—', '記録が無いのに 0.00% と出している');
    assert.equal(qOf(lapi, '攻').lead, 'none', '記録が無い人を比べている');
    assert.equal(qOf(moran, '攻').text, '0.00%', '本当に0の人を「未取得」にしている');
    assert.equal(qOf(moran, '攻').lead, 'up', '0 と 20 を互角にしている');
});

test('★ 編成のアイコンと差がずれない (キャラ名の行そのものを回す)', () => {
    // 添字で teamGaps と突き合わせると、片方にしか無い体が落ちたときに1つずつずれる
    const rows = [
        growthRow(1, 'ラピ', ol(10)), growthRow(2, 'ラピ', ol(30)),
        growthRow(1, 'アリス', ol(50)),   // 相手は持っていない
        growthRow(1, 'モラン', ol(20)), growthRow(2, 'モラン', ol(20)),
    ];
    const t = build({ rows, teams: [atk(1, ['ラピ', 'アリス', 'モラン'])], them: 2 });
    const out = t.paint();
    const cells = tmCells(out);
    assert.deepEqual(cells.map(c => c.name), ['ラピ', 'アリス', 'モラン'], '並びが崩れている');
    // 出す値は**この編成の持ち主** (既定は自分)。色は自分と相手のどちらが上か
    assert.deepEqual(cells.map(c => [qOf(c, '攻').text, qOf(c, '攻').lead]),
        [['5.00%', 'up'], ['25.00%', 'none'], ['10.00%', 'flat']],
        `アイコンとクイックがずれている: ${JSON.stringify(cells.map(c => c.q))}`);
    assert.equal(cells[1].miss, 'なべりうす は未取得', '片方しか無いことを言っていない');
});

test('★ アイコンの下に 突破/スキル/攻撃/有利コード を出す (開かずに読める)', () => {
    const t = build({ ...BASE, them: 2 });
    const [c] = tmCells(t.paint());
    assert.deepEqual(c.q.map(x => x.short), ['凸', 'ｽｷﾙ', '攻', '有'], '出す項目か順番が違う');
    assert.match(qOf(c, 'ｽｷﾙ').text, /^\d+\/\d+\/\d+$/, 'S1/S2/バーストが1行になっていない');
});

test('★ クイックに出すのは「この編成の持ち主」の値 (相手の編成なら相手の値)', () => {
    const rows = [growthRow(1, 'ラピ', ol(10)), growthRow(2, 'ラピ', ol(30))];
    const t = build({ rows, teams: [atk(1, ['ラピ']), atk(2, ['ラピ'], { damage_raw: 1e10 })], them: 2 });
    assert.equal(qOf(tmCells(t.paint())[0], '攻').text, '5.00%', '自分の編成なのに自分の値を出していない');
    t.handleGrowthAnaBase('them');
    assert.equal(qOf(tmCells(t.paint())[0], '攻').text, '15.00%', '相手の編成なのに自分の値を出している');
    // 色はどちらの編成でも「自分と相手のどちらが上か」
    assert.equal(qOf(tmCells(t.paint())[0], '攻').lead, 'up', '色が持ち主基準になっている');
});

test('★ 火力役: 既定はバースト3。押すと入り切りでき、要約は火力役だけの合計', () => {
    // ユニオンレイドの火力は火力役の 有利コード＋攻撃 で決まる。バフ役を混ぜると意味が薄れる
    const t = build({ ...BASE, them: 2 });
    let cells = tmCells(t.paint());
    assert.deepEqual(cells.filter(c => c.dps).map(c => c.name), ['ヘルム', '紅蓮'],
        `既定の火力役がバースト3になっていない: ${JSON.stringify(cells.map(c => [c.name, c.dps]))}`);
    // 押すと入り切りできる (指定数に上限なし)
    const i = cells.findIndex(c => c.name === 'クラウン');
    t.handleGrowthAnaDps(i);
    cells = tmCells(t.paint());
    assert.ok(cells.find(c => c.name === 'クラウン').dps, '手で足せない');
    t.handleGrowthAnaDps(cells.findIndex(c => c.name === 'ヘルム'));
    cells = tmCells(t.paint());
    assert.ok(!cells.find(c => c.name === 'ヘルム').dps, '既定の火力役を手で外せない');
});

test('★ 火力役を選んだ効き目が、編成ごとに出る (選んで終わりにしない)', () => {
    // 全編成をまとめた要約だけだと、選んだ手ごたえが無い (実機FB 2026-09-10)
    const t = build({ ...BASE, them: 2 });
    let out = t.paint();
    const bar = () => out.match(/class="gv-dpsbar[^"]*">([\s\S]*?)<\/div>/)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    assert.match(bar(), /⚡ 火力役 2体 有利＋攻撃/, '編成ごとの火力役の帯が出ていない');
    assert.match(bar(), /自分 [\d.]+% .* [\d.]+% 差 [\d.]+%/, '自分・相手・差が出ていない');
    // 火力役を1体増やすと、その場の数字が変わる
    const before = bar();
    t.handleGrowthAnaDps(tmCells(out).findIndex(c => c.name === 'クラウン'));
    out = t.paint();
    assert.match(bar(), /⚡ 火力役 3体/, '足した火力役が帯に効いていない');
    assert.notEqual(bar(), before, '火力役を変えても数字が動かない');
    // 全部外すと、その旨を言う
    for (const nm of ['ヘルム', '紅蓮', 'クラウン']) {
        t.handleGrowthAnaDps(tmCells(t.paint()).findIndex(c => c.name === nm));
    }
    out = t.paint();
    assert.match(bar(), /火力役が選ばれていません/, '0体のときに何も言わない');
});

test('★ ユニオン全体でも火力役が効く (編成の火力役の合計で何位か)', () => {
    // ここで効かないと、いちばん使う画面で選んだ意味が無くなる
    const t = build({ ...BASE, them: null, view: 'pt' });
    const out = t.paint();
    const bar = out.match(/class="gv-dpsbar[^"]*">([\s\S]*?)<\/div>/)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    assert.match(bar, /⚡ 火力役 2体の合計/, '火力役の合計を出していない');
    assert.match(bar, /3位 \/ 3人中/, `ユニオン内の順位が出ていない: ${bar}`);
});

test('★ キャラ別を「火力役だけ」で絞れる', () => {
    const t = build({ ...BASE, them: 2, view: 'char' });
    assert.equal((t.paint().match(/class="gv-tile/g) || []).length, 5);
    t.handleGrowthAnaDpsOnly();
    const out = t.paint();
    assert.equal((out.match(/class="gv-tile/g) || []).length, 2, '火力役だけに絞れていない');
    assert.ok(/ヘルム/.test(out) && /紅蓮/.test(out), '残る顔ぶれが違う');
});

test('★ バーストの値が変でも style に流し込まない (constructor などの継承した鍵)', () => {
    // 対応表に無い値なら既定色に倒れるが、Object.prototype 由来の鍵は「無い」とは限らない
    const t = build({
        rows: [growthRow(1, 'あやしい'), growthRow(2, 'あやしい')],
        teams: [atk(1, ['あやしい'])], them: 2, view: 'char',
        bursts: { あやしい: 'constructor' },
    });
    const out = t.paint();
    assert.ok(!/--b-c:function|--b-c:\[object/.test(out), 'style に関数が流れ込んでいる');
    assert.match(out, /--b-c:#8A9097;/, '既定の色に倒れていない');
    // 見た目の崩れも防ぐ: 色は必ず #RRGGBB の形
    for (const m of out.matchAll(/--b-c:([^;"]*)/g)) {
        assert.match(m[1], /^#[0-9A-Fa-f]{6}$/, `色の形になっていない: ${m[1].slice(0, 40)}`);
    }
});

test('★ 色の値が壊れていたら既定に倒す / 文字色は読めるほうを選ぶ', () => {
    // ★ 自前の鍵でも値が色の形とは限らない (手で書き換える・別の版が混ざる)
    const t = build({
        ...BASE, them: 2, view: 'char',
        burstColors: { B1: 'red;background:url(x)', B2: '#GGGGGG', B3: 42, 'BΛ': '#E5484D' },
    });
    const out = t.paint();
    for (const m of out.matchAll(/--b-c:([^;"]*)/g)) {
        assert.match(m[1], /^#[0-9A-Fa-f]{6}$/, `色の形でない値が style に入った: ${m[1].slice(0, 40)}`);
    }
    assert.ok(!/url\(x\)/.test(out), 'CSS が差し込まれている');
    assert.equal(t._gvBurstColor('B1'), '#8A9097', '壊れた値を既定に倒していない');
    assert.equal(t._gvBurstColor('B2'), '#8A9097', '#GGGGGG を色として通している');
    assert.equal(t._gvBurstColor('B3'), '#8A9097', '数値を色として通している');
    assert.equal(t._gvBurstColor('BΛ'), '#E5484D', '正しい色まで落としている');
    assert.equal(t._gvBurstColor('constructor'), '#8A9097', '継承した鍵を使っている');
    // ★ 文字色は「黒と白のうちコントラストの高いほう」— 端まで確かめる
    assert.equal(t._gvBurstInk('#FFFFFF'), '#14161A', '白地に白文字を選んでいる');
    assert.equal(t._gvBurstInk('#000000'), '#FFFFFF', '黒地に黒文字を選んでいる');
    assert.equal(t._gvBurstInk('#F2B705'), '#14161A', 'B2 の黄色に白文字を選んでいる');
});

test('★ バーストの点は白地でも輪郭が見える (縁のコントラストを実際に計算する)', () => {
    // ★ 縁があるだけでは足りない — 薄い縁は白に溶けて 1.9:1 にしかならなかった (Codex指摘)。
    //   色そのものは文字にしない (B2 の黄色は白地で 1.8:1)。意味は文字が、色は縁のある点が担う
    const dot = html.match(/\.gv-pills button\.gv-b \.dot \{[\s\S]*?\}/)?.[0] || '';
    const m = dot.match(/box-shadow: 0 0 0 1px rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    assert.ok(m, '点に縁が無い (白地で見えない色がある)');
    const a = Number(m[4]);
    const over = (c) => c * a + 255 * (1 - a);            // 白地に重ねた実際の色
    const lin = (c) => { const n = over(c) / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(Number(m[1])) + 0.7152 * lin(Number(m[2])) + 0.0722 * lin(Number(m[3]));
    const ratio = 1.05 / (L + 0.05);
    assert.ok(ratio >= 3, `縁が白地に溶けている (${ratio.toFixed(2)}:1 — 3:1 以上が要る)`);
    // ★ バーストの色を文字や枠に使わない (使うと B2 が読めない)
    const pill = html.match(/\.gv-pills button\.gv-b \{[\s\S]*?\}/)?.[0] || '';
    assert.ok(!/color: var\(--b-c/.test(pill), 'バーストの色を文字に使っている');
    assert.ok(!/border-color: var\(--b-c/.test(pill), 'バーストの色を枠に使っている');
});

test('★ 属性表が読めないときは、絞り込みを出さず「すべて」に倒す', () => {
    const out = build({ ...BASE, them: 2, view: 'char', elems: null }).paint();
    assert.ok(!/gv-attrs/.test(out), '属性表が無いのに絞り込みを出している');
    assert.equal((out.match(/class="gv-tile/g) || []).length, 5, '属性表が無いだけで一覧まで消えている');
    // ★ 絞り込んだ状態で表が読めなくなると、全員消えるうえ戻す手立てが無くなる
    const stuck = build({ ...BASE, them: 2, view: 'char', elems: null, attr: 'fire' }).paint();
    assert.equal((stuck.match(/class="gv-tile/g) || []).length, 5,
        '属性で絞ったまま表が読めなくなると全員消える (戻すピルも出ないので詰む)');
});

test('★ ユニオン順位: 「誰もいない」「持っていない」「記録が無い」を言い分ける', () => {
    // ★ 直し方が違うので混ぜてはいけない — 持っていないなら育てる、記録が無いなら取り込み直す
    const ol = (n) => ({ overload: { 有利コード: n / 2, 攻撃力: n / 2 } });
    const others = [
        growthRow(2, 'ヘルム', ol(20)), growthRow(2, '紅蓮', ol(20)),
        growthRow(3, 'ヘルム', ol(30)), growthRow(3, '紅蓮', ol(30)),
    ];
    const team = [atk(1, ['ヘルム', '紅蓮'])];
    // ① 自分が紅蓮を持っていない
    const noChar = build({ rows: [...others, growthRow(1, 'ヘルム', ol(10))], teams: team, them: null }).paint();
    assert.match(noChar, /自分は 紅蓮 を持っていません \(2人が揃っています\)/,
        '持っていないことを言えていない');
    // ② 持っているが装備の記録が無い (取り込みで拾えなかった)
    const noVal = build({
        rows: [...others, growthRow(1, 'ヘルム', ol(10)), growthRow(1, '紅蓮', { overload: null })],
        teams: team, them: null,
    }).paint();
    assert.match(noVal, /自分の 紅蓮 に装備の記録がありません \(2人が揃っています\)/,
        '持っているのに「持っていません」と言っている (取り込み直せば直るのに)');
    // ③ 本当に誰も揃っていない
    const none = build({ rows: [growthRow(1, 'ヘルム', ol(10))], teams: team, them: null }).paint();
    assert.match(none, /この顔ぶれ全員ぶんの記録がある人がいません/);
    assert.ok(!/持っていません/.test(none), '所持の話にすり替えている');
});

test('★ 属性表が戻れば、覚えていた属性の絞り込みがまた効く (同じ画面のまま)', () => {
    // ★ 表が読めない間に絞り込みを捨ててしまうと、戻ったときに全員のままになる。
    //   別々に組み直すのではなく、**同じ状態のまま表だけ戻す**ことで遷移を確かめる
    const t = build({ ...BASE, them: 2, view: 'char', attr: 'fire', elems: null });
    const tiles = () => (t.paint().match(/class="gv-tile/g) || []).length;
    assert.equal(tiles(), 5, '表が無いときに絞り込みが効いてしまっている');
    assert.ok(!/gv-attrs/.test(t.paint()), '表が無いのに絞り込みのピルを出している');
    assert.equal(t.state.attr, 'fire', '表が読めない間に覚えていた絞り込みを捨てている');
    // 表が戻る (再読み込みで拾えた)
    t.state.elems = new Map([['ラピ', 'fire'], ['クラウン', 'water'], ['モラン', 'wind'],
        ['ヘルム', 'fire'], ['紅蓮', 'iron']]);
    assert.equal(tiles(), 2, '表が戻っても絞り込みが効かない');
    assert.ok(/gv-attrs/.test(t.paint()), '表が戻ったのに絞り込みのピルが出ない');
});

test('押した状態でもバーストの点が見える (黒地とのコントラスト)', () => {
    // ★ 値を書き写さない — 本体のパレットが変わったら気づけなくなる
    const src = html.match(/const TE_BURST_COLOR = \{[^}]*\}/)?.[0] || '';
    assert.ok(src, 'バーストの色表を切り出せない');
    const colors = Object.fromEntries([...src.matchAll(/'?([A-ZΛ0-9]+)'?:\s*'(#[0-9A-Fa-f]{6})'/g)]
        .map(m => [m[1], m[2]]));
    assert.equal(Object.keys(colors).length, 4, `色表が読めない: ${src}`);
    const lin = (c) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
    const lum = (h) => 0.2126 * lin(parseInt(h.slice(1, 3), 16)) + 0.7152 * lin(parseInt(h.slice(3, 5), 16))
        + 0.0722 * lin(parseInt(h.slice(5, 7), 16));
    const bg = lum('#14161A');
    for (const [b, c] of Object.entries(colors)) {
        const r = (Math.max(lum(c), bg) + 0.05) / (Math.min(lum(c), bg) + 0.05);
        assert.ok(r >= 3, `${b} の点が押した黒地で見えない (${r.toFixed(2)}:1)`);
    }
});

test('★ 絞り込みで消えた体の比較を出したままにしない', () => {
    // 選んだタイルが無いのに中身だけ残ると、絞り込みと食い違う (Codex指摘 2026-09-10)
    const t = build({ ...BASE, them: 2, view: 'char' });
    t.handleGrowthAnaChar(t.state.chars.indexOf('クラウン'));   // B2 = 火力役ではない
    assert.match(t.paint(), /class="gc-char"/, '選んだ体の比較が出ていない');
    t.handleGrowthAnaDpsOnly();
    const out = t.paint();
    assert.ok(!/class="gc-char"/.test(out), '一覧から消えたのに比較が残っている');
    assert.match(out, /いまの絞り込みから外れています/, 'なぜ出ないのか言っていない');
    // 選択は捨てない — 絞り込みを戻せばそのまま出る
    t.handleGrowthAnaDpsOnly();
    assert.match(t.paint(), /class="gc-char"/, '絞り込みを戻しても出ない (選択を捨てている)');
});

test('★ 絞り込みは重ねがけできる (火力役 × バースト × 属性 × 検索)', () => {
    const t = build({ ...BASE, them: 2, view: 'char',
        elems: { ラピ: 'fire', クラウン: 'water', モラン: 'wind', ヘルム: 'fire', 紅蓮: 'iron' } });
    t.handleGrowthAnaDpsOnly();
    assert.equal((t.paint().match(/class="gv-tile/g) || []).length, 2, '火力役だけに絞れていない');
    t.handleGrowthAnaBurst('B3');
    assert.equal((t.paint().match(/class="gv-tile/g) || []).length, 2, '火力役 × B3 が効いていない');
    t.handleGrowthAnaSearch('ヘルム');
    assert.equal((t.paint().match(/class="gv-tile/g) || []).length, 1,
        '火力役だけのときに検索が無視されている');
    t.handleGrowthAnaBurst('B2');
    assert.equal((t.paint().match(/class="gv-tile/g) || []).length, 0,
        '火力役だけのときにバーストが無視されている');
    // ★ 属性も重ねがけできる (火力役だけのときに属性が無視されないこと)
    t.handleGrowthAnaBurst('all'); t.handleGrowthAnaSearch('');
    assert.equal((t.paint().match(/class="gv-tile/g) || []).length, 2, '火力役だけに戻っていない');
    t.handleGrowthAnaAttr('fire');
    const fire = t.paint();
    assert.equal((fire.match(/class="gv-tile/g) || []).length, 1,
        '火力役だけのときに属性が無視されている');
    assert.ok(/ヘルム/.test(fire), '残る顔ぶれが違う (灼熱の火力役はヘルムだけ)');
});

test('★ 属性は属性アイコンで出す / バーストは色で見分ける', () => {
    const out = build({ ...BASE, them: 2, view: 'char' }).paint();
    // 属性アイコンは既にアプリが持っている素材 (PT_ATTRS.icon)
    assert.equal((out.match(/gv-attrs[\s\S]*?<\/div>/)?.[0].match(/属性アイコン\//g) || []).length, 5,
        '属性アイコンを使っていない (5属性ぶん)');
    assert.match(out, /title="灼熱" aria-label="灼熱"/, '読み上げ用の名前が消えている');
    // バーストはアイコンが無いので色。編成エディタと同じ色づかいにそろえる
    assert.match(out, /style="--b-c:#1FA95C;"[^>]*><i class="dot"><\/i>B1</, 'B1 の色が編成エディタと違う');
    assert.match(out, /style="--b-c:#E5484D;"[^>]*><i class="dot"><\/i>B3</, 'B3 の色が編成エディタと違う');
    // ★ 押した状態を色で塗りつぶさない — B2 の黄色に白文字だと 1.8:1 で読めない
    const pill = html.match(/\.gv-pills button\.gv-b\[aria-pressed="true"\][\s\S]*?\}/)?.[0] || '';
    assert.ok(!/var\(--b-c/.test(pill), '押した状態をバーストの色で塗りつぶしている');
    // バッジの文字色は背景に対して読めるほうを選ぶ
    const ink = out.match(/--b-c:(#[0-9A-Fa-f]{6});--b-ink:(#[0-9A-Fa-f]{6})/);
    assert.ok(ink, 'バッジに文字色を渡していない');
    const lum = (h) => { const v = (i) => { const n = parseInt(h.slice(i, i + 2), 16) / 255;
        return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
        return 0.2126 * v(1) + 0.7152 * v(3) + 0.0722 * v(5); };
    const L = lum(ink[1]);
    assert.equal(ink[2], (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#14161A' : '#FFFFFF',
        '読みにくいほうの文字色を選んでいる');
});

test('★ 要約に「何体で上」を出さない (勝ち負けの見せ方にしない)', () => {
    const out = build({ ...BASE, them: 2 }).paint();
    assert.ok(!/体で上/.test(out), '「何体で上」が残っている (実機FB 2026-09-10)');
    assert.ok(!/互角/.test(out), '勝ち負けの言い回しが残っている');
    // ★ **火力役だけ**の合計。5体ぜんぶを足すと、バフ役の OP まで火力の差として読める
    assert.match(out, /火力役 2体の 有利コード＋攻撃/,
        '火力役だけで合計していない (ヘルムと紅蓮の2体のはず)');
    assert.match(out, /自分 [\d.]+%/, '自分の値が出ていない');
    assert.match(out, /差 [\d.]+%/, '差が出ていない');
});

test('★ 相手えらびの名前を1行で切らない (「ユニオン…」になっていた)', () => {
    const css = html.match(/\.gv-who \.nm \{[\s\S]*?\}/)?.[0] || '';
    assert.ok(!/white-space: nowrap/.test(css), '1行に固定していて名前が切れる');
    assert.ok(/-webkit-line-clamp: 2/.test(css), '2行まで折り返していない');
    const btn = html.match(/\.gv-who button \{[\s\S]*?\}/)?.[0] || '';
    assert.ok(!/[^-]width: \d+px/.test(btn), 'ボタンの幅を決め打ちしている');
    assert.ok(/min-width: 54px/.test(btn), '最小の幅が無い (1体だけのとき潰れる)');
});

test('★ いま選んでいる相手は、その回に育成が無くても相手えらびに残す', () => {
    // 運営タブの名前から来ると、その回に取り込めていない人が選ばれ得る。
    // 消すと「何も選ばれていない」ように見え、画面と食い違う
    const t = build({ ...BASE, rows: [...fullRows(1, 1), ...fullRows(3, 3)], them: 2 });
    const out = t.paint();
    assert.ok(/onclick="handleGrowthAnaWho\(2\)"/.test(out), '選んでいる相手が消えている');
    assert.ok(/aria-pressed="true" onclick="handleGrowthAnaWho\(2\)"/.test(out), '選ばれている印が無い');
    // 選んでいない・育成も無い人は出さない (くらべられないので)
    const other = build({ ...BASE, rows: [...fullRows(1, 1), ...fullRows(3, 3)], them: 3 }).paint();
    assert.ok(!/handleGrowthAnaWho\(2\)/.test(other), 'くらべられない人まで並べている');
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
