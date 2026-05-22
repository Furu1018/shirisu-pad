# Edge Function: analyze-image セットアップ手順

Anthropic Haiku Vision を呼び出すプロキシです。
PADフロントは `supabase.functions.invoke('analyze-image', ...)` でこれを叩きます。

## デプロイ手順（Supabase Dashboard 経由・5分）

### 1. Edge Functions 画面を開く
1. Supabase Dashboard を開く
2. 左メニュー（船のような ⚓ アイコン）の **Edge Functions** をクリック

### 2. 新しい関数を作成
1. 右上の **「Deploy a new function」** または **「Create a new function」** をクリック
2. 表示方法を聞かれたら **「Via Editor」** を選択（ブラウザ内のエディタ）

### 3. 名前と内容を入力
- **Function name**: `analyze-image` （**必ず半角・ハイフン区切り**でこの名前にしてください）
- **Code エディタ**: このフォルダの `index.ts` の中身を全部コピペ
- (HTTP Verify JWT 設定: **OFFにする**。フロントが anon キーで呼ぶため。
  画面によっては「Verify JWT with legacy secret」をオフ、または
  「Invoke without authentication」の選択肢がある)

### 4. デプロイ
- **「Deploy function」** をクリック
- 数十秒待つと "Deployed" 状態になる

### 5. シークレットを確認
- 既に Edge Function Secrets に `ANTHROPIC_API_KEY` がセット済みであることを確認
- セットしてない場合は: **Settings → Edge Functions → Secrets → Add new secret**

### 6. PADから動作テスト
ブラウザのF12コンソールで:
```js
window.supabaseTestAi()
```
が用意されます (フロント側に追加した場合)。

## トラブルシュート

- **404**: 関数名が `analyze-image` と一致しているか確認
- **500: ANTHROPIC_API_KEY not set**: Secrets に変数が無い or 名前が違う
- **502: Anthropic API error**: APIキーが無効 / クレジット切れ / モデル名間違い
- **CORS**: 関数コードの CORS_HEADERS は `Access-Control-Allow-Origin: *` で開放済み

## 料金イメージ (Haiku Vision)
2026時点で 1画像 ≒ $0.001〜0.005 程度 (画像サイズと出力長による)。
NIKKE凸結果1枚なら 1円未満で済む見込み。
