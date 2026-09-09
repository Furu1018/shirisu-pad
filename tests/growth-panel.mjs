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
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
