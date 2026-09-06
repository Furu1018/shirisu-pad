// ============================================================================
// 締め凸 (撃破した凸) の表記を index.html から切り出して実行テストする
// ----------------------------------------------------------------------------
// 単体テストでは出ない実行経路のバグ (TDZ・undefined 参照・エスケープ漏れ) を拾う。
// plan-hp-modal.mjs / team-picker.mjs と同じスタブ実行方式。
//
// ★ 守りたい契約:
//   1. 判定は月次JSON の attacks[].isKill (BlaBlaLINK の赤字) だけを見る。推定はしない
//   2. isKill が無い過去シーズンは「不明」— 締め凸ゼロと表示しない (注記自体を出さない)
//   3. プレイヤー名は必ずエスケープして注記に出す (DB/JSON 由来の文字列)
// ============================================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// index.html から対象の関数群を切り出す
const grab = (name, kind = 'function') => {
    const re = kind === 'const'
        ? new RegExp(`\\n        const ${name} = [^\\n]*;`)
        : new RegExp(`\\n        function ${name}\\([\\s\\S]*?\\n        \\}`);
    const m = html.match(re);
    if (!m) throw new Error(`index.html から ${name} を切り出せませんでした (実装が動いたらこのテストも直す)`);
    return m[0];
};

// 最小の DOM スタブ
const els = new Map();
const makeEl = () => ({ style: {}, innerHTML: '', textContent: '' });
for (const id of ['fururiKillNote', 'rankingKillNote']) els.set(id, makeEl());

let currentData = [];
const src = [
    'let currentData = [];',
    'const document = { getElementById: (id) => els.get(id) || null };',
    'const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");',
    grab('KILL_NOTE', 'const'),
    grab('_renderKillNote'),
    grab('_attackIsKill'),
    grab('_killCountOf'),
    grab('_seasonHasKillFlags'),
    grab('_killBadge'),
    'return { setData: (d) => { currentData = d; }, _renderKillNote, _attackIsKill, _killCountOf, _seasonHasKillFlags, _killBadge };',
].join('\n');
const api = new Function('els', src)(els);

let passed = 0, failed = 0;
const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};

const atk = (isKill) => (isKill === undefined ? { damage: 1e9 } : { damage: 1e9, isKill });

console.log('締め凸バッジ:');

test('isKill:true の凸だけを締め凸として数える', () => {
    assert.equal(api._killCountOf({ attacks: [atk(true), atk(false), atk(true)] }), 2);
    assert.equal(api._killCountOf({ attacks: [atk(false), atk(false)] }), 0);
    assert.equal(api._killCountOf({}), 0, 'attacks が無くても落ちない');
    assert.equal(api._killCountOf(null), 0);
});

test('isKill が無い過去シーズン (v2.4以前) は締め凸ゼロと数えない', () => {
    // ★ ここが崩れると「昔のシーズンは誰も締めていない」という嘘の表示になる
    assert.equal(api._killCountOf({ attacks: [atk(), atk(), atk()] }), 0, '不明は数に入れない');
    api.setData([{ player: 'A', attacks: [atk(), atk()] }]);
    assert.equal(api._seasonHasKillFlags(), false, 'フラグを持たないシーズンと判定する');
    api.setData([{ player: 'A', attacks: [atk(false), atk()] }]);
    assert.equal(api._seasonHasKillFlags(), true, 'false でもフラグは有る');
});

test('バッジは 0件で出さない / 複数は件数つき', () => {
    assert.equal(api._killBadge(0), '');
    assert.ok(api._killBadge(1).includes('>締<'), `1件は「締」: ${api._killBadge(1)}`);
    const b3 = api._killBadge(3, { withCount: true });
    assert.ok(b3.includes('締 3'), `3件は件数つき: ${b3}`);
    assert.ok(b3.includes('title='), 'ツールチップで理由を説明する');
    assert.ok(!api._killBadge(3).includes('締 3'), 'withCount 無しなら件数は出さない');
});

test('注記: 締め凸がある人を多い順に並べ、件数を出す', () => {
    // ★ 少ない人を先に置く — 並べ替えが効いていないと下の「多い順」で落ちる
    api.setData([
        { player: '銀狐リン', attacks: [atk(true), atk(false), atk(true)] },
        { player: 'TAC', attacks: [atk(false), atk(false), atk(false)] },
        { player: 'イオ', attacks: [atk(true), atk(true), atk(true)] },
    ]);
    api._renderKillNote('fururiKillNote');
    const el = els.get('fururiKillNote');
    assert.equal(el.style.display, 'block');
    assert.ok(el.innerHTML.includes('(5件)'), `合計5件: ${el.innerHTML}`);
    assert.ok(el.innerHTML.indexOf('イオ') < el.innerHTML.indexOf('銀狐リン'), '多い順');
    assert.ok(el.innerHTML.includes('イオ (3凸)'), '複数回は件数つき');
    assert.ok(!el.innerHTML.includes('TAC'), '締め凸が無い人は載せない');
});

test('注記: 締め凸が0件なら出さない / 過去シーズンでも出さない', () => {
    api.setData([{ player: 'A', attacks: [atk(false), atk(false)] }]);
    api._renderKillNote('fururiKillNote');
    assert.equal(els.get('fururiKillNote').style.display, 'none', '0件なら隠す');
    api.setData([{ player: 'A', attacks: [atk(), atk()] }]);
    api._renderKillNote('fururiKillNote');
    assert.equal(els.get('fururiKillNote').style.display, 'none', 'フラグ無しシーズンは隠す');
});

test('注記: プレイヤー名をエスケープする (JSON由来の文字列を信頼しない)', () => {
    api.setData([{ player: '<img src=x onerror=alert(1)>', attacks: [atk(true)] }]);
    api._renderKillNote('fururiKillNote');
    const h = els.get('fururiKillNote').innerHTML;
    assert.ok(!h.includes('<img'), `生タグが入ってはいけない: ${h}`);
    assert.ok(h.includes('&lt;img'), 'エスケープされている');
});

test('存在しない要素IDでも落ちない', () => {
    api.setData([{ player: 'A', attacks: [atk(true)] }]);
    api._renderKillNote('noSuchElement');   // 例外が飛ばなければ合格
});

// ---- 実データでの検証 -------------------------------------------------------
console.log('\n実データ (data/2026-09.json):');
test('締め凸12件・イオが3凸とも締め凸', () => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '2026-09.json'), 'utf8'));
    api.setData(d.players.map(p => ({ player: p.player, attacks: p.attacks })));
    assert.equal(api._seasonHasKillFlags(), true);
    const total = d.players.reduce((s, p) => s + api._killCountOf(p), 0);
    assert.equal(total, 12, `締め凸は12件のはず: ${total}`);
    const io = d.players.find(p => p.player === 'イオ');
    assert.equal(api._killCountOf(io), 3, 'イオは3凸とも締め凸');
});

test('締め凸は「ボス×レベルごとに1件」かつ「凸の合計==HP」と一致する', () => {
    // BlaBlaLINK の赤字が本当に撃破を指しているかの裏取り。ここが崩れたら判定色を疑う
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '2026-09.json'), 'utf8'));
    const HP = { 1: { lord: 99.8562792, tyrant: 150.8418136 }, 2: { lord: 149.7844188, tyrant: 226.2627204 }, 3: { lord: 292.44529575, tyrant: 349.2309015 } };
    const TIER = { 'Z.E.U.S.': 'lord', 'H.S.T.A.': 'lord', 'A.N.M.I.': 'tyrant', 'P.S.I.D.': 'lord', 'D.M.T.R.': 'tyrant' };
    const g = new Map();
    for (const p of d.players) for (const a of p.attacks) {
        const k = `${a.bossCode}:${a.level}`;
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(a);
    }
    for (const [k, rows] of g) {
        const [code, lv] = k.split(':');
        const total = rows.reduce((s, a) => s + a.damage, 0) / 1e9;
        const hp = HP[Number(lv)][TIER[code]];
        const kills = rows.filter(a => a.isKill === true).length;
        const cleared = total >= hp - 0.15;
        assert.equal(kills, cleared ? 1 : 0, `${k}: 合計 ${total.toFixed(1)}B / HP ${hp.toFixed(1)}B なのに締め凸 ${kills}件`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
