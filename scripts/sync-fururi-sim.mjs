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
//   前シーズンの古い模擬を誤って基準にしないよう、updated_at (JST の日付) が前シーズンの
//   ハード日より後であることを検査する (古い/不明な場合は --allow-stale を明示しない限り中断)。
// 冪等: PK (season_id, boss_code) で upsert してから、新セットに無い boss_code だけ削除する
//   (DELETE→INSERT だと途中失敗で対象シーズンの基準が空になる窓ができる — Codex指摘)。
// 接続: 本家の他スクリプトと同じく js/supabase-client.js の公開キーを使う
//   (本家は内輪ツールで匿名書き込みを許可している。service key は不要)。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_STALE = args.includes('--allow-stale');
let seasonIdArg = null;
for (let i = 0; i < args.length; i++) if (args[i] === '--season-id') seasonIdArg = parseInt(args[++i], 10);
if (seasonIdArg != null && !Number.isInteger(seasonIdArg)) { console.error('--season-id は整数で指定'); process.exit(1); }

const src = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
const url = src.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = src.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) { console.error('接続情報を読み取れませんでした'); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const api = async (path, init) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: H, ...init });
    if (!res.ok) {
        const body = await res.text();
        // ★ status と body を持たせる。エラー文にはリクエストパスも入るので、
        //   メッセージ全体を正規表現で見ると「列名がパスに含まれるだけ」で誤判定する
        //   (levels を select しただけで、通信断まで列不存在に見えてしまう — Codex指摘)
        const e = new Error(`${path} → ${res.status} ${body}`);
        e.status = res.status; e.body = body;
        throw e;
    }
    return res.status === 204 ? null : res.json();
};
// 列が無い (PostgREST PGRST204 / PostgreSQL 42703) ときだけ true。
// js/supabase-client.js の _isMissingColumnErr と同じ水準の判定
const isMissingColumn = (e, col) => {
    const b = String(e?.body || '');
    return (/PGRST204/.test(b) || /42703/.test(b)) && new RegExp(col, 'i').test(b);
};

// ---- 対象シーズン ----
const seasons = (await api('seasons?select=id,month_key,hard_date,is_active,is_test&order=hard_date.asc'))
    .filter(s => !s.is_test);
const actives = seasons.filter(s => s.is_active);
if (seasonIdArg == null && actives.length > 1) {   // データ異常時に黙って最後のを選ばない
    console.error(`アクティブな実シーズンが複数あります: ${actives.map(s => `${s.id} (${s.month_key})`).join(', ')} — --season-id で明示してください`);
    process.exit(1);
}
const target = seasonIdArg != null
    ? seasons.find(s => s.id === seasonIdArg)
    : (actives[0] ?? seasons.at(-1));
if (!target) { console.error('対象シーズンが見つかりません'); process.exit(1); }
const prev = seasons.filter(s => s.hard_date < target.hard_date).at(-1) ?? null;
console.log(`対象: id ${target.id} (${target.month_key} / hard ${target.hard_date})` +
    (prev ? ` — 前シーズン hard ${prev.hard_date}` : ''));

// ---- ボス (弱点PT属性 → boss_code) ----
const bosses = await api(`bosses?select=boss_code,name,weakness&season_id=eq.${target.id}`);
if (bosses.length !== 5) { console.error(`ボスが5体ではありません (${bosses.length}体)`); process.exit(1); }
const codeByAttr = new Map(bosses.map(b => [String(b.weakness).toLowerCase(), b.boss_code]));
const nameByAttr = new Map(bosses.map(b => [String(b.weakness).toLowerCase(), b.name]));
if (codeByAttr.size !== 5) {   // 弱点属性が重複していると Map が片方を潰して4属性しか作れない
    console.error(`ボスの弱点属性が5種そろっていません: ${bosses.map(b => `${b.boss_code}=${b.weakness}`).join(', ')}`);
    process.exit(1);
}

// ---- ふるりの模擬 (slot1) ----
const players = await api(`players?select=id,name&name=eq.${encodeURIComponent('ふるり')}`);
if (players.length !== 1) { console.error(`プレイヤー「ふるり」が一意に決まりません (${players.length}件)`); process.exit(1); }
// ★ levels / boss_level も取る — 測定ボスレベル廃止 (2026-09-06) 後、アプリは代表値 (中央値) を
//   使う。damage_b (廃止前の互換ミラー = 最大値) をそのまま基準に保存すると、
//   GB のふるり値基準だけが最大値で永続化され、画面と食い違う (Codex指摘)
let dmgs;
try {
    dmgs = await api(`player_damages?select=attribute,slot,damage_b,levels,boss_level,updated_at&player_id=eq.${players[0].id}`);
} catch (e) {
    // 31未適用の環境には levels 列が無い。その場合だけ damage_b で読む (単一値に劣化)。
    // ★ それ以外の失敗で握りつぶすと、最大値を GB の基準として永続保存してしまう
    if (!isMissingColumn(e, 'levels')) throw e;
    dmgs = await api(`player_damages?select=attribute,slot,damage_b,updated_at&player_id=eq.${players[0].id}`);
}
dmgs = dmgs.filter(d => (d.slot ?? 1) === 1);

// 提出の代表ダメージ (中央値) はドメインを唯一の実装にする — 計算を写すと乖離するため
await import(`file://${join(ROOT, 'js', 'domain', 'mockLevels.js')}`);
const mlDom = globalThis.mockLevelsDomain;
if (!mlDom?.representativeDamage) { console.error('js/domain/mockLevels.js を読み込めませんでした'); process.exit(1); }
const representativeDamage = (row) =>
    mlDom.representativeDamage(mlDom.normLevels(row?.levels, row?.damage_b, row?.boss_level)) || 0;

// timestamptz → JST の YYYY-MM-DD (不正/欠損は null = 安全側で stale 扱い)
function jstDate(ts) {
    const t = new Date(ts ?? NaN);
    return Number.isNaN(t.getTime()) ? null : t.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
const rows = [], missing = [], stale = [];
for (const [attr, code] of codeByAttr) {
    const d = dmgs.find(x => String(x.attribute).toLowerCase() === attr);
    const dmgB = representativeDamage(d);
    if (!d || !(dmgB > 0)) { missing.push(`${attr} (${code} / ${nameByAttr.get(attr)})`); continue; }
    const updatedJst = jstDate(d.updated_at);   // hard_date は JST の日付なので同じ基準に揃えて比べる
    if (prev && (!updatedJst || updatedJst <= prev.hard_date)) stale.push(`${attr}: 更新 ${updatedJst ?? '不明'}`);
    rows.push({ season_id: target.id, boss_code: code, damage_raw: Math.round(dmgB * 1e9),
        _attr: attr, _updated: updatedJst ?? '不明', _boss: nameByAttr.get(attr) });
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

// upsert (PK season_id+boss_code で衝突したら上書き) → 新セットに無い旧 boss_code だけ削除。
// この順なら途中で落ちても対象シーズンの基準が空になることはない
const inserted = await api('fururi_simulation_scores', {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows.map(({ season_id, boss_code, damage_raw }) => ({ season_id, boss_code, damage_raw }))),
});
const keep = new Set(rows.map(r => r.boss_code));
const pruned = existing.filter(e => !keep.has(e.boss_code));
for (const e of pruned) {
    await api(`fururi_simulation_scores?season_id=eq.${target.id}&boss_code=eq.${encodeURIComponent(e.boss_code)}`, { method: 'DELETE' });
}
console.log(`\n✓ upsert ${inserted.length}件` + (pruned.length ? ` / 旧コード削除 ${pruned.map(e => e.boss_code).join(', ')}` : '') + ` (既存 ${existing.length}件)`);
console.log('次: GB 側で node scripts/new-season.mjs <本家のパス> --slv <ふるりの現SLv>');
