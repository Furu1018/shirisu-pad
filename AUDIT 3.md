# しりすこPAD システム監査記録

- **対象スナップショット**: `0fc2521` 〜 `7cfa05c`（監査実施時の main HEAD = `7cfa05c`）
- **実施日**: 2026-07-15
- **監査体制**: 2モデルによる独立監査 + 突き合わせ
  - **1次監査**: Claude（Opus 4.8 で初回作成 → Fable 5 でアドバーサリアル自己検証）
  - **独立検証**: Codex（gpt-5.6-sol）による読み取り専用の再監査（約1時間、ファイル実読 + grep/wc による一次証拠採取）
- **性質**: 読み取り専用。この監査ではコード修正・SQL実行・git操作は一切行っていない。本ドキュメントは**記録**であり、修正はまだ入れていない。

> **重要な未検証事項**: 本監査は SQL ソースファイル上の設計を検証したもので、**本番 Supabase の実効状態**（全マイグレーション適用、実際の GRANT、RLS 有効フラグ、Edge Function の JWT 設定、Storage バケット実体）は SQL 未実行のため未検証。ソース設計＝本番挙動とは限らない点に留意。

---

## 0. 突き合わせ結論（最優先アクション）

2モデルの監査を突き合わせた結果、**当初の「緊急対応必要な項目ゼロ／最大の負債はモノリシック構造」という総評は撤回**し、以下に優先順位を組み替える。

| 優先 | 項目 | 根拠 | 状態 |
|---|---|---|---|
| 🔴 **P0** | **保存型 XSS**（anon 書込み × 未エスケープHTML挿入 = JS実行） | `index.html:5487-5491`, `index.html:13698-13707` | 未修正 |
| 🔴 P1 | 週次バックアップは **17テーブル + Storage を対象にする必要**（現状の手動バックアップは14/17） | `js/supabase-client.js:964-1014` | 計画中 |
| 🟠 P2 | Edge Functions が無認可（analyze-image は汎用AIプロキシ、send-push は通知代理） | `analyze-image/index.ts:111-137`, `send-push/index.ts:43-79` | 設計判断だが要再評価 |
| 🟡 P3 | index.html モノリシック構造（退行の温床） | 実測 16,007行 | 漸進返済 |
| 🟡 P4 | テストがソルバーのみ（ふるり値計算/OCR後処理/復元が未テスト） | `tests/run-tests.mjs`（34ケース） | 未着手 |
| 🟢 P5 | 死にコード（4→**少なくとも12関数**）、activity_log改ざん可能、manifest配色、.git肥大67MB、CDN の SRI なし、README陳腐化 | 各節参照 | 未着手 |

**最優先は P0 の保存型XSS 2箇所の修正**。すぐ隣に安全なヘルパー（`jsonAttr` / `escapeHtml`）があるのに使われていない箇所があり、これは設計判断ではなく単なるバグ。内輪運用でもメンバー名欄・アバター文字列経由でスクリプトを仕込める現実的リスク。

---

## 1. 構成マップ（両モデル一致）

```
しりすこPAD (GitHub: Furu1018/shirisu-pad → GitHub Pages 公開・PUBLICリポジトリ)
├─ index.html            16,007行 — UI・CSS・アプリロジックの単一ファイル本体
│                                    (CSS 29-2472 / 本文 2474-16006 / インラインJS 4803-15981)
├─ js/
│  ├─ supabase-client.js  2,681行 — DB I/O層。window.supabaseXxx を公開 (supabase接頭辞72 / 全window公開81)
│  └─ optimal-plan.js       388行 — 凸プランソルバー(純関数・DOM/Supabase非依存・唯一のテスト対象)
├─ sw.js                    113行 — Service Worker (Push受信/通知タップ誘導/画像キャッシュ)
├─ manifest.json                  — PWA マニフェスト
├─ supabase/
│  ├─ 01〜23_*.sql               — マイグレーション23本 (17テーブル)
│  ├─ 99_check_applied.sql       — 適用状況チェッカー (本番で全適用を確認済み)
│  └─ functions/                 — send-push / analyze-image (デプロイslug: dynamic-service)
├─ tests/run-tests.mjs           — 34ケース (ソルバーのみ)
├─ .github/workflows/pages.yml   — Actions デプロイ + ビルドSHA注入
├─ .claude/skills/               — 作業手順スキル4本
└─ data/*.json                   — 月次確定データ 2026-01〜07 + 設定JSON
```

**責務分離**: 純計算(optimal-plan)とDB I/O(supabase-client)は分離済み。それ以外——画面描画・状態管理・ふるり値計算・OCR後処理・シェア画像生成——は全部 index.html に同居。

---

## 2. データの流れ（両モデル一致）

- **起動時**: Supabase シーズン + 直近5ヶ月の `data/YYYY-MM.json` を並列取得（`index.html:13927-13953`）。同月は JSON で上書きだが metadata は `{...Supabase, ...JSON}` でマージ継承（`index.html:13954-13965`）
- **モジュール読込**: CDN二重フォールバック esm.sh→jsDelivr（`js/supabase-client.js:13-22`）
- **ライブ運用**: `_opsDashboardCache` に60秒キャッシュ、10秒ポーリングで協力状況+締凸依頼を更新、3回に1回シーズン/ボスHP再取得（`index.html:8023-8248`）、ソルバー実行前に60秒鮮度保証（`11815-11823`）
- **書き込み**: すべて `window.supabaseXxx` → PostgREST（publishableキー）
- **永続化**: localStorage + Cache API 2系統（画像キャッシュ `shirisu-img-v1` / 通知遷移予約 `sp-nav`）
- **外部連携**: Push（send-push・service role）、OCR（analyze-image・Claude Haiku）。**秘密鍵はソースに存在せず全て環境変数**（VAPID秘密鍵・ANTHROPIC_API_KEY・SERVICE_ROLE_KEY）

---

## 3. Supabase 権限モデル（重点検証・Codexが深掘り）

### 3.1 RLS ポリシー（SQLソース上）

`CREATE TABLE IF NOT EXISTS` の実測は17件。全テーブルに以下のポリシーが付与される（`supabase/02_rls.sql:33-37` の DO ループ + 後続SQL）:

```sql
CREATE POLICY "anon_all" ON <table>
FOR ALL TO anon
USING (true)
WITH CHECK (true)
```

| 群 | テーブル | ポリシー定義箇所 |
|---|---|---|
| 初期11 | players, player_damages, seasons, bosses, player_sync_levels, attacks, day_offs, availability, finish_claims, fururi_simulation_scores, push_subscriptions | `02_rls.sql:27-37` |
| 後続 | push_notifications_log | `06_push_notifications_log.sql:25-29` |
| 後続 | nikke_characters | `07_...sql:28-34` |
| 後続 | finish_coordinations | `11_...sql:23-27` |
| 後続 | published_plans | `17_published_plans.sql:20-24` |
| 後続 | activity_log | `19_activity_log.sql:24-28` |
| 後続 | finish_requests | `22_finish_requests.sql:24-28` |

→ **SQLソース上は「17テーブルすべて anon CRUD 全許可」は正確**。CLAUDE.md に明記された意図的設計（約30名内輪・認証なし・自己申告ID）。

**未検証（SQL実行禁止のため）**: SQL群に明示的 `GRANT` が無い（`rg 'GRANT ...'` → 出力なし）。RLSポリシーとテーブルGRANTは別レイヤであり、本番の実効権限を断定するには `pg_policies` / `pg_class.relrowsecurity` / `role_table_grants` の確認が必要。

### 3.2 publishable キーの露出

`js/supabase-client.js:24-27` に URL とキーをハードコード。`index.html:27` から公開読込、Pages artifact もリポジトリ直下をアップロード（`pages.yml:39-41`）。キー公開自体は前提として正しいが、**安全性は RLS・GRANT・Edge Function 認可に依存**し、本件は RLS 全開放のため匿名 REST アクセスが容易。

### 3.3 Edge Functions の認可設計

**send-push**（`supabase/functions/send-push/index.ts`）:
- CORS任意オリジン（`:27-31`）／JWT・運営者チェックなし（`:43-64`）／全員送信・任意 playerIds 指定可能（`:64-79`）／`ignoreAvailability` で時間帯フィルタ無効化可能（`:71-72`）
- → 秘密鍵はソースになし（環境変数）だが、**関数自体が無認可の「通知送信権限代理」**。第三者がユニオン全員へ通知スパム可能。

**analyze-image**（`supabase/functions/analyze-image/index.ts`）:
- CORS任意オリジン（`:11-15`）／関数内認証なし（`:111-123`）／呼出者が `prompt`・`model` を指定可能（`:123-132`）／`context` で任意テキスト推論可能（`:191-212`）／README が JWT検証OFF を指示（`README.md:17-21`）
- → **OCR専用ではなく、任意モデル・プロンプト・テキストを受け付ける汎用・無認可 Anthropic API プロキシ**。公開キーを知る第三者が Anthropic クレジットを任意用途で消費可能。許可リスト・レート制限・呼出者認可なし。

### 3.4 Storage（avatars バケット）

`storage.objects` に SELECT/INSERT/UPDATE/DELETE の4ポリシー、いずれも `TO public`・所有者制約なし（`14_avatar_storage_policies.sql:19-38`）。任意利用者が任意オブジェクトをアップ・更新・削除可能。バケット作成と Public 設定は Dashboard 手動作業（実体は未検証）。

### 3.5 公開 RPC

`restore_fix_sequences()` は `SECURITY DEFINER`（`23_restore_helpers.sql:12-17`）で anon にも実行権（`:32`）。全データ復元RPCではないが、無認証利用者が採番シーケンスを変更できる追加の攻撃面。

### 3.6 秘密鍵漏洩

`service_role` / `anthropic_api_key` / `vapid_private` 等の秘密値そのものはソースに検出されず（環境変数参照のみ）。**「秘密鍵漏洩なし」は確認済み**。ただし後述のとおり `push_subscriptions` の購読認証素材は anon SELECT 対象。

---

## 4. Codex が指摘した見落とし（1次監査の弱点）

### 4.1 🔴 保存型 XSS（最重要・P0）

プレイヤー名は空白除去以外の検証なしで DB 保存（`js/supabase-client.js:361-369,392-399`）。その値が単一引用符のイベント属性へ `JSON.stringify` **だけ**で埋め込まれている:

```html
onclick='selectPlayerFromModal(${p.id}, ${JSON.stringify(p.name)})'
```

根拠: `index.html:5487-5491`。`JSON.stringify` は `'` を HTML属性用にエスケープしないため、名前に `' onmouseover='...` 等を入れると属性境界を破壊できる。**直後に安全な `jsonAttr` ヘルパーがあるのに、この箇所では使われていない**（`index.html:5498-5503`）＝設計判断ではなく単なるバグ。

さらに `players.avatar_character` は外部キーも CHECK も無い TEXT（`supabase/13_player_avatars.sql:17-23`）で、未エスケープで `innerHTML` に入る（`index.html:13648-13650,13698-13707`）。CSP も未確認（`rg 'Content-Security-Policy|integrity='` → 出力なし）。

→ 実DB が anon 書込み可能なら**保存型 XSS は現実的リスク**。「緊急対応ゼロ」を覆す重要度。

### 4.2 push_subscriptions の購読認証素材が匿名 SELECT 可能

`push_subscriptions` は `endpoint / p256dh / auth` を保持（`supabase/01_schema.sql:118-125`）し `FOR ALL TO anon`（`02_rls.sql:27-35`）。サーバ秘密鍵は漏れていなくても、購読ごとの認証素材が公開対象。

### 4.3 バックアップが 14/17 テーブル（P1）

アプリ内バックアップ対象は14テーブル（`js/supabase-client.js:967-972`）。**欠落**: `published_plans` / `activity_log` / `finish_requests` / Storage の `avatars`。復元対象も同じ14。
→ 週次バックアップ実装では **17テーブル + Storage を対象にする**こと。

### 4.4 activity_log が改ざん可能（防御線にならない）

コメント上は「INSERT専用」（`19_activity_log.sql:3-5`）だが**実ポリシーは `FOR ALL`**（`:24-28`）。攻撃者が本体データとログを同時削除できるため、改ざん耐性のある監査証跡にならない。

### 4.5 99_check_applied.sql の権限検査が浅い

RLS検査は `players` に `anon_all` が1件あるかだけ（`:32-35`）。17テーブル全ポリシー・`USING/WITH CHECK` の実体・RLS有効状態・anon GRANT・Storage 4ポリシーは未検証。チェッカー成功だけでは権限モデルを実環境で証明できない。

### 4.6 死にコードは4→少なくとも12関数

1次監査の4関数（`supabaseDeletePlayerDamage` / `supabaseFindCharacterByIconPath` / `supabaseGetPlayerById` / `supabaseUpdateAttackBoss`）に加え、whole-word 検索で定義以外の参照が無い関数:
`renderAttrIcon`(5974), `openMySettingsModal`(6079), `handleMyAvailToggle`(7887), `attrToCounterBoss`(8354), `handleMyNextAttackRelease`(8521), `renderSettingsLocalInfo`(9800), `openMemberManageModal`(13356), `renderMyDamageInputs`(6325・ROADMAP自身が休眠と記載)。

### 4.7 その他

- **CDN が SRI なし**: Chart.js はバージョンなしURL（`index.html:25`）、Supabase JS は `@2` 固定のみ、`integrity=` なし → 供給元侵害への考慮なし
- **README 陳腐化**: 存在しない `data/latest.json` を案内（`README.md:19-23`）、公開ページを `しりすこPAD.html` と記述（`:7-11`）。実体は `index.html` と `data/YYYY-MM.json`

---

## 5. Codex が指摘した「1次監査の過剰・不正確」

1次監査（Fable/Opus）の数値ラベルには不正確な表現があった。正確には:

| 1次監査の表現 | 正確な表現（Codex実測） |
|---|---|
| 状態変数145 | トップレベル**宣言文**145（let 86 + const 59）、識別子146（1行2宣言 `15549`）。うち可変 let は86行。const には設定値・配列・関数・Mapも含む |
| 関数399 | **名前付き function 宣言**399。アロー関数 `=>` は759、無名 `function(` は5。関数総数ではない |
| インラインstyle 1760 | 文字列 `style="` は1760（正）。生成される実質 style 属性まで含めると1761（`10162`） |
| supabase-client 75関数 | supabase接頭辞72 / 全window公開81。75は分類次第 |
| ポーリング入力競合（未対策問題） | **既に修正済み**（`ROADMAP.md:28-30`、二重ガード `index.html:10797-10813`）。「退行リスク」は妥当だが「現存不具合」は未検証 |
| 全17テーブルが実際にanon全許可 | SQL上の意図は正確だが**本番の実効権限は未検証**（明示GRANT無し・SQL実行禁止） |
| analyze-image Edge Function | 論理名は正しいが**デプロイslugは `dynamic-service`**（`js/supabase-client.js:2372-2379`） |

---

## 6. SW / PWA（両モデル一致・健全）

- キャッシュは同一オリジンのキャラ画像・属性画像・アイコンのみ cache-first（`sw.js:27-50`）。install時のHTMLプリキャッシュなし（`:12-14`）→ **HTML/JS/データは非キャッシュ = push で即反映と矛盾しない**
- **オフライン起動は不可**（ナビゲーション要求を処理しない）。割り切りだが未明文化
- リロード旧版問題は HTTPキャッシュ由来 → ビルドSHA注入（`pages.yml:33-35`）+ `no-store` 比較（`index.html:15348-15368`）で検知
- 通知タップ誘導は postMessage（`sw.js:100-105`）+ Cache `sp-nav` 遷移予約（`:91-98`, 消費 `index.html:15443-15455`）で二重化 = iOS PWA 凍結対策。**iOS の落とし穴を正しく回避**
- manifest 配色 `#FFFBFE / #1976D2`（`manifest.json:7-8`）が現HTML `#fbfcfd`（`index.html:15`）・設計ガイド（`CLAUDE.md:57`）と不一致（実害なし）

---

## 7. index.html モノリシック構造（重点検証・両モデル一致）

**実測値**（Codex による再計測）:

| 指標 | 実測 |
|---|---:|
| 行数 | 16,007 |
| 名前付き function 宣言 | 399 |
| トップレベル宣言文 / 識別子 | 145 / 146 |
| 可変 let | 86行・87識別子 |
| literal `style="` | 1,760 |

**同居しているもの（切り出し候補）**:
- **ふるり値計算**: `calculateFururiScore`(14947-14956), `buildFururiBaseMap`(14962-15038), `calculatePerAttackFururi`(15047-15057), `getFururiBaseTotalsByMode`(15060-15076), `runFururiSimulator`(14759〜)
- **OCR後処理**: `fuzzyResolveCharacter`(6916-6932), `_ocrAttackMultiAndMerge`(9191-9222), `handleMyBulkAttackOcrUpload`(9228-9253), `fsimOcrUpload`(14622-14657), `detectBossCodeFromText`(14659-14735)（API送信自体は `js/supabase-client.js:2372-2387`）
- **シェア画像生成**: `handleOpsPlanImageExport`(11327-11360), `_renderPlanToImage`(11362-11550), `_renderPlanToImageTimetable`(11554-11777)

**負債の本質**（Codex の結論）: 保守性だけでなく、**未テストの純計算・OCR後処理・動的HTML生成・セキュリティ境界が同一スクリプト内で交差**している点。
**返済戦略**: 一括リライトではなく漸進切り出し（ふるり値計算 → OCR後処理 → シェア画像生成の順、③shirisu-pad-global が手本）。切り出したモジュールは optimal-plan と同様に node テストで守る。

---

## 8. 推奨アクション（優先順）

1. **🔴 P0: 保存型XSS 2箇所を修正** — `index.html:5490` を `jsonAttr` に、`index.html:13707` の `avatar_character` を `escapeHtml` に。小さな修正だが最優先。
2. **🔴 P1: 週次バックアップを 17テーブル + Storage 対象で実装**（別途計画中の Actions ワークフロー。欠落3テーブル `published_plans`/`activity_log`/`finish_requests` を必ず含める）
3. **🟠 P2: Edge Functions の無認可を再評価** — analyze-image のモデル/タスク許可リスト・レート制限、send-push の簡易認可。内輪運用でも analyze-image は API コスト実害の余地あり。
4. **🟡 P3: ふるり値計算を純関数化 + テスト**（`js/fururi-calc.js` 切り出し）
5. **🟡 P4: index.html の漸進モジュール化**（大改修する画面から）
6. **🟢 P5: 死にコード12関数の整理**（`day_offs`/`finish_claims` は復元リストと連動するため注意）、activity_log ポリシーを INSERT 限定に、manifest 配色、README 更新、CDN の SRI 付与検討

---

## 付記: 監査手法メモ

- 2モデルの独立監査を突き合わせる方式が有効に機能した。1次監査（Claude）が構造・データフロー・運用リスクを広くカバーし、独立検証（Codex/Sol）が**セキュリティ境界の深掘りと数値の再計測**で1次監査の弱点（保存型XSS の見落とし、バックアップの取りこぼし、数値ラベルの不正確さ）を補正した。
- 本記録の全主張はファイル実読・grep・wc による一次証拠に基づく。断定できない項目は「未検証」と明記した。
- **本番DBの実効状態の検証**（SQL実行による GRANT・RLS有効フラグ・ポリシー実体の確認）は次の課題として残る。
