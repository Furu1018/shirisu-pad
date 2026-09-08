// ============================================================================
// 運営タブ「🧬 育成データの取り込み」の描画 (_growthPaint) の実行テスト
//   node tests/growth-panel.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定 (usedCharacters / wantedCodesFor / STATUS_JP) は js/domain/growth.js の本物を使う。
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
const SRC = cut('        function _growthPaint()');

const P = (id, name, openid = null, extra = {}) => ({ id, name, blabla_openid: openid, ...extra });
const SEASONS = [
    { id: 33, month_key: 'TEST-20260908121322', hard_date: '2026-09-08', is_active: true, is_test: true },
    { id: 30, month_key: '2026-09', hard_date: '2026-09-05', is_active: false, is_test: false },
];
function run({ players = [], statusRows = [], used = ['ラピ'], wanted = { codes: [1007], missing: [] }, busy = false, msg = null,
    seasons = SEASONS, seasonId = 30 } = {}) {
    const els = { opsGrowthBody: { innerHTML: '' }, opsGrowthCounts: { textContent: '' } };
    const env = {
        _growth: { gen: 0, seasons, picked: null, seasonId, players, statusRows, used, wanted, busy, msg },
        window: { growthDomain: dom },
        document: { getElementById: (id) => els[id] || null },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    };
    const keys = Object.keys(env);
    const paint = new Function(...keys, `${SRC}\nreturn _growthPaint;`)(...keys.map(k => env[k]));
    paint();
    return { html: () => els.opsGrowthBody.innerHTML, counts: () => els.opsGrowthCounts.textContent };
}

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object Object\]/.test(out),
    `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object Object\]).{40}/)?.[0]}`);

console.log('育成データの取り込みパネル:\n');

test('★ 4段すべて実際に描ける (名寄せ → 生成 → 貼り付け → 結果)', () => {
    const t = run({
        players: [P(1, 'あ', '123456'), P(2, 'い')],
        statusRows: [{ player_id: 1, status: 'ok', character_count: 5 }, { player_id: 2, status: 'no_openid' }],
    });
    const out = t.html();
    assert.equal((out.match(/class="gr-step/g) || []).length, 5, `段が5つでない: ${out.slice(0, 120)}`);
    assert.ok(out.includes('どのレイドの育成か'));
    assert.ok(out.includes('BlaBlaLINK の識別子をひも付ける'));
    assert.ok(out.includes('取り込み用のブックマークレットを作る'));
    assert.ok(out.includes('id="opsGrowthPaste"'), '貼り付け欄が無い');
    assert.ok(out.includes('取り込みの結果'));
    assert.equal(t.counts(), '2026-09 (09/05) · 紐づけ 1/2 · 対象 1体');
    noUndef(out);
});

test('★ ⓪ レイドは選べる (アクティブとは限らない — 終わったレイドを後から取り込む)', () => {
    const t = run({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }] });
    const out = t.html();
    assert.ok(/onchange="handleGrowthPickSeason\(this\.value\)"/.test(out), '選び直す導線が無い');
    assert.equal((out.match(/<option value="\d+"/g) || []).length, 2, 'シーズンの選択肢が足りない');
    assert.ok(/<option value="30" selected>2026-09 \(09\/05\)<\/option>/.test(out), '選んでいるレイドに印が無い');
    assert.ok(/<option value="33" >TEST-20260908121322 \(09\/08\) 🧪テスト<\/option>/.test(out), 'テストシーズンの印が無い');
    noUndef(out);
});

test('★ 生成ボタンが押せない理由を必ず言う (実機FB 2026-09-09: 押せないだけで理由が分からなかった)', () => {
    // 凸記録が無いレイド (テストシーズン) を選んでいる
    const t = run({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }], seasonId: 33, used: [], wanted: { codes: [], missing: [] } });
    const out = t.html();
    assert.ok(/選んだレイドに凸の記録が無いため/.test(out), `理由が出ていない: ${out.slice(-500)}`);
    assert.ok(/いまはテストシーズンを見ています/.test(out), 'テストシーズンだと気づけない');
    // 識別子が1人もひも付いていない場合は別の理由
    const t2 = run({ players: [{ id: 1, name: 'あ' }] });
    assert.ok(/まず ① で識別子をひも付けてください/.test(t2.html()));
    // 押せるときは理由を出さない
    assert.ok(!/gr-note warn/.test(run({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }] }).html()));
});

test('★ 名寄せ: 済みは値つきで印がつき、未設定は空欄。保存はドメインを通す導線', () => {
    const t = run({ players: [P(1, 'あ', '123456'), P(2, 'い')] });
    const out = t.html();
    assert.ok(/<input[^>]*class="set"[^>]*value="123456"/.test(out), '済みの印か値が無い');
    assert.ok(/<input[^>]*class=""[^>]*value=""[^>]*placeholder="未設定"/.test(out), '未設定の欄が無い');
    assert.equal((out.match(/handleGrowthSetOpenid\(\d+, this\.value\)/g) || []).length, 2, '保存の導線が全員に無い');
    noUndef(out);
});

test('生成ボタン: 紐づけゼロ / 対象キャラゼロ なら押せない', () => {
    assert.ok(/handleGrowthCopySnippet\(\)"\s*>/.test(run({ players: [P(1, 'あ', '123456')] }).html()), '押せる状態にならない');
    assert.ok(/handleGrowthCopySnippet\(\)" disabled/.test(run({ players: [P(1, 'あ')] }).html()), '紐づけゼロで押せてしまう');
    assert.ok(/handleGrowthCopySnippet\(\)" disabled/.test(
        run({ players: [P(1, 'あ', '1')], wanted: { codes: [], missing: [] } }).html()), '対象ゼロで押せてしまう');
});

test('対応表に無いキャラは名指しで警告する (黙って対象から外さない)', () => {
    const t = run({ players: [P(1, 'あ', '123456')], wanted: { codes: [1007], missing: ['シフティー', 'シュエン'] } });
    const out = t.html();
    assert.ok(/gr-note warn[^>]*>対応表に無いキャラが 2 体あります \(シフティー・シュエン\)/.test(out), `警告が無い: ${out.slice(-400)}`);
    noUndef(out);
});

test('★ 43 未適用 (statusRows=null) は取り込みを押させず、適用を案内する', () => {
    const t = run({ players: [P(1, 'あ', '123456')], statusRows: null });
    const out = t.html();
    assert.ok(/handleGrowthImport\(\)" disabled/.test(out), '未適用なのに取り込みが押せる');
    assert.ok(out.includes('supabase/43_member_growth.sql'), '適用の案内が無い');
    assert.ok(!out.includes('取り込みの結果'), '結果の段を出している');
    // 列だけ落ちている環境 (growthUnsupported) も同じ扱い
    assert.ok(/handleGrowthImport\(\)" disabled/.test(run({ players: [P(1, 'あ', null, { growthUnsupported: true })] }).html()));
});

test('★ 結果: 取れなかった人だけ理由つきで出す / 全員取れたら done', () => {
    const t = run({
        players: [P(1, 'あ', '1'), P(2, 'い', '2'), P(3, 'う')],
        statusRows: [
            { player_id: 1, status: 'ok', character_count: 5 },
            { player_id: 2, status: 'private' },
            { player_id: 3, status: 'no_openid' },
        ],
    });
    const out = t.html();
    assert.ok(out.includes('取れた 1人 · 取れなかった 2人'));
    assert.ok(/class="st private"[^>]*>非公開</.test(out), '非公開の表示が無い');
    assert.ok(/title="本人が非公開にしています"/.test(out), 'ピルに詳しい言い方が付いていない');
    assert.ok(/class="st no_openid"[^>]*>未ひも付け</.test(out), '未ひも付けの表示が無い');
    assert.ok(!/class="st ok"/.test(out), '取れた人まで並べている (畳むこと)');
    const all = run({ players: [P(1, 'あ', '1')], statusRows: [{ player_id: 1, status: 'ok', character_count: 5 }] }).html();
    assert.ok(/gr-step done[^>]*>[\s\S]*?取り込みの結果/.test(all) && all.includes('全員ぶん取り込めています'));
    noUndef(out);
});

test('取り込み中はボタンと貼り付け欄を止める / 伝言はそのまま出る', () => {
    const t = run({ players: [P(1, 'あ', '1')], busy: true, msg: { kind: 'err', text: '<壊れた>' } });
    const out = t.html();
    assert.ok(out.includes('取り込み中…') && /class="gr-paste"[^>]*disabled/.test(out), '実行中に止めていない');
    assert.ok(out.includes('&lt;壊れた&gt;'), '伝言を素通しでHTMLにしている');
    noUndef(out);
});

// ============================================================================
// 取り込み本体 (handleGrowthImport) の実行テスト
// ★ ここが実行テストである理由: parseImportPayload は **非同期** (gzip 展開)。
//   await を忘れると box が Promise になり、box.members が undefined で必ず失敗する。
//   ソース検査では気づけない (実際 2026-09-09 に await 漏れのまま commit した)。
// ============================================================================
const SRC_IMPORT = cut('        async function handleGrowthImport()');
const NAME_MAP = { '1012': { jp: 'サクラ', pad: 'サクラ' } };
const member = (o = {}) => ({
    openid: '111111', label: 'あ', code: 0, area: 81, requested: 1,
    characters: [{ name_code: 1012 }],
    details: [{ name_code: 1012, grade: 3, core: 0, lv: 200 }],
    stateEffects: [], ...o,
});
function runImport({ players = [], statusRows = [], used = ['サクラ'], payload = { members: [member()] }, onSaveGrowth = null } = {}) {
    const calls = { growth: [], status: [], notes: [], repaints: 0 };
    const ta = { value: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    const state = { gen: 0, seasons: SEASONS, picked: null, seasonId: 10, players, statusRows, used, wanted: { codes: [1012], missing: [] }, busy: false, msg: null };
    const env = {
        _growth: state,
        _growthNameMap: NAME_MAP,
        window: {
            growthDomain: dom,
            supabaseSaveMemberGrowth: async (seasonId, playerId, rows) => {
                calls.growth.push({ seasonId, playerId, names: rows.map(r => r.character_name) });
                if (onSaveGrowth) await onSaveGrowth(state);
                return rows.length;
            },
            supabaseSaveMemberGrowthStatus: async (seasonId, playerId, o) => { calls.status.push({ seasonId, playerId, ...o }); },
        },
        document: { getElementById: (id) => (id === 'opsGrowthPaste' ? ta : null) },
        _growthPaint: () => { calls.repaints++; },
        _growthNote: (kind, text) => { calls.notes.push({ kind, text }); },
        renderOpsGrowth: async () => { },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, SRC_IMPORT + '\nreturn handleGrowthImport;')(...keys.map(k => env[k]));
    return { run: () => fn(), calls, state, ta };
}

async function testAsync(name, f) {
    try { await f(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.error('  ❌ ' + name + '\n     ' + e.constructor.name + ': ' + e.message); fail++; }
}

console.log('\n取り込み本体:\n');

await testAsync('★ 貼り付けの展開を await している (忘れると1件も保存されない)', async () => {
    const t = runImport({ players: [{ id: 1, name: 'あ', blabla_openid: '111111' }] });
    await t.run();
    assert.equal(t.calls.growth.length, 1, '保存されていない: ' + JSON.stringify(t.calls.notes));
    assert.deepEqual(t.calls.growth[0], { seasonId: 10, playerId: 1, names: ['サクラ'] });
    assert.equal(t.calls.status[0].status, 'ok');
    assert.equal(t.ta.value, '', '成功したのに貼り付け欄を空にしていない');
    assert.equal(t.state.busy, false, '実行中のままになっている');
    assert.match(t.calls.notes.at(-1).text, /取り込み: 1人 \/ 1体/);
});

await testAsync('★ 取り込み中にシーズンが切り替わっても、開始時の写しで書き続ける', async () => {
    // 1人目の保存中に renderOpsGrowth が走って _growth が次のシーズンに入れ替わる状況
    const t = runImport({
        players: [{ id: 1, name: 'あ', blabla_openid: '111111' }, { id: 2, name: 'い', blabla_openid: '222222' }],
        payload: { members: [member(), member({ openid: '222222', label: 'い' })] },
        onSaveGrowth: async (state) => {
            state.seasonId = 99; state.players = [{ id: 7, name: 'ぜんぜん別人' }]; state.used = ['別のキャラ'];
        },
    });
    await t.run();
    assert.equal(t.calls.growth.length, 2, '2人目が落ちている');
    assert.ok(t.calls.growth.every(c => c.seasonId === 10), '別のシーズンに書いている: ' + JSON.stringify(t.calls.growth));
    assert.ok(t.calls.growth.every(c => c.names.length === 1), '入れ替わった対象キャラで絞っている');
    assert.deepEqual(t.calls.growth.map(c => c.playerId), [1, 2]);
    assert.ok(t.calls.status.every(c => c.seasonId === 10), '状態を別のシーズンに書いている');
});

await testAsync('★ すでに取り込めている人は、識別子が無くても no_openid で上書きしない', async () => {
    const t = runImport({
        players: [{ id: 1, name: 'あ', blabla_openid: '111111' }, { id: 2, name: 'い', blabla_openid: null }, { id: 3, name: 'う', blabla_openid: null }],
        statusRows: [{ player_id: 2, status: 'ok' }, { player_id: 3, status: 'error' }],
    });
    await t.run();
    const noOpenid = t.calls.status.filter(c => c.status === 'no_openid');
    assert.deepEqual(noOpenid.map(c => c.playerId), [3], '取り込み済みの人を未ひも付けに落としている');
});

await testAsync('非公開・PADにいない識別子は保存せず、理由だけ残す', async () => {
    const t = runImport({
        players: [{ id: 1, name: 'あ', blabla_openid: '111111' }],
        payload: { members: [member({ code: 1301002 }), member({ openid: '999999', label: '知らない人' })] },
    });
    await t.run();
    assert.equal(t.calls.growth.length, 0, '保存してはいけない行を保存している');
    assert.deepEqual(t.calls.status.map(c => c.status), ['private'], 'PAD にいない識別子まで状態に書いている');
    assert.match(t.calls.notes.at(-1).text, /非公開 1人/);
});

await testAsync('壊れた貼り付けは理由を出して止まる (実行中のままにしない)', async () => {
    const t = runImport({ players: [{ id: 1, name: 'あ', blabla_openid: '111111' }], payload: 'これはちがう' });
    await t.run();
    assert.equal(t.calls.growth.length, 0);
    assert.equal(t.calls.notes.at(-1).kind, 'err');
    assert.equal(t.state.busy, false, '失敗したのに実行中のままになっている');
    assert.ok(t.ta.value !== '', '失敗したのに貼り付けを消している');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
