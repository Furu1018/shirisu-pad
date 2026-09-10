// ============================================================================
// 🏁 締め凸コンソール (_opsFinishConsoleHtml) の実行テスト
//   node tests/finish-console.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判断は js/domain/finish.js の本物を使う (画面で勝ち負けを書き足していないことの確認も兼ねる)。
// ★ テンプレートリテラルの中の未定義参照は実行しないと出ない (2026-09-07 の本番障害と同じ型)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/finish.js';   // globalThis.finishDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function cut(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} を切り出せません (目印が変わった?)`); process.exit(2); }
    let d = 0, started = false, inStr = null, prev = '';
    for (let k = html.indexOf('{', i); k < html.length; k++) {
        const ch = html[k];
        if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; }
        else if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '{') { d++; started = true; }
        else if (ch === '}') { d--; if (started && !d) return html.slice(i, k + 1); }
        prev = ch;
    }
    console.error(`NG: ${marker} の終端を判定できません`); process.exit(2);
}
const SRC = cut('        function _opsFinishConsoleHtml(boss, candidatesAll, remHpB, commitments)');

const H = (...hs) => hs.map(h => `h${String(h).padStart(2, '0')}`);
const P = (id, name, dmg, slots, attackCount = 0) => ({ id, name, dmg, availableSlots: slots, attackCount });

function run({ candidates = [], remHp = 60, curHour = 21, hours = null, shots = null, reqs = [], boss = { boss_number: 3 } } = {}) {
    const env = {
        window: { finishDomain: globalThis.finishDomain },
        _finishReqCache: reqs,
        _finishCurHour: () => curHour,
        _opsFinish: { shots, hours },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn _opsFinishConsoleHtml;`)(...keys.map(k => env[k]));
    return fn(boss, candidates, remHp);
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.log('  ❌ ' + name + '\n     ' + (e && e.message)); fail++; }
}

console.log('\n締め凸コンソール (画面):\n');

test('★ 実際に描ける: 4つの窓と結論の1行が出る', () => {
    const out = run({ candidates: [P(1, 'A', 70, H(21, 22)), P(2, 'B', 58, H(23, 0))] });
    assert.ok(out.includes('いま打つか、待つか'), '見出しが無い');
    for (const w of ['今すぐ', '2時間以内', '4時間以内', '今日いっぱい']) {
        assert.ok(out.includes(w), `窓「${w}」が出ていない`);
    }
    assert.equal((out.match(/handleOpsFinishOpt\('hours'/g) || []).length, 4, '押せる行が4つでない');
    assert.ok(!/undefined|NaN|\[object Object\]/.test(out), `未定義が混ざっている: ${out.slice(0, 300)}`);
});

test('★ 待つと得なら、何B縮むかと「誰が出られるようになるか」を言う', () => {
    // いま出られるのは A(95) だけ → 35 超過。2時間待てば C(62) が出て 2 超過
    const out = run({ candidates: [P(1, 'A', 95, H(21)), P(3, 'C', 62, H(22, 23))] });
    assert.ok(/2時間以内<\/b>まで待つと 33\.00B/.test(out), `節約量が出ていない: ${out.match(/<b>[^<]*<\/b>まで待つと[^<]*/) || ''}`);
    assert.ok(out.includes('C が出られるため'), '誰が出られるようになるかを言っていない');
    assert.ok(out.includes('待って増える: C'), '窓の行に増えた人が出ていない');
});

test('★ 今がいちばんなら「待っても縮まない」と言い切る (待たせない)', () => {
    const out = run({ candidates: [P(1, 'A', 60, H(21)), P(2, 'B', 60, H(23))] });
    assert.ok(out.includes('いま打つのがいちばんきれいです'), `今を勧めていない: ${out.slice(0, 200)}`);
});

test('★ 今は倒せないが待てば倒せる、を言い分ける', () => {
    const out = run({ candidates: [P(1, 'A', 20, H(21)), P(2, 'B', 90, H(0, 1))] });
    assert.ok(out.includes('いますぐは倒しきれません'), '言い分けていない');
    assert.ok(out.includes('この時間では倒しきれません'), '今すぐの行に倒せないと書いていない');
});

test('★ 誰にも倒せないときは、そう言って終わる (待てば倒せると言わない)', () => {
    const out = run({ candidates: [P(1, 'A', 5, H(21))], remHp: 600 });
    assert.ok(out.includes('倒しきれません'), '倒せないと言っていない');
    assert.ok(!out.includes('なら <b>'), '倒せないのに「待てば倒せる」と言っている');
    assert.ok(!out.includes('いちばんきれい'), '倒せない手を勧めている');
});

test('★ いちばんきれいな窓に印が付く (1つだけ)', () => {
    const out = run({ candidates: [P(1, 'A', 95, H(21)), P(3, 'C', 62, H(22))] });
    assert.equal((out.match(/いちばんきれい/g) || []).length, 1, '印が1つでない');
});

test('★ いま選んでいる窓が分かる (押した行が光る)', () => {
    const off = run({ candidates: [P(1, 'A', 60, H(21))], hours: null });
    const on = run({ candidates: [P(1, 'A', 60, H(21))], hours: 2 });
    assert.notEqual(off, on, '選んでいる窓で見た目が変わらない');
    assert.ok(on.includes('background:var(--s1)'), '選んだ行に印が付いていない');
});

test('★ 別のボスで「確認中」の人がいたら言う (二重に頼まない)', () => {
    const out = run({
        candidates: [P(1, 'A', 60, H(21))],
        reqs: [{ player_id: 1, boss_number: 4, status: 'pending' }],
    });
    assert.ok(out.includes('別のボスで確認中'), '確認中を出していない');
    assert.ok(out.includes('A は別のボスで確認中'), '誰なのかを出していない');
});

test('★ 別のボスで「了承済み」で凸が埋まった人は、そもそも案に出さない', () => {
    // A は 2凸済み + 別のボスで1件了承 = 残り0
    const out = run({
        candidates: [P(1, 'A', 90, H(21), 2), P(2, 'B', 60, H(21), 0)],
        reqs: [{ player_id: 1, boss_number: 4, status: 'accepted' }],
    });
    assert.ok(out.includes('B'), 'B が出ていない');
    assert.ok(!/>A ＋|＋ A</.test(out), '凸が埋まっている A を案に出している');
});

test('★ 名前を onclick に埋めない (引用符で属性が壊れる / 注入できる)', () => {
    const out = run({ candidates: [P(1, `"><img src=x onerror=alert(1)>`, 60, H(21))] });
    // ★ 見るのは「タグとして成立する形で出ていないか」。escapeHtml は = や空白は変えないので、
    //   'onerror=' という**文字列**は残る (文字として出るぶんには無害)
    assert.ok(!out.includes('<img src=x'), `タグとして出ている: ${out.slice(0, 200)}`);
    assert.ok(out.includes('&quot;&gt;&lt;img'), '名前をエスケープしていない');
    // 名前を onclick の中に入れていない (引用符で属性が壊れる)
    assert.ok(!/onclick="[^"]*img/.test(out), '名前を onclick に埋めている');
});

test('★ 色を直値で焼き込んでいない (テーマを切り替えても付いてくる)', () => {
    const out = run({ candidates: [P(1, 'A', 95, H(21)), P(3, 'C', 62, H(22))] });
    const lits = out.match(/(?:color|background|border-color)\s*:\s*#[0-9A-Fa-f]{3,8}/g) || [];
    assert.deepEqual(lits, [], `色の直値がある: ${lits.join(', ')}`);
});

test('★ 候補が0人でも落ちない / ドメインが読めていなくても落ちない', () => {
    assert.doesNotThrow(() => run({ candidates: [] }));
    const env = { window: {}, _finishReqCache: [], _finishCurHour: () => 21, _opsFinish: {}, escapeHtml: String };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn _opsFinishConsoleHtml;`)(...keys.map(k => env[k]));
    assert.equal(fn({ boss_number: 3 }, [], 60), '', 'ドメイン未読込のときは静かに空を返すこと');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
