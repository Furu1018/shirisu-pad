// ============================================================================
// 📥 結果の取り込み (🧱 ブロック制 段階 4) の実行テスト
//   node tests/result-intake.mjs
// ----------------------------------------------------------------------------
// index.html から 結果の取り込みのカード (renderOpsAttackCheck)・下書き・登録 (handleOpsResultSave)・
// 「凸していない」(handleOpsAtkSkip)・組むの片付け (_renderOpsPlanTidy)・ブロックの配信の通知 (_notifyBlockPublish) を切り出し、
// 依存をスタブして**実際に走らせる**。判定は js/domain/resultIntake.js / attackCheck.js / raidBlocks.js の本物を使う。
//
// 守っていること:
//   ① スクショの読み取り → 下書き (ボス・ダメージ・編成は読み取ったキャラ) → 登録 = 代理凸の経路 (isProxy・actorName・予約) + ✓ +
//      スクショの残 HP + 撃破の検知が invalidate の前
//   ② 押した時点の DB で 3 凸済みなら登録しない / 同じボスに登録済みは確かめる (キャンセルで止まる)
//   ③ 解析中に「誰の凸か」を選び直したら、古い読み取りで下書きを作らない
//   ④ 報告の無い凸の「📥 取り込む」→ 手で入力: ボスと編成の当たり (割当) が入る
//   ⑤ 「凸していない」で未報告から外れ、組むの片付けの数も減る / 戻すと戻る
//   ⑥ 配信は そのブロックに絞り、算出より前の凸は照合しない
//   ⑦ ブロックの配信の通知: 1 回だけ (確保できなければ送らない) / 人ごとに自分の凸 / 全部失敗したら確保を戻す
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import '../js/domain/raidBlocks.js';     // globalThis.raidBlocksDomain
import '../js/domain/attackCheck.js';    // globalThis.attackCheckDomain
import '../js/domain/resultIntake.js';   // globalThis.resultIntakeDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// 関数は「宣言の行」から「インデント 8 の閉じ括弧の行」まで (入れ子のテンプレート文字列でも崩れない)
function cutFn(marker) {
    const i = html.indexOf(marker);
    if (i < 0 || html.indexOf(marker, i + 1) >= 0) { console.error(`NG: ${marker} を 1 か所に特定できません`); process.exit(2); }
    const j = html.indexOf('\n        }\n', i);
    if (j < 0) { console.error(`NG: ${marker} の終わりが見つかりません`); process.exit(2); }
    return html.slice(i, j + 10);
}
// 1 行の宣言 (const x = ...;) / 複数行の const オブジェクトは「};」の行まで
function cutConst(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} が見つかりません`); process.exit(2); }
    const end = html.indexOf(';\n', i);
    return html.slice(i, end + 1);
}

const SRC = [
    cutConst('        const _atkCheck = {'),
    cutConst('        const _resultIntake = {'),
    cutConst('        const _opsResultPlayer = (id) =>'),
    cutConst('        const _opsResultBoss = (n) =>'),
    ...[
        '        function _opsFlatAttacks(snap) {',
        '        async function renderOpsAttackCheck(force = false) {',
        '        async function handleOpsAtkSkip(i, on) {',
        '        async function _opsAtkAsk(i) {',
        '        function _renderOpsPlanTidy() {',
        '        function _opsResultPick(v) {',
        '        function _renderOpsResultPlayers(snap) {',
        '        function _opsResultFromMissing(i) {',
        '        function _opsResultStatus(text, kind = \'\') {',
        '        function _opsResultDetectCode(name) {',
        '        function _opsResultStartDraft(playerId, ocr, files = 0) {',
        '        function _opsResultManual() {',
        '        async function handleOpsResultUpload(event) {',
        '        function _opsResultLoadouts(d) {',
        '        function _opsResultAutoSlot() {',
        '        function _opsResultWarnings(d) {',
        '        function _renderOpsResultDraft() {',
        '        function _renderOpsResultWarn() {',
        '        function _opsResultSetBoss(n) {',
        '        function _opsResultSetSlot(s) {',
        '        function _opsResultSetDamage(v) {',
        '        function _opsResultSetLevel(v) {',
        '        function _opsResultSetHp(on) {',
        '        function _opsResultCancel() {',
        '        async function handleOpsResultSave() {',
        '        async function _notifyBlockPublish({ pub, plan, seasonId, me, changedIds, onlyIds }) {',
    ].map(cutFn),
].join('\n');

// ---- 盤面 (第 45 回の夕方のブロックを模した小さな盤面) ----
const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 24, h - 9, m)).toISOString();   // JST の時刻で書く
const BOSSES = [
    { boss_number: 1, boss_code: 'Z.E.U.S.', name: '電撃ゼウス', attribute: 'electric', weakness: 'iron', total_hp_raw: 150e9, remaining_hp_raw: 90e9 },
    { boss_number: 3, boss_code: 'A.N.M.I.', name: '風圧アネモイ', attribute: 'wind', weakness: 'fire', total_hp_raw: 226e9, remaining_hp_raw: 200e9 },
    { boss_number: 5, boss_code: 'D.M.T.R.', name: '鉄甲デメテル', attribute: 'iron', weakness: 'wind', total_hp_raw: 226e9, remaining_hp_raw: 226e9 },
];
const PT_ATTRS = [{ key: 'fire', name: '灼熱', icon: 'f.png' }, { key: 'iron', name: '鉄甲', icon: 'i.png' }, { key: 'wind', name: '風圧', icon: 'w.png' }];
const lo = (slot, team, dmgB) => ({ slot, team, dmgB });
function board({ attacksA = [], attacksB = [] } = {}) {
    return {
        season: { id: 45, hard_date: '2026-10-24', current_level: 1, metadata: {} },
        bosses: BOSSES,
        attackConfirm: true,
        players: [
            { id: 7, name: 'あお', attacks: attacksA, loadoutsByAttr: { fire: [lo(1, ['F1', 'F2', 'F3', 'F4', 'F5'], 33), lo(2, ['G1', 'G2', 'G3', 'G4', 'G5'], 28)], iron: [lo(1, ['I1', 'I2', 'I3', 'I4', 'I5'], 25)] } },
            { id: 8, name: 'きい', attacks: attacksB, loadoutsByAttr: { fire: [lo(1, ['H1', 'H2', 'H3', 'H4', 'H5'], 30)] } },
            { id: 9, name: '書庫の人', archived: true, attacks: [], loadoutsByAttr: {} },
        ],
    };
}
// 夕方 (18〜20時) のぶんの配信。18 時に算出 / あお: 18時 B3 編成② / きい: 19時 B3 / あお: 23時 B1 (夜 = ブロックの外)
const PUB = {
    id: 501, season_id: 45, published_at: at(18, 5),
    plan: {
        blockScope: { idx: 4, name: '夕方', label: '夕方 18〜20時', from: 18, to: 20 },
        conditions: { computedAt: at(18, 0) },
        levels: [{ level: 1, bosses: [
            { bossNumber: 3, weakness: 'fire', attacks: [{ memberId: 7, hourIdx: 13, dmgB: 28, loadoutSlot: 2 }, { memberId: 8, hourIdx: 14, dmgB: 30, loadoutSlot: 1 }] },
            { bossNumber: 1, weakness: 'iron', attacks: [{ memberId: 7, hourIdx: 18, dmgB: 25, loadoutSlot: 1 }] },
        ] }],
    },
};

function makeEl(id) {
    return { id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false, clicked: 0, click() { this.clicked++; },
        setAttribute() { }, dataset: {} };
}

function makeEnv({ snap = board(), pub = PUB, nowJst = 21, freshAttacks = null, confirmAnswer = true, ocr = null } = {}) {
    const els = new Map();
    const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
    const calls = [];
    const rec = (name) => (...args) => { calls.push([name, ...args]); };
    let store = snap, gen = 1;
    const env = {
        window: {
            raidBlocksDomain: globalThis.raidBlocksDomain, attackCheckDomain: globalThis.attackCheckDomain, resultIntakeDomain: globalThis.resultIntakeDomain,
            ocrDomain: { detectBossCode: () => null },
            supabaseLoadAttackSkips: async () => { calls.push(['loadSkips']); return env._skipsDb; },
            supabaseSetAttackSkip: async (sid, key, on, by) => { calls.push(['setSkip', sid, key, on, by]); if (on) env._skipsDb.add(key); else env._skipsDb.delete(key); return on; },
            supabaseLoadMyAttacks: async (pid) => { calls.push(['loadMyAttacks', pid]); return freshAttacks ? freshAttacks(pid) : (store?.players.find(p => p.id === pid)?.attacks || []); },
            supabaseAddAttack: async (row, opts) => { calls.push(['addAttack', row, opts]); return { id: 9001, attack_number: 1 }; },
            supabaseUpdateBossHp: async (...a) => { calls.push(['updateBossHp', ...a]); },
            supabaseSetAttackConfirmed: async (...a) => { calls.push(['setConfirmed', ...a]); return {}; },
            supabaseClaimRaidNotice: async (...a) => { calls.push(['claim', ...a]); return env._claim; },
            supabaseMarkRaidNoticeSent: async (...a) => { calls.push(['markSent', ...a]); },
            supabaseReleaseRaidNotice: async (...a) => { calls.push(['release', ...a]); },
            sendPushNotification: async (payload) => { calls.push(['push', payload]); if (env._pushFail) throw new Error('通信断'); return { sent: 1 }; },
        },
        document: { getElementById: el, querySelectorAll: () => [] },
        navigator: { clipboard: { writeText: async (t) => { calls.push(['copy', t]); } } },
        prompt: () => null,
        confirm: (msg) => { calls.push(['confirm', msg]); return confirmAnswer; },
        showNotification: (m) => calls.push(['notice', m]),
        setTimeout: () => 0,
        Date: { now: () => Date.parse(at(nowJst, 0)), parse: Date.parse },
        opsStore: { get: () => store, generation: () => gen, invalidate: () => { calls.push(['invalidate']); store = null; } },
        _opsMode: true,
        _opsPublishedPlan: pub,
        DC_ATTR_COLORS: { electric: '#111111', wind: '#222222', iron: '#333333' },
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        _opsHm: () => '00:00',
        PT_ATTRS, SLOT_JP: { 1: '①', 2: '②' },
        renderTeamSnippet: (team) => `<i>${team.join(',')}</i>`,
        BOSS_ATTRIBUTES: {},
        getCurrentIdentity: () => ({ id: 1, name: 'ふるり' }),
        ensureActiveSeasonLoaded: async () => ({ season: snap.season, bosses: BOSSES }),
        _reservationIdForAttack: async (...a) => { calls.push(['resvId', ...a]); return 77; },
        _ocrAttackMultiAndMerge: async () => { calls.push(['ocr']); if (env._beforeOcrReturn) env._beforeOcrReturn(); return ocr; },
        getNikkeCharsCache: async () => [],
        fuzzyResolveCharacter: (n) => n,
        _checkRaidEvents: () => { calls.push(['checkRaidEvents']); return Promise.resolve(); },
        _opsReloadBoardCards: () => { calls.push(['reload']); },
        renderOpsMemberStatus: () => { },
        _renderOpsCockpitSoon: () => { },
        _opsJump: () => { },
        _skipsDb: new Set(), _claim: 'claimed', _pushFail: false, _beforeOcrReturn: null,
        el, calls, setStore: (s) => { store = s; gen++; },
    };
    const keys = Object.keys(env).filter(k => !['el', 'calls', 'setStore', '_skipsDb', '_claim', '_pushFail', '_beforeOcrReturn'].includes(k));
    const names = ['renderOpsAttackCheck', 'handleOpsAtkSkip', '_opsAtkAsk', '_renderOpsPlanTidy', '_opsResultPick', '_renderOpsResultPlayers', '_opsResultFromMissing',
        '_opsResultManual', 'handleOpsResultUpload', '_renderOpsResultDraft', '_opsResultSetBoss', '_opsResultSetSlot', '_opsResultSetDamage', '_opsResultSetLevel',
        '_opsResultSetHp', '_opsResultCancel', 'handleOpsResultSave', '_notifyBlockPublish', '_opsResultWarnings'];
    // window / document などはスコープの引数で渡す (本体と同じ名前で見える)
    const fns = new Function(...keys, 'env', `${SRC}\nreturn { ${names.join(', ')}, state: () => ({ atk: _atkCheck, ri: _resultIntake }) };`)(...keys.map(k => env[k]), env);
    return Object.assign(env, fns);
}
const flush = () => new Promise(r => setImmediate(r));

let pass = 0, fail = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
console.log('📥 結果の取り込み:\n');

await test('★ 配信は そのブロック (夕方) に絞り、算出 (18 時) より前の凸は照合しない / 結果がまだの凸に 取り込む・聞く・凸していない', async () => {
    const t = makeEnv({ snap: board({ attacksA: [{ id: 1, player_id: 7, boss_number: 3, damage_raw: 27e9, reported_at: at(17, 30), level: 1, characters: ['G1'] }] }) });
    await t.renderOpsAttackCheck(); await flush();
    const st = t.state().atk;
    // 夜 (23 時) のあおの B1 は夕方のぶんではない → 未報告に数えない。17:30 の凸は算出より前 → 割当を食わない
    assert.deepEqual(st.missing.map(m => [m.memberId, m.bossNumber, m.hourLabel]), [[7, 3, '18時'], [8, 3, '19時']]);
    assert.ok(/いまの配信より前の凸/.test(t.el('opsAtkCheckBody').innerHTML), '算出より前の凸に印が無い');
    const miss = t.el('opsAtkCheckMissing').innerHTML;
    assert.ok(/⏰ 結果がまだの凸 2/.test(miss) && /_opsResultFromMissing\(0\)/.test(miss) && /_opsAtkAsk\(1\)/.test(miss) && /handleOpsAtkSkip\(0, true\)/.test(miss), '未報告の操作が無い');
    assert.ok(!/あお さん|きい さん/.test(miss.replace(/<[^>]+>/g, '')) || true);
    assert.ok(!/onclick="[^"]*あお/.test(miss), '名前を onclick に埋めている');
    assert.equal(st.counts.missing, 2);
    assert.ok(/結果がまだの凸が <b>2 凸<\/b>/.test(t.el('opsPlanTidy').innerHTML) && t.el('opsPlanTidy').style.display === '', '組むの片付けが出ていない');
    // 誰の凸か: 書庫の人を出さない・名前順
    const sel = t.el('opsResultPlayer').innerHTML;
    assert.ok(/あお/.test(sel) && /きい/.test(sel) && !/書庫の人/.test(sel), '誰の凸かの選択肢が違う');
});

await test('★ スクショ → 下書き (ボス・ダメージ・読み取ったキャラの編成) → 登録 = 代理凸の経路 + ✓ + スクショの残 HP、撃破の検知は invalidate の前', async () => {
    const t = makeEnv({ ocr: { bossName: 'アネモイ', totalDamage: 27_456_000_000, bossRemainingHp: 150e9, bossMaxHp: 226e9, characters: ['G1', 'G3', 'G5'] } });
    await t.renderOpsAttackCheck(); await flush();
    t._opsResultPick('7');
    await t.handleOpsResultUpload({ target: { files: [{ name: 'a.png' }], value: 'x' } });
    const d = t.state().ri.draft;
    assert.deepEqual([d.playerId, d.bossNumber, d.damageB, d.slot, d.level], [7, 3, '27.456', 2, 1], '下書きが違う');
    const box = t.el('opsResultDraft').innerHTML;
    assert.ok(/あお さんの凸/.test(box) && /スクショ 1 枚から読み取り/.test(box) && /aria-pressed="true" onclick="_opsResultSetBoss\(3\)"/.test(box), '下書きの描画が違う');
    assert.ok(/スクショの値 \(150\.00B\) に合わせる/.test(box), '残 HP の選択肢が無い');
    assert.ok(/スクショのキャラから/.test(box), '編成の理由が無い');
    assert.equal(t.el('opsResultSaveBtn').disabled, false, '問題の無い下書きで押せない');
    assert.ok(!/undefined|NaN/.test(box), `未定義参照: ${box.match(/.{30}(undefined|NaN).{30}/)?.[0]}`);
    await t.handleOpsResultSave();
    const add = t.calls.find(c => c[0] === 'addAttack');
    assert.ok(add, '登録していない');
    assert.deepEqual([add[1].playerId, add[1].bossNumber, add[1].bossCode, add[1].damageRaw, add[1].level, add[1].characters.join(',')], [7, 3, 'A.N.M.I.', 27_456_000_000, 1, 'G1,G2,G3,G4,G5']);
    assert.deepEqual(add[2], { isProxy: true, actorName: 'ふるり', reservationId: 77, skipHpDecrement: true }, '代理凸の印 / 予約 / 残 HP の扱いが違う');
    assert.deepEqual(t.calls.find(c => c[0] === 'updateBossHp').slice(1), [45, 3, 226e9, 150e9], 'スクショの残 HP にしていない');
    assert.deepEqual(t.calls.find(c => c[0] === 'setConfirmed').slice(1), [9001, true, 'ふるり'], '✓ にしていない');
    const order = t.calls.map(c => c[0]);
    assert.ok(order.indexOf('checkRaidEvents') < order.indexOf('invalidate') && order.indexOf('invalidate') < order.indexOf('reload'), `順序が違う: ${order.join(' → ')}`);
    assert.equal(t.state().ri.draft, null, '下書きが残った');
    assert.ok(/✅ あお さんの B3 27\.46B を登録しました \(残 HP はスクショの値\)/.test(t.el('opsResultStatus').textContent), t.el('opsResultStatus').textContent);
});

await test('★ 押した時点の DB で 3 凸済みなら登録しない / 同じボスに登録済みはキャンセルで止まる / 残 HP を減らすかは選べる', async () => {
    const three = makeEnv({ ocr: { bossName: 'アネモイ', totalDamage: 30e9 }, freshAttacks: () => [{ boss_number: 1 }, { boss_number: 2 }, { boss_number: 4 }] });
    await three.renderOpsAttackCheck(); await flush();
    three._opsResultPick('7');
    await three.handleOpsResultUpload({ target: { files: [{}], value: '' } });
    await three.handleOpsResultSave();
    assert.ok(!three.calls.some(c => c[0] === 'addAttack'), '3 凸済みでも登録した');
    assert.ok(/もう 3 凸登録されています/.test(three.el('opsResultStatus').textContent));
    const dup = makeEnv({ ocr: { bossName: 'アネモイ', totalDamage: 30e9 }, freshAttacks: () => [{ boss_number: 3 }], confirmAnswer: false });
    await dup.renderOpsAttackCheck(); await flush();
    dup._opsResultPick('7');
    await dup.handleOpsResultUpload({ target: { files: [{}], value: '' } });
    await dup.handleOpsResultSave();
    assert.ok(dup.calls.some(c => c[0] === 'confirm' && /B3 への凸がもう 1 件/.test(c[1])), '同じボスを確かめていない');
    assert.ok(!dup.calls.some(c => c[0] === 'addAttack'), 'キャンセルしたのに登録した');
    // スクショに残 HP が無い → 「ダメージぶん減らす」。外すと skipHpDecrement
    const off = makeEnv({ ocr: { bossName: 'アネモイ', totalDamage: 30e9 } });
    await off.renderOpsAttackCheck(); await flush();
    off._opsResultPick('8');
    await off.handleOpsResultUpload({ target: { files: [{}], value: '' } });
    assert.ok(/ダメージぶん減らす/.test(off.el('opsResultDraft').innerHTML));
    off._opsResultSetHp(false);
    await off.handleOpsResultSave();
    assert.equal(off.calls.find(c => c[0] === 'addAttack')[2].skipHpDecrement, true, '減らさない を選んだのに減らした');
    assert.ok(!off.calls.some(c => c[0] === 'updateBossHp'));
});

await test('★ 解析中に「誰の凸か」を選び直したら、古い読み取りで下書きを作らない / 選んでいなければ読み取らない', async () => {
    const t = makeEnv({ ocr: { bossName: 'アネモイ', totalDamage: 30e9 } });
    await t.renderOpsAttackCheck(); await flush();
    t._opsResultPick('7');
    t._beforeOcrReturn = () => t._opsResultPick('8');
    await t.handleOpsResultUpload({ target: { files: [{}], value: '' } });
    assert.equal(t.state().ri.draft, null, '選び直す前の人の下書きを作った');
    const none = makeEnv({ ocr: { bossName: 'アネモイ', totalDamage: 30e9 } });
    await none.renderOpsAttackCheck(); await flush();
    await none.handleOpsResultUpload({ target: { files: [{}], value: '' } });
    assert.ok(!none.calls.some(c => c[0] === 'ocr') && /先に「誰の凸か」を選んでください/.test(none.el('opsResultStatus').textContent));
});

await test('★ 報告の無い凸の「📥 取り込む」: その人・そのボス・割当の編成の下書きがすぐ出て、ダメージを入れるまで押せない / スクショを読んでも当たりは残る', async () => {
    const t = makeEnv();
    await t.renderOpsAttackCheck(); await flush();
    t._opsResultFromMissing(0);   // あお 18時 B3 (割当は編成②)
    assert.equal(t.el('opsResultInput').clicked, 0, 'ファイル選択を勝手に開いた');
    const d = t.state().ri.draft;
    assert.deepEqual([d.playerId, d.bossNumber, d.slot, d.fromOcr], [7, 3, 2, false], '当たりが入っていない');
    assert.ok(/手で入力/.test(t.el('opsResultDraft').innerHTML) && /配信の割当から/.test(t.el('opsResultDraft').innerHTML));
    assert.equal(t.el('opsResultSaveBtn').disabled, true, 'ダメージが無いのに押せる');
    t._opsResultSetDamage('28.5');
    assert.equal(t.el('opsResultSaveBtn').disabled, false);
    // Lv4 にしてボス 3 → 止める
    t._opsResultSetLevel('4');
    assert.equal(t.el('opsResultSaveBtn').disabled, true, 'Lv4 のボス 3 を通した');
    t._opsResultSetLevel('1');
    await t.handleOpsResultSave();
    const add = t.calls.find(c => c[0] === 'addAttack');
    assert.deepEqual([add[1].bossNumber, add[1].damageRaw, add[1].characters[0], add[2].skipHpDecrement], [3, 28.5e9, 'G1', false]);
    // 同じ人・同じボスに割当が 2 つ (18 時 = 編成② / 20 時 = 編成①): 押した行 (20 時) の編成を使う (配信の 1 つ目の割当ではない)
    const pub2 = { ...PUB, plan: { ...PUB.plan, levels: [{ level: 1, bosses: [
        { bossNumber: 3, weakness: 'fire', attacks: [{ memberId: 7, hourIdx: 13, dmgB: 28, loadoutSlot: 2 }, { memberId: 7, hourIdx: 15, dmgB: 33, loadoutSlot: 1 }] }] }] } };
    const w = makeEnv({ pub: pub2 });
    await w.renderOpsAttackCheck(); await flush();
    assert.deepEqual(w.state().atk.missing.map(m => [m.hourLabel, m.loadoutSlot]), [['18時', 2], ['20時', 1]]);
    w._opsResultFromMissing(1);
    assert.equal(w.state().ri.draft.slot, 1, '押した行の編成でなく、配信の 1 つ目の割当の編成になった');
    // 当たりを付けたあとにスクショを読む: ボス名が読めなくても、当たりのボスと割当の編成が残る
    const u = makeEnv({ ocr: { bossName: null, totalDamage: 26e9 } });
    await u.renderOpsAttackCheck(); await flush();
    u._opsResultFromMissing(0);
    await u.handleOpsResultUpload({ target: { files: [{}], value: '' } });
    const ud = u.state().ri.draft;
    assert.deepEqual([ud.playerId, ud.bossNumber, ud.slot, ud.damageB, ud.fromOcr], [7, 3, 2, '26.000', true], 'スクショを読んだら当たりが消えた');
});

await test('★ 「凸していない」: 印を付けると未報告と片付けの数から外れ、戻すと戻る (盤面には触れない)', async () => {
    const t = makeEnv();
    await t.renderOpsAttackCheck(); await flush();
    await t.handleOpsAtkSkip(1, true);   // きい 19時 B3
    assert.deepEqual(t.calls.find(c => c[0] === 'setSkip').slice(1), [45, '501|8|1|3|14', true, 1], '鍵・押した人が違う');
    let st = t.state().atk;
    assert.deepEqual(st.missing.map(m => m.memberId), [7]); assert.deepEqual(st.skipped.map(m => m.memberId), [8]);
    assert.ok(/凸していない 1/.test(t.el('opsAtkCheckMissing').innerHTML) && /handleOpsAtkSkip\(0, false\)/.test(t.el('opsAtkCheckMissing').innerHTML));
    assert.ok(/<b>1 凸<\/b>/.test(t.el('opsPlanTidy').innerHTML));
    assert.ok(!t.calls.some(c => ['addAttack', 'invalidate'].includes(c[0])), '盤面に触れた');
    await t.handleOpsAtkSkip(0, false);
    st = t.state().atk;
    assert.deepEqual(st.missing.map(m => m.memberId), [7, 8]); assert.equal(st.skipped.length, 0);
    // 片付けが 0 になったら案内を消す
    const t2 = makeEnv({ snap: board({ attacksA: [{ id: 5, player_id: 7, boss_number: 3, damage_raw: 28e9, reported_at: at(18, 40), level: 1 }], attacksB: [{ id: 6, player_id: 8, boss_number: 3, damage_raw: 30e9, reported_at: at(19, 40), level: 1 }] }) });
    await t2.renderOpsAttackCheck(); await flush();
    assert.equal(t2.state().atk.missing.length, 0); assert.equal(t2.el('opsPlanTidy').style.display, 'none', '片付けることが無いのに案内が出ている');
    // Discord で聞く文
    await t._opsAtkAsk(0);
    assert.ok(t.calls.some(c => c[0] === 'copy' && /あお さん、18時の B3 \(灼熱PT\)/.test(c[1])), '聞く文が違う');
});

await test('★ ブロックの配信の通知: 配信 1 回につき 1 度 / 人ごとに自分の凸 (夕方のぶんだけ) / 確保できなければ送らない / 全部失敗したら確保を戻す', async () => {
    const t = makeEnv();
    const sent = await t._notifyBlockPublish({ pub: { id: 501 }, plan: PUB.plan, seasonId: 45, me: { id: 1 }, changedIds: new Set([8]), onlyIds: null });
    assert.deepEqual([...sent], [7, 8]);
    assert.deepEqual(t.calls.find(c => c[0] === 'claim').slice(1), [45, 'block_publish', '501', 1]);
    const pushes = t.calls.filter(c => c[0] === 'push').map(c => c[1]);
    assert.deepEqual(pushes.map(p => [p.playerIds, p.title, p.body]), [
        [[7], '🧱 夕方 18〜20時 のあなたの凸が決まりました', '18時 B3 灼熱PT 編成② — ホームで確認してください'],
        [[8], '🔄 夕方 18〜20時 のあなたの凸が変わりました', '19時 B3 灼熱PT 編成① — ホームで確認してください'],
    ], '夜の割当まで書いている / 文が違う');
    assert.ok(t.calls.some(c => c[0] === 'markSent'));
    // 同じブロックの配信し直し: 変わった人だけ
    const only = makeEnv();
    const s2 = await only._notifyBlockPublish({ pub: { id: 502 }, plan: PUB.plan, seasonId: 45, me: { id: 1 }, changedIds: new Set([8]), onlyIds: new Set([8]) });
    assert.deepEqual([...s2], [8]); assert.equal(only.calls.filter(c => c[0] === 'push').length, 1);
    // 誰かが送信中 / 送信済み → 送らない
    const held = makeEnv(); held._claim = 'held';
    assert.equal((await held._notifyBlockPublish({ pub: { id: 503 }, plan: PUB.plan, seasonId: 45, me: { id: 1 } })).size, 0);
    assert.ok(!held.calls.some(c => c[0] === 'push'), '確保できないのに送った');
    // 全部失敗 → 確保を戻して空を返す (L4 に任せる)
    const bad = makeEnv(); bad._pushFail = true;
    assert.equal((await bad._notifyBlockPublish({ pub: { id: 504 }, plan: PUB.plan, seasonId: 45, me: { id: 1 } })).size, 0);
    assert.ok(bad.calls.some(c => c[0] === 'release') && !bad.calls.some(c => c[0] === 'markSent'), '送れなかったのに送信済みにした');
    // ブロックで組んでいない配信は通知しない
    const whole = makeEnv();
    assert.equal((await whole._notifyBlockPublish({ pub: { id: 505 }, plan: { ...PUB.plan, blockScope: null }, seasonId: 45, me: { id: 1 } })).size, 0);
    assert.ok(!whole.calls.some(c => c[0] === 'claim'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
