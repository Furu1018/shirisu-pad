#!/usr/bin/env node
// BlablaLINK 図鑑アイコンを本家PADに一括反映する (1回きりの運用スクリプト・再実行は冪等)。
//
// GB (shirisu-pad-global) の data/blabla-map.json (resource_id → 日本語名) と
// assets/blabla-icons/<resource_id>.webp を読み、
//   1) 画像を character-images/<md5(内容)>.webp としてコピー
//   2) nikke_characters.icon_paths の先頭に差し込む (表示は icon_paths[0] 参照のため
//      UIコード変更なしで全画面が図鑑アイコンになる。OCR学習済みの切り抜きは後ろに残る)
//
// 使い方:
//   node scripts/add-blabla-icons.mjs ../shirisu-pad-global            # dry-run (書き込みなし)
//   node scripts/add-blabla-icons.mjs ../shirisu-pad-global --apply    # 実行
// 実行前に icon_paths 全行のバックアップを ~/Desktop/しりすこPAD-icon-backup-<日時>.json へ保存する。
// 入力 (GBのmap/原本) はGBリポジトリの当時リビジョンに依存する — 再現には両リポジトリの整合が必要。

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gbDir = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!gbDir || !existsSync(join(gbDir, 'data', 'blabla-map.json'))) {
    console.error('使い方: node scripts/add-blabla-icons.mjs <shirisu-pad-globalのパス> [--apply]');
    process.exit(1);
}

const clientSrc = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
const url = clientSrc.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = clientSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
const HEADERS = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const norm = (s) => String(s).replace(/：/g, ':').replace(/\s+/g, '').trim();

// 現状の取得 + バックアップ
const res = await fetch(`${url}/rest/v1/nikke_characters?select=canonical_name,icon_paths&order=canonical_name.asc`, { headers: HEADERS });
if (!res.ok) { console.error('取得失敗:', res.status, await res.text()); process.exit(1); }
const rows = await res.json();
const byName = new Map(rows.map(r => [norm(r.canonical_name), r]));
// バックアップは秒付きファイル名 + 既存を上書きしない (適用前の復旧用を失わないため — Codex指摘)
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupPath = join(homedir(), 'Desktop', `しりすこPAD-icon-backup-${stamp}.json`);
if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(rows, null, 1), 'utf8');
console.log(`バックアップ保存: ${backupPath} (${rows.length}行)`);
console.log(`モード: ${APPLY ? '★ 適用 (--apply)' : 'dry-run (書き込みなし。--apply で実行)'}\n`);

const bm = JSON.parse(readFileSync(join(gbDir, 'data', 'blabla-map.json'), 'utf8'));
let planned = 0, skippedSame = 0, noRow = [], copied = 0, patched = 0, failed = [];
for (const [rid, e] of Object.entries(bm.icons ?? {})) {
    const srcFile = join(gbDir, 'assets', 'blabla-icons', `${rid}.webp`);
    if (!existsSync(srcFile)) { console.warn(`⚠ 画像なし: rid=${rid} (${e.en})`); continue; }
    const buf = readFileSync(srcFile);
    const hash = createHash('md5').update(buf).digest('hex');
    const relPath = `./character-images/${hash}.webp`;
    const dst = join(ROOT, 'character-images', `${hash}.webp`);
    for (const jp of (Array.isArray(e.jp) ? e.jp : [e.jp])) {
        const row = byName.get(norm(jp));
        if (!row) { noRow.push(`${e.en} → ${jp}`); continue; }
        const cur = Array.isArray(row.icon_paths) ? row.icon_paths : [];
        if (cur[0] === relPath) { skippedSame++; continue; }
        planned++;
        const next = [relPath, ...cur.filter(p => p !== relPath)];
        if (!APPLY) {
            console.log(`  ${row.canonical_name}: [0]=${relPath} (旧先頭: ${cur[0] ?? 'なし'} / 学習画像${cur.length}枚は温存)`);
            continue;
        }
        if (!existsSync(dst)) { copyFileSync(srcFile, dst); copied++; }
        try {
            const pr = await fetch(`${url}/rest/v1/nikke_characters?canonical_name=eq.${encodeURIComponent(row.canonical_name)}`, {
                method: 'PATCH', headers: HEADERS, body: JSON.stringify({ icon_paths: next }),
            });
            if (pr.ok) patched++;
            else failed.push(`${row.canonical_name}: ${pr.status} ${await pr.text()}`);
        } catch (e) {
            // 通信断でもループを止めず、行単位で失敗を記録する (Codex指摘)
            failed.push(`${row.canonical_name}: fetch失敗 ${e?.message ?? e}`);
        }
    }
}
console.log(`\n対象: ${planned}件 / 既に先頭一致でスキップ: ${skippedSame}件 / マスタ行なし: ${noRow.length}件${noRow.length ? ' (' + noRow.join(', ') + ')' : ''}`);
if (APPLY) {
    console.log(`画像コピー: ${copied}枚 / DB更新成功: ${patched}件 / 失敗: ${failed.length}件`);
    for (const f of failed) console.error('  ✗', f);
    console.log('※ 戻す場合はバックアップJSONの icon_paths を同様の PATCH で書き戻す');
}
