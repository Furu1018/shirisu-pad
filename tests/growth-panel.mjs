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

test('★ 一括のひも付け中は、個別の識別子欄を触らせない (計画が古くなる — Codex指摘)', () => {
    const busy = run({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }], busy: true }).html();
    assert.ok(/<input[^>]*disabled/.test(busy), '実行中に個別の欄が触れる');
    const idle = run({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }] }).html();
    assert.ok(!/<input[^>]*disabled/.test(idle), '実行中でないのに触れない');
});

test('★ ① 名簿からまとめて読み取る導線がある (入れ替えが多い回に1人ずつは現実的でない)', () => {
    const t = run({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }] });
    const out = t.html();
    assert.ok(/メンバー一覧からまとめて読み取る/.test(out), 'まとめて読み取る入口が無い');
    assert.ok(/handleGrowthCopyRosterSnippet\(\)/.test(out), '名簿のブックマークレットをコピーできない');
    assert.ok(/id="opsGrowthRoster"/.test(out), '名簿の貼り付け欄が無い');
    assert.ok(/handleGrowthApplyRoster\(\)/.test(out), '突き合わせる導線が無い');
    assert.ok(/開発者ツールを閉じたまま/.test(out), 'DevTools を閉じる注意が無い');
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
    assert.ok(/class="why">本人が非公開にしています</.test(out), '理由を画面に出していない');
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

// ---- 個別のひも付け (handleGrowthSetOpenid) ----
const SRC_SETID = cut('        async function handleGrowthSetOpenid(');
function runSetId({ players = [], busy = false } = {}) {
    const calls = { saved: [], notes: [] };
    const state = { players, busy, msg: null };
    const env = {
        _growth: state,
        window: {
            growthDomain: dom,
            supabaseSetPlayerOpenid: async (id, v) => { calls.saved.push({ id, v }); },
        },
        _growthNote: (kind, text) => { calls.notes.push({ kind, text }); },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, SRC_SETID + '\nreturn handleGrowthSetOpenid;')(...keys.map(k => env[k]));
    return { run: (id, v) => fn(id, v), calls };
}

await testAsync('★ 一括のひも付け中は個別の書き換えを受けない (計画が古くなる — Codex指摘)', async () => {
    const busy = runSetId({ players: [{ id: 1, name: 'あ', blabla_openid: null }], busy: true });
    await busy.run(1, '123456789');
    assert.equal(busy.calls.saved.length, 0, '一括中なのに保存している');
    assert.equal(busy.calls.notes.at(-1).kind, 'warn');
    // 実行中でなければ普通に保存する (アドレスからも取り出す)
    const idle = runSetId({ players: [{ id: 1, name: 'あ', blabla_openid: null }] });
    await idle.run(1, 'https://www.blablalink.com/user?uid=123456789');
    assert.deepEqual(idle.calls.saved, [{ id: 1, v: '123456789' }], 'アドレスから識別子を取り出して保存していない');
    // 空にすると解除
    const off = runSetId({ players: [{ id: 1, name: 'あ', blabla_openid: '1' }] });
    await off.run(1, '');
    assert.deepEqual(off.calls.saved, [{ id: 1, v: null }]);
    // 読み取れない入力は保存しない
    const bad = runSetId({ players: [{ id: 1, name: 'あ', blabla_openid: null }] });
    await bad.run(1, 'よくわからない文字');
    assert.equal(bad.calls.saved.length, 0, '読み取れないのに保存している');
    assert.equal(bad.calls.notes.at(-1).kind, 'err');
});

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

test('★ 声かけの導線は「非公開の人がいるとき」だけ出す (未ひも付けは運営の作業待ち)', () => {
    const priv = run({
        players: [P(1, 'あ', '111111'), P(2, 'い')],
        statusRows: [{ player_id: 1, status: 'private' }, { player_id: 2, status: 'no_openid' }],
    });
    assert.ok(priv.html().includes('handleGrowthAskPublish()'), '非公開の人がいるのに導線が無い');
    const noPriv = run({
        players: [P(1, 'あ', '111111'), P(2, 'い')],
        statusRows: [{ player_id: 1, status: 'error', detail: 'x' }, { player_id: 2, status: 'no_openid' }],
    });
    assert.ok(!noPriv.html().includes('handleGrowthAskPublish()'), '非公開の人がいないのに送れてしまう');
    const allOk = run({ players: [P(1, 'あ', '111111')], statusRows: [{ player_id: 1, status: 'ok', character_count: 3 }] });
    assert.ok(!allOk.html().includes('handleGrowthAskPublish()'), '全員取れているのに送れてしまう');
});

// ---- ホームの「育成データが未公開です」(B3・2026-09-09) --------------------
//   遅い応答・人の入れ替わり・43未適用は**実行しないと出ない**ので、実際に動かす
const NOTICE_DECL = (html.match(/\n(\s*let _growthNoticeSeq = 0;)/) || [])[1];
if (!NOTICE_DECL) { console.error('NG: _growthNoticeSeq の宣言が無い'); process.exit(2); }
const NOTICE_SRC = NOTICE_DECL + '\n' + cut('        async function renderMyGrowthNotice(identity)');

function noticeHarness({ current = { id: 1, name: 'あ' } } = {}) {
    const card = { style: { display: '?' } }, meta = { textContent: '?' };
    const els = { myGrowthNoticeCard: card, myGrowthNoticeMeta: meta };
    const pend = [], state = { current };
    const env = {
        document: { getElementById: (id) => els[id] || null },
        window: { supabaseLoadMyGrowthStatus: (pid) => new Promise((res, rej) => pend.push({ pid, res, rej })) },
        getCurrentIdentity: () => state.current,
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${NOTICE_SRC}\nreturn renderMyGrowthNotice;`)(...keys.map(k => env[k]));
    return { fn, card, meta, pend, state };
}

await testAsync('★ ホームの知らせ: 非公開のときだけ出す (取り込み済み・未ひも付け・43未適用では出さない)', async () => {
    for (const [status, want] of [['private', ''], ['ok', 'none'], ['no_openid', 'none'], ['error', 'none']]) {
        const h = noticeHarness();
        const p = h.fn({ id: 1 });
        h.pend[0].res({ status, checked_at: '2026-09-09T01:00:00Z' });
        await p;
        assert.equal(h.card.style.display, want, `${status} の出し方が違う`);
    }
    const none = noticeHarness();               // 43未適用 = null。「未取り込み」と混同しない
    const p = none.fn({ id: 1 }); none.pend[0].res(null); await p;
    assert.equal(none.card.style.display, 'none');
    assert.equal(none.meta.textContent, '?', '中身が無いのに日付を書き換えている');
});

await testAsync('確認した日を出す (日付が無ければ空にする)', async () => {
    const h = noticeHarness();
    let p = h.fn({ id: 1 }); h.pend[0].res({ status: 'private', checked_at: '2026-09-09T01:00:00Z' }); await p;
    assert.match(h.meta.textContent, /^\d+\/\d+ に確認$/, `日付が読めない: ${h.meta.textContent}`);
    const h2 = noticeHarness();
    p = h2.fn({ id: 1 }); h2.pend[0].res({ status: 'private', checked_at: null }); await p;
    assert.equal(h2.meta.textContent, '', '日付が無いのに何か書いている');
});

await testAsync('★ 追い越した古い応答で上書きしない', async () => {
    const h = noticeHarness();
    const p1 = h.fn({ id: 1 });                 // 遅い方
    const p2 = h.fn({ id: 1 });                 // 速い方
    h.pend[1].res({ status: 'ok' }); await p2;
    assert.equal(h.card.style.display, 'none');
    h.pend[0].res({ status: 'private' }); await p1;
    assert.equal(h.card.style.display, 'none', '古い応答で出してしまっている');
});

await testAsync('★ 待っている間に名乗り直したら、別人の状態を出さない', async () => {
    const h = noticeHarness({ current: { id: 1 } });
    const p = h.fn({ id: 1 });
    h.state.current = { id: 2 };                // 途中でプレイヤーを切り替えた
    h.pend[0].res({ status: 'private' }); await p;
    assert.equal(h.card.style.display, '?', '別人の状態で書き換えている');
});

await testAsync('名乗る前は問い合わせず、黙って隠す', async () => {
    const h = noticeHarness({ current: null });
    await h.fn(null);
    assert.equal(h.card.style.display, 'none');
    assert.equal(h.pend.length, 0, '名乗る前に問い合わせている');
});

await testAsync('読み込みに失敗しても、例外を投げずに隠すだけ (ホームを巻き込まない)', async () => {
    const h = noticeHarness();
    const p = h.fn({ id: 1 });
    h.pend[0].rej(new Error('boom'));
    await p;
    assert.equal(h.card.style.display, 'none');
});
// ---- 📣 未公開の人に公開をお願いする (B3) の実行テスト ---------------------
//   ★ ソースの文字列一致だけだと、privateTargets の行を残したまま送信側を
//     全員に広げる変異がすり抜ける (Codex指摘 2026-09-09)。**実際の playerIds** を見る。
//   ★ さらに「手元の写しを見直す」だけでは別端末の変更を防げない。
//     確認のあと **DB を引き直している**ことまで見る。
const ASK_SRC = cut('        async function handleGrowthAskPublish()');

function runAsk({
    players = [], statusRows = [], sendFails = false, holdSend = false,
    fresh, freshPlayers, freshNull = false, freshThrows = false,
} = {}) {
    const calls = { sent: [], notes: [], previews: [], loads: 0 };
    let resolvePreview = null, finishSend = null;
    const state = {
        gen: 0, seasons: null, picked: null, seasonId: 30, players, statusRows,
        used: [], wanted: null, busy: false, sending: false, msg: null, rosterOpen: false,
    };
    const env = {
        _growth: state,
        window: {
            growthDomain: dom,
            // ★ 既定は「DB も画面と同じ」。テストで fresh を渡すと、別端末で変わった状況になる
            supabaseLoadMemberGrowthStatus: async () => {
                calls.loads++;
                if (freshThrows) throw new Error('圏外');
                if (freshNull) return null;
                return fresh === undefined ? state.statusRows : fresh;
            },
            supabaseLoadPlayersWithOpenid: async () => (freshPlayers === undefined ? state.players : freshPlayers),
            sendPushNotification: async (payload) => {
                calls.sent.push(payload);
                if (holdSend) await new Promise((r) => { finishSend = r; });
                if (sendFails) throw new Error('圏外');
                return { ok: true, sent: payload.playerIds.length };
            },
        },
        showPushPreview: (groups) => {
            calls.previews.push(groups);
            return new Promise((res) => { resolvePreview = res; });
        },
        _growthNote: (kind, text) => { calls.notes.push({ kind, text }); },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${ASK_SRC}\nreturn handleGrowthAskPublish;`)(...keys.map(k => env[k]));
    return {
        state, calls,
        run: () => fn(),
        answer: (v = true) => { if (resolvePreview) resolvePreview(v); },
        finish: () => { if (finishSend) finishSend(); },
        tick: () => new Promise((r) => setTimeout(r, 0)),
        recipients: () => (calls.previews[0]?.[0]?.recipients || []).map(r => r.id),
        playerIds: () => (calls.sent[0]?.playerIds || []),
    };
}

const P4 = [{ id: 1, name: 'あ' }, { id: 2, name: 'い' }, { id: 3, name: 'う' }, { id: 4, name: 'え' }];
const S4 = [
    { player_id: 1, status: 'private' }, { player_id: 2, status: 'no_openid' },
    { player_id: 3, status: 'ok' }, { player_id: 4, status: 'error' },
];

await testAsync('★ 送るのは非公開の人だけ (取り込み済み・未ひも付け・失敗には送らない)', async () => {
    const t = runAsk({ players: P4, statusRows: S4 });
    const p = t.run(); t.answer(true); await p;
    assert.deepEqual(t.recipients(), [1], '確認画面の顔ぶれが違う');
    assert.deepEqual(t.playerIds(), [1], `実際の送信先が違う: ${JSON.stringify(t.playerIds())}`);
    assert.equal(t.calls.notes.at(-1).kind, 'ok');
});

await testAsync('★ 確認のあと DB を引き直す (手元の写しを見直すだけでは別端末の変更を防げない)', async () => {
    const t = runAsk({
        players: P4,
        statusRows: [{ player_id: 1, status: 'private' }, { player_id: 2, status: 'private' }],
        // 別の運営が取り込んで 2 が ok になった。★ 自分の画面 (state) は古いまま
        fresh: [{ player_id: 1, status: 'private' }, { player_id: 2, status: 'ok' }],
    });
    const p = t.run();
    assert.deepEqual(t.recipients(), [1, 2], '確認画面は自分の画面の顔ぶれ');
    t.answer(true); await p;
    assert.equal(t.calls.loads, 1, 'DB を引き直していない (手元の写しだけ見ている)');
    assert.deepEqual(t.playerIds(), [1], '状況が変わった人にも送っている');
    assert.match(t.calls.notes.at(-1).text, /1人は状況が変わったので外しました/);
});

await testAsync('★ 確認している間に書庫に入れた人には送らない (購読は残るので本当に届く)', async () => {
    const t = runAsk({
        players: P4,
        statusRows: [{ player_id: 1, status: 'private' }, { player_id: 4, status: 'private' }],
        freshPlayers: P4.filter(x => x.id !== 4),      // 書庫入り = 一覧から消える
    });
    const p = t.run();
    assert.deepEqual(t.recipients(), [1, 4]);
    t.answer(true); await p;
    assert.deepEqual(t.playerIds(), [1], 'PAD にいない人に送っている');
});

await testAsync('★ いまの状況を確認できなかったら送らない (古い顔ぶれで一斉送信しない)', async () => {
    const nul = runAsk({ players: P4, statusRows: S4, freshNull: true });
    let p = nul.run(); nul.answer(true); await p;
    assert.equal(nul.calls.sent.length, 0, '確認できないのに送っている');
    assert.equal(nul.calls.notes.at(-1).kind, 'warn');
    // ★ 「確認できなかった」と「状況が変わった」は運営の次の行動が違う。文面まで固定する
    assert.match(nul.calls.notes.at(-1).text, /確認できませんでした/,
        '確認できなかったのに「状況が変わりました」と言っている (運営が原因を取り違える)');
    assert.equal(nul.state.sending, false, '送信中のままになっている');
    const err = runAsk({ players: P4, statusRows: S4, freshThrows: true });
    p = err.run(); err.answer(true); await p;
    assert.equal(err.calls.sent.length, 0, '確認に失敗したのに送っている');
    assert.equal(err.calls.notes.at(-1).kind, 'err');
    assert.equal(err.state.sending, false);
});

await testAsync('確認している間に全員いなくなったら送らない', async () => {
    const t = runAsk({
        players: P4, statusRows: [{ player_id: 1, status: 'private' }],
        fresh: [{ player_id: 1, status: 'ok' }],
    });
    const p = t.run(); t.answer(true); await p;
    assert.equal(t.calls.sent.length, 0, '宛先ゼロなのに送っている');
    assert.equal(t.calls.notes.at(-1).kind, 'warn');
});

await testAsync('確認画面で断ったら送らない (次も送れる) / 相手が0なら確認画面も出さない', async () => {
    const no = runAsk({ players: P4, statusRows: S4 });
    const p = no.run(); no.answer(false); await p;
    assert.equal(no.calls.sent.length, 0, '断ったのに送っている');
    assert.equal(no.calls.loads, 0, '断ったのに DB を引いている');
    assert.equal(no.state.sending, false, '断ったあと送信中のままで、以後送れなくなる');
    const none = runAsk({ players: P4, statusRows: [{ player_id: 3, status: 'ok' }] });
    await none.run();
    assert.equal(none.calls.previews.length, 0, '相手がいないのに確認画面を出している');
    assert.equal(none.calls.notes.at(-1).kind, 'warn');
});

await testAsync('★ 送信中に押しても二重に送らない (通信が終わるまで塞ぐ)', async () => {
    const t = runAsk({ players: P4, statusRows: S4, holdSend: true });
    const p1 = t.run();
    t.answer(true);
    await t.tick();                       // 送信が始まり、返事を待っている状態
    assert.equal(t.calls.sent.length, 1, '送信が始まっていない');
    await t.run();                        // ここで二度押し
    assert.equal(t.calls.previews.length, 1, '送信中なのに確認画面をもう一度出している');
    assert.equal(t.calls.sent.length, 1, '二重に送っている');
    t.finish(); await p1;
    assert.equal(t.state.sending, false, '送り終わったのに送信中のままになっている');
});

await testAsync('送信に失敗しても実行中のままにしない', async () => {
    const t = runAsk({ players: P4, statusRows: S4, sendFails: true });
    const p = t.run(); t.answer(true); await p;
    assert.equal(t.calls.notes.at(-1).kind, 'err');
    assert.equal(t.state.sending, false, '失敗したのに送信中のままになっている');
});

// ---- 育成の読み出しのページ送り -------------------------------------------
//   ★ 1シーズン 600行を超える。Supabase の既定上限 1000 で黙って切れると、
//     **後ろのメンバーだけ**「未取得」に見える (原因が分かりにくい壊れ方)
const CLIENT = fs.readFileSync(path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').replace(/\r\n/g, '\n');
const ROWS_SRC = (CLIENT.match(/window\.supabaseLoadGrowthSeasonRows = async function[\s\S]*?\n\};\n/) || [])[0];
if (!ROWS_SRC) { console.error('NG: supabaseLoadGrowthSeasonRows を切り出せません'); process.exit(2); }

function runPager(pages) {
    const ranges = [];
    let call = 0;
    const b = {
        select: () => b, eq: () => b, order: () => b,
        range: async (from, to) => {
            ranges.push([from, to]);
            const p = pages[call++];
            if (p instanceof Error) return { data: null, error: p };
            return { data: p || [], error: null };
        },
    };
    const win = {};
    new Function('supabase', '_isMissingTableErr', 'window', `${ROWS_SRC}\nreturn 0;`)(
        { from: () => b },
        (e, t) => String(e?.message || '').includes(t),
        win,
    );
    return { load: win.supabaseLoadGrowthSeasonRows, ranges };
}
const page = (n) => Array.from({ length: n }, (_, i) => ({ player_id: i, character_name: 'x' }));

await testAsync('★ 1000行を超えても全部読む (後ろのメンバーだけ消えない)', async () => {
    const t = runPager([page(1000), page(318)]);
    const rows = await t.load(30);
    assert.equal(rows.length, 1318, `読み落としている: ${rows.length}`);
    assert.deepEqual(t.ranges, [[0, 999], [1000, 1999]], `ページの取り方が違う: ${JSON.stringify(t.ranges)}`);
});

await testAsync('ちょうど1000行なら、空の次ページまで見て終わる', async () => {
    const t = runPager([page(1000), page(0)]);
    assert.equal((await t.load(30)).length, 1000);
    assert.equal(t.ranges.length, 2, '1ページ目で打ち切っている (次があるか確かめていない)');
});

await testAsync('1ページで収まるなら1回で終わる / シーズン未指定は読みに行かない', async () => {
    const t = runPager([page(618)]);
    assert.equal((await t.load(30)).length, 618);
    assert.equal(t.ranges.length, 1, '余計に読みに行っている');
    const none = runPager([page(10)]);
    assert.deepEqual(await none.load(null), [], 'シーズンが無いのに読みに行っている');
    assert.equal(none.ranges.length, 0);
});

await testAsync('★ 途中のエラーは握りつぶさない / 43未適用だけ null', async () => {
    const boom = runPager([page(1000), new Error('network down')]);
    await assert.rejects(() => boom.load(30), /network down/, '途中で失敗したのに半端な行を返している');
    const missing = runPager([new Error('relation "public.member_growth" does not exist')]);
    assert.equal(await missing.load(30), null, '43未適用を「育成ゼロ」と混同している');
});

// ---- レイド一覧のページ送り ------------------------------------------------
//   ★ 1回のレイドで人数ぶんの行が積まれる。既定上限 1000 のままだと 30回ほどで
//     **古い回が選択肢から黙って消え**、境界の回は取り込み人数も過少になる (Codex指摘 2026-09-09)
const SUM_SRC = (CLIENT.match(/window\.supabaseLoadGrowthSeasonSummary = async function[\s\S]*?\n\};\n/) || [])[0];
if (!SUM_SRC) { console.error('NG: supabaseLoadGrowthSeasonSummary を切り出せません'); process.exit(2); }

function runSummary(pages, seasons = []) {
    const ranges = [];
    let call = 0;
    const st = {
        select: () => st, order: () => st,
        range: async (from, to) => {
            ranges.push([from, to]);
            const p = pages[call++];
            if (p instanceof Error) return { data: null, error: p };
            return { data: p || [], error: null };
        },
    };
    const se = { select: () => se, in: async (col, ids) => ({ data: seasons.filter(s => ids.includes(s.id)), error: null }) };
    const win = {};
    new Function('supabase', '_isMissingTableErr', 'window', `${SUM_SRC}\nreturn 0;`)(
        { from: (t) => (t === 'member_growth_status' ? st : se) },
        (e, t) => String(e?.message || '').includes(t),
        win,
    );
    return { load: win.supabaseLoadGrowthSeasonSummary, ranges };
}
const stPage = (n, seasonId, okEvery = 2) =>
    Array.from({ length: n }, (_, i) => ({ season_id: seasonId, status: i % okEvery === 0 ? 'ok' : 'private' }));

await testAsync('★ レイド一覧も1000行で切れない (古い回が選択肢から消える)', async () => {
    const t = runSummary(
        [stPage(1000, 30), stPage(31, 26)],
        [{ id: 30, month_key: '2026-09', hard_date: '2026-09-05', is_test: false },
            { id: 26, month_key: '2026-08', hard_date: '2026-08-01', is_test: false }],
    );
    const out = await t.load();
    assert.deepEqual(out.map(s => s.id), [30, 26], `古い回が消えている: ${JSON.stringify(out.map(s => s.id))}`);
    assert.deepEqual(t.ranges, [[0, 999], [1000, 1999]], 'ページの取り方が違う');
    assert.equal(out.find(s => s.id === 30).total, 1000);
    assert.equal(out.find(s => s.id === 26).ok, 16, '取り込み人数を数え間違えている');
});

await testAsync('ちょうど1000行なら次のページまで見る / 1件も無ければ空', async () => {
    const t = runSummary([stPage(1000, 30), []], [{ id: 30, month_key: '2026-09', is_test: false }]);
    assert.equal((await t.load()).length, 1);
    assert.equal(t.ranges.length, 2, '1ページ目で打ち切っている');
    const none = runSummary([[]]);
    assert.deepEqual(await none.load(), []);
});

await testAsync('43未適用は null / それ以外のエラーは投げる', async () => {
    const missing = runSummary([new Error('relation "public.member_growth_status" does not exist')]);
    assert.equal(await missing.load(), null, '未適用を「レイドが無い」と混同している');
    const boom = runSummary([stPage(1000, 30), new Error('network down')]);
    await assert.rejects(() => boom.load(), /network down/, '途中で失敗したのに半端な一覧を返している');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
