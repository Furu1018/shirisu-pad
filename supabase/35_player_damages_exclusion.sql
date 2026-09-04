-- ============================================================================
-- Phase: 模擬提出の運営除外 (異常値・誤入力を運営がはじく)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全・レイド中でも即時)
--
-- 何が変わるか:
--   メンバーが誤った値 (桁違い等) を模擬で提出したまま放置すると、運営側でその値を
--   プラン算出・締め凸候補・残凸表・事前比較・提出状況から外す手段が無かった
--   (本人になりすまして編集/削除するしかなかった — 2026-09-05 第44回ハード日に顕在化)。
--   行を消さずに「除外」の印だけ付ける列を足す。
--
--   excluded_at     TIMESTAMPTZ  除外した時刻 (NULL = 通常)
--   excluded_by     TEXT         除外した運営の表示名
--   excluded_reason TEXT         理由 (本人の模擬パネル・編成編集モーダルに表示される)
--
-- 読み取り側 (supabaseLoadOpsDashboardData / _selectUsableDamages) が excluded_at IS NOT NULL の行を外す。
-- 本人がその行を保存し直す (提出・単値保存・測定削除) とクライアントが 3列を NULL に戻す = 修正すれば自動復帰。
-- 凸報告の焼き戻し (characters だけの更新) では戻さない (値を見直していないため)。
-- ADD COLUMN (NULL 既定) はメタデータ変更のみで、既存行の書き換えもロックも発生しない。
-- 未適用の環境: 読み取りは除外なしに静かに劣化し、🧹除外の操作だけがエラーで適用を案内する。
-- ============================================================================

ALTER TABLE player_damages ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;
ALTER TABLE player_damages ADD COLUMN IF NOT EXISTS excluded_by TEXT;
ALTER TABLE player_damages ADD COLUMN IF NOT EXISTS excluded_reason TEXT;

NOTIFY pgrst, 'reload schema';   -- API に即認識させる (忘れると列が見えず 35未適用扱いのまま)
