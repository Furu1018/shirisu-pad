---
name: shirisu-supabase-migration
description: しりすこPADでSupabaseにテーブル・カラムを追加するときの手順とテンプレート。マイグレーションSQLの書き方、クライアント関数の慣習、ユーザーへの適用依頼まで。
---

# Supabase マイグレーション (しりすこPAD)

## SQLファイルの作法

`supabase/NN_name.sql` (連番)。**必ず再実行しても壊れない (冪等)** ように書く:

```sql
-- ============================================================================
-- Phase: 機能名
-- 何のためのテーブルかを1〜2行で
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

CREATE TABLE IF NOT EXISTS xxx (
    id BIGSERIAL PRIMARY KEY,
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    ...
);

CREATE INDEX IF NOT EXISTS idx_xxx_yyy ON xxx(...);

ALTER TABLE xxx ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON xxx;
CREATE POLICY "anon_all" ON xxx FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON xxx;
CREATE POLICY "authenticated_all" ON xxx FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';   -- API に即認識させる。忘れると 404 になる
```

RLS は anon 全許可 (認証なしの内輪運用という設計判断。変えない)。

## 適用は自動化されていない — 必ずユーザーに依頼

マイグレーションは**ユーザーが SQL Editor で手動実行**する運用。実装したら:
1. 依頼時に SQL の中身と「何をするか」を説明する
2. クライアント側は未適用環境で**静かに劣化**させる — 機能ボタンの catch で
   「初回は supabase/NN_xxx.sql を SQL Editor で実行してください」と案内する
3. CLAUDE.md の「supabase/」の項に前提SQLとして追記する

## クライアント関数の慣習 (js/supabase-client.js)

- `window.supabaseXxx = async function (...)` 形式で公開。呼び出し側は index.html
- **カラム未マイグ環境へのフォールバック**: 新カラムを select/insert して失敗したら、
  そのカラム抜きでリトライする (既存コードの player_damages.characters の扱いを参照)
- 表示用の名前は JOIN せず**非正規化カラム**で持ってよい (例: published_by_name)。
  内輪ツールなので整合性より読み出しの単純さを優先する
- 「最新1件だけ保持」型のテーブルは insert 後に旧行 delete で掃除する

## 主キー変更を伴うマイグレーション (21_player_damages_slots の実例)

player_damages の PK を (player_id, attribute) → (player_id, attribute, slot) に変えた際の教訓:

- PK/unique が変わると **既存の upsert の onConflict が全滅する**
  (conflict target は unique 制約と一致していないと PostgREST がエラーを返す)
- 対策: そのテーブルへの書き込みを1つのヘルパーに集約し (`_upsertPlayerDamages`)、
  新 onConflict → 失敗したら旧 onConflict にフォールバック。SQL適用とクライアント更新を同一デプロイで出す
- 「同じテーブルに書く別経路」(スナップショット復元・テストシード・前回引継ぎなど) を
  grep で全部洗い出してからやること。1箇所でも旧 onConflict が残ると適用後に壊れる

## Edge Function を触ったとき

`supabase/functions/` の変更は push しても反映されない。**再デプロイが必要**なことを
ユーザーに伝える (例: send-push の通知時間帯フィルタ)。
