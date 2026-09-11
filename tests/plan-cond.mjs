// ============================================================================
// 最適凸プランの条件 (パズル盤 ①②・2026-09-11) の実行テスト
//   条件の焼き込み (_planCondStampHtml) / 自動で効くもの (_renderOpsPlanAutoChips) /
//   きっかけ (renderOpsPlanCue) / 選んだ人の動かせる幅 (_opsPlanFocusBarHtml)
//   node tests/plan-cond.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定は js/domain/planBoard.js / reservations.js / availability.js の本物。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/planBoard.js';
import '../js/domain/reservations.js';
import '../js/domain/availability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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
const SRC = [
    cut('        const _hhmm = (iso) => {') + ';',
    cut('        function _planCondStampHtml(c)'),
    cut('        function _renderOpsPlanAutoChips()'),
    cut('        async function renderOpsPlanCue()'),
    cut('        function _opsPlanFocusBarHtml(plan)'),
    cut('        function _opsPlanSwapHtml(sw, piece)'),
].join('\n');
const HOUR_ORDER = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
const mkEl = () => ({ innerHTML: '', textContent: '', style: {} });

function run({ snap = null, resvRows = undefined, pub = null, lastPlan = null, opsMode = true, count = async () => 0, focus = null, sel = null, promiseNote = false } = {}) {
    const els = { opsPlanAutoChips: mkEl(), opsPlanCue: mkEl(), opsPlanCond: mkEl() };
    const env = {
        document: { getElementById: (id) => els[id] || null },
        opsStore: { get: () => snap },
        window: { planBoardDomain: globalThis.planBoardDomain, reservationsDomain: globalThis.reservationsDomain, availabilityDomain: globalThis.availabilityDomain, supabaseCountMockUpdatesSince: count },
        _resv: { rows: resvRows },
        _opsPublishedPlan: pub,
        _opsLastPlan: lastPlan,
        _opsMode: opsMode,
        _opsPlanFocus: focus,
        _opsPlanSel: sel,
        _opsPlanPromiseNote: promiseNote,
        _planCueSeq: 0,
        HOUR_ORDER,
        _planNowIdx: () => 16,   // 21時
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        renderTeamSnippet: (t) => `<i>${t.length}人</i>`,
        console: { warn: () => {}, log: () => {}, error: () => {} },
    };
    const keys = Object.keys(env);
    const api = new Function(...keys, `${SRC}\nreturn { _planCondStampHtml, _renderOpsPlanAutoChips, renderOpsPlanCue, _opsPlanFocusBarHtml, _opsPlanSwapHtml };`)(...keys.map(k => env[k]));
    return { ...api, els };
}
const season = { id: 45, current_level: 2 };
const players = [
    { id: 1, name: 'ふるり', availableSlots: ['h20', 'h21', 'h22', 'h23'], excludedByAttr: { fire: [{}] } },
    { id: 2, name: 'B', availableSlots: ['h22'], unavailableThisSeason: false },
    { id: 3, name: 'C', availableSlots: [], unavailableThisSeason: true },
    { id: 4, name: 'D', availableSlots: ['h21', 'h22'], excludedByAttr: {} },
];

let pass = 0, fail = 0;
async function test(name, f) {
    try { await f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]}`);

console.log('最適凸プランの条件 (焼き込み / 自動で効くもの / きっかけ / 動かせる幅):\n');

await test('★ 焼き込みのスタンプ: 条件の要約 · 誰がいつ算出 · 基準の配信 · 「条件を変える」', async () => {
    const t = run();
    const c = globalThis.planBoardDomain.conditionsOf({ who: 'all', from: 'now', prev: 'keep', reservations: 3, excluded: 1, unavailable: 0,
        publishedBy: 'なべ<b>', publishedAt: '2026-09-11T04:02:00Z', computedBy: 'ふるり', computedAt: '2026-09-11T12:04:00Z' });
    const out = t._planCondStampHtml(c);
    noUndef(out);
    assert.ok(out.includes('<b>全員 · 今から · 前回を尊重 · 🔒予約 3 · 🚫除外 1</b>'), `要約が違う: ${out}`);
    assert.ok(out.includes('· 21:04 に ふるり が算出'), '誰がいつ算出したかが無い');
    assert.ok(out.includes('(基準: なべ&lt;b&gt; 13:02 の配信)'), '尊重した配信 (エスケープ込み) が無い');
    assert.ok(out.includes('onclick="_opsPlanShowCond()">条件を変える'), '条件パネルへ戻る導線が無い');
    // ゼロから のときは基準を出さない / 条件が無い古いプランは何も出さない
    assert.ok(!t._planCondStampHtml({ ...c, prev: 'fresh' }).includes('基準:'), 'ゼロからなのに基準を出している');
    assert.equal(t._planCondStampHtml(null), '');
});

await test('★ 自動で効くもの: 予約 (拘束だけ) / 除外 / 難しい / 配信中 — 取れていないものは — で出す', async () => {
    const resv = [{ status: 'approved' }, { status: 'requested' }, { status: 'cancel_requested', approved_at: '2026-09-11T00:00:00Z' }, { status: 'released' }];
    const t = run({ snap: { season, players }, resvRows: resv, pub: { season_id: 45, published_by_name: 'ふるり', published_at: '2026-09-11T04:02:00Z' } });
    t._renderOpsPlanAutoChips();
    const out = t.els.opsPlanAutoChips.innerHTML;
    noUndef(out);
    assert.ok(out.includes('🔒 予約 2'), `拘束になる予約だけを数えていない: ${out}`);
    assert.ok(out.includes('🚫 除外 1') && out.includes('✋ 難しい 1'), '除外 / 難しい の数が違う');
    assert.ok(out.includes('📤 配信中: ふるり 13:02'), '配信中の基準が無い');
    // 予約が未ロード (null) は 0 ではなく —。別シーズンの配信は基準にしない
    const u = run({ snap: { season, players }, resvRows: null, pub: { season_id: 44, published_by_name: 'x', published_at: '2026-09-10T00:00:00Z' } });
    u._renderOpsPlanAutoChips();
    assert.ok(u.els.opsPlanAutoChips.innerHTML.includes('🔒 予約 —'), '未ロードを 0 に見せている');
    assert.ok(u.els.opsPlanAutoChips.innerHTML.includes('📤 配信なし'), '別シーズンの配信を基準にしている');
    // 盤面が無ければ数字を出さない
    const n = run({ snap: null, resvRows: resv });
    n._renderOpsPlanAutoChips();
    assert.ok(n.els.opsPlanAutoChips.innerHTML.includes('🚫 除外 —'), '盤面が無いのに数字を出している');
});

await test('★ きっかけ: 前回の算出のあとに模擬が更新されていたら「組み直す」。0 件・材料なし・失敗・運営OFF は出さない', async () => {
    const lastPlan = { conditions: { computedAt: '2026-09-11T12:04:00Z' } };
    const a = run({ snap: { season, players }, lastPlan, count: async () => 4 });
    await a.renderOpsPlanCue();
    const out = a.els.opsPlanCue.innerHTML;
    noUndef(out);
    assert.equal(a.els.opsPlanCue.style.display, '');
    assert.ok(out.includes('前回の算出 (21:04) のあと、<b>模擬の提出が 4 件</b>更新されました'), `文面が違う: ${out}`);
    assert.ok(out.includes('onclick="computeAndRenderOptimalPlan()">組み直す'), '組み直すボタンが無い');
    // 算出が無ければ配信を基準にする
    const b = run({ snap: { season, players }, pub: { season_id: 45, published_at: '2026-09-11T04:02:00Z' }, count: async () => 2 });
    await b.renderOpsPlanCue();
    assert.ok(b.els.opsPlanCue.innerHTML.includes('前回の配信 (13:02) のあと'), '配信を基準にしていない');
    for (const [nm, opt] of [
        ['0件', { snap: { season, players }, lastPlan, count: async () => 0 }],
        ['材料なし', { snap: { season, players }, count: async () => 9 }],
        ['失敗', { snap: { season, players }, lastPlan, count: async () => { throw new Error('boom'); } }],
        ['運営OFF', { snap: { season, players }, lastPlan, opsMode: false, count: async () => 9 }],
    ]) {
        const t = run(opt); await t.renderOpsPlanCue();
        assert.equal(t.els.opsPlanCue.style.display, 'none', `${nm} なのに出している`);
    }
    // ★ 追い越し: 遅い応答が新しい応答を上書きしない
    let release; const slow = new Promise(r => { release = r; });
    const c = run({ snap: { season, players }, lastPlan, count: async () => 1 });
    // 同じ関数を2回呼ぶ: 1回目は遅く 7 を返す / 2回目は速く 0 を返す → 最後は「出さない」でなければならない
    let calls = 0;
    c.els.opsPlanCue.style.display = 'x';
    const env2 = run({ snap: { season, players }, lastPlan, count: async () => { calls += 1; if (calls === 1) { await slow; return 7; } return 0; } });
    const p1 = env2.renderOpsPlanCue();
    const p2 = env2.renderOpsPlanCue();
    await p2; release(); await p1;
    assert.equal(env2.els.opsPlanCue.style.display, 'none', '遅い応答が新しい結果を上書きした');
});

await test('★ 選んだ人: 出られる時間と動かせる幅 (硬い / 狭い / 柔らかい)。選んでいなければ空', async () => {
    const plan = {};
    const b = run({ snap: { season, players }, lastPlan: plan, focus: 2 });
    const out = b._opsPlanFocusBarHtml(plan);
    noUndef(out);
    assert.ok(out.includes('<span>B</span>') && out.includes('動かせる幅 <b>硬い</b> (これから 1 コマ)'), `硬いが出ない: ${out}`);
    const d = run({ snap: { season, players }, lastPlan: plan, focus: '4' });   // 文字列の id でも同じ人
    assert.ok(d._opsPlanFocusBarHtml(plan).includes('動かせる幅 <b>狭い</b> (これから 2 コマ)'), '狭いが出ない');
    const f = run({ snap: { season, players }, lastPlan: plan, focus: 1 });
    const fo = f._opsPlanFocusBarHtml(plan);
    assert.ok(fo.includes('動かせる幅 <b>狭い</b> (これから 3 コマ)'), `21時以降 21/22/23 の 3 コマ: ${fo}`);
    assert.ok(/出られる時間 20〜/.test(fo), '出られる時間の要約が無い');
    assert.equal(run({ snap: { season, players }, lastPlan: plan, focus: null })._opsPlanFocusBarHtml(plan), '');
    assert.equal(run({ snap: { season, players }, lastPlan: plan, focus: 999 })._opsPlanFocusBarHtml(plan), '', '盤面にいない人で落ちる/出る');
});

await test('★ 盤の上の操作帯 (③): 📌 の固定は お願いする / 外す、お願い中は期限だけ、駒を選んだら「マスをタップ」、約束は動かさない', async () => {
    const plan = {};
    const pinRow = { id: 21, status: 'pinned', asked_at: null, ask_deadline_at: null };
    const askedRow = { id: 22, status: 'pinned', asked_at: '2026-09-11T12:00:00Z', ask_deadline_at: '2026-09-11T12:15:00Z' };
    const a = run({ snap: { season, players }, lastPlan: plan, focus: 2, resvRows: [pinRow, askedRow], sel: { kind: 'chip', memberId: 2, loadoutSlot: 1, attr: 'iron', reservationId: 21, pinned: true } });
    const oa = a._opsPlanFocusBarHtml(plan);
    noUndef(oa);
    assert.ok(oa.includes('📌 運営の固定 (本人にはまだ見えていません) · 別のマスをタップで置き直し'), `下書きの説明が無い: ${oa}`);
    assert.ok(oa.includes('onclick="_opsPlanAsk(21)">📣 お願いする') && oa.includes('onclick="_opsPlanUnpin(21)">固定を外す'), 'お願いする / 外す のボタンが無い');
    const b = run({ snap: { season, players }, lastPlan: plan, focus: 2, resvRows: [pinRow, askedRow], sel: { kind: 'chip', memberId: 2, loadoutSlot: 1, attr: 'iron', reservationId: 22, pinned: true } });
    const ob = b._opsPlanFocusBarHtml(plan);
    assert.ok(ob.includes('📣 お願い中 〜21:15') && !ob.includes('_opsPlanAsk('), 'お願い中なのに二重にお願いできる / 期限が無い');
    assert.ok(ob.includes('onclick="_opsPlanUnpin(22)">固定を外す'), 'お願い中でも外せること');
    const c = run({ snap: { season, players }, lastPlan: plan, focus: 4, sel: { kind: 'piece', memberId: 4, loadoutSlot: 2, attr: 'fire', reservationId: null, pinned: false } });
    const oc = c._opsPlanFocusBarHtml(plan);
    assert.ok(oc.includes('🧩 模擬ピース') && oc.includes('マスをタップ') && oc.includes('レベルは算出が決めます'), `ピースの案内が無い: ${oc}`);
    assert.ok(!oc.includes('_opsPlanAsk(') && !oc.includes('_opsPlanUnpin('), 'まだ置いていない駒に お願い / 外す が出ている');
    const d = run({ snap: { season, players }, lastPlan: plan, focus: 1, sel: null, promiseNote: true });
    const od = d._opsPlanFocusBarHtml(plan);
    assert.ok(od.includes('🔒 本人が引き受けた約束 — 運営の手では動かしません'), '約束を動かさない注意が無い');
    assert.ok(od.includes('onclick="_opsPlanClearSel()">閉じる'), '閉じるが選択も捨てる形になっていない');
});

await test('★ 入れ替えの確認 (⑤): 自由な凸だけ選べる / 約束と固定は選べない / 同じキャラは必ず外れる / 選べるのが 1 つなら選んでおく', async () => {
    const dom = globalThis.planBoardDomain;
    const plan = { levels: [
        { level: 1, bosses: [
            { bossNumber: 1, name: 'A<b>', weakness: 'fire', attacks: [{ memberId: 1, loadoutSlot: 1, dmgB: 20, team: ['x1'], hourIdx: 0, hourLabel: '5時', fromReservation: true }] },
            { bossNumber: 2, name: 'B', weakness: 'water', attacks: [{ memberId: 1, loadoutSlot: 1, dmgB: 18.25, team: ['y1'], hourIdx: 1, hourLabel: '6時' }] },
        ] },
        { level: 2, bosses: [{ bossNumber: 3, name: 'C', weakness: 'electric', attacks: [{ memberId: 1, loadoutSlot: 2, dmgB: 15, team: ['w1'], hourIdx: 2, flex: true }] }] },
    ] };
    const piece = { name: 'ふるり', attr: 'iron', slot: 2, dmgB: 22, team: ['q1', 'q2'], bossNumber: 4, hourLabel: '22時' };
    const t = run();
    // 自由 2 + 約束 1 → 1 つ外す: 自由の 2 つにラジオ、約束にはラジオ無し
    let out = t._opsPlanSwapHtml(dom.swapOptions({ plan, memberId: 1, team: piece.team, doneAttacks: 0 }), piece);
    noUndef(out);
    assert.ok(out.includes('<b>📌 置く</b> ふるり · 鉄甲PT② 22.0B → B4 22時'), `置くものの見出しが無い: ${out}`);
    assert.equal((out.match(/name="planSwapPick"/g) || []).length, 2, '自由な 2 つだけにラジオ');
    assert.ok(out.includes('<label class="ps-row promise"><span class="ps-ic">🔒</span><span class="ps-main"><b>Lv1 B1</b> A&lt;b&gt; · 5時 · 灼熱PT 20.0B'), `約束の行 (エスケープ込み・ラジオ無し) が無い: ${out}`);
    assert.ok(out.includes('🔒 本人の約束 — 入れ替えられません'), '約束の理由が無い');
    assert.ok(/value="2:3:2"[^>]*>[\s\S]*?<b>Lv2 B3<\/b> C · ⏳ 隙間 · 電撃PT② 15\.0B/.test(out), '隙間の凸が ⏳ で出ていない');
    assert.ok(out.includes('<i>1人</i>'), '編成を出していない');
    assert.ok(out.includes('1 つ外します。<b>外す凸を選ぶ</b>と、残りは 📌 で固定して残します'), '入れ替えの意味 (残りは固定) を言っていない');
    assert.ok(!out.includes(' checked'), '2 つから選ぶのに片方が選ばれている');
    // 選べるのが 1 つ (自由 1 + 約束 2 のような形) なら選んでおく
    const plan2 = { levels: [{ level: 1, bosses: [
        { bossNumber: 1, name: 'A', weakness: 'fire', attacks: [{ memberId: 1, loadoutSlot: 1, dmgB: 20, team: ['x1'], fromReservation: true }] },
        { bossNumber: 2, name: 'B', weakness: 'water', attacks: [{ memberId: 1, loadoutSlot: 1, dmgB: 18, team: ['y1'], hourLabel: '6時' }] },
    ] }] };
    out = t._opsPlanSwapHtml(dom.swapOptions({ plan: plan2, memberId: 1, team: ['q1'], doneAttacks: 1 }), piece);
    assert.ok(/name="planSwapPick" value="1:2:1" checked/.test(out), '選べるのが 1 つなのに選んでいない');
    // 同じキャラ → 必ず外れる (ラジオ無し・✕)。残りは固定
    out = t._opsPlanSwapHtml(dom.swapOptions({ plan, memberId: 1, team: ['w1'], doneAttacks: 0 }), piece);
    assert.ok(!out.includes('name="planSwapPick"'), '被りで外れるのにラジオが出ている');
    assert.ok(/<label class="ps-row conflict"><span class="ps-ic">✕<\/span>/.test(out) && out.includes('同じキャラ — 必ず外れます'), '被りの行が無い');
    assert.ok(out.includes('同じキャラの凸が外れます。残りは 📌 で固定して残します'), '被りのときの説明が無い');
    // 2 つ多い → 算出に任せる
    out = t._opsPlanSwapHtml(dom.swapOptions({ plan, memberId: 1, team: ['q1'], doneAttacks: 1 }), piece);
    assert.ok(out.includes('2 つ多くなります。外す凸は<b>算出に任せて</b>ください') && !out.includes('name="planSwapPick"'), '2 つ多いときに選ばせている');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
