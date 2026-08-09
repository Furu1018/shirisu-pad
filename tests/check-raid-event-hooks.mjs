// ============================================================================
// 戦況の通知フックの網羅チェック
//   node tests/check-raid-event-hooks.mjs
// ----------------------------------------------------------------------------
// ボスの残HPを動かす呼び出しの「同じ関数の中」に `_checkRaidEvents()` の
// **実呼び出し**があることを確認する。
//
// なぜ要るか:
//   撃破/レベル開放の検知は「盤面の差分」を見るが、比較元は invalidate 前のキャッシュ。
//   HPを動かす経路にフックを足し忘れると、その操作で倒れた場合に通知を落とす。
//   2026-08-09 のレビューで **6回の指摘を経てようやく全経路が埋まった** (凸報告 →
//   凸ダメージ編集 → 一括保存 → 代理凸 → 運営側の編集/削除 → ボス概要編集)。
//
// ★ 初版は「後続60行に _checkRaidEvents という文字列があるか」で見ていたが、
//   コメント中の文字列や**隣のハンドラのフック**を拾って素通ししていた (Codex指摘)。
//   いまは (1) <script> の中だけを見る (2) 行コメントを落としてから探す
//   (3) 探索範囲を**その呼び出しを含む関数の終わりまで**に限る、で誤検出を潰している。
//
// ⚠ これは**網羅の目安**であって到達保証ではない。
//   静的な文字列解析なので「書き込みが成功したら必ずフックに到達する」ことまでは
//   検証できない (アロー関数の中・catch の中だけのフックなどは通ってしまう)。
//   あくまで「足し忘れ」を機械的に拾うための道具として使うこと。
//
// 新しくHPを動かす経路を足したら、その直後 (invalidate より前) に
// `_checkRaidEvents().catch(...)` を呼ぶこと。
// HPを触らない呼び出しは `skipHpDecrement: true` を付ければ対象外になる。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// --- 検査対象は <script> の中身だけ (HTML本文をJSとして扱うと壊れる) ---
// 行番号を保つため、script 外は空行に置き換える
const rawLines = raw.split('\n');
const inScript = new Array(rawLines.length).fill(false);
{
    let on = false;
    rawLines.forEach((l, i) => {
        if (/<script(\s|>)/.test(l) && !/src=/.test(l)) { on = true; return; }
        if (/<\/script>/.test(l)) { on = false; return; }
        inScript[i] = on;
    });
}

// --- 行コメントを潰す ---
// これをやらないと「// …_checkRaidEvents に一本化…」のような**コメント**が
// フックとして数えられ、実呼び出しを外しても素通りする (Codex指摘)。
// URL の「://」は消さないよう、// の直前が : でない場合だけ落とす
const lines = rawLines.map((l, i) => {
    if (!inScript[i]) return '';
    const m = l.match(/(^|[^:])\/\//);
    if (!m) return l;
    const at = m.index + (m[1] ? m[1].length : 0);
    return l.slice(0, at);
});

// 呼び出しを含む「関数」の範囲を返す。
// ★ 呼び出し行のインデントを基準にすると try / if / for の閉じ括弧で切れてしまう。
//   後ろ向きに `function 名前(` を探して関数の頭を見つけ、
//   そのインデントの `}` までを範囲にする (このコードベースは名前付き関数で統一されている)。
//   範囲を切らないと**隣のハンドラのフック**を自分のものと誤認する (Codex指摘)
const indentOf = (l) => l.length - l.trimStart().length;
function functionRange(callIdx) {
    let head = -1;
    for (let k = callIdx; k >= 0; k--) {
        if (/^\s*(async\s+)?function\s+[\w$]+\s*\(/.test(lines[k])) { head = k; break; }
    }
    if (head < 0) return [callIdx, lines.length];
    const base = indentOf(rawLines[head]);
    for (let k = head + 1; k < lines.length; k++) {
        const t = rawLines[k].trim();
        if (t.startsWith('}') && indentOf(rawLines[k]) === base) return [head, k + 1];
    }
    return [head, lines.length];
}

// 残HPを動かしうる書き込み
const WRITERS = [
    'supabaseUpdateBossHp(',
    'supabaseAddAttack(',
    'supabaseUpdateAttackDamage(',
    'supabaseDeleteAttack(',
];

const problems = [];
let checked = 0, skipped = 0;
lines.forEach((line, i) => {
    if (!line.includes('await') || !WRITERS.some(w => line.includes(w))) return;
    const name = WRITERS.find(w => line.includes(w)).slice(0, -1);
    // HPを触らない呼び出しは対象外 (引数オブジェクトの範囲だけ見る)
    if (/skipHpDecrement:\s*true/.test(lines.slice(i, i + 14).join('\n'))) { skipped++; return; }
    checked++;
    const [, end] = functionRange(i);
    const scope = lines.slice(i, end).join('\n');
    // ★ 「行頭の実文としての呼び出し」だけを認める。
    //   単なる文字列一致だと、コメントやテンプレートリテラル内の
    //   `_checkRaidEvents()` を拾って素通りする (Codex指摘)
    if (!/^\s*_checkRaidEvents\s*\(/m.test(scope)) {
        problems.push(`行${i + 1}: ${name} と同じ関数の中に _checkRaidEvents() の呼び出しがありません`
            + `\n        ${rawLines[i].trim().slice(0, 90)}`);
    }
});

console.log(`HPを動かす呼び出し ${checked} 件 (HP非減算 ${skipped} 件は対象外)`);
// ★ 検査対象が0件でも OK と出てしまうのが初版の失敗モードだった (Codex指摘)。
//   実装が変わって検出できなくなったら、素通りではなく失敗させる
const MIN_EXPECTED = 8;
if (checked < MIN_EXPECTED) {
    console.error(`NG: 検査対象が ${checked} 件しかありません (最低 ${MIN_EXPECTED} 件を想定)`);
    console.error('  → 呼び出しの書き方が変わってチェッカーが検出できなくなった可能性があります。');
    console.error('     WRITERS と検出条件を実装に合わせて直してください');
    process.exit(1);
}
if (problems.length) {
    console.error('NG:');
    problems.forEach(p => console.error(`  ${p}`));
    console.error('\n  → HPを動かしたら、invalidate の前に _checkRaidEvents().catch(...) を呼んでください');
    console.error('     (呼ばないと、その操作で倒れたときに撃破通知を落とします)');
    process.exit(1);
}
// --- js/supabase-client.js の直接HP更新の棚卸し ---
// index.html のフックだけ見ていると、クライアント側で bosses.remaining_hp_raw を
// 直接 update/upsert する関数が増えたことに気づけない。既知のものを列挙しておき、
// 増えたら失敗させて「通知が要るか」を必ず考えさせる。
// ※ シーズン作成時の insert (supabaseCreateSeason の初期HP) は対象外 —
//   新シーズンの初期盤面であり、初回観測は通知しない設計と整合する
const KNOWN_DIRECT_WRITERS = [
    'supabaseAddAttack',            // 凸報告の自動減算 (index.html 側でフック済み)
    'supabaseDeleteAttack',         // 凸削除でHPを戻す (同上)
    'supabaseUpdateAttackDamage',   // 凸ダメージ編集の差分反映 (同上)
    'supabaseUpdateBossHp',         // 運営のHP保存 (同上)
    'supabaseSeedTestMockAttacks',  // ★通知対象外: テストシーズンの初期盤面を作るシード。
                                    //   新シーズンの初回観測は通知しない設計と整合する
];
const client = fs.readFileSync(path.join(ROOT, 'js', 'supabase-client.js'), 'utf8').split('\n');
let curFn = null;
const found = new Set();
client.forEach((l) => {
    const m = l.match(/^window\.(\w+)\s*=\s*(async\s+)?function/);
    if (m) curFn = m[1];
    if (/remaining_hp_raw\s*:/.test(l) && /update|upsert|insert/.test(client.slice(Math.max(0, client.indexOf(l) - 3)).slice(0, 1).join('') + l)) { /* noop */ }
});
// 「.update({ ... remaining_hp_raw ... })」を関数名つきで拾う
curFn = null;
client.forEach((l, i) => {
    const m = l.match(/^window\.(\w+)\s*=\s*(async\s+)?function/);
    if (m) curFn = m[1];
    if (/remaining_hp_raw/.test(l) && /^\s*\.?(update|upsert)\(|remaining_hp_raw:\s*\w/.test(l)) {
        const near = client.slice(Math.max(0, i - 6), i + 3).join('\n');
        if (/\.(update|upsert|insert)\(/.test(near) && curFn) found.add(curFn);
    }
});
// ★ found が空になっても unknown も空で成功してしまう = 棚卸しの退行を見逃す (Codex指摘)
const MIN_DIRECT_WRITERS = 4;
if (found.size < MIN_DIRECT_WRITERS) {
    console.error(`NG: 残HPを直接更新する関数が ${found.size} 件しか見つかりません (最低 ${MIN_DIRECT_WRITERS} 件を想定)`);
    console.error('  → 洗い出しの条件が実装に合わなくなった可能性があります');
    process.exit(1);
}
const unknown = [...found].filter(f => !KNOWN_DIRECT_WRITERS.includes(f));
if (unknown.length) {
    console.error('NG: ボスの残HPを直接更新する未知の関数があります:');
    unknown.forEach(f => console.error(`  js/supabase-client.js の ${f}()`));
    console.error('\n  → その経路で撃破が起きうるなら、呼び出し側に _checkRaidEvents() を足してください。');
    console.error('     通知不要なら KNOWN_DIRECT_WRITERS に理由つきで追加してください');
    process.exit(1);
}
console.log(`残HPを直接更新する関数 ${found.size} 件 — すべて棚卸し済み`);

console.log('OK: すべての経路に検知フックがあります');
