#!/usr/bin/env node
// ふるりの模擬入力 (player_damages の slot1) を fururi_simulation_scores へ転記する。
//
//   node scripts/sync-fururi-sim.mjs                    # dry-run (対象 = アクティブな実シーズン)
//   node scripts/sync-fururi-sim.mjs --apply
//   node scripts/sync-fururi-sim.mjs --season-id 30 --apply
//
// なぜ必要か: fururi_simulation_scores に書き込むUIが本家に無く (読み取り専用)、
// GB (しりすこPAD GB) の scripts/new-season.mjs はこのテーブルを「ふるり基準」として読む。
// 毎シーズン手作業でINSERTしていたのでスクリプト化した。
//
// ⚠ player_damages はシーズン列を持たない「現在の模擬」テーブル。
//   前シーズンの古い模擬を誤って基準にしないよう、updated_at が前シーズンのハード日より
//   後であることを検査する (古い場合は --allow-stale を明示しない限り中断)。
// 冪等: 対象シーズンの既存行を削除してから入れ直す。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_STALE = args.includes('--allow-stale');
let seasonIdArg = null;
for (let i = 0; i < args.length; i++) if (args[i] === '--season-id') seasonIdArg = parseInt(args[++i], 10);

const src = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
const url = src.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = src.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) { console.error('接続情報を読み取れませんでした'); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const api = async (path, init) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: H, ...init });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
};

// ---- 対象シーズン ----
const seasons = (await api('seasons?select=id,month_key,hard_date,is_active,is_test&order=hard_date.asc'))
    .filter(s => !s.is_test);
const target = seasonIdArg != null
    ? seasons.find(s => s.id === seasonIdArg)
    : (seasons.findLast(s => s.is_active) ?? seasons.at(-1));
if (!target) { console.error('対象シーズンが見つかりません'); process.exit(1); }
const prev = seasons.filter(s => s.hard_date < target.hard_date).at(-1) ?? null;
console.log(`対象: id ${target.id} (${target.month_key} / hard ${target.hard_date})` +
    (prev ? ` — 前シーズン hard ${prev.hard_date}` : ''));

// ---- ボス (弱点PT属性 → boss_code) ----
const bosses = await api(`bosses?select=boss_code,name,weakness&season_id=eq.${target.id}`);
if (bosses.length !== 5) { console.error(`ボスが5体ではありません (${bosses.length}体)`); process.exit(1); }
const codeByAttr = new Map(bosses.map(b => [String(b.weakness).toLowerCase(), b.boss_code]));
const nameByAttr = new Map(bosses.map(b => [String(b.weakness).toLowerCase(), b.name]));

// ---- ふるりの模擬 (slot1) ----
const players = await api(`players?select=id,name&name=eq.${encodeURIComponent('ふるり')}`);
if (!players.length) { console.error('プレイヤー「ふるり」が見つかりません'); process.exit(1); }
const dmgs = (await api(`player_damages?select=attribute,slot,damage_b,updated_at&player_id=eq.${players[0].id}`))
    .filter(d => (d.slot ?? 1) === 1);

const rows = [], missing = [], stale = [];
for (const [attr, code] of codeByAttr) {
    const d = dmgs.find(x => String(x.attribute).toLowerCase() === attr);
    if (!d || !(Number(d.damage_b) > 0)) { missing.push(`${attr} (${code} / ${nameByAttr.get(attr)})`); continue; }
    if (prev && String(d.updated_at) <= `${prev.hard_date}`) stale.push(`${attr}: 更新 ${String(d.updated_at).slice(0, 10)}`);
    rows.push({ season_id: target.id, boss_code: code, damage_raw: Math.round(Number(d.damage_b) * 1e9),
        _attr: attr, _updated: String(d.updated_at).slice(0, 10), _boss: nameByAttr.get(attr) });
}

console.log(`\nふるりの模擬 (slot1) → 基準:`);
for (const r of rows) console.log(`  ${r._attr.padEnd(9)} ${(r.damage_raw / 1e9).toFixed(3)} B  vs ${r._boss} (${r.boss_code})  更新 ${r._updated}`);
if (missing.length) { console.error(`\n❌ 模擬が未入力の属性: ${missing.join(', ')}`); process.exit(1); }
if (stale.length) {
    console.error(`\n⚠ 前シーズンのハード日 (${prev.hard_date}) より古い模擬があります:\n  ${stale.join('\n  ')}`);
    if (!ALLOW_STALE) { console.error('  → 今シーズンの模擬を入れ直すか、意図的なら --allow-stale を付けて再実行'); process.exit(1); }
}

const existing = await api(`fururi_simulation_scores?select=boss_code,damage_raw&season_id=eq.${target.id}`);
console.log(`\n既存の基準 (season_id=${target.id}): ${existing.length}件` +
    (existing.length ? ` — ${existing.map(e => `${e.boss_code}=${(Number(e.damage_raw) / 1e9).toFixed(2)}B`).join(' ')}` : ''));
if (!APPLY) { console.log('\n(dry-run。--apply で反映)'); process.exit(0); }

if (existing.length) await api(`fururi_simulation_scores?season_id=eq.${target.id}`, { method: 'DELETE' });
const inserted = await api('fururi_simulation_scores', {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(rows.map(({ season_id, boss_code, damage_raw }) => ({ season_id, boss_code, damage_raw }))),
});
console.log(`\n✓ 投入 ${inserted.length}件 (既存 ${existing.length}件は入れ替え)`);
console.log('次: GB 側で node scripts/new-season.mjs <本家のパス> --slv <ふるりの現SLv>');
