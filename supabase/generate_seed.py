#!/usr/bin/env python3
"""data/YYYY-MM.json から Supabase 用シードデータSQL を生成する。

Usage:
    cd supabase && python3 generate_seed.py
出力:
    supabase/03_seed_data.sql
"""
import json
import re
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'data'
OUT = Path(__file__).resolve().parent / '03_seed_data.sql'

# bossCode → ボス自身の属性
BOSS_CODE_TO_ATTR = {
    'H.S.T.A.': 'fire',
    'P.S.I.D.': 'water',
    'D.M.T.R.': 'iron',
    'Z.E.U.S.': 'electric',
    'A.N.M.I.': 'wind',
}
# ボス属性 → 弱点（PT想定属性）
WEAKNESS_MAP = {
    'fire': 'water', 'water': 'electric', 'iron': 'wind',
    'electric': 'iron', 'wind': 'fire',
}

# raid-config.json から月別 tier 情報を取得
with open(DATA_DIR / 'raid-config.json') as f:
    RAID_CFG = json.load(f)
BOSS_CLASS_BY_MONTH = RAID_CFG.get('bossClassByMonth', {})


def sql_escape(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"


def parse_boss_position(boss_type):
    """bossType の冒頭ローマ数字から boss_number(1-5) を推定"""
    if not boss_type:
        return None
    m = re.match(r'^(V|IV|III|II|I)', boss_type)
    if not m:
        return None
    return {'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5}[m.group(1)]


def infer_tier(month_key, boss_code, boss_number):
    """ボスの tier を推定:
    1. raid-config.json の bossClassByMonth に該当があればそれを使用
    2. なければ boss_number 3 と 5 を tyrant とする旧Discord botの規約
    """
    cfg = BOSS_CLASS_BY_MONTH.get(month_key, {})
    if boss_code in cfg:
        return cfg[boss_code]
    if boss_number in (3, 5):
        return 'tyrant'
    return 'lord'


def main():
    months = sorted([p.stem for p in DATA_DIR.glob('2026-*.json')])

    # ===== Step 1: 全プレイヤー名を収集 =====
    all_players = {}  # name -> latest_sync_level
    sync_by_season = {}  # month_key -> {player_name: sync_level}
    for m in months:
        with open(DATA_DIR / f'{m}.json') as f:
            d = json.load(f)
        sync_by_season[m] = {}
        for pl in d.get('players', []):
            name = pl.get('player')
            if not name:
                continue
            slv = pl.get('syncLevel', 0) or 0
            all_players.setdefault(name, slv)
            sync_by_season[m][name] = slv

    # ===== Step 2: SQL 生成 =====
    out_lines = [
        '-- ============================================================================',
        '-- しりすこPAD Seed Data (auto-generated from data/YYYY-MM.json)',
        f'-- Generated at: {datetime.now().isoformat()}',
        '-- Source months: ' + ', '.join(months),
        '-- ============================================================================',
        '',
        '-- 既存データを全削除してから投入（再実行可能にするため）',
        '-- ⚠ 本番運用後はコメントアウト推奨',
        'TRUNCATE TABLE',
        '    attacks, player_sync_levels, day_offs, availability,',
        '    finish_claims, fururi_simulation_scores, push_subscriptions,',
        '    player_damages, bosses, seasons, players',
        '    RESTART IDENTITY CASCADE;',
        '',
    ]

    # ===== Players =====
    out_lines.append('-- ===== Players =====')
    for name in sorted(all_players.keys()):
        out_lines.append(
            f"INSERT INTO players (name) VALUES ({sql_escape(name)});"
        )
    out_lines.append('')

    # ===== Seasons / Bosses / Attacks / SLv / SimScores =====
    out_lines.append('-- ===== Seasons + Bosses + Attacks =====')
    for m in months:
        with open(DATA_DIR / f'{m}.json') as f:
            d = json.load(f)
        md = d.get('metadata', {})

        # hard_date: extractedAt の日付を採用（あくまで取り込み日。正確な開幕日は未保存）
        extracted_at = md.get('extractedAt') or f'{m}-01'
        hard_date = extracted_at[:10]
        union_rank = md.get('unionRank')

        out_lines.append('')
        out_lines.append(f'-- --- Season {m} ---')
        meta_json = json.dumps({
            k: v for k, v in md.items()
            if k in ('extractedAt', 'totalDamage', 'playerCount', 'unionRank')
        }, ensure_ascii=False)
        out_lines.append(
            f"INSERT INTO seasons (month_key, hard_date, union_rank, metadata) "
            f"VALUES ({sql_escape(m)}, {sql_escape(hard_date)}, "
            f"{union_rank if union_rank is not None else 'NULL'}, "
            f"{sql_escape(meta_json)}::jsonb);"
        )

        # 各ボスを位置・属性ごとに収集
        boss_info = {}
        for pl in d.get('players', []):
            for a in pl.get('attacks', []):
                bc = a.get('bossCode')
                bt = a.get('bossType')
                if not bc or bc in boss_info:
                    continue
                pos = parse_boss_position(bt)
                boss_info[bc] = {'name': bt, 'pos': pos}

        for bc in BOSS_CODE_TO_ATTR.keys():
            boss_info.setdefault(bc, {'name': None, 'pos': None})

        used_positions = {info['pos'] for info in boss_info.values() if info['pos']}
        next_pos = 1
        boss_codes_sorted = sorted(boss_info.keys())
        for bc in boss_codes_sorted:
            info = boss_info[bc]
            if info['pos']:
                continue
            while next_pos in used_positions:
                next_pos += 1
            info['pos'] = next_pos
            used_positions.add(next_pos)
            next_pos += 1

        # Bosses (5体分)
        for bc in sorted(boss_info.keys(), key=lambda x: boss_info[x]['pos']):
            info = boss_info[bc]
            attr = BOSS_CODE_TO_ATTR[bc]
            weak = WEAKNESS_MAP[attr]
            tier = infer_tier(m, bc, info['pos'])
            out_lines.append(
                f"INSERT INTO bosses (season_id, boss_number, boss_code, name, attribute, weakness, tier) "
                f"SELECT id, {info['pos']}, {sql_escape(bc)}, {sql_escape(info['name'])}, "
                f"{sql_escape(attr)}, {sql_escape(weak)}, {sql_escape(tier)} "
                f"FROM seasons WHERE month_key = {sql_escape(m)};"
            )

        # SLv 履歴
        out_lines.append(f'-- SLv 履歴 ({m})')
        for name, slv in sync_by_season[m].items():
            out_lines.append(
                f"INSERT INTO player_sync_levels (season_id, player_id, sync_level) "
                f"SELECT s.id, p.id, {slv} "
                f"FROM seasons s, players p "
                f"WHERE s.month_key = {sql_escape(m)} AND p.name = {sql_escape(name)};"
            )

        # Fururi 模擬戦スコア
        sim = md.get('fururiSimulationScores') or {}
        if sim:
            out_lines.append(f'-- Fururi 模擬戦スコア ({m})')
            for bc, dmg in sim.items():
                out_lines.append(
                    f"INSERT INTO fururi_simulation_scores (season_id, boss_code, damage_raw) "
                    f"SELECT s.id, {sql_escape(bc)}, {int(dmg)} "
                    f"FROM seasons s WHERE s.month_key = {sql_escape(m)};"
                )

        # Attacks
        out_lines.append(f'-- Attacks ({m})')
        for pl in d.get('players', []):
            pname = pl.get('player')
            if not pname:
                continue
            for idx, a in enumerate(pl.get('attacks', []), start=1):
                bc = a.get('bossCode') or 'H.S.T.A.'  # 不明時はとりあえずH.S.T.A.に振る（移行時のみ）
                dmg = int(a.get('damage') or 0)
                level = int(a.get('level') or 1)
                chars = a.get('characters') or []
                chars_json = json.dumps(chars, ensure_ascii=False)
                # attack_date は hard_date を流用（厳密日付は不明）
                out_lines.append(
                    f"INSERT INTO attacks (season_id, player_id, attack_date, boss_number, boss_code, "
                    f"damage_raw, attack_number, level, characters) "
                    f"SELECT s.id, p.id, s.hard_date, b.boss_number, {sql_escape(bc)}, "
                    f"{dmg}, {idx}, {level}, {sql_escape(chars_json)}::jsonb "
                    f"FROM seasons s "
                    f"JOIN players p ON p.name = {sql_escape(pname)} "
                    f"LEFT JOIN bosses b ON b.season_id = s.id AND b.boss_code = {sql_escape(bc)} "
                    f"WHERE s.month_key = {sql_escape(m)};"
                )
        out_lines.append('')

    # ===== 最終シーズンを active に =====
    if months:
        latest = months[-1]
        out_lines.append('-- ===== 最終シーズンをアクティブに設定 =====')
        out_lines.append(
            f"UPDATE seasons SET is_active = TRUE WHERE month_key = {sql_escape(latest)};"
        )
        out_lines.append('')

    OUT.write_text('\n'.join(out_lines), encoding='utf-8')
    print(f'✅ Generated: {OUT}')
    print(f'   Months: {months}')
    print(f'   Players: {len(all_players)}')


if __name__ == '__main__':
    main()
