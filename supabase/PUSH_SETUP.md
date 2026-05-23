# Push通知 セットアップ手順 (Phase 6)

しりすこPADで Web Push 通知を使えるようにするためのワンタイム設定です。
**運営の人が1回だけ** やればOKです。

## 1. VAPIDキーペアを生成

Web Push に必要な公開鍵 + 秘密鍵のペアを作成します。

### 一番ラクな方法: ブラウザで生成

1. https://vapidkeys.com/ を開く
2. **「Generate VAPID Keys」** をクリック
3. 表示された **Public Key** と **Private Key** をメモ
   - Public Key: フロントエンドに埋め込む（公開してOK）
   - Private Key: Edge Function Secrets に登録（**絶対に公開しない**）

### CLI派の方

```bash
npx web-push generate-vapid-keys
```

## 2. フロントエンドに Public Key を埋め込む

`js/supabase-client.js` の以下の行を編集:

```js
window.SHIRISU_VAPID_PUBLIC_KEY = '';   // ← ここに Public Key を貼る
```

→ commit & push して GitHub Pages 反映を待つ。

⚠️ Public Keyは公開しても安全な仕様ですが、変更したら全メンバーが再購読する必要があります。

## 3. Supabase に Private Key を登録

Phase 6b で Edge Function から Push 送信する時に使います。

1. Supabase Dashboard → **Edge Functions** → **Secrets**
2. **Add new secret**
3. Name: `VAPID_PRIVATE_KEY` / Value: 生成した Private Key
4. もう1つ: Name: `VAPID_SUBJECT` / Value: `mailto:あなたのメールアドレス`
   (購読サービスへの連絡先、ダミーでもOK)
5. Save

## 4. Edge Function `send-push` をデプロイ (Phase 6b)

PADから実際に Push 通知を送るための Edge Function です。

1. Supabase Dashboard → Edge Functions → **Deploy a new function**
2. **Via Editor** を選択
3. **Function name** に `send-push` を入力
4. コード欄に下記URL の中身を全部コピー&ペースト:
   ```
   https://raw.githubusercontent.com/Furu1018/shirisu-pad/main/supabase/functions/send-push/index.ts
   ```
5. **Deploy function**
6. デプロイ後、**Settings** タブで **「Verify JWT with legacy secret」を OFF** に

⚠️ もし slug が `send-push` でなく別の名前で作られた場合は、フロント `js/supabase-client.js` の `sendPushNotification` の `slug` を実際の名前に合わせる必要があります。

### 動作確認

PAD → 運営タブ → 「📣 Push通知 一斉送信」 → タイトルと本文を入れて送信

## 5. (任意) PWA化: iPhoneでホーム画面追加→Push通知

iOS Safariは PWA でしか Push通知に対応しないため:

1. iPhone Safari でしりすこPADを開く
2. 共有メニュー → **「ホーム画面に追加」**
3. ホーム画面のアイコンから起動
4. マイページ → 「🔔 通知を有効にする」

これで他のアプリと同じように通知が届くようになります。

---

## 動作確認

- マイページ → 「🔔 Push通知設定」セクションに「✅ 有効化済み」と表示される
- 🧪 ローカル通知テスト → 通知バナーが画面に出る

ここまでで Phase 6a 完了。
次に Phase 6b（Edge Function から実際に Push を送る）に進みます。
