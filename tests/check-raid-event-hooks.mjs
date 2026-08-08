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
    if (!/_checkRaidEvents\s*\(/.test(scope)) {
        problems.push(`行${i + 1}: ${name} と同じ関数の中に _checkRaidEvents() の呼び出しがありません`
            + `\n        ${rawLines[i].trim().slice(0, 90)}`);
    }
});

console.log(`HPを動かす呼び出し ${checked} 件 (HP非減算 ${skipped} 件は対象外)`);
if (problems.length) {
    console.error('NG:');
    problems.forEach(p => console.error(`  ${p}`));
    console.error('\n  → HPを動かしたら、invalidate の前に _checkRaidEvents().catch(...) を呼んでください');
    console.error('     (呼ばないと、その操作で倒れたときに撃破通知を落とします)');
    process.exit(1);
}
console.log('OK: すべての経路に検知フックがあります');
