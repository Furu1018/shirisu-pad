// ============================================================================
// 月次JSON (data/YYYY-MM.json) の取り込み後チェック
// ----------------------------------------------------------------------------
// 使い方:  node scripts/check-monthly-json.mjs 2026-08
//
// 2026-08 の取り込みで「全プレイヤーの characters に同一のテンプレ編成が
// 複製される」生成バグが本番に入った (分析タブの編成比較が全員ウソになる)。
// 取り込んだら毎回これを流して同種の壊れ方を検出する。
//   1. bossCode が既知5コードか
//   2. 凸番号ごとの編成パターン多様性 (1パターンが過半数 = 複製バグの疑い)
//   3. characters のアイコンパスがリポジトリに実在するか
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(key || '')) {
    console.error('使い方: node scripts/check-monthly-json.mjs YYYY-MM');
    process.exit(2);
}
const file = path.join(root, 'data', `${key}.json`);
const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
const players = data.players || data.raidData?.players || [];
if (players.length === 0) {
    console.error('NG: players が空です');
    process.exit(1);
}

const KNOWN_CODES = new Set(['H.S.T.A.', 'P.S.I.D.', 'Z.E.U.S.', 'D.M.T.R.', 'A.N.M.I.']);
const problems = [];

// 1) bossCode (欠落も検出 — 分析タブのモーダルは bossCode の無い凸を黙って落とすため)
for (const p of players) {
    for (const a of (p.attacks || [])) {
        if (!a.bossCode) {
            problems.push(`bossCode 欠落: ${p.player} (${a.bossType || '?'}) dmg=${a.damage}`);
        } else if (!KNOWN_CODES.has(a.bossCode)) {
            problems.push(`未知の bossCode: ${p.player} ${a.bossCode}`);
        }
    }
}

// 2) 凸番号ごとの編成多様性 (編成が入っている人だけ母数にする)
const maxAtk = Math.max(...players.map(p => (p.attacks || []).length), 0);
for (let i = 0; i < maxAtk; i++) {
    const counts = new Map();
    let withTeam = 0;
    for (const p of players) {
        const chars = p.attacks?.[i]?.characters || [];
        if (chars.length === 0) continue;
        withTeam++;
        const sig = [...chars].sort().join('|');
        counts.set(sig, (counts.get(sig) || 0) + 1);
    }
    const top = Math.max(...counts.values(), 0);
    if (withTeam >= 4 && top > withTeam / 2) {
        problems.push(`凸${i + 1}: 同一編成が ${top}/${withTeam} 人 — テンプレ複製バグの疑い (2026-08 で実際に発生)`);
    }
}

// 3) アイコンパスの実在。Windows の fs は大文字小文字を無視して「ある」と答えるが、
//    GitHub Pages は case-sensitive で 404 になる — ディレクトリ一覧との完全一致で判定する
const dirListing = new Map();   // dir → Set(実ファイル名)
function existsExact(rel) {
    const abs = path.join(root, rel);
    const dir = path.dirname(abs);
    if (!dirListing.has(dir)) {
        try { dirListing.set(dir, new Set(fs.readdirSync(dir))); }
        catch { dirListing.set(dir, new Set()); }
    }
    return dirListing.get(dir).has(path.basename(abs));
}
let iconTotal = 0, iconMissing = 0;
for (const p of players) {
    for (const a of (p.attacks || [])) {
        for (const u of (a.characters || [])) {
            iconTotal++;
            if (typeof u !== 'string' || !existsExact(u)) iconMissing++;
        }
    }
}
if (iconMissing > 0) problems.push(`characters のアイコンパス ${iconMissing}/${iconTotal} 件が実在しない`);

const atkCount = players.reduce((s, p) => s + (p.attacks || []).length, 0);
console.log(`${key}: プレイヤー ${players.length}人 / 凸 ${atkCount}件 / アイコン参照 ${iconTotal}件`);
if (problems.length) {
    console.error('NG:\n  ' + problems.join('\n  '));
    process.exit(1);
}
console.log('OK: 既知の壊れ方は検出されませんでした');
