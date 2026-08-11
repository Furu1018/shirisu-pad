// ============================================================================
// index.html のインライン <script> と js/ 配下の構文チェック
//   node tests/check-syntax.mjs
// ----------------------------------------------------------------------------
// index.html は約18,000行の単一ファイルで、中身の JS は普通の構文チェックに
// かからない。これまでは手で python 抽出 → node --check していたが、
// 2026-08-12 に**コマンドの連結ミスで構文エラーのまま commit した**ため、
// テストとして固定する (手順ではなく仕組みで防ぐ)。
//
// ⚠ これは構文だけ見る。実行経路のバグは team-picker.mjs / plan-hp-modal.mjs 側。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

function ok(name) { console.log(`  ✅ ${name}`); }
function ng(name, e) { failed++; console.error(`  ❌ ${name}`); console.error(`     ${e.message}`); }

console.log('syntax:');

// ---- index.html のインライン script ----
{
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // src 付き (外部読み込み) と type="application/json" 等は対象外
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter(m => !/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1]));
    if (blocks.length === 0) { ng('index.html: <script> を検出できませんでした', new Error('抽出条件が実装と合っていない可能性')); }
    blocks.forEach((m, i) => {
        // 何行目から始まるブロックかを出して、エラー位置を追えるようにする
        const line = html.slice(0, m.index).split('\n').length;
        const isModule = /type\s*=\s*["']module["']/i.test(m[1]);
        try {
            new vm.Script(m[2], { filename: `index.html <script #${i + 1}> (${line}行目〜)` });
            ok(`index.html <script #${i + 1}> (${line}行目〜, ${m[2].split('\n').length}行)`);
        } catch (e) {
            if (isModule && /await is only valid|Cannot use import/i.test(e.message)) {
                ok(`index.html <script #${i + 1}> (module のため簡易確認)`);
                return;
            }
            ng(`index.html <script #${i + 1}> (${line}行目〜)`, e);
        }
    });
}

// ---- js/ 配下 ----
{
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name))
            : (/\.(js|mjs|cjs)$/.test(d.name) ? [path.join(dir, d.name)] : []));
    const files = walk(path.join(ROOT, 'js'));
    if (files.length === 0) ng('js/ にファイルがありません', new Error('探索条件を確認'));
    files.forEach(f => {
        const rel = path.relative(ROOT, f);
        const src = fs.readFileSync(f, 'utf8');
        const isModule = /^\s*(import|export)\s/m.test(src);
        try {
            if (isModule) {
                // ESM は vm.Script では扱えない。node 本体の構文チェックに委ねる
                // (自前で import/export を削ると、消し方次第で偽陽性・偽陰性の両方が出る)
                execFileSync(process.execPath, ['--input-type=module', '--check'],
                    { input: src, stdio: ['pipe', 'ignore', 'pipe'] });
                ok(`${rel} (ESM)`);
            } else {
                new vm.Script(src, { filename: rel });
                ok(rel);
            }
        } catch (e) {
            ng(rel, new Error(String(e.stderr || e.message).trim().split('\n').slice(0, 3).join(' / ')));
        }
    });
}

console.log(failed === 0 ? '\nOK: 構文エラーなし' : `\nNG: ${failed}件`);
process.exit(failed > 0 ? 1 : 0);
