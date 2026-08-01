#!/usr/bin/env node
// マクスウェル2キャラの整理 (1回きりの是正スクリプト・冪等)。
//   node scripts/fix-maxwell.mjs            # dry-run
//   node scripts/fix-maxwell.mjs --apply    # 実行
//
// 背景: マクスウェルは別キャラが2体いる。
//   - マクスウェル                       … 従来キャラ・B3・鉄甲
//   - マクスウェル：オーディナリーメカニック … 最新実装・B2・風圧
// 本家DBは OCR が読んだ「マクスウェルオーディナリー」(観測9) が別行として残り、
// さらにその aliases に「マクスウェル」を持っていたため、
// **通常マクスウェルのOCR結果まで新キャラに吸われる**状態だった (名前解決は aliases 経由)。
//
// 是正内容:
//   1) 「マクスウェル：オーディナリーメカニック」に観測数を集約し、aliases に
//      「マクスウェルオーディナリー」を追加 (「マクスウェル」は入れない)
//   2) 重複行「マクスウェルオーディナリー」を削除
//   3) 通常「マクスウェル」の行を作成 (burst=B3・確認済み)。GB の図鑑アイコンがあれば
//      character-images へコピーして icon_paths に設定

import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const gbDir = process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1])
    ?? join(ROOT, '..', 'shirisu-pad-global');

const clientSrc = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
const url = clientSrc.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = clientSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const q = (v) => encodeURIComponent(v);

const NEW = 'マクスウェル：オーディナリーメカニック';   // B2・風圧 (最新実装)
const OLD = 'マクスウェル';                              // B3・鉄甲 (従来)
const OCR = 'マクスウェルオーディナリー';                // OCRの読み取り (新キャラの略記)

const rows = await (await fetch(`${url}/rest/v1/nikke_characters?select=*`, { headers: H })).json();
const byName = new Map(rows.map(r => [r.canonical_name, r]));
const ocrRow = byName.get(OCR), newRow = byName.get(NEW), oldRow = byName.get(OLD);
console.log(`現状: ${OCR}=${ocrRow ? `観測${ocrRow.sighting_count}・別名[${ocrRow.aliases}]` : 'なし'} / ` +
    `${NEW}=${newRow ? `burst=${newRow.burst}` : 'なし'} / ${OLD}=${oldRow ? `burst=${oldRow.burst}` : 'なし'}`);

// 通常マクスウェルの図鑑アイコン (GB の blabla-map から rid を引く)
let iconRel = null;
try {
    const bm = JSON.parse(readFileSync(join(gbDir, 'data', 'blabla-map.json'), 'utf8'));
    const hit = Object.entries(bm.icons).find(([, e]) => (Array.isArray(e.jp) ? e.jp : [e.jp]).includes(OLD));
    if (hit) {
        const src = join(gbDir, 'assets', 'blabla-icons', `${hit[0]}.webp`);
        if (existsSync(src)) {
            const hash = createHash('md5').update(readFileSync(src)).digest('hex');
            iconRel = `./character-images/${hash}.webp`;
            if (APPLY && !existsSync(join(ROOT, 'character-images', `${hash}.webp`))) {
                copyFileSync(src, join(ROOT, 'character-images', `${hash}.webp`));
            }
        }
    }
} catch { /* GB が隣に無ければアイコンなしで続行 */ }

const plan = [];
if (newRow) {
    const aliases = [...new Set([...(newRow.aliases || []).filter(a => a !== OLD), OCR])];
    const sight = Math.max(newRow.sighting_count || 0, ocrRow?.sighting_count || 0);
    plan.push({ what: `PATCH ${NEW}`, body: { aliases, sighting_count: sight, is_confirmed: true, burst: newRow.burst ?? 'B2' } });
}
if (ocrRow) plan.push({ what: `DELETE ${OCR} (重複行)`, del: OCR });
if (!oldRow) {
    plan.push({ what: `INSERT ${OLD} (B3・従来キャラ)`, insert: {
        canonical_name: OLD, aliases: [], burst: 'B3', burst_alt: null,
        is_confirmed: true, sighting_count: 0, icon_paths: iconRel ? [iconRel] : [],
    } });
} else if (iconRel && !(oldRow.icon_paths || []).includes(iconRel)) {
    plan.push({ what: `PATCH ${OLD} (アイコン設定)`, body: { icon_paths: [iconRel, ...(oldRow.icon_paths || [])], burst: oldRow.burst ?? 'B3', is_confirmed: true } });
}

console.log(`\n実行予定 (${APPLY ? '★適用' : 'dry-run'}):`);
for (const p of plan) console.log('  -', p.what, p.body ? JSON.stringify(p.body, null, 0) : (p.insert ? JSON.stringify(p.insert) : ''));
if (!plan.length) { console.log('  (変更なし = 既に是正済み)'); process.exit(0); }
if (!APPLY) { console.log('\n--apply で実行'); process.exit(0); }

for (const p of plan) {
    let res;
    if (p.del) res = await fetch(`${url}/rest/v1/nikke_characters?canonical_name=eq.${q(p.del)}`, { method: 'DELETE', headers: H });
    else if (p.insert) res = await fetch(`${url}/rest/v1/nikke_characters`, { method: 'POST', headers: H, body: JSON.stringify(p.insert) });
    else res = await fetch(`${url}/rest/v1/nikke_characters?canonical_name=eq.${q(p.what.split(' ')[1])}`, { method: 'PATCH', headers: H, body: JSON.stringify(p.body) });
    console.log(res.ok ? `✓ ${p.what}` : `✗ ${p.what}: ${res.status} ${await res.text()}`);
}
console.log('\n完了。GB 側は node scripts/update-roster.mjs で再ビルドしてください');
