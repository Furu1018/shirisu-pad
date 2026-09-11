// ============================================================================
// ホームの一目 (2026-09-11 ユーザー要望) の実行テスト
//   横画面のボス状況カード (renderMyBossBoard) / 状態ボタンの人数 + タイル (_refreshMyStatusSwitcher) /
//   HP更新の鮮度ピル (_hpFreshHtml)
//   node tests/home-glance.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// 判定は js/domain/attributes.js (homeBossBoard / homeStatusCounts) と opsLayout.js (hpFreshnessMin) の本物。
// テンプレートリテラルの未定義参照は実行しないと出ない (2026-09-07 の本番障害と同じ型)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import '../js/domain/attributes.js';   // globalThis.homeBossBoard / homeStatusCounts
import '../js/domain/opsLayout.js';    // globalThis.opsLayoutDomain

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
    cut('        function _hpFreshHtml(bosses)'),
    cut('        function renderMyBossBoard(identity)'),
    cut('        function _refreshMyStatusSwitcher(identity)'),
].join('\n');

const ATTR_VISUAL = {
    fire: { color: '#FF3D44', name: '灼熱', icon: './属性アイコン/灼熱.png' },
    water: { color: '#2E8BFF', name: '水冷', icon: './属性アイコン/水冷.png' },
    electric: { color: '#9B4DFF', name: '電撃', icon: './属性アイコン/電撃.png' },
    iron: { color: '#FF8A2B', name: '鉄甲', icon: './属性アイコン/鉄甲.png' },
    wind: { color: '#18C26B', name: '風圧', icon: './属性アイコン/風圧.png' },
};
const mkClassList = () => { const s = new Set(); return { toggle: (c, on) => { if (on === undefined) on = !s.has(c); if (on) s.add(c); else s.delete(c); return on; }, contains: (c) => s.has(c), add: (c) => s.add(c), remove: (c) => s.delete(c), has: s }; };
const mkEl = () => ({ innerHTML: '', textContent: '', style: {}, classList: mkClassList() });

function run({ season, bosses = [], coords = [], self = null } = {}) {
    const els = {
        myBossBoard: mkEl(), myBossBoardMeta: mkEl(), myBossBoardCard: mkEl(),
        mypageStatusTiles: mkEl(), mypageStatusHint: mkEl(),
        mypageBattleLive: mkEl(), mypageBattleGate: mkEl(), mypageBattleExpanded: mkEl(),
    };
    const buttons = ['available', 'practicing', 'coordinating'].map(st => {
        const cnt = mkEl();
        return { dataset: { status: st, color: '#123456' }, style: {}, cnt, querySelector: (sel) => sel === '.dc-status-cnt' ? cnt : null };
    });
    const env = {
        document: {
            getElementById: (id) => els[id] || null,
            querySelectorAll: (sel) => sel === '#mypageStatusSwitcher button.dc-status-btn' ? buttons : [],
        },
        seasonStore: { get: () => (season ? { season, bosses } : null) },
        window: { opsLayoutDomain: globalThis.opsLayoutDomain },
        homeBossBoard: globalThis.homeBossBoard,
        homeStatusCounts: globalThis.homeStatusCounts,
        _coordActiveCache: coords,
        _coordSelfCache: self,
        ATTR_VISUAL,
        escapeHtml: (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        console,
    };
    const keys = Object.keys(env);
    const api = new Function(...keys, `${SRC}\nreturn { renderMyBossBoard, _refreshMyStatusSwitcher, _hpFreshHtml };`)(...keys.map(k => env[k]));
    return { ...api, els, buttons };
}
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const season = { id: 45, current_level: 2, hard_date: '2026-09-11' };
const bosses = [
    { boss_number: 3, attribute: 'iron', name: 'テストボス3', remaining_hp_raw: 75.5e9, total_hp_raw: 150.84e9, updated_at: ago(3) },
    { boss_number: 1, attribute: 'fire', name: '<b>x', remaining_hp_raw: 0, total_hp_raw: 99.86e9, updated_at: ago(3) },
    { boss_number: 2, attribute: 'water', name: 'テストボス2', remaining_hp_raw: null, total_hp_raw: 99.86e9, updated_at: ago(3) },
    { boss_number: 4, attribute: 'electric', name: 'テストボス4', remaining_hp_raw: 99.86e9, total_hp_raw: 99.86e9, updated_at: ago(3) },
    { boss_number: 5, attribute: 'wind', name: 'テストボス5', remaining_hp_raw: 150.84e9, total_hp_raw: 150.84e9, updated_at: ago(3) },
];
const coords = [
    { player_id: 1, name: 'A', status: 'available' },
    { player_id: 2, name: 'B<i>', status: 'available' },
    { player_id: 3, name: 'C', status: 'practicing' },
    { player_id: 9, name: 'Me', status: 'coordinating', boss_number: 3 },
    { player_id: 4, name: 'D', status: 'coordinating', boss_number: 3 },
];

let pass = 0, fail = 0;
function test(name, f) {
    try { f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
const noUndef = (out) => assert.ok(!/undefined|NaN|\[object/.test(out), `未定義参照: ${out.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]}`);

console.log('ホームの一目 (ボス状況カード / 状態の人数 / HP鮮度):\n');

test('★ ボス状況カード: 5枚のタイル・残HP%・残/総HP・交戦者の名前・撃破・エスケープ', () => {
    const t = run({ season, bosses, coords });
    t.renderMyBossBoard({ id: 9 });
    const out = t.els.myBossBoard.innerHTML;
    noUndef(out);
    assert.equal((out.match(/<div class="bb/g) || []).length, 5, '5枚出ていない');
    assert.equal(t.els.myBossBoardCard.style.display, '', 'カードを隠している (出す/隠すは CSS の役)');
    // 並びはボス順 (1→5)
    assert.deepEqual([...out.matchAll(/<div class="id">B(\d)<\/div>/g)].map(m => m[1]), ['1', '2', '3', '4', '5']);
    assert.ok(out.includes('<div class="bb done"'), '撃破したボスを沈めていない');
    assert.ok(/class="bb live" style="--bb-c:var\(--attr-iron-solid\);--bb-t:var\(--attr-iron\);"/.test(out), '戦闘中のボスの枠が属性色でない');
    assert.ok(out.includes('<span class="pct">50%</span>'), '残HP% が無い');
    assert.ok(out.includes('75.50 / 150.84 B'), '残/総HP が無い');
    assert.ok(out.includes('⚔ あなた / D'), '交戦者の名前が無い (自分は「あなた」で先頭)');
    assert.ok(out.includes('💀 撃破'), '撃破の表示が無い');
    assert.ok(out.includes('交戦者なし'), '交戦者なしの表示が無い');
    assert.ok(out.includes('<span class="pct">—</span>') && out.includes('HP 未取得'), '残HP不明を 0% や撃破に見せている');
    assert.ok(out.includes('&lt;b&gt;x'), 'ボス名をエスケープしていない');
    assert.ok(out.includes('src="./属性アイコン/鉄甲.png"'), '属性アイコンが無い');
    assert.ok(/<i style="width:50%">/.test(out) && /<i style="width:0%">/.test(out), 'HP バーの幅が違う');
    // 見出し: Lv と HP更新のピル
    const meta = t.els.myBossBoardMeta.innerHTML;
    assert.ok(meta.includes('Lv2') && /class="hp-fresh"[^>]*>HP更新 3分前</.test(meta), `見出しの Lv / 鮮度が無い: ${meta}`);
});

test('★ HP更新の鮮度: 30分以上は warn (⚠️)、読めなければ空', () => {
    const t = run({ season, bosses, coords });
    assert.ok(/^<span class="hp-fresh"[^>]*>HP更新 3分前<\/span>$/.test(t._hpFreshHtml(bosses)));
    const stale = bosses.map(b => ({ ...b, updated_at: ago(45) }));
    assert.ok(/class="hp-fresh warn"[^>]*>HP更新 45分前 ⚠️</.test(t._hpFreshHtml(stale)), '30分以上を警告にしていない');
    assert.ok(/HP更新 2時間前 ⚠️/.test(t._hpFreshHtml(bosses.map(b => ({ ...b, updated_at: ago(150) })))));
    // ★ 境界 (Codex指摘 2026-09-11): 30 分ちょうどで警告、29 分では警告しない (>= を > に変えると落ちる)
    assert.ok(/class="hp-fresh warn"[^>]*>HP更新 30分前 ⚠️</.test(t._hpFreshHtml(bosses.map(b => ({ ...b, updated_at: ago(30) })))), '30分ちょうどで警告していない');
    assert.ok(/class="hp-fresh"[^>]*>HP更新 29分前</.test(t._hpFreshHtml(bosses.map(b => ({ ...b, updated_at: ago(29) })))), '29分で警告している');
    assert.equal(t._hpFreshHtml(bosses.map(b => ({ ...b, updated_at: null }))), '', '読めないのに何か出している');
    assert.equal(t._hpFreshHtml([]), '');
    // ボード側にも warn が伝わる
    const s = run({ season, bosses: stale, coords }); s.renderMyBossBoard({ id: 9 });
    assert.ok(s.els.myBossBoardMeta.innerHTML.includes('hp-fresh warn'), 'カードの見出しに警告が出ない');
});

test('シーズン無し / ボス無し はカードを隠す', () => {
    const a = run({ season: null }); a.renderMyBossBoard({ id: 9 });
    assert.equal(a.els.myBossBoardCard.style.display, 'none');
    const b = run({ season, bosses: [] }); b.renderMyBossBoard({ id: 9 });
    assert.equal(b.els.myBossBoardCard.style.display, 'none');
});

test('★ 状態ボタンの人数 + 横画面のタイル (名前ごと・自分は「あなた」・エスケープ)', () => {
    const t = run({ season, bosses, coords, self: { status: 'coordinating', boss_number: 3 } });
    t._refreshMyStatusSwitcher({ id: 9 });
    const by = Object.fromEntries(t.buttons.map(b => [b.dataset.status, b.cnt]));
    assert.equal(by.available.textContent, '2'); assert.ok(by.available.classList.contains('on'));
    assert.equal(by.practicing.textContent, '1');
    assert.equal(by.coordinating.textContent, '2');
    const tiles = t.els.mypageStatusTiles.innerHTML;
    noUndef(tiles);
    assert.equal((tiles.match(/<div class="st /g) || []).length, 3, 'タイルが3枚でない');
    assert.ok(/class="st available on"[\s\S]*?<div class="v">2<\/div><div class="n">A \/ B&lt;i&gt;<\/div>/.test(tiles), 'オンラインの人数・名前 (エスケープ) が違う');
    assert.ok(/class="st coordinating on"[\s\S]*?<div class="n">あなた \/ D<\/div>/.test(tiles), '戦闘中に自分が「あなた」で先頭に出ていない');
    assert.ok(tiles.includes('title="オンライン: A / B&lt;i&gt;"'), 'title もエスケープする');
    // 自分の状態の見た目 (既存の役目) も壊れていない
    const meBtn = t.buttons.find(b => b.dataset.status === 'coordinating');
    assert.equal(meBtn.style.color, '#123456', '自分の状態のボタンが点いていない');
    assert.equal(t.els.mypageStatusHint.textContent, '🛡 B3 テストボス3 に挑戦中');
});

test('誰もいなければ数字は消え、タイルは「—」', () => {
    const t = run({ season, bosses, coords: [] });
    t._refreshMyStatusSwitcher({ id: 9 });
    for (const b of t.buttons) { assert.equal(b.cnt.textContent, ''); assert.ok(!b.cnt.classList.contains('on')); }
    const tiles = t.els.mypageStatusTiles.innerHTML;
    assert.equal((tiles.match(/<div class="v">0<\/div>/g) || []).length, 3);
    assert.equal((tiles.match(/<div class="n">—<\/div>/g) || []).length, 3);
    assert.ok(!/class="st [a-z]+ on"/.test(tiles), '0人のタイルが点いている');
});

// ===== 次の凸 (ボスタイル): 待っている間の名乗り直し / 読み込み失敗 (Codex指摘 2026-09-11) =====
const SRC2 = cut('        async function renderMyNextAttackBosses(identity)');
function run2({ current, loader }) {
    const el = mkEl();
    const warns = [];
    const env = {
        document: { getElementById: (id) => (id === 'mypageNextAttackBosses' ? el : null) },
        getCurrentIdentity: () => current.value,
        ensureActiveSeasonLoaded: loader,
        console: { warn: (...a) => warns.push(a.join(' ')), log: () => {}, error: () => {} },
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, `${SRC2}\nreturn renderMyNextAttackBosses;`)(...keys.map(k => env[k]));
    return { fn, el, warns };
}
async function testAsync(name, f) {
    try { await f(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.constructor.name}: ${e.message}`); fail++; }
}
await testAsync('★ 次の凸: 待っている間に名乗り直したら DOM を書かない / 読み込み失敗は中で受けて reject しない', async () => {
    // 待っている間に別人へ → 何も書かない
    const cur = { value: { id: 9 } };
    const a = run2({ current: cur, loader: async () => { cur.value = { id: 10 }; return { season: null }; } });
    await a.fn({ id: 9 });
    assert.equal(a.el.innerHTML, '', '前の人のまま描いている');
    // 同じ人のまま → 描く (ガードが厳しすぎない)
    const cur2 = { value: { id: 9 } };
    const b = run2({ current: cur2, loader: async () => ({ season: null }) });
    await b.fn({ id: 9 });
    assert.ok(b.el.innerHTML.includes('アクティブシーズン無し'), '同じ人なのに描かない');
    // 読み込みが失敗しても reject しない (呼び出し側は await しない)
    const c = run2({ current: { value: { id: 9 } }, loader: async () => { throw new Error('boom'); } });
    let rejected = false;
    await c.fn({ id: 9 }).catch(() => { rejected = true; });
    assert.equal(rejected, false, '失敗が外へ漏れている (未処理 Promise になる)');
    assert.equal(c.warns.length, 1, '失敗を黙って捨てている'); assert.ok(c.warns[0].includes('boom'));
    assert.equal(c.el.innerHTML, '');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
