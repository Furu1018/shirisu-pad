// ============================================================================
// 戦況の通知フックの網羅チェック
//   node tests/check-raid-event-hooks.mjs
// ----------------------------------------------------------------------------
// ボスの残HPを動かす呼び出しの直後に `_checkRaidEvents()` があることを機械的に確認する。
//
// なぜ要るか:
//   撃破/レベル開放の検知は「盤面の差分」を見るが、比較元は invalidate 前のキャッシュ。
//   HPを動かす経路にフックを足し忘れると、その操作で倒れた場合に通知を落とす。
//   2026-08-09 のレビューで **6回の指摘を経てようやく全経路が埋まった** (凸報告 →
//   凸ダメージ編集 → 一括保存 → 代理凸 → 運営側の編集/削除 → ボス概要編集)。
//   人力の grep では漏れるのでテストにした。
//
// 新しくHPを動かす経路を足したら、その直後 (invalidate より前) に
// `_checkRaidEvents().catch(...)` を呼ぶこと。
// HPを触らない呼び出しは `skipHpDecrement: true` を付ければ対象外になる。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').split('\n');

// 残HPを動かしうる書き込み
const WRITERS = [
    'supabaseUpdateBossHp(',
    'supabaseAddAttack(',
    'supabaseUpdateAttackDamage(',
    'supabaseDeleteAttack(',
];
const LOOKAHEAD = 60;   // 呼び出し〜フックまでに挟まる後処理を許容する幅

const problems = [];
let checked = 0, skipped = 0;
lines.forEach((line, i) => {
    if (!line.includes('await') || !WRITERS.some(w => line.includes(w))) return;
    const near = lines.slice(i, i + 14).join('\n');
    const window = lines.slice(i, i + LOOKAHEAD).join('\n');
    const name = WRITERS.find(w => line.includes(w)).slice(0, -1);
    if (/skipHpDecrement:\s*true/.test(near)) { skipped++; return; }   // HPを触らない
    checked++;
    if (!window.includes('_checkRaidEvents')) {
        problems.push(`行${i + 1}: ${name} の直後に _checkRaidEvents() がありません`);
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
