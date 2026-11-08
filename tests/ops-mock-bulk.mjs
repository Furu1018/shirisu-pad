// ============================================================================
// ✏️ まとめて入力 (1 人 5 属性・第46期メモ §3・2026-11-08) の実行テスト
//   node tests/ops-mock-bulk.mjs
// ----------------------------------------------------------------------------
// index.html から openOpsMockBulk / _mkbRender / _mkbPick / _mkbSetDmg / _mkbAddRow / handleOpsMockBulkSave / _mkbNext / closeOpsMockBulk と
// _saveMockFor を切り出し、通信 (人気編成の材料・前のシーズン・保存) と DOM だけをスタブにして実際に走らせる。
// 守るのは: ① 名前で開くと その人の 5 属性がボスの順に・いまの登録が入った状態で描け、プリセット (人気 → 前回の自分) が読み込みのあとに並ぶ
//          ② プリセットを押すと 5 枠に入る / 被るプリセット (別の属性の編成とも・同じ属性の 2 編成目とも) は選べない
//          ③ まとめて保存 = 変えた枠だけ・ダメージのある枠だけ を属性の順に 1 つずつ _saveMockFor (キャラはマスタで正規化) → 失敗した枠はそのまま残る
//          ④ 保存中は閉じられない・二重に押せない ⑤ 待っている間に別の人を開いたら古い読み込みの結果で上書きしない ⑥ 次の人は表の並び
// ★ テンプレートリテラルの中の未定義参照は実行しないと出ない — 画面を組み立てる関数なので実行テストが要る
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/raidBlocks.js';      // globalThis.raidBlocksDomain
import '../js/domain/mockIntake.js';      // globalThis.mockIntakeDomain

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function cut(marker) {
    const i = html.indexOf(marker);
    if (i < 0) { console.error(`NG: ${marker} を index.html から切り出せませんでした (目印が変わった?)`); process.exit(2); }
    let paren = 0, bodyStart = -1;
    for (let k = html.indexOf('(', i); k < html.length; k++) {
        if (html[k] === '(') paren++;
        else if (html[k] === ')') { paren--; if (paren === 0) { bodyStart = html.indexOf('{', k); break; } }
    }
    let depth = 0, inStr = null, prev = '';
    for (let k = bodyStart; k < html.length; k++) {
        const ch = html[k];
        if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; }
        else if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); }
        prev = ch;
    }
    console.error(`NG: ${marker} の終端を判定できませんでした`); process.exit(2);
}
const a0 = html.indexOf('        // ========== ✏️ まとめて入力 (1 人 5 属性'), a1 = html.indexOf('        // ========== 👥 メンバー状況ボード');
assert.ok(a0 > 0 && a1 > a0, 'まとめて入力の本体を切り出せない');
const SRC = html.slice(a0, a1) + '\n' + cut('        async function _saveMockFor(');

const PT_ATTRS = [{ key: 'fire', name: '灼熱' }, { key: 'water', name: '水冷' }, { key: 'electric', name: '電撃' }, { key: 'iron', name: '鉄甲' }, { key: 'wind', name: '風圧' }];
const T = (s) => s.split('');
function makeEnv(o = {}) {
    const els = new Map();
    let bodyHtml = '', open = false;
    const el = (id) => {
        if (!els.has(id)) els.set(id, { id, style: {}, textContent: '', innerHTML: '', hidden: false, disabled: false,
            classList: { add: (c) => { if (id === 'opsMockBulkModal' && c === 'open') open = true; }, remove: (c) => { if (id === 'opsMockBulkModal' && c === 'open') open = false; }, contains: (c) => id === 'opsMockBulkModal' && c === 'open' && open } });
        return els.get(id);
    };
    const bodyEl = { id: 'opsMockBulkBody', style: {}, set innerHTML(v) { bodyHtml = String(v); }, get innerHTML() { return bodyHtml; } };
    els.set('opsMockBulkBody', bodyEl);
    const inputs = {};   // [data-mkb-dmg="attr:i"] の value (焦点の確認用)
    const players = o.players || [
        { id: 1, name: 'ミリン', availableSlots: ['h17', 'h18', 'h19', 'h20'], loadoutsByAttr: { fire: [{ slot: 1, dmgB: 37.8, team: T('ABCDE') }], water: [{ slot: 1, dmgB: 32.9, team: T('FGHIJ') }] } },
        { id: 2, name: '銀狐', availableSlots: ['h17', 'h21'], loadoutsByAttr: {} },
        { id: 3, name: '書庫', archived: true, availableSlots: [], loadoutsByAttr: {} },
    ];
    const bosses = [
        { boss_number: 1, name: 'オベリスク', weakness: 'iron' }, { boss_number: 2, name: 'クリスタル', weakness: 'electric' },
        { boss_number: 3, name: 'アルトアイゼン', weakness: 'fire' }, { boss_number: 4, name: 'ビッグアームズ', weakness: 'wind' }, { boss_number: 5, name: 'ブラックスミス', weakness: 'water' },
    ];
    const pop = o.pop || {
        iron: [{ team: T('KLMNO'), count: 5, mockCount: 3, histCount: 2 }, { team: T('AXYZW'), count: 2, mockCount: 1, histCount: 1 }],   // 2 つ目は 灼熱の編成の A と被る
        water: [{ team: T('FGHIJ'), count: 4, mockCount: 4, histCount: 0 }],   // いまの水冷の編成と同じ
    };
    const saved = [], reg = [], toasts = [], loads = [], reloads = [];
    const env = {
        _opsMode: true,
        PT_ATTRS, SLOT_JP: { 1: '①', 2: '②', 3: '③' }, MY_TEAM_SLOTS: [1, 2, 3],
        _MK_ATTR_CSS: Object.fromEntries(PT_ATTRS.map(a => [a.key, { bg: `var(--attr-${a.key}-bg)`, deep: `var(--attr-${a.key}-deep)` }])),
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        _charIconHtml: (name) => `<i>${name}</i>`,
        // 本物と同じ形: 画像パスはマスタに無ければ null (解決できない凸は丸ごと捨てる)・名前はそのまま
        resolveNikkeChar: (s) => { const m = /\/w(\d)\.webp$/.exec(String(s)); if (m) return { canonical: 'W' + m[1], iconPath: s }; return String(s).includes('/') ? null : { canonical: String(s), iconPath: null }; },
        fuzzyResolveCharacter: (n) => n,
        _mockIntake: { order: [1, 2], players },
        opsStore: { get: () => (o.noBoard ? null : { season: { id: 46, metadata: {} }, players, bosses }), load: async () => { throw new Error('no'); }, invalidate: () => { env.invalidated++; } },
        showNotification: (m) => { toasts.push(m); },
        confirm: () => env._confirm,
        getCurrentIdentity: () => ({ id: 7, name: '運営A' }),
        _loadTeamSubs: (force) => { loads.push(force); return env._loadGate ? env._loadGate() : Promise.resolve([]); },
        _teamHistCache: [
            { player_id: 1, season_id: 45, attribute: 'wind', characters: ['./p/w1.webp', './p/w2.webp', './p/w3.webp', './p/w4.webp', './p/w5.webp'] },
            { player_id: 1, season_id: 45, attribute: 'iron', characters: ['./p/w1.webp', './p/zz.webp', './p/w3.webp', './p/w4.webp', './p/w5.webp'] },   // 解決できない 1 人 → 使わない
            { player_id: 1, season_id: 44, attribute: 'wind', characters: ['./p/w6.webp', './p/w7.webp', './p/w8.webp', './p/w9.webp', './p/w1.webp'] },   // 前々回 → 使わない
            { player_id: 2, season_id: 45, attribute: 'wind', characters: ['./p/w6.webp', './p/w7.webp', './p/w8.webp', './p/w9.webp', './p/w1.webp'] },   // 別の人
        ],
        _teamGroupsFor: (attr) => ({ total: 0, list: pop[attr] || [] }),
        openIconPicker: (cur, cb, title, opts) => { env.picker = { cur, cb, title, opts }; },
        _opsReloadBoardCards: () => { reloads.push(1); },
        renderMyDamagePanels: () => { env.myPanels++; },
        document: {
            getElementById: el,
            querySelector: (sel) => { const m = /\[data-mkb-dmg="([a-z]+):(\d+)"\]/.exec(sel); if (!m) return null; const k = `${m[1]}:${m[2]}`; return { get value() { return inputs[k] || ''; }, focus() { env.focused.push(k); } }; },
        },
        window: {
            mockIntakeDomain: globalThis.mockIntakeDomain, raidBlocksDomain: globalThis.raidBlocksDomain,
            supabaseLoadGrowthSeasons: async () => [{ id: 46, is_active: true, is_test: false, month_key: '2026-12' }, { id: 47, is_active: false, is_test: true, month_key: '2026-12t' }, { id: 45, is_active: false, is_test: false, month_key: '2026-11' }, { id: 44, is_active: false, is_test: false, month_key: '2026-10' }],
            supabaseRegisterOcrCharacters: async (names) => { reg.push(names.slice()); return { canonical: names.map(n => n + '!') }; },
            supabaseSaveMockSubmission: async (pid, attr, opts) => { if (env._saveGate) await env._saveGate(attr); if (env._failAttr === attr) throw new Error(`${attr} だめ`); saved.push({ pid, attr, ...opts });
                if (env._redirectRule) { const r = env._redirectRule(attr, opts, saved.length); if (r) return { slot: r }; }
                return { slot: env._redirectTo && attr === env._redirectAttr ? env._redirectTo : opts.slot }; },
        },
        console,
        saved, reg, toasts, loads, reloads, inputs, els, focused: [], invalidated: 0, myPanels: 0, _confirm: true, _failAttr: null, _loadGate: null, _saveGate: null, _redirectTo: null, _redirectAttr: null,
        body: () => bodyHtml, isOpen: () => open,
    };
    const names = ['_opsMode', 'PT_ATTRS', 'SLOT_JP', 'MY_TEAM_SLOTS', '_MK_ATTR_CSS', 'escapeHtml', '_charIconHtml', 'resolveNikkeChar', 'fuzzyResolveCharacter', '_mockIntake', 'opsStore',
        'showNotification', 'confirm', 'getCurrentIdentity', '_loadTeamSubs', '_teamHistCache', '_teamGroupsFor', 'openIconPicker', '_opsReloadBoardCards', 'renderMyDamagePanels', 'document', 'window', 'console'];
    const fns = new Function(...names, SRC + '\nreturn { _mkb, openOpsMockBulk, closeOpsMockBulk, _mkbRender, _mkbPick, _mkbPickChar, _mkbSetDmg, _mkbAddRow, _mkbNext, _mkbNextId, handleOpsMockBulkSave, _mkbFlatRows, _mkbPresetsOf };')(...names.map(n => env[n]));
    return { env, ...fns };
}
const tick = () => new Promise(r => setTimeout(r, 0));
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log(`  ✅ ${name}`); } catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e?.stack || e}`); } }

await t('① 開く: 5 属性がボスの順・いまの登録が入っている・「のみ」と 〆 の札・読み込みのあとにプリセット (人気 → 前回の自分・解決できない凸と前々回と別の人は使わない)', async () => {
    const h = makeEnv();
    await h.openOpsMockBulk(1);
    assert.ok(h.env.isOpen(), 'モーダルが開かない');
    assert.equal(h.env.els.get('opsMockBulkTitle').textContent, '✏️ ミリン の模擬 (5 属性)');
    const b = h.env.body();
    assert.deepEqual([...b.matchAll(/data-mkb-attr="([a-z]+)"/g)].map(m => m[1]), ['iron', 'electric', 'fire', 'wind', 'water'], 'ボスの順でない');
    assert.ok(/B1 鉄甲PT<\/span><small>vs オベリスク<\/small>/.test(b) && /B5 水冷PT<\/span><small>vs ブラックスミス/.test(b), 'ボスの見出し');
    assert.ok(b.includes('D 夕方 のみ') && b.includes('〆 D 夕方の前'), '「のみ」と 〆 の札が無い');
    assert.ok(/value="37.8"/.test(b) && /value="32.9"/.test(b) && /<i>A<\/i>/.test(b), 'いまの登録 (ダメージ・編成) が入っていない');
    assert.ok(b.includes('2 / 5 属性'), '進み');
    assert.deepEqual(h.env.loads, [true], 'プリセットの材料を読み直していない (force)');
    assert.ok(!/mkb-loading/.test(b), '読み込みが終わったのに「読み込み中」');
    assert.ok(/data-key="K\|L\|M\|N\|O"/.test(b) && /class="mkb-preset warn" data-key="A\|W\|X\|Y\|Z"[^>]*>[\s\S]*?別の属性と被り: A/.test(b) && !/mkb-preset ng/.test(b), '鉄甲の人気の編成が無い / 灼熱の編成と被るものが「注意」でなく選べない見た目');
    assert.ok(/<b>5 人<\/b>が使用<br>模擬3\+過去の凸2/.test(b), '人数の内訳');
    assert.ok(/class="mkb-preset on" data-key="F\|G\|H\|I\|J"/.test(b), 'いまの編成と同じプリセットが選択中になっていない');
    assert.ok(/data-key="W1\|W2\|W3\|W4\|W5"[^>]*>[\s\S]*?<span class="mine">前回の自分<\/span>/.test(b), '前回の自分 (風圧) が無い');
    assert.ok(!/W6\|/.test(b) && !/zz/.test(b), '前々回の凸 / 別の人の凸 / 解決できない凸 が混ざっている');
    assert.ok(/この属性のプリセットはまだありません/.test(b), '材料の無い属性の案内');
    assert.ok(/mkbSaveBtn" onclick="handleOpsMockBulkSave\(\)" disabled/.test(b), '何も変えていないのに保存できる');
    assert.ok(/次の人 → 銀狐/.test(b), '次の人 (表の並び)');
    assert.equal(h._mkbNextId(), 2);
});

await t('② プリセットを押すと 5 枠に入ってダメージへ焦点 / 被るプリセットは選べない (別の属性の編成とも・同じ属性の 2 編成目とも) / 顔を押すと 1 人ずつ', async () => {
    const h = makeEnv();
    await h.openOpsMockBulk(1);
    h._mkbPick('iron', 0, 'K|L|M|N|O');
    assert.deepEqual(h._mkb.rows.iron[0].team, T('KLMNO'));
    assert.deepEqual(h.env.focused, ['iron:0'], 'ダメージの欄へ焦点が移らない');
    assert.ok(h._mkbFlatRows().find(r => r.attr === 'iron').dirty, '変更ありにならない');
    assert.ok(/保存するのは変えた枠だけ: 0 件 · ダメージの無い枠 1 は保存しません/.test(h.env.body()), '編成だけの枠を保存する数に入れている');
    // 別の属性 (灼熱) の編成と被るプリセットは「注意」で選べる (支援キャラは複数の属性に入るのが普通) → 行に ⚠ の文
    h._mkbPick('iron', 0, 'A|W|X|Y|Z');
    assert.deepEqual(h._mkb.rows.iron[0].team.slice().sort(), T('AWXYZ'), '別の属性と被るだけのプリセットが選べない');   // 並びはプリセットのまま (人気の表示順) なので揃えて比べる
    assert.ok(/⚠ 別の属性と被り: A/.test(h.env.body()), '別の属性との被りの文が無い');
    assert.ok(!/mkb-face has dup/.test(h.env.body()), '別の属性との被りで顔を赤くした');
    h._mkbPick('iron', 0, 'K|L|M|N|O');
    // 同じ属性の 2 編成目: 水冷の編成①と同じ 5 人は選べない (2 編成目は両方使う)
    h._mkbAddRow('water');
    assert.equal(h._mkb.rows.water.length, 2); assert.equal(h._mkb.rows.water[1].slot, 2);
    assert.ok(/＋ 編成③を足す/.test(h.env.body()) && /B5 水冷PT/.test(h.env.body()), '3 つ目を足すボタン');
    const p2 = h._mkbPresetsOf('water', 1);
    assert.deepEqual(p2.map(p => [p.key, p.dup, p.blocked, p.blockedWith]), [['F|G|H|I|J', false, true, T('FGHIJ')]], '同じ属性の編成①と被るのに選べる');
    assert.ok(/class="mkb-preset ng" data-key="F\|G\|H\|I\|J"/.test(h.env.body()), '選べない見た目でない');
    h._mkbPick('water', 1, 'F|G|H|I|J');
    assert.deepEqual(h._mkb.rows.water[1].team, ['', '', '', '', ''], '被るのに入った');
    assert.ok(h.env.toasts.some(m => /同じ属性の別の編成とキャラが被ります \(F・G・H・I・J\)/.test(m)), '被りの知らせが無い');
    // 同じ属性の 2 編成目に編成①と同じキャラを顔から入れると、その顔が赤い
    h._mkbPickChar('water', 1, 0); h.env.picker.cb('F');
    assert.ok(/class="mkb-face has dup"/.test(h.env.body()), '同じ属性の被りの顔が赤くない');
    // 顔を押す → アイコンピッカー (属性つき) → 選んだ名前が入る。選んでいる間に別の人を開いたら捨てる
    h._mkbPickChar('electric', 0, 2);
    assert.equal(h.env.picker.opts.attr, 'electric'); assert.ok(/電撃PT 編成① の 3枠目/.test(h.env.picker.title));
    h.env.picker.cb('ナガ');
    assert.deepEqual(h._mkb.rows.electric[0].team, ['', '', 'ナガ', '', '']);
    const cb = h.env.picker.cb;
    await h.openOpsMockBulk(2);
    cb('アニス');
    assert.ok(!Object.values(h._mkb.rows).flat().some(r => r.team.includes('アニス')), '別の人を開いたあとに前の人のピッカーの結果が入った');
});

await t('③ まとめて保存: 変えた枠だけ・ダメージのある枠だけ を属性の順に 1 つずつ _saveMockFor (キャラはマスタで正規化・代理の印) / 失敗した枠はそのまま残る / 盤面を取り直す', async () => {
    const h = makeEnv();
    await h.openOpsMockBulk(1);
    h._mkbPick('iron', 0, 'K|L|M|N|O'); h._mkbSetDmg('iron', 0, '26.1');
    h._mkbSetDmg('electric', 0, '15');            // 編成なし・ダメージだけ
    h._mkbSetDmg('fire', 0, '37.8');              // 同じ値 = 変えていない
    h._mkbPick('wind', 0, 'W1|W2|W3|W4|W5');       // 編成だけ (ダメージ無し) → 保存しない
    h.env._failAttr = 'electric';
    // 直前の操作 (プリセット) は描き直すので、件数は描いた本文で見る (入力だけのときは _mkbSyncFooter が要素を直に更新する)
    assert.ok(/保存するのは変えた枠だけ: 2 件 \(鉄甲・電撃\) · ダメージの無い枠 1 は保存しません/.test(h.env.body()), h.env.body().match(/保存するのは[^<]*/)?.[0]);
    assert.ok(!/mkbSaveBtn" onclick="handleOpsMockBulkSave\(\)" disabled/.test(h.env.body()), '保存できない');
    h._mkbSetDmg('electric', 0, '15');
    assert.equal(h.env.els.get('mkbCnt').textContent, '保存するのは変えた枠だけ: 2 件 (鉄甲・電撃) · ダメージの無い枠 1 は保存しません', '入力のたびの更新');
    assert.equal(h.env.els.get('mkbSaveBtn').disabled, false);
    await h.handleOpsMockBulkSave();
    assert.deepEqual(h.env.saved.map(s => [s.pid, s.attr, s.slot, s.damageB, s.characters, s.actorName]), [[1, 'iron', 1, 26.1, ['K!', 'L!', 'M!', 'N!', 'O!'], '運営A']], '保存の中身');
    assert.deepEqual(h.env.reg, [T('KLMNO')], 'キャラをマスタで正規化していない / 編成の無い枠で正規化を呼んだ');
    assert.equal(h._mkb.busy, false);
    const iron = h._mkb.rows.iron[0], ele = h._mkb.rows.electric[0];
    assert.ok(iron.saved && !h._mkbFlatRows().find(r => r.attr === 'iron').dirty, '保存した枠がまだ「変更あり」');
    assert.ok(/electric だめ/.test(ele.err) && h._mkbFlatRows().find(r => r.attr === 'electric').dirty, '失敗した枠が残っていない');
    assert.ok(/✅ ミリン: 鉄甲 26\.1B を登録しました \/ ❌ 電撃 は保存できませんでした/.test(h._mkb.msg), h._mkb.msg);
    assert.equal(h.env.invalidated, 1); assert.deepEqual(h.env.reloads, [1]); assert.equal(h.env.myPanels, 0, '本人でないのに模擬タブを描いた');
    const b = h.env.body();
    assert.ok(/✓ 保存しました/.test(b) && /❌ electric だめ/.test(b) && /mkbDone-iron"(?! hidden)/.test(b), '保存のあとの見た目');
    // もう一度押すと失敗した枠だけ
    h.env._failAttr = null;
    await h.handleOpsMockBulkSave();
    assert.deepEqual(h.env.saved.map(s => s.attr), ['iron', 'electric']);
    assert.equal(h.env.saved[1].characters, null, '編成の無い枠のキャラが null でない');
    assert.ok(/✅ ミリン: 電撃 15\.0B を登録しました$/.test(h._mkb.msg), h._mkb.msg);
    // 何も変えずに押す
    await h.handleOpsMockBulkSave();
    assert.equal(h.env.saved.length, 2); assert.ok(/変えた枠がありません/.test(h._mkb.msg));
    // 同一編成のため別の枠に寄せられたら (寄せ先の行が無い): その枠番号と注記
    h.env._redirectAttr = 'wind'; h.env._redirectTo = 2;
    h._mkbSetDmg('wind', 0, '20');
    await h.handleOpsMockBulkSave();
    assert.equal(h._mkb.rows.wind.length, 1); assert.equal(h._mkb.rows.wind[0].slot, 2); assert.ok(/編成②に統合/.test(h._mkb.rows.wind[0].note));
    assert.ok(!h._mkbFlatRows().some(r => r.dirty), '統合のあとに「変更あり」が残る');
    // 寄せ先の行がある (編成② に入れたものが編成① と同一編成だった): 編成① の行をこの中身にして、編成② の行は消す (同じ枠番号の行を 2 つにしない — Codex P1)
    h._mkbAddRow('water');
    for (let k = 0; k < 5; k++) { h._mkbPickChar('water', 1, k); h.env.picker.cb('PQRST'[k]); }
    h._mkbSetDmg('water', 1, '33');
    h.env._redirectAttr = 'water'; h.env._redirectTo = 1;
    await h.handleOpsMockBulkSave();
    assert.equal(h.env.saved.at(-1).slot, 2, '編成② として保存を頼んでいない');
    assert.equal(h._mkb.rows.water.length, 1, '同じ枠番号の行が 2 つになった / 行が消えた');
    assert.deepEqual([h._mkb.rows.water[0].slot, h._mkb.rows.water[0].damageB, h._mkb.rows.water[0].team], [1, 33, T('PQRST')]);
    assert.ok(/編成②に入れた模擬は同一編成のためこちらに統合/.test(h._mkb.rows.water[0].note) && h._mkb.rows.water[0].saved);
    assert.ok(!h._mkbFlatRows().some(r => r.dirty), '統合のあとに「変更あり」が残る');
    await h.handleOpsMockBulkSave();
    assert.ok(/変えた枠がありません/.test(h._mkb.msg), '統合のあとにもう一度保存できてしまう');
    // 寄せ先の行がこのあと保存される (変更中) とき: 編成① に入れた X が「いまの DB の編成② と同一」で ② へ寄せられ、そのあと編成② の保存 (Y) が ② を上書きする
    // → ② の保存のあとに ① をもう一度保存する (そのときは ② と別の編成なので ① に入る)。最後は ① = X・② = Y で、どちらも保存済み (Codex 再監査 A②)
    const g = makeEnv();
    await g.openOpsMockBulk(1);
    g._mkbAddRow('water');
    for (let k = 0; k < 5; k++) { g._mkbPickChar('water', 0, k); g.env.picker.cb('abcde'[k]); }   // ① を X に
    g._mkbSetDmg('water', 0, '31');
    for (let k = 0; k < 5; k++) { g._mkbPickChar('water', 1, k); g.env.picker.cb('PQRST'[k]); }   // ② を Y に
    g._mkbSetDmg('water', 1, '33');
    let firstWater1 = true;
    g.env._redirectRule = (attr, opts) => { if (attr === 'water' && opts.slot === 1 && firstWater1) { firstWater1 = false; return 2; } return null; };   // 最初の ① の保存だけ「② と同一編成」
    await g.handleOpsMockBulkSave();
    assert.deepEqual(g.env.saved.filter(x => x.attr === 'water').map(x => [x.slot, x.damageB]), [[1, 31], [2, 33], [1, 31]], '② の保存のあとに ① を保存し直していない');
    assert.deepEqual(g._mkb.rows.water.map(r => [r.slot, r.damageB, r.team.join(''), r.saved]), [[1, 31, 'abcde', true], [2, 33, 'PQRST', true]], '寄せ先 (②) を ① の中身で上書きした / 行が消えた');
    assert.ok(!g._mkbFlatRows().some(r => r.dirty), '「変更あり」が残る');
    assert.ok(/✅ ミリン: 水冷 33\.0B・水冷 31\.0B を登録しました$/.test(g._mkb.msg), g._mkb.msg);   // 保存し直した ① は後ろ (実際の処理順)
});

await t('④ 保存中は閉じられない・二重に押せない・開き直せない / ⑤ 待っている間に別の人を開いたら古い読み込みで上書きしない / ⑥ 次の人 (未保存なら確認)', async () => {
    const h = makeEnv();
    await h.openOpsMockBulk(1);
    h._mkbSetDmg('electric', 0, '15');
    h._mkbPickChar('electric', 0, 1); const lateCb = h.env.picker.cb;   // 保存の前に開いたピッカー
    let release; h.env._saveGate = () => new Promise(r => { release = r; });
    const p = h.handleOpsMockBulkSave();
    await tick();
    assert.equal(h._mkb.busy, true);
    assert.ok(/data-mkb-dmg="electric:0" oninput="[^"]*" disabled/.test(h.env.body()) && /class="mkb-face"[^>]* disabled/.test(h.env.body()) && /class="mkb-preset[^"]*"[^>]* disabled/.test(h.env.body()) && /class="mkb-add"[^>]* disabled/.test(h.env.body()), '保存中に入力欄・顔・プリセット・追加が押せる');
    h.closeOpsMockBulk(); assert.ok(h.env.isOpen() && h.env.toasts.some(m => /保存中/.test(m)), '保存中に閉じられた');
    await h.handleOpsMockBulkSave(); assert.equal(h.env.saved.length, 0, '二重に保存した');
    await h.openOpsMockBulk(2); assert.equal(h._mkb.playerId, 1, '保存中に別の人を開けた');
    // 保存中に遅れて届いたピッカーの結果と入力は反映しない (保存した中身と画面がずれて「保存済み」になる — Codex P1)
    lateCb('遅れて来た'); h._mkbSetDmg('electric', 0, '99');
    assert.deepEqual(h._mkb.rows.electric[0].team, ['', '', '', '', '']); assert.equal(h._mkb.rows.electric[0].damageB, 15);
    assert.ok(h.env.toasts.some(m => /保存中なので反映しませんでした/.test(m)), '遅れて来たピッカーの結果を黙って捨てた');
    release(); await p;
    assert.equal(h.env.saved.length, 1); assert.equal(h._mkb.busy, false);
    assert.ok(h._mkb.rows.electric[0].saved && !h._mkbFlatRows().some(r => r.dirty), '保存したあとの状態');
    assert.ok(/data-mkb-dmg="electric:0" oninput="[^"]*">/.test(h.env.body()) && !/class="mkb-face"[^>]* disabled/.test(h.env.body()) && !/class="mkb-preset[^"]*"[^>]* disabled/.test(h.env.body()), '保存が終わったのに disabled のまま');
    // ⑤ 世代: 1 の読み込みが遅い間に 2 を開く → 1 の結果で描き直さない
    const g = makeEnv();
    let gates = []; g.env._loadGate = () => new Promise(r => gates.push(r));
    const o1 = g.openOpsMockBulk(1); await tick();
    const o2 = g.openOpsMockBulk(2); await tick();
    gates[0](); await o1; await tick();
    assert.equal(g._mkb.playerId, 2); assert.equal(g.env.els.get('opsMockBulkTitle').textContent, '✏️ 銀狐 の模擬 (5 属性)');
    assert.equal(g._mkb.loading, true, '2 の読み込みが終わっていないのに 1 の結果で「読み込み済み」になった');
    gates[1](); await o2;
    assert.equal(g._mkb.loading, false); assert.equal(g._mkb.playerId, 2);
    // ⑥ 次の人: 未保存があれば確認・断れば動かない
    const n = makeEnv();
    await n.openOpsMockBulk(1);
    n._mkbSetDmg('electric', 0, '15');
    n.env._confirm = false; n._mkbNext(); await tick(); assert.equal(n._mkb.playerId, 1, '断ったのに進んだ');
    n.env._confirm = true; n._mkbNext(); await tick(); assert.equal(n._mkb.playerId, 2, '次の人に進まない');
    assert.ok(!/次の人 →/.test(n.env.body()), '最後の人なのに「次の人」が出る');
    n.closeOpsMockBulk(); assert.ok(!n.env.isOpen(), '変更が無いのに閉じない');
    // 盤面が無い / 運営OFF / 書庫の人
    const z = makeEnv({ noBoard: true }); await z.openOpsMockBulk(1); assert.ok(!z.env.isOpen() && z.env.toasts.some(m => /盤面/.test(m)));
    const y = makeEnv(); await y.openOpsMockBulk(3); assert.ok(!y.env.isOpen() && y.env.toasts.some(m => /見つかりません/.test(m)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
