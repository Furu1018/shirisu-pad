// ============================================================================
// 編成編集モーダルのタイルピッカー (renderTeamEditPicker ほか) の実行テスト
//   node tests/team-picker.mjs
// ----------------------------------------------------------------------------
// index.html から「タイルピッカー」ブロックを切り出し、依存をスタブして**実際に動かす**。
// UIテストが無いリポジトリなので、この画面だけは実行経路のバグが出やすい:
//   - 値の保持先は #myTeamEditFields の5つの input のまま。ピッカーはそこへ書くだけ。
//     この契約が崩れると、保存・OCR・人気編成の適用がまとめて壊れる
//   - const/let の TDZ (2026-08-08 に openPlanHpModal で実際に踏んだ)
//   - 上位10体の折りたたみ・5人そろったら自動で畳む、の状態遷移
// index.html 側の関数や依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const START = '        // ===== 編成編集モーダルのタイルピッカー';
const END = '        function renderTeamEditChainRow() {';
const i = html.indexOf(START), j = html.indexOf(END);
if (i < 0 || j < 0 || j <= i) {
    console.error('NG: ピッカーのブロックを index.html から切り出せませんでした (目印が変わった?)');
    process.exit(2);
}
const src = html.slice(i, j);

// ---- 最小 DOM スタブ ----
// querySelector/querySelectorAll と innerHTML/hidden/textContent/value だけ持つ簡易実装。
// 実 DOM は使わないので、生成された HTML 文字列を検査して振る舞いを確かめる
const nodes = new Map();
function mkNode(id) {
    const n = {
        id, _html: '', hidden: false, textContent: '', value: '', style: {}, _listeners: [],
        addEventListener(type, fn) { this._listeners.push({ type, fn }); },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); },
    };
    nodes.set(id, n);
    return n;
}
['teSlots', 'teGrid', 'teMore', 'teFilters', 'teArmedName', 'tePickBody', 'tePickCnt',
 'tePickArw', 'teTopArw', 'myTeamEditTopTeams', 'myTeamEditFields', 'teManualArw', 'teSearch'].forEach(mkNode);

// 5つの入力欄 = 値の保持先
const inputs = Array.from({ length: 5 }, (_, k) => ({ value: '', dataset: { teamIdx: String(k) } }));

globalThis.document = {
    getElementById: (id) => nodes.get(id) || null,
    querySelectorAll: (sel) => {
        if (sel === '#myTeamEditFields input[data-team-idx]') return inputs;
        return [];
    },
    querySelector: (sel) => {
        const m = /#myTeamEditFields input\[data-team-idx="(\d)"\]/.exec(sel);
        if (m) return inputs[Number(m[1])] || null;
        return null;
    },
};

globalThis.escapeHtml = (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// キャラマスタ (バースト内訳を作って絞り込みを確かめられるようにする)
const MASTER = [
    { canonical_name: 'アニス:スター', burst: 'B1', burst_alt: null, icon_paths: ['./character-images/a.webp'] },
    { canonical_name: 'リトルマーメイド', burst: 'B1', burst_alt: null, icon_paths: ['./character-images/b.webp'] },
    { canonical_name: 'モラン', burst: 'B1', burst_alt: null, icon_paths: ['./character-images/c.webp'] },
    { canonical_name: 'クラウン', burst: 'B2', burst_alt: null, icon_paths: ['./character-images/d.webp'] },
    { canonical_name: 'ナユタ', burst: 'B2', burst_alt: null, icon_paths: ['./character-images/e.webp'] },
    { canonical_name: 'リバーレリオ', burst: 'B3', burst_alt: null, icon_paths: ['./character-images/f.webp'] },
    { canonical_name: '紅蓮：ブラックシャドウ', burst: 'B3', burst_alt: null, icon_paths: ['./character-images/g.webp'] },
    { canonical_name: 'ベルベット', burst: 'B2', burst_alt: null, icon_paths: ['./character-images/h.webp'] },
    { canonical_name: 'ラピ:レッドフード', burst: 'B3', burst_alt: 'B1', icon_paths: ['./character-images/i.webp'] },
    { canonical_name: 'アイコン無し子', burst: 'B3', burst_alt: null, icon_paths: [] },
    // ★ 注入を試す名前。キャラ名は OCR 由来の外部入力なので、記号が入りうる前提で扱う
    { canonical_name: `危険'); alert(1); ('<img src=x onerror=alert(2)>`, burst: 'B1', burst_alt: null, icon_paths: [] },
];
for (let k = 0; k < 14; k++) {
    MASTER.push({ canonical_name: `その他${k}`, burst: ['B1', 'B2', 'B3'][k % 3], burst_alt: null, icon_paths: [`./character-images/x${k}.webp`] });
}
globalThis._nikkeCharsCache = MASTER;
globalThis._nikkeCharsByName = new Map(MASTER.map(c => [c.canonical_name, c]));
globalThis.resolveNikkeChar = (input) => {
    if (typeof input !== 'string' || !input.trim()) return null;
    const hit = globalThis._nikkeCharsByName.get(input.trim());
    return { canonical: hit?.canonical_name || input.trim(), iconPath: hit?.icon_paths?.[0] || null, raw: input };
};
globalThis.fuzzyResolveCharacter = (n) => (globalThis._nikkeCharsByName.has(n) ? n : n);
globalThis._myTeamEditAttr = 'wind';
globalThis._teamSubsCache = [
    { player_id: 1, attribute: 'wind', characters: ['紅蓮：ブラックシャドウ', 'リバーレリオ', 'ナユタ', 'リトルマーメイド', 'ベルベット'] },
    { player_id: 2, attribute: 'wind', characters: ['紅蓮：ブラックシャドウ', 'リバーレリオ', 'ナユタ', 'リトルマーメイド', 'モラン'] },
    { player_id: 3, attribute: 'wind', characters: ['紅蓮：ブラックシャドウ', 'クラウン', 'アニス:スター', 'モラン', 'ラピ:レッドフード'] },
    { player_id: 4, attribute: 'fire', characters: ['クラウン', 'クラウン', 'クラウン', 'クラウン', 'クラウン'] },
];
// updateMyTeamEditIcon は本体では「アイコン + チェーン + ピッカー」を描き直す。
// ここでは再描画だけを再現する (無限ループしないことの確認も兼ねる)
let iconCalls = 0;
globalThis.updateMyTeamEditIcon = function (idx) {
    iconCalls++;
    if (iconCalls > 200) throw new Error('updateMyTeamEditIcon が過剰に呼ばれています (再帰の疑い)');
    renderTeamEditPicker();
};

// ---- 切り出したブロックを評価 ----
let renderTeamEditPicker, renderTeamEditGrid, tePick, teArmSlot, teClearSlot, teSetFilter,
    onTeamEditSearch, toggleTeamEditGridMore, toggleTeamEditPicker, _teBuildUsage, _teNames;
try {
    const factory = new Function(`${src}
        return { renderTeamEditPicker, renderTeamEditGrid, tePick, teArmSlot, teClearSlot, teSetFilter,
                 onTeamEditSearch, toggleTeamEditGridMore, toggleTeamEditPicker, _teBuildUsage, _teNames,
                 getArmed: () => _teArmed,
                 setOther: (v) => { _myTeamEditOtherTeam = v; },
                 resetState: () => { _teArmed = 0; _teFilter = 'all'; _teQuery = '';
                     _teExpanded = false; _tePickManual = false; _teLastFull = false; } };`);
    const api = factory();
    ({ renderTeamEditPicker, renderTeamEditGrid, tePick, teArmSlot, teClearSlot, teSetFilter,
       onTeamEditSearch, toggleTeamEditGridMore, toggleTeamEditPicker, _teBuildUsage, _teNames } = api);
    globalThis.__api = api;
} catch (e) {
    console.error('NG: ピッカーのブロックを評価できませんでした:', e.message);
    process.exit(1);
}

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}`); console.error(`     ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const gridNames = () => [...nodes.get('teGrid')._html.matchAll(/class="te-cap">([^<]*)</g)].map(m => m[1]);
const slotCaps = () => [...nodes.get('teSlots')._html.matchAll(/class="te-cap">([^<]*)</g)].map(m => m[1]);
// ★ ピッカーの状態はモジュールに残るので、テストごとに開いた直後の状態へ戻す
//   (戻さないと前のテストの選択枠・絞り込みを引き継いでテストが順序依存になる)
const reset = () => {
    inputs.forEach(i => { i.value = ''; });
    iconCalls = 0;
    globalThis.__api.setOther([]);
    globalThis.__api.resetState();
};

console.log('teamPicker:');

test('空の編成でも描画でき、5枠ぶんのプレースホルダが出る', () => {
    reset();
    _teBuildUsage();
    renderTeamEditPicker();
    assert(slotCaps().length === 5, `5枠のはず: ${slotCaps().length}`);
    assert(slotCaps().join(',') === 'B1,B2,B3,自由,自由', `枠の見出しがおかしい: ${slotCaps()}`);
});

test('選択中の枠に入り、次の空き枠へ進む (枠を決めてから選ぶ方式)', () => {
    // B1/B2/B3 の見出しは「バーストチェーンの目安」であって固定枠ではない。
    // 選択中の枠があればそこに入れる = ユーザーの意図を優先する
    reset(); renderTeamEditPicker();
    tePick('アニス:スター');     // 枠0 が選択中
    assert(inputs[0].value === 'アニス:スター', `枠0に入るはず: ${JSON.stringify(inputs.map(i => i.value))}`);
    tePick('ナユタ');            // 自動で枠1へ進んでいる
    assert(inputs[1].value === 'ナユタ', '次の空き枠へ進むはず');
    tePick('リバーレリオ');
    assert(inputs[2].value === 'リバーレリオ', 'さらに次の空き枠へ');
});

test('枠が未選択のときはバーストの合う空き枠へ入る', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');          // 枠の選択を外す (_teArmed = null)
    assert(globalThis.__api.getArmed() === null, '枠が未選択になること');
    tePick('ナユタ');            // B2 → B2の枠(1)へ
    assert(inputs[1].value === 'ナユタ', `B2枠に入るはず: ${JSON.stringify(inputs.map(i => i.value))}`);
    teSetFilter('all');
    tePick('リバーレリオ');      // B3 → 枠2へ
    assert(inputs[2].value === 'リバーレリオ', 'B3枠に入るはず');
});

test('同じキャラをもう一度押すと外れる', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');                    // 枠の選択を外してバースト任せで入れる
    tePick('ナユタ');
    assert(inputs[1].value === 'ナユタ', `先に入ること: ${JSON.stringify(inputs.map(i => i.value))}`);
    tePick('ナユタ');
    assert(inputs[1].value === '', `外れるはず: ${inputs[1].value}`);
});

test('枠を選ぶとその枠のバーストだけに絞られる', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');                 // いったん枠の選択を外す (同じ枠を押すと解除されるため)
    teArmSlot(0);                       // B1 の枠
    const names = gridNames();
    assert(names.includes('アニス:スター'), 'B1のキャラが出るはず');
    assert(!names.includes('ナユタ'), `B2のキャラは出ないはず: ${names}`);
    assert(nodes.get('teFilters')._html.includes('B1だけ表示中'), '絞り込み中の表示が要る');
});

test('burst_alt を持つキャラは両方の枠で出る (ラピ:レッドフード = B3/B1)', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');
    teArmSlot(0);   // B1
    assert(gridNames().includes('ラピ:レッドフード'), 'B1枠でも出るはず');
    teArmSlot(2);   // B3
    assert(gridNames().includes('ラピ:レッドフード'), 'B3枠でも出るはず');
});

test('グリッドは上位10体まで + 残りは折りたたみ', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');
    assert(gridNames().length === 10, `10体のはず: ${gridNames().length}`);
    assert(nodes.get('teMore').textContent.startsWith('▼ 残り'), `折りたたみボタンが要る: ${nodes.get('teMore').textContent}`);
    toggleTeamEditGridMore();
    assert(gridNames().length === MASTER.length, `全件のはず: ${gridNames().length}`);
    toggleTeamEditGridMore();
    assert(gridNames().length === 10, '畳み直せるはず');
});

test('検索中は折りたたみを外して全件出す', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');
    onTeamEditSearch('その他');
    assert(gridNames().length === 14, `その他14体が全部出るはず: ${gridNames().length}`);
    assert(nodes.get('teMore').style.display === 'none', '検索中は折りたたみボタンを出さない');
    onTeamEditSearch('');
});

test('上位10体は「まだ選んでいないキャラ」で数える', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all');
    tePick('紅蓮：ブラックシャドウ'); tePick('リバーレリオ'); tePick('ナユタ');
    teSetFilter('all');   // 枠の絞り込みを外す
    const shown = gridNames();
    const unpicked = shown.filter(n => !['紅蓮：ブラックシャドウ', 'リバーレリオ', 'ナユタ'].includes(n));
    assert(unpicked.length === 10, `未選択が10体出るはず: ${unpicked.length} (全${shown.length})`);
});

test('5人そろうとキャラ選択が自動で畳まれ、1人外すと開く', () => {
    reset(); renderTeamEditPicker();
    assert(nodes.get('tePickBody').hidden === false, '最初は開いている');
    ['アニス:スター', 'ナユタ', 'リバーレリオ', 'モラン', 'クラウン'].forEach(tePick);
    assert(_teNames().filter(Boolean).length === 5, '5人入るはず');
    assert(nodes.get('tePickBody').hidden === true, '5人そろったら畳むはず');
    assert(nodes.get('tePickCnt').textContent === '5人そろいました', `見出しの表示: ${nodes.get('tePickCnt').textContent}`);
    teClearSlot(0);
    assert(nodes.get('tePickBody').hidden === false, '1人外したら開くはず');
    assert(nodes.get('tePickCnt').textContent === '残り1人', `見出しの表示: ${nodes.get('tePickCnt').textContent}`);
});

test('手で開閉したら、人数が変わるまで自動制御を止める', () => {
    reset(); renderTeamEditPicker();
    ['アニス:スター', 'ナユタ', 'リバーレリオ', 'モラン', 'クラウン'].forEach(tePick);
    assert(nodes.get('tePickBody').hidden === true, '5人で畳まれる');
    toggleTeamEditPicker();                       // 手で開く
    assert(nodes.get('tePickBody').hidden === false, '手で開ける');
    renderTeamEditPicker();                       // 再描画しても勝手に閉じない
    assert(nodes.get('tePickBody').hidden === false, '手で開けた状態が保たれるはず');
});

test('もう一方の編成で使っているキャラに被りマークが付く', () => {
    reset();
    globalThis.__api.setOther(['紅蓮：ブラックシャドウ']);
    renderTeamEditPicker();
    teSetFilter('all'); toggleTeamEditGridMore();
    const html = nodes.get('teGrid')._html;
    const m = /<button[^>]*class="te-tile[^"]*dup[^"]*"[^>]*title="([^"]*)"/.exec(html);
    assert(m, '被りマークのタイルが要る');
    assert(m[1].includes('紅蓮'), `被り対象がおかしい: ${m[1]}`);
    toggleTeamEditGridMore();
});

test('単独採用率が高い順に並び、％がタイルに出る', () => {
    reset(); _teBuildUsage(); renderTeamEditPicker();
    teSetFilter('all');
    const first = gridNames()[0];
    assert(first === '紅蓮：ブラックシャドウ', `採用率トップが先頭のはず: ${first}`);
    assert(/100%/.test(nodes.get('teGrid')._html), '採用率がタイルに出るはず');
});

test('アイコンが無いキャラもタイルに出る (頭文字で代替)', () => {
    reset(); renderTeamEditPicker();
    teSetFilter('all'); toggleTeamEditGridMore();
    assert(gridNames().includes('アイコン無し子'), 'アイコン無しでも選べるはず');
    toggleTeamEditGridMore();
});

test('キャラ名を onclick に文字列で埋めない (属性内JSへの注入を塞ぐ)', () => {
    // escapeHtml した &#39; は HTMLパース時に ' に戻るため、onclick の中では
    // エスケープが効かない。data 属性 + 委譲リスナーで受けること
    reset(); renderTeamEditPicker();
    teSetFilter('all'); toggleTeamEditGridMore();
    const html = nodes.get('teGrid')._html;
    assert(!/onclick=/.test(html), `グリッドに onclick を出さないこと: ${(/onclick="[^"]*"/.exec(html) || [])[0]}`);
    assert(/data-te-pick="/.test(html), 'data-te-pick で受けること');
    // 危険な名前が属性値の外へ出ていないか (生の ' " < > が属性値に残っていない)
    const attrs = [...html.matchAll(/data-te-pick="([^"]*)"/g)].map(m => m[1]);
    const bad = attrs.find(a => /[<>"]/.test(a) || /(^|[^&#\d])'/.test(a));
    assert(!bad, `属性値にエスケープ漏れ: ${bad}`);
    assert(attrs.some(a => a.includes('&#39;')), '危険な名前がエスケープされて入っていること');
    // 生のままの危険な断片が出力に現れないこと (エスケープされていれば ' は &#39; になる)
    assert(!html.includes(`'); alert(1);`), '生の引用符が出力に残っている');
    assert(!html.includes('<img src=x'), '名前が img タグとして出力されている');
    toggleTeamEditGridMore();
});

test('値の保持先は input のまま (ピッカーは input に書くだけ)', () => {
    reset(); renderTeamEditPicker();
    tePick('ナユタ');                       // 枠0 が選択中なので枠0へ
    assert(inputs[0].value === 'ナユタ', `input に書かれること: ${JSON.stringify(inputs.map(i => i.value))}`);
    inputs[3].value = '手入力キャラ';       // 手入力の値も拾えること
    renderTeamEditPicker();
    assert(slotCaps()[3] === '手入力キャラ', `手入力もタイルに反映されるはず: ${slotCaps()[3]}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
