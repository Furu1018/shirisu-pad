// ============================================================================
// 🧬 育成をくらべる (_gcRender) の実行テスト
//   node tests/growth-compare.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 比較の判定 (項目・勝ち負け・オーバーロード) は js/domain/growth.js の本物を使う。
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
const SRC = cut('        function _gcRender()');

// 育成1行ぶん。省略した項目は null (未取得) として扱われる
const row = (o = {}) => ({
    character_name: 'ラピ', grade: 3, core: 0, lv: 200, skill1_lv: 7, skill2_lv: 7, ulti_skill_lv: 7,
    combat: 500000, attractive_lv: 20, harmony_cube_lv: 10, favorite_item_lv: 5, overload: null, ...o,
});
function run({ them = { id: 2, name: 'なべりうす' }, mine = {}, theirs = {}, squads = [], pick = 0 } = {}) {
    let out = '';
    const els = { growthCmpBody: { set innerHTML(v) { out = v; }, get innerHTML() { return out; } } };
    const env = {
        _gc: { gen: 0, them, squads, pick, mine, theirs, seasonId: 30, err: null },
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

test('★ 編成ぶんのカードが実際に描ける / 上のほうに緑が付く', () => {
    const mine = { ラピ: row({ lv: 200, combat: 400000 }) };
    const theirs = { ラピ: row({ lv: 825, combat: 900000 }) };
    const out = run({ mine, theirs, squads: [{ attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 33.1, team: ['ラピ'] }] });
    assert.equal((out.match(/class="gc-char"/g) || []).length, 1, 'カードが出ていない');
    assert.ok(out.includes('ラピ'), 'キャラ名が無い');
    assert.ok(/レベル<\/span><span class="v lose">Lv200<\/span><span class="v win">Lv825</.test(out), `勝ち負けが付いていない: ${out.slice(0, 400)}`);
    assert.ok(out.includes('>自分<') && out.includes('>なべりうす<'), '見出しに両者の名前が無い');
    noUndef(out);
});

test('★ 編成が複数あれば選べる (属性・編成枠・ダメージが出る)', () => {
    const theirs = { ラピ: row(), アリス: row({ character_name: 'アリス' }) };
    const squads = [
        { attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 33.1, team: ['ラピ'] },
        { attrKey: 'water', attrName: '水冷', slot: 2, dmgB: 28.4, team: ['アリス'] },
    ];
    const out = run({ mine: {}, theirs, squads, pick: 1 });
    assert.equal((out.match(/handleGrowthCmpPick\(\d+\)/g) || []).length, 2, '選択肢が2つ出ていない');
    assert.ok(/aria-pressed="true"[^>]*onclick="handleGrowthCmpPick\(1\)"/.test(out), '選んでいる編成に印が無い');
    assert.ok(out.includes('水冷② 28.4B'), '属性・編成枠・ダメージが出ていない');
    assert.ok(out.includes('アリス') && !/class="gc-char"[\s\S]*?ラピ/.test(out), '選んだ編成のキャラだけを出していない');
    noUndef(out);
});

test('★ 引き分けは「負け」と同じ見た目にしない (Codex指摘 2026-09-09)', () => {
    // 同じ値なのに両方とも薄字だと「どちらも足りない」に読める
    const same = { ラピ: row({ lv: 500, combat: 700000 }) };
    const out = run({
        mine: same, theirs: { ラピ: row({ lv: 500, combat: 700000 }) },
        squads: [{ attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 0, team: ['ラピ'] }],
    });
    assert.ok(/class="v same">Lv500<\/span><span class="v same">Lv500</.test(out), `引き分けの見た目が違う: ${out.slice(0, 400)}`);
    assert.ok(!/class="v lose"/.test(out), '引き分けを負けにしている');
    noUndef(out);
});
test('★ 相手の育成が無ければ、取り込みの案内を出す (空のカードを並べない)', () => {
    const out = run({ mine: { ラピ: row() }, theirs: {} });
    assert.ok(out.includes('育成データはまだありません'), '案内が無い');
    assert.ok(out.includes('ゲームカードを公開'), '何をすればよいか言っていない');
    assert.ok(!/class="gc-char"/.test(out), '中身の無いカードを出している');
    noUndef(out);
});

test('自分の育成が無ければ注意を出す (比較そのものは出す)', () => {
    const out = run({ mine: {}, theirs: { ラピ: row() }, squads: [{ attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 0, team: ['ラピ'] }] });
    assert.ok(out.includes('自分の育成がまだ取り込まれていません'), '注意が無い');
    assert.ok(/class="gc-char"/.test(out), '比較を出していない');
    assert.ok(/class="v unknown">—</.test(out), '片方欠けを「—」にしていない');
    noUndef(out);
});

test('★ 片方しか持っていないキャラは名指しで印を付ける', () => {
    const out = run({
        mine: { ラピ: row() }, theirs: { ラピ: row(), アリス: row({ character_name: 'アリス' }) },
        squads: [{ attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 0, team: ['ラピ', 'アリス'] }],
    });
    assert.equal((out.match(/class="miss"/g) || []).length, 1, '印が1つでない');
    assert.ok(/アリス<span class="miss">自分は未取り込み</.test(out), '誰の何が無いのか分からない');
    noUndef(out);
});

test('編成が分からないときは、取り込めたキャラをまとめて出す', () => {
    const out = run({ mine: {}, theirs: { ラピ: row(), アリス: row({ character_name: 'アリス' }) }, squads: [] });
    assert.ok(!/gc-seg/.test(out), '選択肢が1つなのにセグメントを出している');
    assert.equal((out.match(/class="gc-char"/g) || []).length, 2, '取り込めたキャラを並べていない');
    noUndef(out);
});

test('オーバーロードは両方の項目をそろえて出す', () => {
    const mine = { ラピ: row({ overload: { 攻撃力: 10.5 } }) };
    const theirs = { ラピ: row({ overload: { 攻撃力: 20.25, 装弾数: 30 } }) };
    const out = run({ mine, theirs, squads: [{ attrKey: 'fire', attrName: '灼熱', slot: 1, dmgB: 0, team: ['ラピ'] }] });
    assert.ok(out.includes('オーバーロード'), '見出しが無い');
    assert.ok(out.includes('攻撃力') && out.includes('装弾数'), '両方の項目を集めていない');
    noUndef(out);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
