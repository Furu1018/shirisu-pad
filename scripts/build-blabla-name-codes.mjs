#!/usr/bin/env node
// BlaBlaLINK の name_code → PAD のキャラ名 の対応表を作る (再実行で最新に更新できる)。
//
// ユニオンメンバーの育成データ取り込み (2026-09-08 決定 A1/B3/C1/D1) の土台。
// BlaBlaLINK の育成 API は数値の name_code で返してくるので、PAD のキャラ名に
// 移し替える表が要る。**この表が無いと、取り込んだデータをどのキャラのものか決められない。**
//
// 材料はどちらも BlaBlaLINK の CDN で、ブラウザもログインも要らない:
//   ① /character/character_id_map.json      → name_code → resource_id
//   ② /roledata/{resource_id}-v2-ja.json    → name_localkey (日本語名)
//
// ★ GB の data/blabla-map.json (手で維持している resource_id → 日本語名) には依存しない。
//   あれは 177 件で止まっており、コラボや新キャラが抜ける。CDN から引けば毎回最新になる。
//   (2026-09-08 検証: GB 経由だと 177/203、CDN 直だと下の実行結果のとおり)
//
// 使い方:
//   node scripts/build-blabla-name-codes.mjs            # 生成せず、突合結果だけ出す (dry-run)
//   node scripts/build-blabla-name-codes.mjs --apply    # data/blabla-name-codes.json を書く
//
// CDN のパスは難読化されているが、規則が分かっているので平文パスから決まる
// (しりすこスクワッド scraper/cdn_path.py の移植。あちらが正本なので、変わったら一緒に直す)。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const CDN_BASE = 'https://sg-tools-cdn.blablalink.com';
const LOCALE = 'ja';

// ---- CDN パスの難読化 (フロントエンドの obfuscatedPath と同じ規則) ----
const LARGE_PRIMES = [224737, 1000639, 2654435761, 2654435769, 1000621, 4294967291];

/** JS のビット演算 (ToInt32) セマンティクスで回す djb2。 */
function djb2(text, seed) {
    let value = seed;
    for (const ch of text) value = (value * 33 + ch.codePointAt(0)) | 0;
    return value;
}

function dirToken(path, prime) {
    const r = ((djb2(path, prime) % prime) + prime) % prime;
    const letters = String.fromCharCode(97 + (Math.floor(r / 26) % 26)) + String.fromCharCode(97 + (r % 26));
    return `${letters}-${String(r % 99).padStart(2, '0')}`;
}

/** 平文パス → CDN の URL。末尾がファイル名、それ以外はディレクトリトークン。 */
function cdnUrl(path) {
    const plain = path.replace(/^\/+/, '');
    const segments = plain.split('/').filter(Boolean);
    const out = segments.map((seg, i) => {
        if (i === segments.length - 1) {
            const ext = seg.split('.').slice(1).join('.');
            return `${createHash('md5').update(plain).digest('hex')}.${ext}`;
        }
        return dirToken(plain, LARGE_PRIMES[i]);
    });
    return `${CDN_BASE}/${out.join('/')}`;
}

async function cdnJson(path) {
    const res = await fetch(cdnUrl(path), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ---- 名前が一致しないものの手当て (name_code → PAD の canonical_name) ----
//
// ★ name_code で持つ。CDN 側の表記が変わっても壊れない (名前で持つと変わった瞬間に外れる)。
// ★ ここに書いた名前が PAD のキャラマスタに無ければ、スクリプトが止まる (打ち間違いの検出)。
const OVERRIDES = {
    // 同じ日本語名の別キャラ。**放っておくと他人の育成データが別キャラに付く**
    // (CDN では 1012 も 3015 も「サクラ」。1012 がニケ本編、3015 がエヴァコラボ)
    3015: '鈴原サクラ',

    // 略号の書き方だけの違い
    1013: 'ソルジャーEG',   // CDN: ソルジャーE.G.
    1014: 'ソルジャーFA',   // CDN: ソルジャーF.A.
    1025: 'ソルジャーOW',   // CDN: ソルジャーO.W.

    // CDN は接頭辞つき、PAD は無し
    1017: 'フラワー',       // CDN: I-DOLL・フラワー
    1018: 'オーシャン',     // CDN: I-DOLL・オーシャン
    1023: 'サン',           // CDN: I-DOLL・サン

    // コラボ勢。CDN は短い呼び名、PAD はフルネーム
    5118: '式波・アスカ・ラングレー',        // CDN: アスカ
    5119: '綾波レイ',                        // CDN: レイ
    5132: 'アヤナミレイ(仮称)',              // CDN: レイ（仮称）
    5133: '式波・アスカ・ラングレー：WILLE', // CDN: アスカ：WILLE
    5152: 'エイダ・ウォン',                  // CDN: エイダ
    5153: 'ジル・バレンタイン',              // CDN: ジル
    5164: '錦木千束',                        // CDN: 千束
    5165: '井ノ上たきな',                    // CDN: たきな
    5179: 'クイーン(新島真)',                // CDN: クイーン（真）
    5180: '天城雪子',                        // CDN: 雪子
};

// ---- PAD のキャラマスタ (照合用。書き込みはしない) ----
const norm = (s) => String(s).replace(/：/g, ':').replace(/\s+/g, '').trim();

async function loadPadCharacters() {
    const src = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
    const url = src.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
    const key = src.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
    if (!url || !key) throw new Error('supabase-client.js から接続先を読めませんでした');
    const res = await fetch(`${url}/rest/v1/nikke_characters?select=canonical_name&order=canonical_name.asc`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`キャラマスタ取得失敗: ${res.status}`);
    return (await res.json()).map((r) => r.canonical_name);
}

// ---- 本体 ----
console.log('① character_id_map.json を取得...');
const idRows = await cdnJson('/character/character_id_map.json');
// 同じ name_code が突破段階ぶん並ぶので、最初の1件だけ拾う
const nameCodeToResource = new Map();
for (const row of idRows) {
    if (!nameCodeToResource.has(row.name_code)) nameCodeToResource.set(row.name_code, row.resource_id);
}
console.log(`   name_code ${nameCodeToResource.size} 種 / resource_id ${new Set(nameCodeToResource.values()).size} 種`);

console.log(`② roledata から日本語名を取得 (${LOCALE})...`);
const resourceIds = [...new Set(nameCodeToResource.values())];
const nameByResource = new Map();
const missed = [];
const CHUNK = 8;
for (let at = 0; at < resourceIds.length; at += CHUNK) {
    const slice = resourceIds.slice(at, at + CHUNK);
    await Promise.all(slice.map(async (rid) => {
        try {
            const d = await cdnJson(`/roledata/${rid}-v2-${LOCALE}.json`);
            if (d && d.name_localkey) nameByResource.set(rid, String(d.name_localkey));
            else missed.push(rid);
        } catch {
            missed.push(rid);
        }
    }));
    process.stdout.write(`\r   ${Math.min(at + CHUNK, resourceIds.length)}/${resourceIds.length}`);
}
console.log(`\n   日本語名が取れた resource_id: ${nameByResource.size} / 取れず: ${missed.length}`);

// ③ name_code → 日本語名
const table = {};
for (const [nameCode, rid] of nameCodeToResource) {
    const jp = nameByResource.get(rid);
    if (jp) table[nameCode] = { jp, resource_id: rid };
}
console.log(`③ 日本語名が付いた name_code: ${Object.keys(table).length}`);

// ④ PAD のキャラマスタと突合
console.log('④ PAD のキャラマスタと突合...');
const pad = await loadPadCharacters();
const padByNorm = new Map(pad.map((p) => [norm(p), p]));

// 手当ての宛先が実在するか先に確かめる (打ち間違いに気づかず一致 0 件になるのを防ぐ)
const badOverrides = Object.entries(OVERRIDES).filter(([, name]) => !padByNorm.has(norm(name)));
if (badOverrides.length) {
    console.error('\n❌ OVERRIDES の宛先が PAD のキャラマスタにありません:');
    for (const [nc, name] of badOverrides) console.error(`      ${nc} → ${name}`);
    process.exit(1);
}

const unknownJp = [];
for (const [nameCode, entry] of Object.entries(table)) {
    const forced = OVERRIDES[nameCode];
    const hit = forced ? padByNorm.get(norm(forced)) : padByNorm.get(norm(entry.jp));
    if (hit) { entry.pad = hit; if (forced) entry.overridden = true; } else unknownJp.push(`${nameCode} ${entry.jp}`);
}

// ★ 2つの name_code が同じキャラに付いていないか。付いていたら**取り込みが混ざる**ので止める
const byPad = new Map();
for (const [nameCode, entry] of Object.entries(table)) {
    if (!entry.pad) continue;
    if (!byPad.has(entry.pad)) byPad.set(entry.pad, []);
    byPad.get(entry.pad).push(`${nameCode}(${entry.jp})`);
}
const collisions = [...byPad].filter(([, codes]) => codes.length > 1);
if (collisions.length) {
    console.error('\n❌ 同じキャラに複数の name_code が付いています (取り込みが混ざります):');
    for (const [name, codes] of collisions) console.error(`      ${name} ← ${codes.join(' / ')}`);
    console.error('   → OVERRIDES にどちらが正しいかを書いてください');
    process.exit(1);
}

const matchedPadNames = new Set(byPad.keys());
const padWithout = pad.filter((p) => !matchedPadNames.has(p));

console.log(`   PAD のキャラ ${pad.length} 件 / name_code が付いた ${matchedPadNames.size} 件`);
if (padWithout.length) {
    console.log(`\n   ⚠ PAD にあるが name_code が付かなかった (${padWithout.length}件):`);
    for (const p of padWithout) console.log('      ', p);
}
if (unknownJp.length) {
    console.log(`\n   ℹ CDN にあるが PAD に無いキャラ (${unknownJp.length}件・未実装や未登録):`);
    for (const u of unknownJp.slice(0, 30)) console.log('      ', u);
    if (unknownJp.length > 30) console.log(`       ... ほか ${unknownJp.length - 30} 件`);
}

// ⑤ 書き出し
const out = {
    version: 1,
    generated: new Date().toISOString(),
    source: 'blablalink CDN: /character/character_id_map.json + /roledata/{resource_id}-v2-ja.json',
    note: 'name_code → { jp: CDNの日本語名, resource_id, pad: PADのcanonical_name (一致したものだけ) }。'
        + '再生成は node scripts/build-blabla-name-codes.mjs --apply',
    counts: { name_codes: Object.keys(table).length, matched_pad: matchedPadNames.size, pad_total: pad.length },
    data: table,
};
const dest = join(ROOT, 'data', 'blabla-name-codes.json');
if (APPLY) {
    writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`\n✅ 書き出しました: data/blabla-name-codes.json`);
} else {
    console.log(`\n(dry-run: 書き込んでいません。--apply で ${dest.replace(ROOT + '/', '')} に書きます)`);
}
