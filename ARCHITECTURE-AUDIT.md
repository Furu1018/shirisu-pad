# しりすこPAD アーキテクチャ監査記録（2026-07-21）と作り変えロードマップ

## この文書について

問い:「システム全体がスパゲッティコードになっていないか？ ちょっとした改修でエラーが起きないきっちりした作りに作り変えてもよい」。
Fable（Claude）＋Codex(gpt-5.6-sol) を併用し、**4本の独立監査**（Explore×3 + Codex×1）＋実測メトリクスで評価した。結論は完全に一致。

- これは**構造/保守性の監査**。`AUDIT.md`（2026-07-15のセキュリティ/機能監査）とは別物。
- **リアーキのアプローチと着手順はこの文書では確定させない**。この文書を土台に、着手時に改めて方針を決める。「決めるための材料」であり実装着手の合意ではない。

> **【決定 2026-07-22】ユーザー承認により B (段階的モジュール分割) で着手。**
> レイドまで日程に余裕があることを確認済み。推奨順どおり**ステップ1 (ドメイン境界の固定) から開始**。
> 進捗はこの文書の §4 各ステップに ✅ と完了日を追記していく。

---

## 1. 結論：スパゲッティか？ → **はい（単に巨大なだけでなく、真に絡み合っている）**

| 指標 | Codex評価 | 補足 |
|---|---|---|
| 保守性 | **3/10** | js/optimal-plan.js と supabase-client.js は良い分離。本体index.htmlが問題 |
| 変更容易性 | **2/10** | 変更の影響範囲を静的に(コードから)絞れない＝スパゲッティの定義そのもの |

`js/optimal-plan.js`（純関数ソルバー・テスト有）と `js/supabase-client.js`（DB I/O）は**良い分離**。問題は**本体 index.html** に集中している。

### 実測メトリクス（2026-07-21時点）
- index.html **17,025行**（CSS 2,451 / 静的HTML 約2,400 / 単一インライン`<script>` 12,135）
- **単一の`<script>`に292のトップレベル関数が同一グローバルスコープで同居**（モジュール境界がファイル内に無い）
- トップレベル状態変数 165（**可変`let` 96**）
- インライン`onclick` 308 + 他ハンドラ34 = **342**（イベント委譲は**0**）
- インライン`style=` **1,856**（デザインシステムがCSSクラスに集約されず散在）
- `innerHTML`代入 **209〜212**
- ビルドステップ **なし**（生ESM + scriptタグをGitHub Pagesがそのまま配信）
- テスト: `js/optimal-plan.js` の**約55〜59件のみ**。他は全て無防備

---

## 2. 「小改修で別の場所が壊れる」構造的原因 トップ5（4監査が一致）

### ① 神オブジェクト `_opsDashboardCache`（index.html:11021 付近）
- 30箇所以上が読み書き、**13箇所以上で `= null` 無効化**、ポーリングが `.bosses` を直接部分上書き(8798-8808 付近)。
- ops描画・締め凸・ソルバー・マイページSLv/レーダー・HP更新・代理凸が同一オブジェクトに依存。
- 「どの操作が何を無効化すべきか」が呼び出し側に散在＝**キャッシュではなく無契約の暗黙アプリ状態**。無効化を1つ足し引きすると別画面/ポーリングが古い or 空データを掴む。

### ② タブ切替↔スワイプ↔CSS↔PTR の三位一体
- `switchTab`(5422 付近) が active class/スクロール保存/描画キャッシュ/再描画を一括。後段でbottom-nav同期のため関数自体をラップ。
- スワイプ(`_swipe` 16525-16800 付近)が隣タブを `position:fixed`+`transform` 直書き、`header.offsetHeight` をJS実測して座標に流用。
- `swipe-no-anim` クラスの**所有権が switchTab と finish() の2関数に分裂**、CSS `.tab-content.swipe-no-anim.active{animation:none}`(286 付近) と三位一体。scrollTo が3段(同期→finish内→rAF)。
- → 「タブ追加」「ある要素を横スクロール化」「アニメ変更」が JS/CSS/除外セレクタ/scroll復元/ゴーストクリック抑止をまたぐ変更になる。**今一番痛んでいる箇所**（プルプル拡大縮小・ちらつきは全部ここ）。

### ③ innerHTML全再描画 + インライン onclick で DOM の寿命が短い
- 308ハンドラがHTML文字列とグローバル関数名に結合、209箇所の`innerHTML`が部分画面を破棄・再生成。
- 再描画でイベントは文字列内onclickで復活するが、**フォーカス/入力中テキスト/スクロール/選択/一時エラー表示は毎回失われる**。
- → 「5文字打つと入力解除」(commit ec886e3)の温根。画面を増やすたびに `_userIsTyping()`/`_opsBossEditingNum` のような保護を再発明する羽目に。XSSも未エスケープ連結が大規模ゆえ安全ヘルパーの適用漏れとして同根。

### ④ 非同期レース対策が「事故った関数だけ」への後付け
- 入っている: `_myPubRenderSeq`(配信プラン)、散布図`chartRef`同一性ガード、`_userIsTyping`(ボス編集)、Supabaseモジュール待機ポーリング。
- **入っていない**: `renderOpsDashboard`/`renderMyDamagePanels`/`renderMyFururiRadar`/`renderMyAttacks` 等。既定でレース無防備。
- → ガードの有無が関数ごとにまちまち。新しい非同期renderを足すと既定で壊れる。横展開されていないのが**次の小改修で再発する最大の弱さ**。

### ⑤ `boss.attribute`（ボス本来の属性）と `boss.weakness`（持っていくPT属性）が型無しの裸文字列
- 意味が違う値を同じ`string`で扱い、区別は**人間向けコメントのみ**。誤用しても型/テスト/API境界で止まらない。
- 旧データ用 `BOSS_ATTRIBUTES.attribute` は「PT想定属性」という**さらに別の意味**で三つ巴。相性仕様変更・OCR補正・季節例外で静かに誤表示/誤候補化。過去の取り違えバグの正体。

**git履歴が「小改修→退行」の直接証拠**: 0170c7d(プルプル), c8c208d(ちらつき), ec886e3(入力破壊), 8fe8fe2(横スクロール暴発), 688484f/bbaf709(ソルバーのロジックバグ) — 全部この構造から出た事故。

---

## 3. リアーキ選択肢の比較（4監査の推奨は一致して **B**）

| 選択肢 | 効果 | リスク | 判断 |
|---|---|---|---|
| **A. フルスクラッチ** | 最もきれい | 稼働中PWAの全機能・例外処理・運用知を再実装。単独開発に非常に危険 | **非推奨（全員一致）** |
| **B. 段階的モジュール分割** | 高い。挙動を保ったまま依存を減らす | 移行中は新旧が共存 | **推奨（全員一致）** |
| **C. Vite等ビルド導入** | 型検査/バンドルの土台 | ビルド/デプロイ/PWAキャッシュの責務増。構造問題自体は解決しない | Bの後に必要なら |
| **D. 現状維持+規律** | 直近コスト最小 | 全再描画/グローバル/レースを規律だけでは封じられない | 短期凍結時のみ |

**B（段階的モジュール分割・ビルドレスESM）** が推奨。GitHub Pages/ビルドなしのまま、ネイティブESMで `js/domain/` `js/state/` `js/features/` を直接配信できる。

### 手本は既にある：`shirisu-pad-global`（~/Desktop/shirisu-pad-global）
別アプリ(ふるり値チェッカー)だが、**最初からクリーンなESM分割**で作られており、本体の作り変えテンプレになる:
- `shared.js`（色/定数/`escapeHtml`/正規表現の一元化）
- `backend.js`（データアクセス層）
- `calc.js`（DOM非依存の純関数・テスト対象）
- `sharecard.js`（Canvas無状態関数）
- `app.js`（UIオーケストレータ＝DOMを触るのはここだけ）
- `tests/run-tests.mjs`（ESM直import） + **`tests/e2e.mjs`（npm依存ゼロ・Node内蔵http+headless Chrome+iframe375pxでUI駆動）** ← 本体の「UIテスト無し」の穴を埋める実例

---

## 4. 推奨する段階的ロードマップ（依存少・効果大の順。各ステップに完了条件）

> **順序の考え方**: 依存が少なく低リスクな「土台」から入れる。痛んでいるタブ/スワイプ(ステップ5)は依存が最も多いので本来最後だが、痛みが強ければ前倒しも選べる（着手時に再決定）。

1. **ドメイン境界を固定する（型/変換の分離）** — **✅ 完了 (2026-07-22)**
   `Boss` の `bossAttribute` と `weaknessPt` を別名・別変換関数にし、画面からの相性逆算を追放。JSDoc(または段階的TS)で `plan`/`player`/`attack` の形を固定。
   **完了条件**: PT選択は全て `weaknessPt` を読み、属性変換の単体テストが通る。
   > 実施内容: `js/domain/attributes.js` 新設 (`weaknessPtOf`/`bossAttributeOf`/`normalizeAttrKey`、
   > JSDoc typedef、単体テスト5件)。画面側の相性逆算 `bossAttrToPlayerAttr` 6箇所を
   > `weaknessPtOf(boss)` (DB保存値の直読) に置換して撤去、死にコード `attrToCounterBoss` 削除。
   > 潜在バグ修正: `detectPtAttrFromBossName` の `COUNTER[大文字キー]` が常に undefined だった
   > 二重変換 (監査C7)。DB書き込み境界 (supabaseCreateSeason) と相互参照コメントで結線。
   > 追記 (同日): `plan`/`player`/`attack`/`boss` を optimal-plan.js ヘッダーで JSDoc typedef 化
   > (BossRow/PlayerInput/PlanInput/PlanAttack/PlanBoss/PlanLevel/Plan)。大文字ドメイン
   > (BOSS_ATTRIBUTES島) の境界2箇所に normalizeAttrKey / 境界コメントを付与。
   > ⚠ 注意: PT_ATTR_TO_BOSS_CODE はトップレベル即時評価のため defer 読込の
   > normalizeAttrKey が使えない (toLowerCase 直書きを許す例外として文書化済み)。

2. **未テストの純ロジックを `js/` へ抽出＋テスト化** — **✅ 完了 (2026-07-22)**
   ふるり値計算(`calculateFururiScore`/`buildFururiBaseMap` ほか)、OCR後処理(`fuzzyResolveCharacter`/`_ocrAttackMultiAndMerge`/`detectBossCodeFromText`)、候補選別・ダメージ整形をDOM非依存に。
   **完了条件**: 抽出済みロジックがNodeテストで固定され、index.htmlは入出力変換だけを担う。
   > 実施済み: `js/domain/fururi.js` 新設 (buildFururiBaseMaps / calcFururiScore /
   > calcPerAttackFururi / fururiBaseTotalsByMode — 全て引数渡しの純関数、テスト6件)。
   > index.html 側は同名アダプタがグローバル (currentData/slvRatioTable/fururiBaseMap 系) を
   > 集めて渡すだけに縮小。既存のグローバル契約 (fururiBaseMap 等) は読者が多いため維持。
   > 実施済み (同日2): `js/domain/ocr.js` 新設 — normNameForMatch / simBetween /
   > fuzzyResolveCharacter / mergeOcrAttackResults / detectBossCode (テスト5件)。
   > _ocrAttackMultiAndMerge は I/O (画像変換・AI呼び出し) だけ index.html に残し統合則をドメインへ。
   > **旧実装との差分テスト497ケース全一致で等価移植を確認** (地雷処理の塊のため)。
   > 実施済み (同日3): `js/domain/finish.js` (締め凸候補: computeFinishPlans の1〜3凸
   > 組合せ探索 + buildFinishLeaderTimeline の時間帯別リーダー変化点 — 時刻は引数渡し) と
   > `js/domain/format.js` (rawToB / formatDamageRaw / trimZeroB) を新設、テスト5件。
   > ※ ダメージ整形のインライン散在 (`Number(x)/1e9` 等 約20箇所) は一括置換せず
   > 「触った機会に formatDomain へ寄せる + 新規は必ず formatDomain」の方針
   > (一括置換は差分が大きく表示退行リスクに見合わない)。

3. **`_opsDashboardCache` を単一ストア＋Repositoryへ置換** — **✅ 完了 (2026-07-22)**
   `load/refresh/invalidate` と更新イベントを一箇所に集約。画面はselector経由で読む、書き手はミューテーション経由のみ。
   **完了条件**: `_opsDashboardCache` への直接代入・直接部分更新がゼロになる。
   > 実施内容: `js/state/opsStore.js` 新設 (get / load / isStale / invalidate /
   > patchBosses / patchPlayer)。旧 `_opsDashboardCache`/`_opsDashboardCacheAt` の
   > 全52箇所を移行し**出現ゼロを機械確認** (無効化21 / 読み取り17 / 全量ロード2 /
   > ポーリング部分更新1 / SLv即時反映1 / 宣言 / TTL判定)。
   > 移行前に全50行の使用箇所調査を行い**不変条件9つ**を特定して保存
   > (opsタブは毎回全量ロード / プランのみ60秒TTL / patchBosses はTTL時刻を進めない /
   > load失敗時は旧データ保持 / 入力中ガードは描画層に残置 等 — opsStore.js 冒頭に記載)。
   > ストア契約はテスト5件で固定 (81 passed)。
   > **残 (意図的スコープ外)**: subscribe/セレクタによる更新イベント層は見送り —
   > 現行は「invalidate → 明示的に再描画呼び出し」の定型で挙動維持を優先した。
   > `_activeSeasonCache` (二重キャッシュ・無効化12/21箇所のみ連動) の統合は次の課題。

4. **運営画面をイベント委譲＋ターゲット更新へ**
   `onclick`文字列をコンテナのclickハンドラ(`data-action`)へ寄せ、入力中カードは全置換せず値・表示領域だけ更新。
   **完了条件**: 10秒ポーリング中でもHP・名称入力のフォーカス/値/カーソル位置が失われない。

5. **タブコントローラとジェスチャーを分離**
   タブ状態・スクロール復元を1つのcontrollerに。スワイプ/PTR/bottom-navは「遷移要求」だけを出す。viewportに `maximum-scale=1` 等を入れてプルプルを構造的に封じ、`data-no-swipe` 必須を不変条件で担保。
   **完了条件**: タブ追加が「タブ定義1箇所への追加」だけで、CSS/スワイプ/PTRの個別修正なしに動く。

**重要**: 1〜5はいずれも一括リライトではなく漸進切り出しで着手できる。各ステップ後もアプリは動く。既存の防御(`_myPubRenderSeq`, `chartRef`ガード, `_userIsTyping`)は正しいが横展開されていない＝ステップ3/4がそれを機構化する。

---

## 5. 着手時の進め方 / 検証

- リアーキ着手時は各ステップの「完了条件」を受け入れ基準にし、`node tests/run-tests.mjs` を都度緑に保つ。
- 変更のたびに `.claude/skills/shirisu-verify-ship`（push前チェック）に従う。
- 各ステップは独立コミット。移行中も本番は常に動く状態を維持。

## 補足メモ
- 別途、セキュリティ監査 `AUDIT.md`（2026-07-15）で **P0 保存型XSS** を検出済み（index.html:5490 付近の `JSON.stringify` を属性へ直接埋め込み / avatar_character の innerHTML 未エスケープ挿入）。これは上記ステップ③④（描画層のイベント委譲＋エスケープ一元化）で**構造的に解消できる**。単発で直す場合は `jsonAttr`/`escapeHtml` を使うだけ。
- 監査は Fable（Claude）＋ Codex(gpt-5.6-sol) の併用。Explore×3（構造マップ / 脆さホットスポット / 手本調査）＋ Codex独立アーキ評価が独立に同一結論へ収束した。
