# しりすこPAD Supabase セットアップ手順

Discord bot から Supabase へ移行するための **Phase 0（基盤準備）** の手順です。
専門知識不要、コピペだけで完了します。

---

## 📋 やること（3ステップ）

1. SQLを3回コピペして実行（テーブル作成・RLS有効化・データ投入）
2. ブラウザで動作確認
3. 完了報告 → Phase 1 へ

所要時間: **10〜15分**

---

## Step 1: SQLをSupabaseで実行

### 1-1. SQL Editorを開く
1. https://supabase.com にログイン
2. 「SirisukoPAD」プロジェクトを開く
3. 左メニューの **SQL Editor**（< > アイコン）をクリック
4. 右上の **「+ New query」** を押す

### 1-2. スキーマSQL を実行
1. このリポジトリの `supabase/01_schema.sql` の **中身を全部コピー**
2. SQL Editor に貼り付け
3. 右下の緑色 **「Run」** ボタン（または Ctrl/Cmd + Enter）
4. 下に「Success. No rows returned」と出れば成功

### 1-3. RLS Policy SQL を実行
1. 同じくSQL Editorで「+ New query」
2. `supabase/02_rls.sql` の中身を全部コピー → 貼り付け → Run

### 1-4. シードデータ SQL を実行
1. 同じくSQL Editorで「+ New query」
2. `supabase/03_seed_data.sql` の中身を全部コピー → 貼り付け → Run
3. 約700行のINSERTが走るので、数秒待つ

---

## Step 2: 動作確認

### 2-1. Supabase Dashboard で確認
1. 左メニューの **Table Editor**（テーブルアイコン）をクリック
2. 左サイドに以下のテーブルが並んでいればOK:
   - `players` (42行) ← クリックして中身を確認
   - `seasons` (5行)
   - `bosses` (25行)
   - `attacks` (約450行)
   - `player_sync_levels` (約150行)
   - `fururi_simulation_scores` (4行)
   - その他空テーブル多数

### 2-2. しりすこPAD でブラウザ確認
1. ローカルなら `index.html` をブラウザで開く（または既にGitHub Pagesにpush済みでもOK）
2. F12 で **開発者ツール** を開いて **Console** タブを見る
3. `[Supabase] 接続OK` と表示されればOK
4. 詳細確認: コンソールで `supabaseTest()` を実行すると seasons/players/attacks の件数が表示される

---

## Step 3: 完了報告

うまくいったら Claude Code に「Supabase接続OK」と伝えてください。
Phase 1（既存ビューをSupabase経由に切り替え）に進みます。

---

## トラブルシュート

### `relation "xxx" does not exist`
→ 01_schema.sql が未実行 or 失敗しています。Step 1-2 から再実行。

### `permission denied for table xxx`
→ 02_rls.sql が未実行。Step 1-3 を実行。

### `duplicate key value violates unique constraint`
→ 03_seed_data.sql が既に実行済み。TRUNCATEから始まるのでもう一度実行すれば洗い替えOK。

### コンソールに `[Supabase] 初期接続に失敗:` が出る
- Network エラー: ブラウザでURL `https://djahnbzwupxcekneydid.supabase.co` を直接開くと {"hint": "..."} などのJSONが返るか確認
- JWT/Key エラー: `js/supabase-client.js` の `SUPABASE_PUBLISHABLE_KEY` が最新かチェック

---

## ファイル構成

```
supabase/
├── README.md                ← この手順書
├── 01_schema.sql            ← テーブル定義 (CREATE TABLE)
├── 02_rls.sql               ← 全テーブルにanon許可ポリシー
├── 03_seed_data.sql         ← 既存JSONからの初期データ投入 (自動生成)
├── 04_archived_column.sql   ← Phase 2a 追加: players.archived カラム
└── generate_seed.py         ← 03_seed_data.sql の再生成スクリプト
```

## 後から追加する移行SQL

`04_archived_column.sql` のような番号付き SQL は順番に SQL Editor で実行してください。
既存テーブルに対する `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` 形式なので
何度実行しても安全です。

データを更新したくなった場合: `python3 supabase/generate_seed.py` で再生成 → Supabaseで再実行。
