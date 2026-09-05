#!/usr/bin/env node
// 新キャラをキャラマスタ (nikke_characters) に事前登録する (CLI版・冪等)。
//
//   node scripts/register-character.mjs --name "ドレイク：グレイトヴィラン" --burst B3 \
//        --source https://example.com/... --by ふるり --notes "Web調査で確認"
//   ... --apply    # 付けるまでは dry-run
//
// なぜ必要か: 実装直後の新キャラは OCR が既存キャラ (素体・別衣装) に誤解決する。
// 名前を先回りで入れておけば OCR がそこへ寄る (マクスウェル：オーディナリーメカニックの教訓)。
// 設定タブの「➕ 新キャラの事前登録」と同じことを CLI から行う。
//
// ⚠ 二者確認 (supabase/34_nikke_verification.sql・運営改修 #6):
//   手動登録は必ず is_confirmed=false (🔍要確認) + registered_by + 根拠URL で入れる。
//   確定は「登録者とは別の運営」が設定タブで押す (登録から24時間経てば本人でも可)。
//   要確認のままでも編成・OCR解決・GB への反映は動く (バーストさえ入っていればゴースト扱いされない)。
// ⚠ aliases は入れない。別キャラを吸い込む事故が起きる (素体マクスウェルが新キャラに吸われた)。
//   OCR のゆれは観測されてから設定タブで足すこと。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] ?? null : null; };

const name = (opt('name') ?? '').trim();
const burst = (opt('burst') ?? '').trim().toUpperCase() || null;
const source = (opt('source') ?? '').trim() || null;
const by = (opt('by') ?? '').trim() || null;
const notes = (opt('notes') ?? '').trim() || null;

const BURSTS = ['B1', 'B2', 'B3', 'BΛ'];
if (!name) { console.error('--name <正式名> は必須です'); process.exit(1); }
if (!burst || !BURSTS.includes(burst)) { console.error(`--burst は ${BURSTS.join(' / ')} のいずれか (誤バーストは GB の編成ピッカーまで波及する)`); process.exit(1); }
if (!source || !/^https?:\/\/\S+$/i.test(source)) { console.error('--source <根拠URL> は http(s) の絶対URLで必須 (二者確認の根拠)'); process.exit(1); }
if (!by) { console.error('--by <登録した運営の表示名> は必須です'); process.exit(1); }

const src = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
const url = src.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = src.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) { console.error('接続情報を読み取れませんでした'); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const api = async (path, init) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: H, ...init });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;   // return=minimal は 201 + 空ボディ
};

// 全角/半角コロン・空白のゆれを吸収して既存を探す (GB の build-characters と同じ正規化)
const norm = (s) => String(s).normalize('NFKC').replace(/：/g, ':').replace(/\s+/g, '').trim();
const all = await api('nikke_characters?select=canonical_name,burst,burst_alt,is_confirmed,aliases,icon_paths,registered_by,verification_source,notes');
const hit = all.find(r => norm(r.canonical_name) === norm(name));

if (hit) {
    console.log(`既に登録済み: 「${hit.canonical_name}」 burst=${hit.burst ?? 'なし'} ` +
        `${hit.is_confirmed ? '✅確定' : (hit.registered_by ? `🔍要確認 (登録: ${hit.registered_by})` : '⚠未確定')} ` +
        `アイコン${(hit.icon_paths ?? []).length}件`);
    if (hit.burst && hit.burst !== burst) {
        console.error(`❌ バーストが食い違っています (DB=${hit.burst} / 指定=${burst})。設定タブで確認してから直してください`);
        process.exit(1);
    }
    if (!hit.burst) {
        console.log(`→ バースト ${burst} を補完します`);
        if (APPLY) await api(`nikke_characters?canonical_name=eq.${encodeURIComponent(hit.canonical_name)}`,
            { method: 'PATCH', body: JSON.stringify({ burst }) });
    }
    console.log(APPLY ? '完了 (既存行はそれ以外を書き換えません)' : '(dry-run。--apply で反映)');
    process.exit(0);
}

// 素体との取り違え防止: 「A：B」の A 部分が既存キャラなら、それとは別行になることを明示する
const base = name.split(/[：:]/)[0];
const baseRow = all.find(r => norm(r.canonical_name) === norm(base));
if (baseRow && norm(baseRow.canonical_name) !== norm(name)) {
    console.log(`ℹ 素体「${baseRow.canonical_name}」(burst=${baseRow.burst ?? '不明'}) とは別キャラとして新規登録します`);
}

const nowIso = new Date().toISOString();
const row = {
    canonical_name: name,
    aliases: [],                 // ⚠ 空のまま (別キャラを吸い込まないため)
    icon_paths: [],              // アイコンは観測から自動学習
    sighting_count: 0,
    is_confirmed: false,         // 🔍要確認 — 別の運営が根拠を見て確定する
    first_seen: nowIso,
    last_seen: nowIso,
    burst,
    registered_by: by,
    verification_source: source,
    ...(notes ? { notes } : {}),
};

console.log(`\n新規登録 (${APPLY ? '★適用' : 'dry-run'}):`);
console.log(`  ${name} / ${burst} / 🔍要確認 (登録: ${by})`);
console.log(`  根拠: ${source}`);
if (notes) console.log(`  メモ: ${notes}`);
if (!APPLY) { console.log('\n(dry-run。--apply で反映)'); process.exit(0); }

await api('nikke_characters', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
console.log('\n✓ 登録しました (🔍要確認)。');
console.log('  次: ① 設定タブ → キャラ管理で別の運営が根拠を見て「確認済みにする」');
console.log('      ② GB 側で node scripts/update-roster.mjs <本家のパス> (属性は data/element-map.json に追記)');
