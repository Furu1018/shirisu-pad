// ============================================================================
// レイドの振り返り (分析タブ) の実行テスト
//   ① 属性別の進捗 (_rrProgressHtml) / ② 得意・不得意 (_rrAptBarsHtml / _rrAptScatterHtml) /
//   ③ 誰がどの属性で (_rrMembersHtml)
//   node tests/raid-review.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定は js/domain/raidReview.js の本物、材料は **本番の 2026-09 のデータ**。
// ★ 守りたい契約:
//   1. 進捗率は「削った量 / そのボスのHP」で、踏破した Lv の合計が設定HPと一致することからクラスを推定する
//   2. 強さの指標 (対GB中央値比) は SLv 補正済みで、締め凸は**除く**
//   3. 材料 (HP表 / GB / SLv) が無くても描ける — 率を出さない・SLv補正に劣化する、と画面に書く
//   4. テンプレートに undefined / NaN を出さない (実行しないと出ないバグ)
// ============================================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../js/domain/raidReview.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'));

const grab = (name, kind = 'function') => {
    const re = kind === 'const'
        ? new RegExp(`\\n        const ${name} = [^\\n]*;`)
        : new RegExp(`\\n        function ${name}\\([\\s\\S]*?\\n        \\}`);
    const m = html.match(re);
    if (!m) throw new Error(`index.html から ${name} を切り出せませんでした (実装が動いたらこのテストも直す)`);
    return m[0];
};

const BOSS_ATTRIBUTES = {
    'H.S.T.A.': { attribute: 'WATER', attributeJP: '水冷', nameJP: '灼熱ヘスティア' },
    'P.S.I.D.': { attribute: 'ELECTRIC', attributeJP: '電撃', nameJP: '水冷ポセイドン' },
    'Z.E.U.S.': { attribute: 'IRON', attributeJP: '鉄甲', nameJP: '電撃ゼウス' },
    'D.M.T.R.': { attribute: 'WIND', attributeJP: '風圧', nameJP: '鉄甲デメテル' },
    'A.N.M.I.': { attribute: 'FIRE', attributeJP: '灼熱', nameJP: '風圧アネモイ' },
};
let identity = { id: 1, name: 'イオ' };
const src = [
    'const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");',
    'const renderAttrIcon = (k, n) => `<img alt="${k}" width="${n}">`;',
    'const getCurrentIdentity = () => identity;',
    'let _rrAptView = "scatter", _rrLastApt = null;',   // index.html ではモジュールの変数 (切り出しに入らないのでここで用意する)
    grab('_rrAttrJp', 'const'),
    grab('_rrAttrOf', 'const'),
    grab('_rrB', 'const'),
    grab('_rrProgressHtml'),
    grab('_rrAptFmt'),
    grab('_rrAptBarsHtml'),
    grab('_rrAptScatterHtml'),
    grab('_rrMembersHtml'),
    grab('_rrPaintAptitude'),
    'return { _rrProgressHtml, _rrAptBarsHtml, _rrAptScatterHtml, _rrMembersHtml, _rrPaintAptitude, _rrAttrOf, _rrB };',
].join('\n');
// _rrPaintAptitude は DOM を触るので最小のスタブを当てる (注記の文言を実際に組ませる)
const els = new Map([['raidReviewAptitude', null], ['raidReviewAptitudeNote', null], ['rrAptScatterBtn', null], ['rrAptBarsBtn', null]]
    .map(([k]) => [k, { innerHTML: '', textContent: '', classList: { list: new Set(), toggle(c, on) { if (on) this.list.add(c); else this.list.delete(c); } } }]));
const document = { getElementById: (id) => els.get(id) || null };
const api = new Function('BOSS_ATTRIBUTES', 'identity', 'window', 'document', 'localStorage', src)
    (BOSS_ATTRIBUTES, identity, { planBoardDomain: undefined }, document, { getItem: () => null, setItem: () => {} });

const dom = globalThis.raidReviewDomain;
const players = rd('data/2026-09.json').players;
const cfg = rd('data/raid-config.json');
const gb = rd('data/gb-export/2026-09.json');
const ratio = rd('data/slv-ratio.json').data;
const attrOf = api._rrAttrOf;

let passed = 0, failed = 0;
const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const clean = (out) => assert.ok(!/undefined|NaN|\[object/.test(out),
    `未定義参照: ${out.match(/.{50}(undefined|NaN|\[object).{50}/)?.[0] || ''}`);

console.log('レイドの振り返り (本番の 2026-09 のデータで実行):\n');

test('① 進捗: 5属性ぶんの帯が出て、踏破した属性は 100% / 未踏破は率と残りが出る', () => {
    const rows = dom.attributeProgress({ players, hpTable: cfg.hardLevelHp, attrOf });
    const out = api._rrProgressHtml(rows);
    clean(out);
    assert.equal((out.match(/class="rr-row"/g) || []).length, 5, '5属性ぶん出ていない');
    assert.equal((out.match(/class="rr-seg"/g) || []).length, 15, 'Lv1〜3 × 5属性 の区間が無い');
    // 2026-09: 風圧と水冷だけ Lv3 まで踏破 / 灼熱は 89.0%
    assert.ok(out.includes('100.0%'), '踏破した属性の 100% が無い');
    assert.ok(out.includes('89.0%'), `灼熱の 89.0% が無い: ${out.match(/\d+\.\d%/g)}`);
    assert.equal((out.match(/💀 Lv3 まで踏破/g) || []).length, 2, 'Lv3 まで踏破が 2 属性でない');
    assert.ok(out.includes('(HP推定)'), 'クラスを推定したことを書いていない');
    assert.ok(out.includes('646.7B / 726.3B'), '削った量 / 総HP が無い');
    assert.ok(out.includes('21凸'), '凸数が無い');
    assert.ok(out.includes('かけた凸数'), '進捗率の読み方の注記が無い');
});

test('① 進捗: ボスのHPが分からないときは率を出さず総量だけ (母数をでっち上げない)', () => {
    const rows = dom.attributeProgress({ players, hpTable: {}, attrOf });
    const out = api._rrProgressHtml(rows);
    clean(out);
    assert.ok(out.includes('ボスの総HPが分からないため率は出しません'), '断りが無い');
    assert.ok(!/\d+\.\d%/.test(out), '率を出している');
    assert.ok(!out.includes('class="rr-seg"'), '帯を描いている (母数が無いのに)');
    assert.ok(out.includes('646.7B'), '総量が出ていない');
});

test('② ランキング: 対GB中央値比の順・100% の目印・凸数', () => {
    const apt = dom.attributeAptitude({ players, ratioTable: ratio, gb, attrOf });
    assert.equal(apt.basis, 'gb'); assert.equal(apt.killsExcluded, true);
    const out = api._rrAptBarsHtml(apt);
    clean(out);
    assert.equal((out.match(/class="rr-bar"/g) || []).length, 5, '5属性ぶん出ていない');
    // 2026-09: 鉄甲 110% が先頭、電撃 84% が最後
    assert.ok(out.indexOf('鉄甲') < out.indexOf('電撃'), '強い順に並んでいない');
    assert.ok(out.includes('110%') && out.includes('84%'), `値が出ていない: ${out.match(/>\d+%/g)}`);
    assert.ok(out.includes('14凸') && out.includes('21凸'), '凸数が無い');
    assert.ok(/left:[\d.]+%;top:0;bottom:0;width:1px/.test(out), '100% の目印が無い');
});

test('② 散布図: 5点 + 軸 + GB中央値の線 (点が1つなら横棒に倒す)', () => {
    const apt = dom.attributeAptitude({ players, ratioTable: ratio, gb, attrOf });
    const out = api._rrAptScatterHtml(apt);
    clean(out);
    assert.ok(out.startsWith('<svg viewBox="0 0 320 210"'), 'SVG になっていない');
    assert.equal((out.match(/<circle /g) || []).length, 5, '点が5つでない');
    assert.ok(out.includes('GB中央値 100%'), '基準線の説明が無い');
    assert.ok(out.includes('stroke-dasharray'), '基準線 (破線) が無い');
    assert.ok(/fill="var\(--attr-iron-solid\)"/.test(out), '属性の色をトークンで塗っていない');
    assert.ok(out.includes('凸数') && out.includes('右上ほど'), '軸と読み方が無い');
    // 点が1つの回は散布図にしない
    const one = { rows: [apt.rows[0]], basis: 'gb', killsExcluded: true, refSlv: null };
    assert.ok(api._rrAptScatterHtml(one).includes('class="rr-bar"'), '点が1つでも散布図を描いている');
});

test('② 劣化: GB が無ければ SLv を揃えた 1凸平均 / SLv 表も無ければ記録のまま', () => {
    const slv = dom.attributeAptitude({ players, ratioTable: ratio, attrOf });
    assert.equal(slv.basis, 'slv'); assert.ok(slv.refSlv > 0, '基準の SLv が無い');
    const out = api._rrAptBarsHtml(slv);
    clean(out);
    assert.ok(/\d+\.\dB/.test(out) && !/>\d+%</.test(out), 'B でなく % で出している');
    const raw = dom.attributeAptitude({ players, attrOf });
    assert.equal(raw.basis, 'raw');
    clean(api._rrAptBarsHtml(raw));
});

test('③ 誰が: 30人 × 5属性の表・自分の行が分かる・打っていない属性は空', () => {
    const mm = dom.memberMatrix({ players, attrOf });
    const out = api._rrMembersHtml(mm);
    clean(out);
    assert.equal(mm.rows.length, 30, '人数が違う');
    assert.equal((out.match(/<tr/g) || []).length, 31, '見出し + 30 行でない');
    assert.ok(out.includes('class="me"'), '自分の行が分からない');
    assert.ok(out.includes('data-no-swipe'), '横スクロールの箱にタブのスワイプ避けが無い');
    // 全員 3 属性ずつ = 空のマスが 30 × 2 = 60
    assert.equal((out.match(/class="c z"/g) || []).length, 60, '打っていない属性のマスの数が違う');
    assert.ok(/color-mix\(in srgb, var\(--attr-iron-solid\) \d+%, transparent\)/.test(out), '濃さを属性の色で出していない');
    assert.ok(out.includes('73.9'), '最大のセル (鉄甲 73.9B) が無い');
    assert.ok(out.includes('172.6B'), '合計が無い');
});

test('③ 誰が: 名前はエスケープされる (JSON 由来の文字列)', () => {
    const evil = [{ player: '<img src=x onerror=alert(1)>', syncLevel: 600, attacks: [{ bossCode: 'Z.E.U.S.', level: 3, damage: 1e9 }] }];
    const out = api._rrMembersHtml(dom.memberMatrix({ players: evil, attrOf }));
    assert.ok(!out.includes('<img src=x'), '生の HTML が出ている');
    assert.ok(out.includes('&lt;img src=x'), 'エスケープされていない');
});

test('締め凸は強さから外れ、削った量には残る (2026-09 の実データで確かめる)', () => {
    const apt = dom.attributeAptitude({ players, ratioTable: ratio, gb, attrOf });
    const prog = dom.attributeProgress({ players, hpTable: cfg.hardLevelHp, attrOf });
    for (const r of apt.rows) {
        const p = prog.find(x => x.attr === r.attr);
        assert.equal(r.scored, r.attacks - p.kills, `${r.attr}: 締め凸を除いた本数が合わない`);
        assert.equal(r.attacks, p.attacks, `${r.attr}: 凸数が進捗と食い違う`);
    }
    assert.ok(prog.every(p => p.kills > 0), '2026-09 には各属性に締め凸があるはず (前提が変わった)');
    // 締め凸を混ぜると 1凸平均は必ず下がる (除いている証拠)
    const withKill = dom.attributeAptitude({ players: players.map(p => ({ ...p, attacks: (p.attacks || []).map(({ isKill, ...a }) => a) })), ratioTable: ratio, gb, attrOf });
    assert.equal(withKill.killsExcluded, false, 'isKill が無いのに除いたことにしている');
    for (const r of apt.rows) {
        const w = withKill.rows.find(x => x.attr === r.attr);
        assert.ok(w.value < r.value, `${r.attr}: 締め凸を混ぜても値が下がらない (除けていない)`);
    }
});

test('① 進捗: 古い回 (レベルの記録の形が違う) は率を出さない — 分子と分母が揃わないため', () => {
    // 2026-03〜07 は level が 11 / 21 / 31 等。分子だけ全部の凸を足すと率が嘘になる (Codex指摘 2026-09-15)
    const old = rd('data/2026-05.json').players;
    const rows = dom.attributeProgress({ players: old, hpTable: cfg.hardLevelHp, declaredClasses: cfg.bossClassByMonth['2026-05'], attrOf });
    assert.equal(rows.length, 5, '5属性ぶん出ていない');
    assert.ok(rows.every(r => r.pct == null && r.noRate === 'levels' && r.unknownLevel > 0), `古い回で率を出している: ${rows.map(r => r.attr + ':' + r.pct)}`);
    assert.ok(rows.every(r => r.cls), 'クラスの宣言 (2026-05) が効いていない — 率を止めているのは別の理由かもしれない');
    const out = api._rrProgressHtml(rows);
    clean(out);
    assert.ok(out.includes('この回はレベルの記録の形が違うため率は出しません'), `断りが無い: ${out.slice(0, 300)}`);
    assert.ok(!/\d+\.\d%/.test(out), '率を出している');
    assert.ok(!out.includes('まで踏破'), '踏破を数えている (レベルが読めないのに)');
    // レベルが Lv1〜3 で揃っている回は今までどおり率が出る
    const ok8 = dom.attributeProgress({ players: rd('data/2026-08.json').players, hpTable: cfg.hardLevelHp, attrOf });
    assert.ok(ok8.every(r => r.pct > 0 && r.noRate === null), '2026-08 で率が出ない');
    assert.ok(Math.abs(ok8[0].pct - 97.2) < 0.1, `2026-08 の先頭が 97.2% でない: ${ok8[0].pct}`);
});

test('② 注記: 締め凸を見分けられない回はそう言う / 基準 (GB・SLv揃え・記録のまま) を言い分ける', () => {
    const note = els.get('raidReviewAptitudeNote');
    api._rrPaintAptitude(dom.attributeAptitude({ players, ratioTable: ratio, gb, attrOf }));
    assert.ok(note.textContent.includes('GB 利用者の中央値') && note.textContent.includes('締め凸は除く'), `2026-09 の注記が違う: ${note.textContent}`);
    // 2026-08 は isKill が無い = 締め凸が混ざる
    const old8 = dom.attributeAptitude({ players: rd('data/2026-08.json').players, ratioTable: ratio, gb, attrOf });
    assert.equal(old8.killsExcluded, false, '2026-08 に締め凸の印がある (前提が変わった)');
    api._rrPaintAptitude(old8);
    assert.ok(note.textContent.includes('締め凸を見分けられない'), `締め凸が混ざることを言っていない: ${note.textContent}`);
    api._rrPaintAptitude(dom.attributeAptitude({ players, ratioTable: ratio, attrOf }));
    assert.ok(note.textContent.includes('SLv') && note.textContent.includes('揃えた'), `SLv 揃えの断りが無い: ${note.textContent}`);
    api._rrPaintAptitude(dom.attributeAptitude({ players, attrOf }));
    assert.ok(note.textContent.includes('記録のまま'), `記録のままの断りが無い: ${note.textContent}`);
    assert.ok(!/undefined|NaN/.test(note.textContent));
});

test('② 散布図: 軸が壊れる値 (無限・幅0) なら横棒に倒す', () => {
    const mk = (vals) => ({ basis: 'gb', killsExcluded: true, refSlv: null,
        rows: vals.map((v, i) => ({ attr: ['iron', 'fire', 'wind'][i], attacks: 10 + i, value: v, avgB: 1e9, median: v, hi: v, lo: v })) });
    assert.ok(api._rrAptScatterHtml(mk([Number.MAX_VALUE, 1, 2])).includes('class="rr-bar"'), '無限になる値で散布図を描いている');
    const same = { basis: 'raw', killsExcluded: false, refSlv: null,
        rows: ['iron', 'fire'].map(a => ({ attr: a, attacks: 10, value: 0, avgB: 0, median: 0, hi: 0, lo: 0 })) };
    const out = api._rrAptScatterHtml(same);
    assert.ok(!/NaN|Infinity/.test(out), `座標が壊れている: ${out.slice(0, 200)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
