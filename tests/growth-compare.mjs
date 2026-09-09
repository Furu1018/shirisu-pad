// ============================================================================
// 🧬 育成をくらべる (_gcRender) の実行テスト
//   node tests/growth-compare.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定と並び (rankSquad / compare) は js/domain/growth.js の本物を使う。
//
// ★ この画面の値は「読み方」そのもの (2026-09-09 のモックで決めた):
//   結論を先に出す → 差の大きい順に並べる → 差のある項目だけ出す → 全項目は畳む。
//   9項目 × 5体を全部並べた版は、差がどこにあるか読めなかった。
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
const SRC = [cut('        function _gcRender()'), cut('        function _gcCls(')].join('\n');

// 育成1行ぶん。省略した項目は null (未取得) として扱われる
const row = (o = {}) => ({
    character_name: 'ラピ', grade: 3, core: 0, lv: 200, skill1_lv: 7, skill2_lv: 7, ulti_skill_lv: 7,
    combat: 500000, attractive_lv: 20, harmony_cube_lv: 10, favorite_item_lv: 5, overload: null, ...o,
});
const SQ = (team, o = {}) => ({ attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 33.1, team, ...o });

function run({ them = { id: 2, name: 'なべりうす' }, mine = {}, theirs = {}, squads = [], pick = 0, open = [] } = {}) {
    let out = '';
    const els = { growthCmpBody: { set innerHTML(v) { out = v; }, get innerHTML() { return out; } } };
    const env = {
        _gc: { gen: 0, them, squads, pick, mine, theirs, seasonId: 30, err: null, open: new Set(open.map(String)) },
        window: { growthDomain: dom },
        document: { getElementById: (id) => els[id] || null },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        SLOT_JP: { 1: '①', 2: '②' },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn _gcRender;`)(...keys.map(k => env[k]));
    fn();
    return out;
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (o) => assert.ok(!/undefined|NaN|\[object Object\]/.test(o),
    `未定義参照: ${o.match(/.{40}(undefined|NaN|\[object Object\]).{40}/)?.[0]}`);

console.log('育成をくらべる:\n');

test('★ 結論を先に出す (何体で上か / 合計と差)', () => {
    const mine = { ラピ: row({ combat: 495120 }), アリス: row({ character_name: 'アリス', combat: 700000 }) };
    const theirs = { ラピ: row({ combat: 868355 }), アリス: row({ character_name: 'アリス', combat: 720000 }) };
    const out = run({ mine, theirs, squads: [SQ(['ラピ', 'アリス'])] });
    assert.ok(/class="gc-verdict"/.test(out), '結論のカードが無い');
    assert.ok(/相手が <em>2\/2体<\/em> で上/.test(out), `何体で上かが出ていない: ${out.slice(0, 400)}`);
    assert.ok(/自分 計 119\.5万/.test(out), '自分の合計が違う');
    assert.ok(/なべりうす 計 158\.8万 \(\+39\.3万\)/.test(out), `相手の合計と差が違う: ${out.match(/計 [^<]*/g)}`);
    // 結論はカードより前に出る
    assert.ok(out.indexOf('gc-verdict') < out.indexOf('gc-char'), '結論が後ろにある');
    noUndef(out);
});

test('★ 差の大きい順に並べる (詰めるべきキャラが上に来る)', () => {
    const mine = { A: row({ character_name: 'A', combat: 100000 }), B: row({ character_name: 'B', combat: 100000 }), C: row({ character_name: 'C', combat: 100000 }) };
    const theirs = { A: row({ character_name: 'A', combat: 150000 }), B: row({ character_name: 'B', combat: 400000 }), C: row({ character_name: 'C', combat: 90000 }) };
    const out = run({ mine, theirs, squads: [SQ(['A', 'B', 'C'])] });
    const order = [...out.matchAll(/class="cn">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(order, ['B', 'A', 'C'], `差の大きい順でない: ${order}`);
    assert.ok(/class="gc-gap up">\+30\.0万/.test(out), '差の表示が無い');
    assert.ok(/class="gc-gap mine">−1\.0万/.test(out), '自分が上のときの表示が無い');
    noUndef(out);
});

test('★ 差のある項目だけをチップに出す (同じ項目は出さない)', () => {
    const mine = { ラピ: row({ lv: 500, skill2_lv: 7, harmony_cube_lv: 10, attractive_lv: 40 }) };
    const theirs = { ラピ: row({ lv: 825, skill2_lv: 10, harmony_cube_lv: 15, attractive_lv: 30 }) };
    const out = run({ mine, theirs, squads: [SQ(['ラピ'])] });
    const chips = [...out.matchAll(/class="gc-chip[^"]*">([^<]+)</g)].map(m => m[1]);
    assert.ok(chips.some(c => /レベル Lv825/.test(c)), `レベルの差が無い: ${chips}`);
    assert.ok(chips.some(c => /スキル2 Lv10/.test(c)), 'スキル2の差が無い');
    assert.ok(!chips.some(c => /スキル1/.test(c)), '同じ項目 (スキル1) までチップにしている');
    // 自分が上の項目は別の色
    assert.ok(/class="gc-chip mine">好感度 Lv40</.test(out), '自分が上の項目を分けていない');
    noUndef(out);
});

test('★ 全項目は畳んでおき、押すと開く (9項目 + オーバーロード)', () => {
    const mine = { ラピ: row({ overload: { 攻撃力: 32.6 } }) };
    const theirs = { ラピ: row({ lv: 825, overload: { 攻撃力: 45.1, 装弾数: 170.7 } }) };
    const shut = run({ mine, theirs, squads: [SQ(['ラピ'])] });
    assert.ok(!/class="gc-tbl"/.test(shut), '畳んでいない');
    assert.ok(/9項目すべてを見る/.test(shut), '開く導線が無い');
    assert.ok(/onclick="handleGrowthCmpOpen\(0\)"/.test(shut), '番号で開いていない (名前を埋めない)');
    const open = run({ mine, theirs, squads: [SQ(['ラピ'])], open: [0] });
    assert.ok(/class="gc-tbl"/.test(open), '開いていない');
    assert.equal((open.match(/class="gc-tr"/g) || []).length, 1 + 9 + 1 + 2, `行数が合わない`);
    assert.ok(/オーバーロード/.test(open) && /装弾数/.test(open), 'オーバーロードが出ていない');
    assert.ok(/畳む/.test(open), '畳む導線が無い');
    noUndef(open);
});

test('★ 合計は比べられる体だけ (片方にしか無い体を混ぜない — Codex指摘 2026-09-09)', () => {
    const out = run({
        mine: { ラピ: row({ combat: 100000 }) },
        theirs: { ラピ: row({ combat: 150000 }), アリス: row({ character_name: 'アリス', combat: 900000 }) },
        squads: [SQ(['ラピ', 'アリス'])],
    });
    assert.ok(/自分 計 10\.0万/.test(out), `自分の合計が違う: ${out.match(/計 [^<]*/g)}`);
    assert.ok(/計 15\.0万 \(\+5\.0万\)/.test(out), '相手の合計に比べられない体が入っている');
    assert.ok(/相手が <em>1\/1体<\/em> で上/.test(out), '比べられる体の数が違う');
    // 比べられない体もカード自体は出す (最後に回す)
    assert.equal((out.match(/class="gc-char"/g) || []).length, 2);
    noUndef(out);
});
test('★ 引き分けは負けと同じ見た目にしない', () => {
    const same = row({ lv: 500, combat: 700000 });
    const out = run({ mine: { ラピ: same }, theirs: { ラピ: { ...same } }, squads: [SQ(['ラピ'])], open: [0] });
    assert.ok(/class="v same">Lv500<\/span><span class="v same">Lv500</.test(out), `引き分けの見た目が違う: ${out.slice(0, 300)}`);
    assert.ok(/class="gc-gap flat">差なし</.test(out), '戦闘力の差なしを出していない');
    noUndef(out);
});

test('片方しか持っていないキャラは名指しで印を付け、最後に回す', () => {
    const out = run({
        mine: { ラピ: row() },
        theirs: { ラピ: row({ combat: 900000 }), アリス: row({ character_name: 'アリス' }) },
        squads: [SQ(['アリス', 'ラピ'])],
    });
    const order = [...out.matchAll(/class="cn">([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(order, ['ラピ', 'アリス'], '比べられない体を先に出している');
    assert.ok(/class="gc-miss">自分 は未取り込み</.test(out), '誰の何が無いのか分からない');
    assert.ok(/class="gc-gap none">比べられない</.test(out));
    noUndef(out);
});

test('編成が複数あれば選べる / 相手の育成が無ければ案内だけ出す', () => {
    const theirs = { ラピ: row(), アリス: row({ character_name: 'アリス' }) };
    const two = run({
        mine: {}, theirs, pick: 1,
        squads: [SQ(['ラピ']), SQ(['アリス'], { attrName: '水冷', slot: 2, dmgB: 28.4 })],
    });
    assert.equal((two.match(/handleGrowthCmpPick\(\d+\)/g) || []).length, 2, '選択肢が2つ出ていない');
    assert.ok(/aria-pressed="true"[^>]*onclick="handleGrowthCmpPick\(1\)"/.test(two), '選んでいる編成に印が無い');
    assert.ok(two.includes('水冷② 28.4B'), '属性・編成枠・ダメージが出ていない');
    assert.ok(/自分の育成がまだ取り込まれていません/.test(two), '自分が未取り込みの注意が無い');

    const none = run({ mine: { ラピ: row() }, theirs: {} });
    assert.ok(none.includes('育成データはまだありません') && none.includes('ゲームカードを公開'), '案内が無い');
    assert.ok(!/gc-char/.test(none), '中身の無いカードを出している');
    noUndef(two);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
