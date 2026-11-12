// ============================================================================
// 🧱 組む: 🧭 ピースのガイド と 🔄 ほかの運営の駒の反映 (2026-11-12) の実行テスト
//   node tests/ops-build-guide.mjs
// ----------------------------------------------------------------------------
// 純ロジック blockBuildDomain.pieceGuide / pinChanges と、index.html から切り出した _obGuideHtml / _obSyncPins / _obSyncNow / _obSyncHtml を
// 通信と DOM だけスタブにして実際に走らせる。守るのは:
//   ① ガイド: 同じ人のほかの編成が「使えなくなる (被るキャラ)」「残る」「置いた」「使用済み」に分かれる / 置くとどうなるか (撃破・余り・あと) /
//      残り凸の合計 (この編成を使う vs いちばん高い組み合わせ・同じキャラは 1 回)
//   ② 差分: 置いた / 外した (外した人) / 移した / 中身が変わった。✓ で実行済みになっただけの駒は数えない
//   ③ 反映: 手が空いていれば自動で・ピースを選んでいる間と自動 OFF は知らせるだけ / 読んでいる間にこの端末が駒を書き換えたら古い読み取りを捨てる /
//      見えていなければ通信しない / 「反映する」は押した時点の DB を読み直す
// ★ テンプレートリテラルの中の未定義参照は実行しないと出ない — 画面を組み立てる関数なので実行テストが要る
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import '../js/domain/raidBlocks.js';
import '../js/domain/planChain.js';
import '../js/domain/reservations.js';
import '../js/domain/blockBuild.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const bb = globalThis.blockBuildDomain, rbd = globalThis.raidBlocksDomain, rv = globalThis.reservationsDomain;
const blocks = rbd.blocksOfSeason(null);   // A 朝 5〜9 / B 午前 / C 午後 / D 夕方 / E 夜 / F 深夜

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const between = (a, b) => {
    const i = html.indexOf(a), j = html.indexOf(b, i + a.length);
    if (i < 0 || j < 0) { console.error(`NG: 「${a}」〜「${b}」を index.html から切り出せませんでした (目印が変わった?)`); process.exit(2); }
    return html.slice(i, j);
};

// ---- 盤面の見本 ----
const W = ['fire', 'wind', 'iron', 'electric', 'water'];
const slotsOf = (idxs) => rbd.slotsOfBlocks(blocks, idxs);
const lo = (slot, dmgB, team) => ({ slot, dmgB, team });
const mkBoard = (remB = [18.2, 0, 26, 31.5, 9.4]) => ({
    season: { id: 1, current_level: 2, hard_date: '2026-12-05' },
    bosses: W.map((w, i) => ({ boss_number: i + 1, name: `ボス${i + 1}`, weakness: w, tier: 'lord', remaining_hp_raw: remB[i] * 1e9 })),
    players: [
        { id: 1, name: 'こむぎ', attackCount: 0, attacks: [], availableSlots: slotsOf([2, 3, 4]), loadoutsByAttr: {
            fire: [lo(1, 24.1, ['クラウン', 'リター', 'レッドフード', 'アリス', 'ナガ'])],
            iron: [lo(1, 29.3, ['クラウン', 'ティア', 'ナガ', 'ラピ', 'マクスウェル'])],
            electric: [lo(1, 27.0, ['ブラン', 'ノワール', 'ドロシー', 'シンデレラ', 'プリバティ'])],
            water: [lo(1, 22.5, ['リター', 'グレイブ', '紅蓮', 'モダニア', 'リバーレリオ'])],
            wind: [lo(1, 20.6, ['アニス', 'モラン', 'エイダ', 'ヘルム', 'マスト'])] } },
        { id: 2, name: 'おはぎ', attackCount: 1, attacks: [{ characters: ['ルージュ', 'マスト', 'ラピ', 'マクスウェル', 'ヘルム'], reported_at: '2026-12-05T00:10:00Z' }], availableSlots: slotsOf([2]), loadoutsByAttr: {
            iron: [lo(1, 30.0, ['ルージュ', 'マスト', 'ラピ', 'マクスウェル', 'ヘルム'])],
            fire: [lo(1, 21.4, ['リター', 'ブラン', 'ノワール', 'レッドフード', 'モダニア'])],
            water: [lo(1, 8.0, [])] } },
    ],
});
const ctxOf = (board, { placed = new Map(), pins = [], idx = 2, first = 2 } = {}) => {
    const planOf = (i, level, cur) => bb.pinsPlan(bb.blockPins(pins), blocks[i], level, cur.bosses, cur.players);
    const ov = bb.overview({ board, blocks, first, planOf, hpOf: () => 50 });
    const tray = bb.trayPieces({ board: ov[idx].startBoard, blocks, idx, bossOrder: W, placed, first });
    return { blocks, first, ov, idx, tray };
};
const piece = (ctx, key) => ctx.tray.find(p => p.key === key);

// ============================== ① 🧭 ピースのガイド (純ロジック) ==============================
test('pieceGuide: この編成を使うと、被るキャラのある編成は「使えなくなる」・無い編成は「残る」(被ったキャラの名前つき)', () => {
    const ctx = ctxOf(mkBoard());
    const g = bb.pieceGuide({ piece: piece(ctx, '1:fire:1'), ...ctx });
    const by = Object.fromEntries(g.mates.map(m => [m.attr, m]));
    assert.equal(by.iron.state, 'clash'); assert.deepEqual(by.iron.hit, ['クラウン', 'ナガ']);
    assert.equal(by.water.state, 'clash'); assert.deepEqual(by.water.hit, ['リター']);
    assert.equal(by.electric.state, 'free'); assert.deepEqual(by.electric.hit, []);
    assert.equal(by.wind.state, 'free');
    assert.equal(g.mates.length, 4, '自分自身を相手に入れている / ほかの人の編成が混ざった');
});
test('pieceGuide: 置き先 — 撃破と余り / あと ◯B / 撃破済みは理由 (bossState) / もう置いてあるピースは null', () => {
    const ctx = ctxOf(mkBoard());
    const fire = bb.pieceGuide({ piece: piece(ctx, '1:fire:1'), ...ctx }).drop;
    assert.equal(fire.ok, true); assert.equal(fire.bossNumber, 1); assert.equal(fire.kill, true);
    assert.ok(Math.abs(fire.overB - 5.9) < 1e-6 && fire.afterB === 0 && Math.abs(fire.remB - 18.2) < 1e-6);
    const elec = bb.pieceGuide({ piece: piece(ctx, '1:electric:1'), ...ctx }).drop;
    assert.equal(elec.kill, false); assert.ok(Math.abs(elec.afterB - 4.5) < 1e-6 && elec.overB === 0);
    const wind = bb.pieceGuide({ piece: piece(ctx, '1:wind:1'), ...ctx }).drop;
    assert.equal(wind.ok, false); assert.equal(wind.st.why, 'killed', '撃破済みのボスに「置ける」と言った');
    const placed = ctxOf(mkBoard(), { placed: new Map([['1:fire:1', 2]]) });
    assert.equal(bb.pieceGuide({ piece: piece(placed, '1:fire:1'), ...placed }).drop, null);
    // Lv4 (ボス 5・HP 無限)
    const b4 = mkBoard(); b4.season.current_level = 4;
    const c4 = ctxOf(b4);
    const inf = bb.pieceGuide({ piece: piece(c4, '1:water:1'), ...c4 }).drop;
    assert.equal(inf.ok, true); assert.equal(inf.infinite, true); assert.equal(inf.remB, null);
});
test('pieceGuide: 残り凸の合計 — この編成を使う場合と、いちばん高い組み合わせ (同じキャラは 1 回・残り凸の数まで)', () => {
    const ctx = ctxOf(mkBoard());
    const t = bb.pieceGuide({ piece: piece(ctx, '1:fire:1'), ...ctx }).total;
    assert.equal(t.n, 3);
    // いちばん高い = 鉄甲 29.3 + 電撃 27.0 + 水冷 22.5 = 78.8 (水冷は灼熱とだけ被る) / 灼熱を使う = 24.1 + 27.0 + 20.6 = 71.7
    assert.ok(Math.abs(t.best.sumB - 78.8) < 1e-6, `best ${t.best.sumB}`);
    assert.deepEqual(t.best.picks.map(x => x.attr).sort(), ['electric', 'iron', 'water']);
    assert.ok(Math.abs(t.withThis.sumB - 71.7) < 1e-6, `withThis ${t.withThis.sumB}`);
    assert.ok(t.withThis.picks.some(x => x.attr === 'fire'), 'この編成が入っていない');
    assert.ok(Math.abs(t.diffB + 7.1) < 1e-6);
    const best = bb.pieceGuide({ piece: piece(ctx, '1:iron:1'), ...ctx }).total;
    assert.ok(Math.abs(best.diffB) < 1e-6, 'いちばん高い組み合わせに入っている編成で差が出た');
    // 残り 1 凸なら 1 つだけ
    const b1 = mkBoard(); b1.players[0].attackCount = 2;
    const c1 = ctxOf(b1);
    const t1 = bb.pieceGuide({ piece: piece(c1, '1:fire:1'), ...c1 }).total;
    assert.equal(t1.n, 1); assert.ok(Math.abs(t1.best.sumB - 29.3) < 1e-6 && Math.abs(t1.withThis.sumB - 24.1) < 1e-6);
});
test('pieceGuide: きょう使ったキャラの編成は used・置いた編成は placed・置いた編成と被る編成は dup — 使えないピースは合計を出さない', () => {
    const ctx = ctxOf(mkBoard());
    const g = bb.pieceGuide({ piece: piece(ctx, '2:fire:1'), ...ctx });
    assert.equal(g.mates.find(m => m.attr === 'iron').state, 'used', 'きょう使ったキャラの編成を「残る」と言った');
    assert.equal(g.mates.find(m => m.attr === 'water').state, 'free', 'キャラの登録が無い編成は被りを判定しない');
    assert.equal(g.total.n, 2);
    assert.ok(Math.abs(g.total.best.sumB - 29.4) < 1e-6, '使用済みの編成を合計に入れた');
    assert.equal(bb.pieceGuide({ piece: piece(ctx, '2:iron:1'), ...ctx }).total, null);
    const placed = ctxOf(mkBoard(), { placed: new Map([['1:iron:1', 3]]) });
    const gp = bb.pieceGuide({ piece: piece(placed, '1:electric:1'), ...placed });
    assert.equal(gp.mates.find(m => m.attr === 'iron').state, 'placed'); assert.equal(gp.mates.find(m => m.attr === 'iron').placedIdx, 3);
    assert.equal(gp.mates.find(m => m.attr === 'fire').state, 'dup', '置いた編成と被ってもう使えない編成を「残る」と言った');
    assert.equal(bb.pieceGuide({ ...placed, piece: null }), null);
});

// ============================== ② 🔄 差分 (純ロジック) ==============================
const pin = (id, o = {}) => ({ id, status: 'pinned', time_mode: 'block', block_from: blocks[0].from, block_to: blocks[0].to, player_id: 1, boss_number: 1, loadout_slot: 1,
    expected_damage_b: 24.1, characters_snapshot: ['クラウン'], pinned_by: 'ふるり', ...o });
test('pinChanges: 置いた / 外した (外した人) / 移した / 中身が変わった — 変わっていなければ空', () => {
    const a = [pin(1), pin(2, { boss_number: 3, player_id: 2 }), pin(3, { boss_number: 4 })];
    assert.deepEqual(bb.pinChanges(a, a.map(r => ({ ...r })), blocks), []);
    const b = [pin(1, { expected_damage_b: 25 }), { ...pin(2, { boss_number: 3, player_id: 2 }), status: 'released', released_by: 'さくら' },
        pin(3, { boss_number: 4, block_from: blocks[1].from, block_to: blocks[1].to }), pin(9, { player_id: 5, boss_number: 2, pinned_by: 'さくら' })];
    const ch = bb.pinChanges(a, b, blocks);
    const by = Object.fromEntries(ch.map(c => [c.id, c]));
    assert.equal(ch.length, 4);
    assert.equal(by[1].kind, 'changed');
    assert.equal(by[2].kind, 'removed'); assert.equal(by[2].by, 'さくら', '外した人を言っていない'); assert.equal(by[2].blockIdx, 0);
    assert.equal(by[3].kind, 'moved'); assert.equal(by[3].fromBlockIdx, 0); assert.equal(by[3].blockIdx, 1);
    assert.equal(by[9].kind, 'placed'); assert.equal(by[9].by, 'さくら'); assert.equal(by[9].playerId, 5);
    // 行ごと消えた駒は、外した人が分からない
    assert.equal(bb.pinChanges([pin(1)], [], blocks)[0].by, null);
    // ブロックの駒でない行 (時刻の予約・承認待ち) は数えない
    assert.deepEqual(bb.pinChanges([], [{ ...pin(4), time_mode: 'slot' }, { ...pin(5), status: 'requested' }], blocks), []);
    // 承認済みのブロックの約束は isFixed を渡したときだけ駒
    const fixed = { ...pin(6), status: 'approved' };
    assert.equal(bb.pinChanges([], [fixed], blocks, rv.isFixed)[0].fixed, true);
    assert.deepEqual(bb.pinChanges([], [fixed], blocks), []);
});

// ============================== ①' 🧭 ガイドの描画 (index.html から切り出して実行) ==============================
const GUIDE_SRC = between('        function _obGuideKey(ctx) {', '        // 決定できるブロック: 🧮 で組んだ');
const DEAD_SRC = between('        function _obDeadText(st, blocks, pt, attr) {', '        // 「このブロックのみ」「このブロックで最後」の人の段');
const PT_ATTRS = [{ key: 'fire', name: '灼熱' }, { key: 'wind', name: '風圧' }, { key: 'iron', name: '鉄甲' }, { key: 'electric', name: '電撃' }, { key: 'water', name: '水冷' }];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mkGuide = (_ob, el = { innerHTML: '' }) => new Function('window', '_ob', 'PT_ATTRS', 'SLOT_JP', '_bbFill', '_charIconHtml', 'escapeHtml', '_obHours', 'document',
    `${DEAD_SRC}\n${GUIDE_SRC}\nreturn { _obGuideKey, _obGuideHtml, _obGuidePaint };`)(
    { blockBuildDomain: bb }, _ob, PT_ATTRS, { 1: '①', 2: '②', 3: '③' }, () => ['var(--x)', 'var(--y)'], (c, n) => `<i data-c="${esc(c)}" data-n="${n}"></i>`, esc,
    (b) => b.attackRange || b.range, { getElementById: (id) => (id === 'obGuide' ? el : null) });
test('ガイドの描画: 名前・属性・キャラのアイコン 5 つ・ダメージ / 置くとどうなるか / 出られるブロックのタイル / ほかの編成 (✕ 使えなくなる・○ 残る) / 合計の差', () => {
    const ctx = ctxOf(mkBoard());
    const G = mkGuide({ sel: '1:fire:1', hover: null });
    const h = G._obGuideHtml(ctx, G._obGuideKey(ctx));
    assert.ok(h.includes('<span>こむぎ</span>') && h.includes('灼熱PT') && h.includes('24.1B'), '見出しが無い');
    assert.equal((h.match(/<div class="obg-h">[\s\S]*?<\/div>/)[0].match(/data-c=/g) || []).length, 5, '握った編成のキャラが 5 つ出ていない');
    assert.ok(h.includes('B1 ボス1: あと 18.2B → 置くと 撃破 ✓ 余り 5.9B'), `置くとどうなるかが無い: ${h.match(/obg-drop[^<]*<?[^<]*/)}`);
    const tiles = h.match(/<div class="obg-blks"[^>]*>([\s\S]*?)<\/div>/)[1];
    assert.deepEqual([...tiles.matchAll(/<span class="([^"]*)"/g)].map(m => m[1]), ['past', 'past', 'on now', 'on', 'on', ''], '出られるブロックのタイル (過ぎた・いま・出られる) が違う');
    assert.ok(h.includes('ほかに D 夕方・E 夜 でも置けます'), 'ほかに出られるブロックを言っていない');
    assert.equal((h.match(/class="obg-mk x">✕ 使えなくなる/g) || []).length, 2); assert.equal((h.match(/class="obg-mk o">○ 残る/g) || []).length, 2);
    assert.ok(h.includes('クラウン・ナガ が同じ') && h.includes('<span class="obg-face hit"><i data-c="クラウン"'), '被るキャラを名前と印で出していない');
    assert.ok(h.includes('この編成を使う: <b>71.7B</b>') && h.includes('いちばん高い組み合わせ: <b>78.8B</b>') && h.includes('差 -7.1B'), '合計の差が無い');
    assert.ok(mkGuide({ sel: '1:iron:1', hover: null })._obGuideHtml(ctx, '1:iron:1').includes('差なし'), 'いちばん高い組み合わせの編成で「差なし」と言っていない');
});
test('ガイドの描画: ポインタを乗せたピースが先・無ければ選んだピース・どちらも無ければ案内 / このブロックのみ / 置けない理由・使用済み・置いてある / 描き直しはガイドだけ', () => {
    const ctx = ctxOf(mkBoard());
    const el = { innerHTML: '' };
    const ob = { sel: '1:fire:1', hover: '2:fire:1', ctxLast: ctx };
    const G = mkGuide(ob, el);
    assert.equal(G._obGuideKey(ctx), '2:fire:1');
    G._obGuidePaint();
    assert.ok(el.innerHTML.includes('<span>おはぎ</span>') && el.innerHTML.includes('出られるブロック — このブロックのみ') && el.innerHTML.includes('ほかのブロックには置けません'), 'ポインタを乗せた人のガイドになっていない');
    assert.ok(el.innerHTML.includes('class="obg-mk ">キャラ使用済み') && el.innerHTML.includes('キャラの登録なし'), '使用済みの編成・キャラの無い編成の出し方が違う');
    ob.hover = '消えたピース';
    assert.equal(G._obGuideKey(ctx), '1:fire:1', 'もう無いピースを指したまま');
    ob.hover = null; ob.sel = null;
    G._obGuidePaint();
    assert.ok(el.innerHTML.includes('obg-empty') && el.innerHTML.includes('ピースを押す'), '何も選んでいないときの案内が無い');
    assert.ok(G._obGuideHtml(ctx, '1:wind:1').includes('⚠ 置けない: 風圧PT の相手 B2 ボス2 は Lv2 を もう撃破済み'), '置けない理由が盤・ピースと同じ文でない');
    assert.ok(G._obGuideHtml(ctx, '2:iron:1').includes('⚠ 使えない: この編成のキャラは、きょうもう使っています'));
    const placed = ctxOf(mkBoard(), { placed: new Map([['1:iron:1', 3]]) });
    const hp = G._obGuideHtml(placed, '1:iron:1');
    assert.ok(hp.includes('D 夕方 に置いてあります') && hp.includes('この編成を置いたので、ほかの編成は') && !hp.includes('obg-sum'), '置いてあるピースの出し方が違う');
    assert.ok(G._obGuideHtml(placed, '1:fire:1').includes('⚠ 使えない: 置いた別の編成とキャラが被ります'));
    ob.ctxLast = null; el.innerHTML = 'そのまま';
    G._obGuidePaint();
    assert.equal(el.innerHTML, 'そのまま', '盤を描く前に描いた');
});

// ============================== ③ 🔄 反映 (index.html から切り出して実行) ==============================
const SYNC_SRC = between("        const _OB_SYNC_AUTO_KEY = 'shirisuko_ob_sync_auto_v1';", '        // ✅ 決定 (シンプル化 S4): 最新の決定の行を読む');
const FP_SRC = between('        const _obFpRows = (rows) =>', '        const _obPinsFp = ');
function mkSync({ pins, sel = null, visible = true, auto = true, opsMode = true, plans = new Map() } = {}) {
    const log = [];
    const store = new Map(auto ? [] : [['shirisuko_ob_sync_auto_v1', '0']]);
    const _ob = { pins, pinsErr: null, pinsSeason: 1, epoch: 1, busy: false, sel, plans, blocks, syncPending: null, syncNote: null, flash: null, syncing: false };
    const el = { innerHTML: '' };
    const gate = { next: null, hold: null };   // next = 次に返す行 / hold = 止めておく約束
    const W2 = { reservationsDomain: rv, blockBuildDomain: bb, raidBlocksDomain: rbd,
        supabaseLoadReservations: async () => { log.push('load'); if (gate.hold) await gate.hold; if (gate.next instanceof Error) throw gate.next; return gate.next; } };
    const board = mkBoard();
    const api = new Function('window', '_ob', 'localStorage', 'opsStore', 'document', 'renderOpsBuild', 'showNotification', 'PT_ATTRS', 'SLOT_JP', 'escapeHtml', '_obTimeOf', '_opsModeOf', 'setTimeout', 'clearTimeout',
        `const _obSame = (epoch, sid) => _ob.epoch === epoch && _ob.pinsSeason === sid;\n${FP_SRC}\n${SYNC_SRC.replace(/!_opsMode/g, '!_opsModeOf()')}\nreturn { _obSyncPins, _obSyncNow, _obSyncApply, _obSyncHtml, _obSetSyncAuto, _obSyncDismiss, _obSyncAuto, _obRawSig };`)(
        W2, _ob, { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        { get: () => board }, { getElementById: (id) => (id === 'opsBuild' ? { offsetParent: visible ? {} : null } : (id === 'obSync' ? el : null)) },
        () => log.push('render'), (m) => log.push('note:' + m), PT_ATTRS, { 1: '①', 2: '②', 3: '③' }, esc, () => '12/5 08:45', () => opsMode, () => 0, () => {});
    return { _ob, log, el, gate, api, store };
}
const base = () => [pin(1), pin(2, { boss_number: 3, player_id: 2 })];
const other = () => [pin(1), { ...pin(2, { boss_number: 3, player_id: 2 }), status: 'released', released_by: 'さくら' }, pin(9, { player_id: 2, boss_number: 3, expected_damage_b: 30, pinned_by: 'さくら' })];

test('反映: 変わっていなければ何もしない (駒の一覧を差し替えない・描き直さない)', async () => {
    const s = mkSync({ pins: base() }); const before = s._ob.pins;
    s.gate.next = base();
    await s.api._obSyncPins();
    assert.equal(s._ob.pins, before); assert.deepEqual(s.log, ['load']);
});
test('反映: 手が空いていれば自動で反映 — 駒を差し替え・だれが何をしたかの知らせ・置かれた駒を光らせる・描き直す', async () => {
    const s = mkSync({ pins: base() });
    s.gate.next = other();
    await s.api._obSyncPins();
    assert.equal(s._ob.pins, s.gate.next, '駒を差し替えていない');
    assert.deepEqual(s.log, ['load', 'render']);
    assert.equal(s._ob.syncNote.changes.length, 2); assert.deepEqual([...s._ob.flash], [9], '置かれた駒だけを光らせる (外れた駒は無い)');
    const h = s.api._obSyncHtml();
    assert.ok(h.includes('ob-sync done') && h.includes('✓ ほかの運営の変更 2 件を反映しました'), '反映の知らせが無い');
    assert.ok(h.includes('<li>さくら が A 朝 · B3 に おはぎ 鉄甲 30.0B を置いた</li>') && h.includes('<li>さくら が A 朝 · B3 の おはぎ 鉄甲 24.1B を外した</li>'), `だれが・何を が違う: ${h}`);
    s.api._obSyncDismiss();
    assert.ok(s.el.innerHTML.includes('ob-sync idle') && s.el.innerHTML.includes('ほかの運営の駒を自動で反映する'), '閉じたあとにスイッチだけ残っていない');
});
test('反映: ピースを選んでいる間は知らせるだけ (駒は差し替えない・盤は描き直さない) → 手が空いたら次の見回りで自動 / 相手が元に戻したら知らせを消す', async () => {
    const s = mkSync({ pins: base(), sel: '1:fire:1', plans: new Map([[0, { fromDecided: null }]]) }); const before = s._ob.pins;
    s.gate.next = other();
    await s.api._obSyncPins();
    assert.equal(s._ob.pins, before, '選んでいる最中に駒を差し替えた'); assert.deepEqual(s.log, ['load'], '選んでいる最中に盤を描き直した');
    assert.ok(s.el.innerHTML.includes('ob-sync pend') && s.el.innerHTML.includes('🔄 ほかの運営の変更が 2 件あります') && s.el.innerHTML.includes('onclick="_obSyncNow()"'), '知らせのバーが無い');
    assert.ok(s.el.innerHTML.includes('この端末で 🧮 した結果のうち'), '🧮 した結果が組み直しになり得ると言っていない');
    s.gate.next = base();
    await s.api._obSyncPins();
    assert.equal(s._ob.syncPending, null); assert.ok(s.el.innerHTML.includes('ob-sync idle'), '元に戻ったのに知らせが残った');
    s.gate.next = other(); s._ob.sel = null;
    await s.api._obSyncPins();
    assert.equal(s._ob.pins, s.gate.next); assert.equal(s._ob.syncPending, null);
});
test('反映: 自動 OFF は知らせるだけ — 「反映する」は押した時点の DB を読み直して合わせる・握っていたピースは外す / ON に戻すと待っていた分を反映', async () => {
    const s = mkSync({ pins: base(), auto: false });
    s.gate.next = other();
    await s.api._obSyncPins();
    assert.ok(s._ob.syncPending && s._ob.pins !== s.gate.next, '自動 OFF なのに反映した');
    const later = [...other(), pin(10, { player_id: 1, boss_number: 4, pinned_by: 'さくら' })];
    s.gate.next = later; s._ob.sel = '1:fire:1';
    await s.api._obSyncNow();
    assert.equal(s._ob.pins, later, '知らせたときの古い行で合わせた'); assert.equal(s._ob.sel, null); assert.equal(s._ob.syncNote.changes.length, 3);
    assert.equal(s.log.filter(x => x === 'render').length, 1);
    const t = mkSync({ pins: base(), auto: false });
    t.gate.next = other();
    await t.api._obSyncPins();
    t.api._obSetSyncAuto(true);
    assert.equal(t.store.has('shirisuko_ob_sync_auto_v1'), false); assert.equal(t._ob.pins, t.gate.next, 'ON に戻しても待っていた分を反映しない');
    t.api._obSetSyncAuto(false);
    assert.equal(t.store.get('shirisuko_ob_sync_auto_v1'), '0'); assert.equal(t.api._obSyncAuto(), false);
});
test('反映: 読んでいる間にこの端末が駒を書き換えた / 処理中になった / シーズンが変わった → 古い読み取りを捨てる (自分で置いた駒が消えない)', async () => {
    for (const mutate of [(o) => { o.pins = [...o.pins, pin(50)]; }, (o) => { o.busy = true; }, (o) => { o.epoch++; }]) {
        const s = mkSync({ pins: base() });
        let open; s.gate.hold = new Promise(r => { open = r; }); s.gate.next = other();
        const p = s.api._obSyncPins();
        await Promise.resolve();
        mutate(s._ob);
        const mine = s._ob.pins;
        open(); await p;
        assert.equal(s._ob.pins, mine, '古い読み取りで駒を上書きした'); assert.equal(s._ob.syncPending, null); assert.equal(s._ob.syncNote, null);
        assert.ok(!s.log.includes('render'));
    }
});
test('反映: 見えていない・運営モードでない・処理中・駒を読めていない・読み取りの最中 は通信しない / 読めなかったら何も変えない', async () => {
    for (const o of [{ visible: false }, { opsMode: false }]) { const s = mkSync({ pins: base(), ...o }); s.gate.next = other(); await s.api._obSyncPins(); assert.deepEqual(s.log, [], JSON.stringify(o)); }
    for (const set of [(o) => { o.busy = true; }, (o) => { o.pins = null; }, (o) => { o.pinsErr = '読めない'; }, (o) => { o.syncing = true; }, (o) => { o.pinsSeason = 2; }]) {
        const s = mkSync({ pins: base() }); set(s._ob); s.gate.next = other(); await s.api._obSyncPins(); assert.deepEqual(s.log, []);
    }
    const s = mkSync({ pins: base() }); const before = s._ob.pins;
    s.gate.next = new Error('通信');
    await s.api._obSyncPins();
    assert.equal(s._ob.pins, before); assert.equal(s._ob.syncing, false, '失敗のあと読み取り中のまま固まった');
    s.gate.next = null;
    await s.api._obSyncNow();
    assert.equal(s._ob.pins, before); assert.ok(s.log.some(x => x.startsWith('note:⚠️')), '「反映する」が読めなかったことを言わない');
});
test('反映: ✓ で実行済みになっただけ (駒の出入りなし) は言わずに合わせる — 選んでいる間は待つ', async () => {
    const done = () => [pin(1), { ...pin(2, { boss_number: 3, player_id: 2 }), status: 'released', release_reason: 'fulfilled' }];
    const s = mkSync({ pins: base() });
    s.gate.next = done();
    await s.api._obSyncPins();
    assert.equal(s._ob.pins, s.gate.next); assert.equal(s._ob.syncNote, null, '✓ を「外した」と知らせた'); assert.deepEqual(s.log, ['load', 'render']);
    const t = mkSync({ pins: base(), sel: '1:fire:1' }); const before = t._ob.pins;
    t.gate.next = done();
    await t.api._obSyncPins();
    assert.equal(t._ob.pins, before); assert.equal(t._ob.syncPending, null); assert.deepEqual(t.log, ['load']);
});

// ============================== 配線 ==============================
test('配線: 盤の下にガイド・先頭に知らせの置き場 / 置ける行に「置くと」/ 見回りが 10 秒ごとに確かめる / シーズンが変わったら捨てる / ポインタは PC だけ', () => {
    const r = between('        function renderOpsBuild() {', '        function _obGuideKey(ctx) {');
    assert.ok(r.includes('<div class="ob-main"><div class="ob-board">${rows}</div><div class="ob-guide" id="obGuide">${_obGuideHtml(ctx, _obGuideKey(ctx))}</div></div>'), 'ガイドが盤の下 (左の列) に無い — ピース置き場の中に置くと、乗せるたびにピースが動く');
    assert.ok(r.includes('<div id="obSync">${_obSyncHtml()}</div>'), '知らせの置き場が無い');
    assert.ok(/_ob\.ctxLast = ctx;/.test(r) && /if \(_ob\.hover && !host\.querySelector\('\[data-ob-piece\]:hover'\)\) _ob\.hover = null;/.test(r), 'ガイドの材料・離れたポインタの片付けが無い');
    assert.ok(/const ifB = \(can === true && !r\.infinite\) \? r\.remB - sel\.dmgB : null;/.test(r) && r.includes('<span class="hp">${hp}</span>${ifTxt}</div>'), '置ける行に「置くと」が無い');
    assert.ok(/_ob\.syncPending = null; _ob\.syncNote = null; _ob\.flash = null; _ob\.hover = null;/.test(r), 'シーズンが変わっても前の知らせを持ち越す');
    const poll = between('        function _startCoordPolling() {', '        function _stopCoordPolling() {');
    assert.ok(/if \(_opsMode && document\.getElementById\('tab-ops'\)\?\.classList\.contains\('active'\) && typeof _obSyncPins === 'function'\) _obSyncPins\(\)\.catch\(/.test(poll), '見回りが確かめていない');
    assert.ok(!/_coordPollTick === \d[^\n]*_obSyncPins/.test(poll), '10 秒ごとでなく 30 秒ごとになっている');
    const del = between('        function _obDelegate(host) {', '        function _obSelect(key) {');
    assert.ok(/if \(window\.matchMedia && window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)\.matches\) \{\s*\n\s*host\.addEventListener\('mouseover'/.test(del), 'タッチの端末でもポインタの処理を付けている');
    assert.ok(/host\.addEventListener\('mouseover', \(e\) => \{ const pc = e\.target\.closest\('\[data-ob-piece\]'\); if \(!pc \|\| _ob\.hover === pc\.dataset\.obPiece\) return; _ob\.hover = pc\.dataset\.obPiece; _obGuidePaint\(\); \}\);/.test(del), '乗せるたびに盤ごと描き直している');
    const sync = SYNC_SRC;
    assert.ok(/if \(!Array\.isArray\(rows\) \|\| !_obSame\(epoch, sid\) \|\| _ob\.busy \|\| _ob\.pins !== before\) return;/.test(sync), '読み取りの追い越しを見ていない');
    assert.ok(/bb\.pinChanges\(_obFpRows\(before\), _obFpRows\(rows\), blocks,/.test(sync), '✓ で実行済みの駒を実行前に戻さずに比べている');
});

for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 6).join('\n     ')}`); }
}
console.log(`\n${failed ? 'NG' : 'OK'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
