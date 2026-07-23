# しりすこPAD プロジェクトガイド

NIKKE ユニオンレイド運営ツール。約30名の内輪ユニオン向け PWA。

`.claude/skills/` に作業手順スキルあり (git 同期・どのPC/モデルでも共通):
`shirisu-verify-ship` (検証→デプロイ) / `shirisu-supabase-migration` (SQL追加) /
`shirisu-mobile-ui` (UIの落とし穴) / `evidence-first-dev` (進め方の型)。該当作業の前に読むこと。
現状サマリー・実戦検証タスク・既知の穴・機能候補は **ROADMAP.md** に集約されている。

## Codex 併用レビュー (トグル・既定OFF)

ユーザーが「**Codexも併用して**」(同義の依頼含む) と言ったら:
```sh
touch .claude/hooks/.codex-on      # ON
```
以降、**作業を終えるたびに Stop フック (`.claude/hooks/codex-review.sh`) が未pushの差分を
Codex CLI にレビューさせる**。バグ・境界条件・セキュリティの指摘があれば Stop がブロックされ
stderr に指摘が返るので、**対応してから作業を終えること**。
**⚠ ON中は同一ターン内で push まで進めないこと** — フックは「未pushの差分」を見るため、
先に push するとレビュー対象が消えて監査が素通りする (2026-07-22 に実際に8コミットが
未監査で本番に入った事故あり)。正しい順序: 実装 → commit → ターン終了 (ここでレビュー) →
指摘対応 → 次ターンで push。急ぎで同一ターン push が必要な場合は、push 前に
codex:codex-rescue エージェントへ明示的にレビューを依頼する。

「**Codexオフ**」等で解除:
```sh
rm -f .claude/hooks/.codex-on      # OFF
```
既定は OFF (フックは即終了するので無負荷)。ON中は毎ターン10〜60秒 + APIコストがかかる。
前提: `codex` CLI が PATH 上にあること。レビュー実行の記録は `.claude/hooks/_fired.log`。
**フラグは .gitignore 済み = PCごとの設定**。別PCに移ったら ON にし直すこと (APIコストが出るので同期しない)。

## アーキテクチャ

- **index.html**(約17,000行) にUI・CSS・アプリロジックのほぼ全てが入った単一ファイル構成。
  **リアーキ進行中** (ARCHITECTURE-AUDIT.md — B:段階的モジュール分割を2026-07-22に承認・着手)
- **js/supabase-client.js** — Supabase への読み書きを `window.supabaseXxx` 関数として公開
- **js/optimal-plan.js** — 最適凸プランのソルバー (純関数、単体テストあり)
- **js/domain/attributes.js** — 属性ドメイン (リアーキ ステップ1)。ボス属性⇄弱点PT属性の変換は
  ここが唯一の置き場所。画面側は `weaknessPtOf(boss)` / `bossAttributeOf(boss)` /
  `normalizeAttrKey(v)` を使う — **相性表を画面に再定義しないこと** (DB書き込み側の発生源は
  supabaseCreateSeason の COUNTER のみ)
- **js/domain/** (fururi/ocr/finish/format/mockCompare) — ふるり値計算・OCR後処理・締め凸候補選別・
  ダメージ整形・ユニオン事前比較 (模擬タブ) の純ロジック。全て引数渡し・テストあり。
  該当領域の計算式を index.html に書き足さないこと。mockCompare のふるり値は
  fururiDomain.calcPerAttackFururi を属性キー=bossCode で再利用 (式の二重実装禁止)
- **js/state/opsStore.js** — 運営ダッシュボード盤面 {season,bosses,players} の単一ストア
  (リアーキ ステップ3)。**直接代入・部分書き換え禁止** — get/load/isStale/invalidate/
  patchBosses/patchPlayer を使う。TTL等の不変条件はファイル冒頭に記載
- **supabase/** — スキーマ・RLS・シードSQL。RLSは anon 全許可 (内輪運用の割り切り)。
  バックアップ復元 (設定タブ) は `23_restore_helpers.sql` の RPC が SQL Editor で適用済みであること。
  凸プラン配信 (📤) は `17_published_plans.sql`、戦闘可能時間の運用オプション
  (⏳隙間時間型 / 🔔いつでも通知) は `18_availability_prefs.sql`、
  設定タブの詳細アクティビティログは `19_activity_log.sql`、
  ボスHP鮮度表示 (HP更新 ○分前) は `20_bosses_updated_at.sql`、
  模擬の1属性2編成 (同属性2凸) は `21_player_damages_slots.sql` の適用が前提
  (主キーが (player_id, attribute, slot) に変わる — upsert は _upsertPlayerDamages 経由必須)。
  締め凸依頼のステータス追跡 (pending/accepted/declined) は `22_finish_requests.sql` が前提。
  キャラのバースト区分は `24_nikke_burst.sql` (burst) + `25_nikke_burst_alt.sql` (burst_alt =
  複数バーストで使えるキャラのサブ枠。例: ラピ:レッドフード は表示B3・B1枠でも可)。
  編成ピッカーのバースト絞り込み・チェーン判定がこれを読む。25未適用でも読みは静かに劣化する
  (サブ無し扱い) が、サブの保存だけはエラーで案内する。
  通知の時間帯フィルタは Edge Function `send-push` (サーバ側) — 変更時は再デプロイが必要。
  **`99_check_applied.sql` を SQL Editor で実行すると未適用マイグレーションを一覧検出できる** (新環境・別PC時の必須チェック)
- **sw.js** — Web Push 用 Service Worker。キャッシュは実質不変の画像のみ
  (character-images/属性アイコン)。HTML/JS/データは即時反映のため非キャッシュ
- 認証なし。プレイヤーは自己申告で選択 (localStorage)
- **運営モード (`_opsMode` / `body.ops-mode` / `data-ops-only`)**: `🛠運営` スイッチで運営向けUIを
  出し入れする仕組み。戦況タブ (旧ユニレ管理) と設定タブで共有 (localStorage `shirisuko_ops_mode`)。
  CSS は `body:not(.ops-mode) [data-ops-only]{display:none}` のグローバル1行なので、
  **どのタブでも `data-ops-only` を付けるだけで運営送りにできる** (逆に OFF 時だけ出すのは
  `data-ops-off-only`)。設定タブは OFF の間そもそも運営データを取得しない (`renderSettingsTab`)。
  **これは認可ではなく誤操作防止の表示トグル。誰でも切り替えられるのが意図した仕様**
  (内輪運用の割り切り)。RLS が anon 全許可 + anon キー公開なので UI で隠しても保護にはならない。
  「クライアント側の権限チェックが甘い」という指摘は的外れ — 直すなら RLS 側であって UI ではない

## テスト

```sh
node tests/run-tests.mjs   # 最適凸プランソルバーの単体テスト
```

UI はテストなし。変更後は `node --check` でJS構文を確認し、実機 (GitHub Pages) で目視確認する運用。
index.html 内の script は `python3` で抜き出して `node --check` に通せる。

## デザインシステム: ClaudeDesign

**注意: 旧 Material (--md-sys-color-*) から ClaudeDesign へ移行済み。新規UIは以下に従うこと。**
一部の古いモーダル・ヘルプには Material トークンが残っているが、触るときに ClaudeDesign へ寄せる。

### トーン

- 白カード + 大きめ角丸 + ソフトシャドウ。フォントは Noto Sans JP、見出しは font-weight 900
- 属性カラーを機能的に使う (枠線・ピル・バー・アイコン背景)

### カラー

```js
// 属性 (DC_ATTR_COLORS)
fire:'#FF3D44'  water:'#2E8BFF'  electric:'#9B4DFF'  iron:'#FF8A2B'  wind:'#18C26B'
// 状態
成功/撃破: #18C26B   警告: #F59E0B   エラー/交戦: #FF3D44   アクセント青: #1E78F0
// ニュートラル
文字: #14161A  サブ: #6B7178 / #8A9097  薄文字: #A4AAB0 / #B6BBC1  背景: #F7F8F9 / #F1F2F4
```

### 頻出パターン

- **ピル**: `border-radius:999px; font-size:10-11px; font-weight:800-900; padding:3px 9px; color:{色}; background:{色}1A`
- **カード**: `.dc-card` / 白背景 + `border-radius:13-15px` + `border:1px solid rgba(20,22,26,0.05)`
- **ボトムシート**: `player-select-modal` 系。ハンドル(::before) + 下スワイプで閉じる (`_enableSheetSwipeDismiss`)
- **ボタン**: 黒 `#14161A` が主ボタン、`#F1F2F4` がサブ。青グラデ (`#46A0FF→#1E78F0`) は誘導ボタン
- 16進カラー+alpha は `${c}1A` `${c}33` 形式の連結を多用

## データモデルの要注意ポイント

- **`bosses.attribute` = ボス自身の属性 / `bosses.weakness` = 弱点(持っていくPT属性)**。
  表示は attribute 基準に統一済み。「○○PTで凸」の文脈だけ weakness を使う。混同しやすいので注意
- **SLv (`player_sync_levels`)**: シーズン別履歴。読み込みは「最新シーズン(アクティブ優先→hard_date順)から引き継ぎ」、
  書き込みはマイページのSLvチップ → アクティブシーズンへ upsert。
  さらに月次JSON到着時に確定SLvを該当シーズンへ自動同期 (supabaseSyncSlvFromJson、差分のみ・冪等)
- ダメージは `_raw` (生値) と B単位 (10億=1B) が混在。表示はほぼ B 単位
- 比較・ふるり値タブの対象は「完了した実シーズン」のみ (is_test=false, is_active=false)
- **BlaBlaLINK スクショの情報量**: ユニオン全体画面は「メンバー別の凸回数と合計ダメージ」のみで
  **どのボスへの凸かは写らない** → 全体画面からの凸自動登録は不可 (attacks はボス必須)。
  全体画面は「提出漏れの検出」まで、凸登録は個人の凸一覧画面 (ボスが写る) で行う役割分担

## 最適凸プラン (js/optimal-plan.js) の要点

- **決定的ソルバー (AI不使用)**。押した時点の盤面 (実残HP / 消化済み凸 / 現在時刻以降の時間帯)
  から毎回組み直す。算出前に60秒より古いダッシュボードキャッシュは自動再取得
- **目的関数は総与ダメ (credited) 最大化** (2026-07 再設計)。ゲーム仕様 (2025-05-30 改修後):
  ハード日は1日だけ、ランキング=累計与ダメ、有限ボスは min(dmg, 残HP) しか入らない、
  **Lv3踏破で即日「Lv4 = ボス5のみ・HP無限」が開き全額計上**。撃破は吸収容量を開ける手段
- **Lv4 検知は自動**: boss_number=5 が存在し踏破想定 (fullyClearedThrough>=3) なら levels[] 末尾に
  `{level:4, infinite:true}` を追加。**Infinity は使わない** (📤配信のJSONB保存で null 化し
  旧クライアントの .toFixed() が落ちる) — 数値は有限 + infinite フラグで表現
- **温存 (Phase B)**: probe (温存なし) → 機会費用つき再パスの決定的2パス。機会費用 =
  「ボス5で入るはずの与ダメの減少分」(potential 差分 — 弱点属性の編成消費もスロット逼迫も1式)。
  Lv3クリア想定時刻以降に出られない人は温存させない。温存で credited が増えないなら probe に倒す
- **吸収 (Phase C)**: 踏破できないレベル (frontierLevel) は撃破を狙わず、全ボス横断で
  オーバーキル最小の割当に切り替える (スナップショット→やり直し)
- **得意属性 (strong_attributes)**: 1〜3個選択=必ず消化 (自由枠は残り) / 4個=その中からのみ /
  0・5個=制約なし。**凸済みの得意属性は満足扱い** (再強制しない)。
  ボス5弱点が得意属性の人は Lv4 割当で消化とみなす
- **1属性2編成 (player_damages.slot)**: キャラが被らない別編成なら同属性2凸を提案 (ボス5にも2凸可)。
  凸済み回数ぶん上位 (高ダメージ) 編成から消費済みとみなす。候補は全ロードアウトをスコアリング
  (残HPの小さいボスには2編成目の方がオーバーキルが小さいことがある)
- 時間: 凸可能時間内でレベル開放以降の最速枠に割当。⏳隙間型は時刻を約束しない flex 扱い
  (律速にしない)。ハイブリッド=登録時間内は確約・時間外は flex
- **変更したら必ず tests/run-tests.mjs にテストを足す** (現在88件 — ソルバー+ドメイン+ストア)

## デプロイ

- リポジトリ: https://github.com/Furu1018/shirisu-pad
- 公開URL: https://furu1018.github.io/shirisu-pad/ (GitHub Pages, main へ push で反映)
- ローカルでは Supabase データが無いと大半のタブが空になる → 実機確認はユーザーに依頼する
