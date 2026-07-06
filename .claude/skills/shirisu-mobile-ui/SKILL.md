---
name: shirisu-mobile-ui
description: しりすこPADのUI実装で踏んだ落とし穴と定石。モバイルの横スクロール/タブスワイプ干渉、CSSグリッドのはみ出し、Canvas共有画像の作り方。UIを触る前に読む。
---

# モバイルUIの落とし穴と定石 (しりすこPAD)

デザイントークン (色・ピル・カード・ボタン) は CLAUDE.md の ClaudeDesign 節が正。
ここには「知らないと踏む」挙動だけを書く。

## 横スクロールとタブスワイプの干渉

このアプリは**タブ領域の横スワイプでタブが切り替わる** (index.html の
`document.addEventListener('touchstart', ...)` 付近、`_SWIPE_TABS`)。

- 横スクロールする要素を作るときは、コンテナに **`data-no-swipe` 属性を付ける**。
  スワイプハンドラが `[data-no-swipe]` 内のタッチを無視する (既存例: mypageDmgPanels, opsBossSummary)
- これを忘れると「スクロールしたいのにタブが切り替わる」クレームになる

スワイプエンジン自体の設計判断 (壊さないこと):
- **button/a の上からでもスワイプは発動する**。方向ロック(8px超の横移動)で初めてドラッグ扱いに
  なるためタップと共存できる。除外は入力系 (input/textarea/select)・開いたモーダル・
  data-no-swipe 系・ナビだけ。ドラッグ後のゴーストクリックは touchend で capture 抑止している
- **切替アニメ中は `_swipe.animating` フラグで新規タッチを拒否** (再グラブで状態が壊れるため)
- 方向ロックは「1.2倍明確に勝った軸」だけ。曖昧な斜めは縦 (スクロール優先) に倒す
- transform 更新は **rAF で1フレーム1回に間引く** (120Hz 端末対策)。touchmove で直接書かない
- `html, body` は overscroll-behavior-x:none (横) + overscroll-behavior-y:contain
  (自前プルリフレッシュのためネイティブPTRを無効化) 済み

## その他の操作系インフラ (壊さないこと)

- **戻る操作でモーダルを閉じる**: `.player-select-modal / .fururi-help-modal / .player-modal / .drawer`
  の `.open` クラスを MutationObserver で監視し history state を積んでいる。
  新しいモーダルを作るときは `.player-select-modal` クラス + `.open` 方式に従えば自動で対象になる
- **プル・トゥ・リフレッシュ**: scrollY=0 から28px以上引くと発動。タブ別の更新経路は
  `_PTR_KNOWN_TABS` + `_renderTabContent`。新タブを追加したらここに登録する
  (未登録タブは location.reload にフォールバック)
- **タップ当たり判定**: `@media (pointer:coarse)` で button の ::before を -4px 拡張している。
  ボタン装飾に ::before を使う新クラスを作ったら除外リスト (:not) に追加すること
- **極小フォント禁止**: 情報テキストは 10px 以上 + 注釈は #8A9097 (#A4AAB0 は薄すぎる)。
  9.5px 以下は 2026-07 に全て +1px 底上げ済み。新規UIでも 9px 台を書かない

## CSSグリッド `1fr` のはみ出し (実際に踏んだバグ)

`1fr` は**中身の min-content より縮まない**。折り返し禁止 (white-space:nowrap) の
テキストや固定幅アイコン列が入ると、グリッド全体が画面幅を超えて
「ページが数十pxだけ横にガタつく + タブスワイプ誤発動」という違和感の強い挙動になる。

対策はどちらかに倒す (中途半端が一番悪い):
- **画面内に収める**: `minmax(0,1fr)` + 全セルに `min-width:0` + テキストは ellipsis、
  アイコン列は `flex-wrap` で折り返し
- **明示的にスクロールさせる**: コンテナに `overflow-x:auto` + `data-no-swipe` + 中身に min-width

ユーザーが「違和感がある」と曖昧に報告してきたら、この min-content はみ出しをまず疑う。

## Canvas 共有画像 (Discord 向け PNG)

既存実装 `_renderPlanToImage` / `_renderPlanToImageTimetable` のパターンを踏襲する:

- 固定幅 1080px、`canvas.width = W*2` + `ctx.scale(2,2)` で Retina 2x
- **2パス構成**: 先に全行の高さを計測して総高さを決めてから描く
- ヘルパー: `f(px,weight)` フォント / `rr()` 角丸パス / `pillDraw()` ピル / measureText ループの ellipsis
- 画像を描くなら**同一オリジンのローカル画像のみ** (character-images/*.webp は安全)。
  Supabase Storage のアバターは CORS taint で toBlob が失敗しうるので描かない
- 画像は `new Image()` + Promise.all で**事前ロード**してから描画 (関数を async にする)
- 絵文字 (💀⏱🕐) は fillText でそのまま描ける
- 出力は navigator.share (モバイル共有シート) → 失敗時 DL フォールバック

## 表示モードを増やすときの原則

- 状態は localStorage に記憶 (`shirisuko_plan_view` 等)。廃止したモード値からの
  **移行処理**を初期化時に入れる (無効値→デフォルトに倒す)
- 画面表示と Canvas 画像で同じ情報を出すときは、**共通のモデル関数**を作って
  両方がそれを消費する (例: `_planTimetableModel`)。ロジックの二重実装をしない
- 「自分」の判定は `getCurrentIdentity()?.id`。自分の行・チップは青 (#1E78F0) でハイライト
