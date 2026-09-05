#!/usr/bin/env node
// ============================================================================
// 月次JSONに写っている「名前が紐づいていないアイコン」を キャラマスタへ結びつける
// ----------------------------------------------------------------------------
// 月次データ (data/YYYY-MM.json) の characters は画像パスなので、
// nikke_characters.icon_paths に無い画像は「誰なのか分からない凸」になる。
// 分析タブは画像で表示できるので壊れはしないが、キャラ単位の集計から漏れる。
//
// 使い方:
//   node scripts/link-icons.mjs 2026-09                          # 未紐づけの一覧 (誰の凸で使われたか付き)
//   node scripts/link-icons.mjs --link a340e8e6…=ナガ b24c71…=ロザンナ        # dry-run (既定)
//   node scripts/link-icons.mjs --link a340e8e6…=ナガ --apply                # 実行
//
// 仕様 (UI の supabaseRegisterCharacterWithIcon と同じ意味論):
//   - 既存キャラの icon_paths の**末尾に追加**する。先頭 (= アバター表示に使う主アイコン) は変えない
//   - 冪等: 既に入っていればスキップ
//   - **他のキャラに紐づいている画像は中断**する (1画像2キャラは逆引きを壊すため)
//   - マスタに無い名前も中断する (新規キャラは要確認フローの scripts/register-character.mjs で登録する)
//   - --apply の前に icon_paths / last_seen / is_confirmed を ~/Desktop/しりすこPAD-icon-backup-<日時>.json へ保存
//     (PATCH で書き換わる列すべて。icon_paths だけだと部分適用の巻き戻しが不完全になる)
//
// ⚠ 取得時点の icon_paths を丸ごと PATCH するので、**実行中に他の人がUIからアイコンを足すと
//   その追加を消す**。運営が同時にキャラマスタを触っていないときに実行すること。
// ============================================================================
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = join(ROOT, 'character-images');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const linkIdx = argv.indexOf('--link');
const pairs = linkIdx >= 0 ? argv.slice(linkIdx + 1).filter(a => !a.startsWith('--')) : [];
const monthKey = argv.find(a => /^\d{4}-\d{2}$/.test(a));

if (!monthKey && pairs.length === 0) {
    console.error('使い方:\n  node scripts/link-icons.mjs YYYY-MM                    # 未紐づけを一覧\n'
        + '  node scripts/link-icons.mjs --link <画像>=<キャラ名> … [--apply]');
    process.exit(2);
}

const clientSrc = readFileSync(join(ROOT, 'js', 'supabase-client.js'), 'utf8');
const url = clientSrc.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
const key = clientSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) { console.error('supabase-client.js から接続情報を読めませんでした'); process.exit(1); }
const HEADERS = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

// 表記ゆれ吸収。UI 側 (js/supabase-client.js の _normalizeNikkeName) の前半と揃える:
// NFKC → 全角コロン→半角 → 空白除去。UI はさらに先頭バースト記号や句読点も落とすが、
// ここは**運営が手で打った名前**の照合なので、落としすぎて別キャラに当たる方が危険。
// 曖昧なときは下の解決処理が「候補が複数」として中断する
const norm = (s) => String(s).normalize('NFKC').replace(/：/g, ':').replace(/\s+/g, '').trim();
// 「32桁hex」「32桁hex.webp」「./character-images/32桁hex.webp」のどれでも受ける。
// 大文字混じりで渡されても既存の小文字パスと同一視する (macOS は大小非区別なので取り違えやすい)
const hashOf = (s) => String(s).split('/').pop().replace(/\.webp$/i, '').trim().toLowerCase();
const pathOf = (h) => `./character-images/${h}.webp`;
// PostgREST の eq 値。**素の encodeURIComponent が正しい** — このエンドポイントで実測したところ
// (2026-09-06 / `E.H.` `アヤナミレイ(仮称)` `シンデレラ:クリスタルウェーブ` で確認)、
// ドキュメント通りに二重引用符で囲むと引用符ごとリテラル扱いになり **0件**になる。
// ただしカンマだけは値の区切りとして解釈されうるので、含む名前は扱わない (下の hasUnsafeName で中断)
const pgEq = (v) => `eq.${encodeURIComponent(v)}`;
// カンマ入りの canonical_name は eq. フィルタで安全に指定できない (現在マスタに該当なし)。
// 将来そういう名前が来たら黙って別行を触らず気づけるように、明示的に止める
const hasUnsafeName = (v) => String(v).includes(',');

// last_seen / is_confirmed も取る — PATCH で書き換える列はバックアップに実値が要る
const res = await fetch(`${url}/rest/v1/nikke_characters?select=canonical_name,aliases,icon_paths,burst,registered_by,last_seen,is_confirmed&order=canonical_name.asc`, { headers: HEADERS });
if (!res.ok) { console.error('マスタ取得失敗:', res.status, await res.text()); process.exit(1); }
const rows = await res.json();

// 名前 → 候補**リスト**。1件に絞れないものは黙って先勝ちにせず、使うときに中断する
// (canonical と alias、あるいは別キャラの alias 同士がぶつかると別人に紐づけてしまう)
const byName = new Map();
const pushName = (k, r) => {
    const list = byName.get(k) || [];
    if (!list.some(x => x.canonical_name === r.canonical_name)) list.push(r);
    byName.set(k, list);
};
for (const r of rows) pushName(norm(r.canonical_name), r);
for (const r of rows) for (const a of (r.aliases || [])) pushName(norm(a), r);
// canonical_name の一致は alias より強い (alias 衝突で正しい名前が使えなくなるのを防ぐ)。
// ここも**候補リスト**にする — 正規化すると別物だった名前 ('Ａ' と 'A' など) が衝突しうるため、
// 1件に絞れないなら後段で中断する。raw の完全一致はさらに優先 (正規化を挟まない最も確実な指定)
const canonRaw = new Map();
const canonNorm = new Map();
for (const r of rows) {
    canonRaw.set(r.canonical_name, [...(canonRaw.get(r.canonical_name) || []), r]);
    canonNorm.set(norm(r.canonical_name), [...(canonNorm.get(norm(r.canonical_name)) || []), r]);
}

// 画像ハッシュ → その画像を持つキャラ**リスト**。DB に「1画像1キャラ」の制約は無いので、
// 既に複数キャラへ重複登録されている画像も検出できるようにする
const ownerOf = new Map();
for (const r of rows) {
    for (const p of (r.icon_paths || [])) {
        const h = hashOf(p);
        const list = ownerOf.get(h) || [];
        if (!list.some(x => x.canonical_name === r.canonical_name)) list.push(r);
        ownerOf.set(h, list);
    }
}
const dup = [...ownerOf.entries()].filter(([, v]) => v.length > 1);
if (dup.length > 0) {
    console.warn(`⚠ 複数キャラに紐づいている画像が ${dup.length}件あります (画像→名前の逆引きが不定になります):`);
    for (const [h, v] of dup.slice(0, 10)) console.warn(`   ${h.slice(0, 12)}… → ${v.map(x => x.canonical_name).join(' / ')}`);
}

// ---- 一覧モード -------------------------------------------------------------
if (monthKey && pairs.length === 0) {
    const file = join(ROOT, 'data', `${monthKey}.json`);
    if (!existsSync(file)) { console.error(`${file} がありません`); process.exit(1); }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const players = data.players || data.raidData?.players || [];
    const unknown = new Map();
    for (const p of players) {
        (p.attacks || []).forEach((a, i) => {
            const hs = (a.characters || []).map(hashOf);
            for (const h of hs) {
                if (ownerOf.has(h)) continue;
                const e = unknown.get(h) || { uses: [], mates: new Map() };
                e.uses.push(`${p.player}凸${i + 1} (${a.bossCode} Lv${a.level})`);
                for (const o of hs) {
                    if (o === h) continue;
                    const c = (ownerOf.get(o) || [])[0];
                    if (c) e.mates.set(c.canonical_name, (e.mates.get(c.canonical_name) || 0) + 1);
                }
                unknown.set(h, e);
            }
        });
    }
    if (unknown.size === 0) { console.log(`${monthKey}: 未紐づけのアイコンはありません`); process.exit(0); }
    console.log(`${monthKey}: 名前が紐づいていないアイコン ${unknown.size}種\n`);
    for (const [h, e] of unknown) {
        const exists = existsSync(join(IMG_DIR, `${h}.webp`));
        console.log(`  ${h}.webp ${exists ? '' : '⚠ 画像ファイルなし '}(${e.uses.length}凸)`);
        console.log(`    使用: ${e.uses.slice(0, 3).join(' / ')}${e.uses.length > 3 ? ' …' : ''}`);
        console.log(`    同編成: ${[...e.mates.keys()].slice(0, 5).join('、') || '(登録済みキャラなし)'}`);
    }
    console.log(`\n名前が分かったら:\n  node scripts/link-icons.mjs --link <画像>=<キャラ名> … --apply`);
    process.exit(0);
}

// ---- 紐づけモード -----------------------------------------------------------
const plan = [];
let bad = 0;
for (const pair of pairs) {
    const eq = pair.lastIndexOf('=');
    if (eq <= 0) { console.error(`✗ 形式が不正: ${pair} (<画像>=<キャラ名>)`); bad++; continue; }
    const h = hashOf(pair.slice(0, eq));
    const name = pair.slice(eq + 1).trim();
    if (!/^[0-9a-f]{32}$/.test(h)) { console.error(`✗ 画像名が32桁hexでない: ${h}`); bad++; continue; }
    if (!existsSync(join(IMG_DIR, `${h}.webp`))) { console.error(`✗ 画像がリポジトリにない: ${h}.webp`); bad++; continue; }
    // raw の完全一致 → 正規化した canonical → alias の順に探す。どの段でも候補が複数なら中断する
    const key = norm(name);
    const cands = canonRaw.get(name) || canonNorm.get(key) || byName.get(key) || [];
    if (cands.length === 0) {
        console.error(`✗ マスタに無い名前: ${name} (新規キャラなら scripts/register-character.mjs で登録)`);
        bad++; continue;
    }
    if (cands.length > 1) {
        console.error(`✗ 名前が一意でない: ${name} → ${cands.map(c => c.canonical_name).join(' / ')} (正式名で指定してください)`);
        bad++; continue;
    }
    const target = cands[0];
    if (hasUnsafeName(target.canonical_name)) {
        console.error(`✗ カンマを含む名前は PostgREST の eq. で指定できません: ${target.canonical_name}`);
        bad++; continue;
    }
    const owners = ownerOf.get(h) || [];
    const others = owners.filter(o => norm(o.canonical_name) !== norm(target.canonical_name));
    if (others.length > 0) {
        // 1画像2キャラは画像→名前の逆引きを壊す。取り違えの可能性が高いので止める
        console.error(`✗ ${h.slice(0, 12)}… は既に「${others.map(o => o.canonical_name).join('/')}」のアイコン (${name} と食い違い)`);
        bad++; continue;
    }
    if (owners.length > 0) { console.log(`= ${name}: ${h.slice(0, 12)}… は登録済み (スキップ)`); continue; }
    plan.push({ h, name, target });
}
if (bad > 0) { console.error(`\n${bad}件に問題があるため中断しました (何も書き込んでいません)`); process.exit(1); }
if (plan.length === 0) { console.log('追加するものはありません'); process.exit(0); }

// 同じ実行内で1つの画像を2回指定するのは取り違えの疑い (1画像2キャラを含む)
const seen = new Set();
for (const p of plan) {
    if (seen.has(p.h)) { console.error(`✗ 同じ画像が2回指定されています: ${p.h}`); process.exit(1); }
    seen.add(p.h);
}
// ★ キャラ単位にまとめる。1キャラに2枚以上を指定したとき、取得時点の icon_paths から
//   毎回組み立てて PATCH すると後の書き込みが前の追加を消す (新スキン2枚を同時に足す場合など)
const jobs = new Map();
for (const p of plan) {
    const j = jobs.get(p.target.canonical_name) || { target: p.target, hashes: [] };
    j.hashes.push(p.h);
    jobs.set(p.target.canonical_name, j);
}

console.log(`\n${APPLY ? '実行' : 'dry-run (--apply で実行)'}: ${plan.length}件 / ${jobs.size}キャラ\n`);
for (const j of jobs.values()) {
    const cur = (j.target.icon_paths || []).length;
    console.log(`  ${j.target.canonical_name} (${j.target.burst || 'バースト未設定'}) ← ${j.hashes.map(h => h.slice(0, 12) + '…').join(' + ')}  [icon_paths ${cur} → ${cur + j.hashes.length}]`);
}
if (!APPLY) process.exit(0);

// バックアップは PATCH で書き換わる列すべて (icon_paths だけだと、途中で失敗したとき
// last_seen / is_confirmed を戻せない)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = join(homedir(), 'Desktop', `しりすこPAD-icon-backup-${stamp}.json`);
writeFileSync(backup, JSON.stringify(rows.map(r => ({
    canonical_name: r.canonical_name, icon_paths: r.icon_paths,
    last_seen: r.last_seen ?? null, is_confirmed: r.is_confirmed ?? null,
})), null, 1), 'utf8');
console.log(`\nバックアップ: ${backup}`);

// 結果は3つに分ける。**「未適用」と「適用されたか分からない」を混ぜない** —
// 混ぜると巻き戻しの案内から、実際には書き換わっている行が抜け落ちる
const done = [];      // 1行更新を確認できた (確実に適用)
const unknown = [];   // 送ったが確認できない (通信断・本文が読めない・複数行) = 適用された可能性あり
const failed = [];    // 明確に未適用 (HTTPエラー・0行)
for (const j of jobs.values()) {
    const paths = [...(j.target.icon_paths || [])];
    for (const h of j.hashes) if (!paths.includes(pathOf(h))) paths.push(pathOf(h));
    const patch = {
        icon_paths: paths,
        last_seen: new Date().toISOString(),
        // 「要確認」(手動登録・registered_by あり) の行はアイコン追加では確定しない —
        // 確定は別の運営の「確認済みにする」だけ (運営改修 #6 と同じ規則)
        ...(j.target.registered_by ? {} : { is_confirmed: true }),
    };
    let r;
    try {
        r = await fetch(`${url}/rest/v1/nikke_characters?canonical_name=${pgEq(j.target.canonical_name)}`,
            { method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    } catch (e) {
        // 送信済みかどうか分からない (サーバ側で適用されている可能性がある)
        console.error(`? ${j.target.canonical_name}: 通信エラー — 適用されたか不明 (${e?.message || e})`);
        unknown.push(j); continue;
    }
    if (!r.ok) { console.error(`✗ ${j.target.canonical_name}: ${r.status} ${await r.text().catch(() => '')}`); failed.push(j); continue; }
    const body = await r.json().catch(() => null);
    if (Array.isArray(body) && body.length === 1) { console.log(`✓ ${j.target.canonical_name} (${j.hashes.length}枚)`); done.push(j); continue; }
    if (Array.isArray(body) && body.length === 0) {
        // 0行 = フィルタが当たっていない = 書き換わっていない
        console.error(`✗ ${j.target.canonical_name}: 該当行なし (名前の指定を確認してください)`);
        failed.push(j); continue;
    }
    // 複数行 (同名が2行) や本文が読めないケース。200 が返っている以上、書き換わっている前提で扱う
    console.error(`? ${j.target.canonical_name}: 更新結果を確認できません (${Array.isArray(body) ? `${body.length}行更新` : '本文なし'}) — 適用された可能性あり`);
    unknown.push(j);
}
console.log(`\n完了: ${done.length}/${jobs.size}キャラ`);
if (unknown.length > 0 || failed.length > 0) {
    if (failed.length > 0) console.error(`未適用 ${failed.length}件: ${failed.map(j => j.target.canonical_name).join('、')}`);
    if (unknown.length > 0) console.error(`要確認 ${unknown.length}件 (適用されたか不明): ${unknown.map(j => j.target.canonical_name).join('、')}`);
    const touched = [...done, ...unknown].map(j => j.target.canonical_name);
    console.error(`巻き戻すなら ${backup} の icon_paths / last_seen / is_confirmed を戻してください`
        + ` (書き換わった可能性があるのは ${touched.join('、') || 'なし'})`);
}
process.exit(unknown.length + failed.length === 0 ? 0 : 1);
