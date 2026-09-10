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
const OFFER_SRC = cut('        function _opsFinishOfferHtml()');

// 打診の進み具合 (_opsFinishOfferHtml) を、本物のドメインで走らせる
function runOffer({ rows = [], offerId = 'o1' } = {}) {
    const env = {
        window: { finishDomain: globalThis.finishDomain },
        _finishReqCache: rows,
        _opsFinish: { offerId },
        _opsFinishOffer: null,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${OFFER_SRC}\nreturn _opsFinishOfferHtml;`)(...keys.map(k => env[k]));
    return fn();
}
const OR = (plan, id, name, status, extra = {}) => ({
    id: id * 10 + (plan === 'A' ? 1 : 2), offer_id: 'o1', plan_key: plan,
    player_id: id, name, status, ...extra,
});

const H = (...hs) => hs.map(h => `h${String(h).padStart(2, '0')}`);
const P = (id, name, dmg, slots, attackCount = 0) => ({ id, name, dmg, availableSlots: slots, attackCount });

function run({ candidates = [], remHp = 60, curHour = 21, hours = null, shots = null, reqs = [],
    boss = { boss_number: 3 }, pick = [], deadlineMin = 15, offerHtml = '' } = {}) {
    const env = {
        window: { finishDomain: globalThis.finishDomain },
        _finishReqCache: reqs,
        _finishCurHour: () => curHour,
        _opsFinish: { shots, hours, pick: new Set(pick), deadlineMin, offerId: null },
        _opsFinishOfferHtml: () => offerHtml,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn _opsFinishConsoleHtml;`)(...keys.map(k => env[k]));
    return fn(boss, candidates, remHp);
}

let pass = 0, fail = 0;
const _pending = [];
function test(name, f) {
    try {
        const r = f();
        // ★ Promise を返すテストは、待ってから結果を数える (待たないと静かに通る)
        if (r && typeof r.then === 'function') {
            _pending.push(r.then(() => { console.log('  ✅ ' + name); pass++; })
                .catch((e) => { console.log('  ❌ ' + name + '\n     ' + (e && e.message)); fail++; }));
            return;
        }
        console.log('  ✅ ' + name); pass++;
    } catch (e) { console.log('  ❌ ' + name + '\n     ' + (e && e.message)); fail++; }
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
    const env = { window: {}, _finishReqCache: [], _finishCurHour: () => 21,
        _opsFinish: { pick: new Set(), deadlineMin: 15 }, _opsFinishOfferHtml: () => '', escapeHtml: String };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC}\nreturn _opsFinishConsoleHtml;`)(...keys.map(k => env[k]));
    assert.equal(fn({ boss_number: 3 }, [], 60), '', 'ドメイン未読込のときは静かに空を返すこと');
});

test('★ 案を選ぶと、期限と「同時に打診」が出る (2案そろうまでは押せない)', () => {
    const cands = [P(1, 'A', 95, H(21)), P(3, 'C', 62, H(22))];
    const none = run({ candidates: cands });
    assert.ok(!none.includes('同時に打診'), '何も選んでいないのにバーが出ている');
    const one = run({ candidates: cands, pick: ['now'] });
    assert.ok(one.includes('1案を選択中'), '選択中と出ていない');
    assert.ok(one.includes('disabled'), '1案なのに押せてしまう');
    assert.ok(one.includes('もう1案選ぶと'), '何をすればいいか書いていない');
    const two = run({ candidates: cands, pick: ['now', 'h2'] });
    assert.ok(two.includes('2案を選択中'), '2案と出ていない');
    assert.ok(!/handleOpsFinishOfferSend\(\)" disabled/.test(two), '2案そろっても押せない');
});

test('★ 期限は運営が都度選べる。既定は15分 (ユーザー決定 2026-09-10)', () => {
    const out = run({ candidates: [P(1, 'A', 95, H(21)), P(3, 'C', 62, H(22))], pick: ['now'] });
    for (const m of [5, 10, 15, 30]) assert.ok(out.includes(`>${m}分</button>`), `${m}分 が選べない`);
    // 既定 (15) だけが押された見た目になっている
    const on = (out.match(/handleOpsFinishDeadline\((\d+)\)"[^>]*background:var\(--t-ink\)/g) || []);
    assert.equal(on.length, 1, '選ばれている期限が1つでない');
    assert.ok(on[0].includes('(15)'), `既定が15分でない: ${on[0]}`);
    const other = run({ candidates: [P(1, 'A', 95, H(21)), P(3, 'C', 62, H(22))], pick: ['now'], deadlineMin: 30 });
    assert.ok(/handleOpsFinishDeadline\(30\)"[^>]*background:var\(--t-ink\)/.test(other), '選び直せない');
});

test('★ 進み具合: 待っている人と、揃った案が読める', () => {
    const out = runOffer({ rows: [
        OR('A', 1, 'あ', 'accepted', { responded_at: '2026-09-10T12:05:00Z', deadline_at: '2026-09-10T12:30:00Z' }),
        OR('B', 2, 'い', 'accepted', { responded_at: '2026-09-10T12:03:00Z' }),
        OR('B', 3, 'う', 'pending'),
    ] });
    assert.ok(out.includes('打診中'), '打診中の見出しが無い');
    assert.ok(out.includes('全員そろいました'), '揃った案を言っていない');
    assert.ok(out.includes('う 待ち'), '誰を待っているか出ていない');
    assert.ok(out.includes('この案で確定'), '確定ボタンが無い');
    assert.equal((out.match(/この案で確定/g) || []).length, 1, '確定ボタンが1つでない');
    assert.ok(!/undefined|NaN|\[object Object\]/.test(out), `未定義が混ざっている: ${out.slice(0, 300)}`);
});

test('★ 進み具合: 断られた案は「見送り」と出て、確定できない', () => {
    const out = runOffer({ rows: [
        OR('A', 1, 'あ', 'declined'),
        OR('B', 2, 'い', 'pending'),
    ] });
    assert.ok(out.includes('見送り (あ が不可)'), '断られた理由が出ていない');
    assert.ok(!out.includes('この案で確定'), '死んだ案を確定できてしまう');
});

test('★ 進み具合: どちらも見送りなら、次の手を促す', () => {
    const out = runOffer({ rows: [OR('A', 1, 'あ', 'declined'), OR('B', 2, 'い', 'declined')] });
    assert.ok(out.includes('どちらの案も見送り'), '全滅と言っていない');
    assert.ok(out.includes('別の組み合わせ'), '次にどうするかを言っていない');
});

test('★ 進み具合: 打診していなければ何も出さない', () => {
    assert.equal(runOffer({ rows: [], offerId: null }), '', '打診が無いのに出している');
    assert.equal(runOffer({ rows: [OR('A', 1, 'あ', 'pending')], offerId: 'ほかの回' }), '',
        '別の回の行を拾っている');
});

test('★ 進み具合: 名前をエスケープする', () => {
    const out = runOffer({ rows: [OR('A', 1, '"><img src=x>', 'pending')] });
    assert.ok(!out.includes('<img src=x'), 'タグとして出ている');
});

test('★ 状態の既定: 期限は15分 (ユーザー決定 2026-09-10)', () => {
    // ★ 画面に渡す値ではなく**状態の初期値**を見る。既定が変わると、
    //   運営が期限を選ばずに送ったときの長さが黙って変わる
    const m = html.match(/const _opsFinish = \{([^}]*)\};/);
    assert.ok(m, '_opsFinish が見つからない');
    assert.ok(/deadlineMin:\s*15\b/.test(m[1]), `期限の既定が15分でない: ${m[1]}`);
    assert.ok(/pick:\s*new Set\(\)/.test(m[1]), '選んだ案を持っていない');
});

test('★ 同時に出せるのは2案まで (3つめは足せない)', () => {
    // ★ 3案以上を同時に出すと、誰に何を頼んだか運営が追えなくなる
    const SRC2 = cut('        function handleOpsFinishPick(key)');
    const state = { pick: new Set(), deadlineMin: 15 };
    const warned = [];
    const env = {
        _opsFinish: state,
        showNotification: (t) => warned.push(t),
        _opsCurrentAttr: null,
        renderOpsFinishList: () => { },
    };
    const keys = Object.keys(env);
    const pick = new Function(...keys, `${SRC2}\nreturn handleOpsFinishPick;`)(...keys.map(k => env[k]));
    pick('now'); pick('h2');
    assert.deepEqual([...state.pick], ['now', 'h2']);
    pick('h4');
    assert.deepEqual([...state.pick], ['now', 'h2'], '3案めが入ってしまう');
    assert.equal(warned.length, 1, '2案までだと伝えていない');
    pick('now');                       // もう一度押すと外れる
    assert.deepEqual([...state.pick], ['h2'], '押し直しで外れない');
    pick('h4');
    assert.deepEqual([...state.pick], ['h2', 'h4'], '外したあとに足せない');
});

test('★ 確定: 見送りを**記録してから**知らせる / 落ちた行だけを落とす', () => {
    // ★ 送ってから記録に失敗すると、「見送り」と伝えたのに画面では確認中のまま残る。
    //   逆に人+ボスで更新すると、勝った案にも居る人の行まで落としてしまう
    const SRC3 = cut('        async function handleOpsFinishOfferConfirm(winnerKey)');
    const order = [];
    let declinedIds = null, pushedTo = null;
    const pr = globalThis.finishDomain.offerProgress([
        { id: 11, plan_key: 'A', player_id: 1, name: 'あ', status: 'accepted' },
        { id: 21, plan_key: 'A', player_id: 2, name: 'い', status: 'accepted' },
        { id: 22, plan_key: 'B', player_id: 2, name: 'い', status: 'accepted' },
        { id: 32, plan_key: 'B', player_id: 3, name: 'う', status: 'pending' },
        { id: 42, plan_key: 'B', player_id: 4, name: 'え', status: 'declined' },
    ]);
    const env = {
        window: {
            finishDomain: globalThis.finishDomain,
            supabaseDeclineFinishRows: async (ids) => { order.push('記録'); declinedIds = ids; return ids.length; },
            sendPushNotification: async (o) => { order.push('送信'); pushedTo = o.playerIds; return { sent: 1, target: 1 }; },
        },
        _opsFinishOffer: pr,
        _opsFinishPushContext: { boss: { name: 'ボス3', boss_number: 3 }, ptInfo: { name: '水冷' } },
        _opsFinish: { offerId: 'o1' },
        confirm: () => true,
        alert: (m) => { throw new Error('alert が出た: ' + m); },
        showPushPreview: async () => true,
        showNotification: () => { },
        _refreshFinishRequests: async () => { },
        _opsCurrentAttr: null,
        renderOpsFinishList: () => { },
        renderOpsBossSummary: () => { },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC3}\nreturn handleOpsFinishOfferConfirm;`)(...keys.map(k => env[k]));
    return fn('A').then(() => {
        assert.deepEqual(order, ['記録', '送信'], '記録より先に送っている');
        // ★ 落ちた案の「う」だけ。勝った案にも居る「い」と、自分で断った「え」は落とさない
        assert.deepEqual(declinedIds, [32], `落とす行が違う: ${JSON.stringify(declinedIds)}`);
        assert.deepEqual(pushedTo, [3], `知らせる相手が違う: ${JSON.stringify(pushedTo)}`);
        assert.equal(env._opsFinish.offerId, null, '確定したのに打診中のまま');
    });
});

await Promise.all(_pending);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
