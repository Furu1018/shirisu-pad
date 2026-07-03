# しりすこPAD プロジェクトガイド

NIKKE ユニオンレイド運営ツール。約30名の内輪ユニオン向け PWA。

## アーキテクチャ

- **index.html**(約13,000行) にUI・CSS・アプリロジックのほぼ全てが入った単一ファイル構成
- **js/supabase-client.js** — Supabase への読み書きを `window.supabaseXxx` 関数として公開
- **js/optimal-plan.js** — 最適凸プランのソルバー (純関数、単体テストあり)
- **supabase/** — スキーマ・RLS・シードSQL。RLSは anon 全許可 (内輪運用の割り切り)
- **sw.js** — Web Push 専用 Service Worker (キャッシュなし)
- 認証なし。プレイヤーは自己申告で選択 (localStorage)

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
  書き込みはマイページのSLvチップ → アクティブシーズンへ upsert
- ダメージは `_raw` (生値) と B単位 (10億=1B) が混在。表示はほぼ B 単位
- 比較・ふるり値タブの対象は「完了した実シーズン」のみ (is_test=false, is_active=false)

## デプロイ

- リポジトリ: https://github.com/Furu1018/shirisu-pad
- 公開URL: https://furu1018.github.io/shirisu-pad/ (GitHub Pages, main へ push で反映)
- ローカルでは Supabase データが無いと大半のタブが空になる → 実機確認はユーザーに依頼する
