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
- `html, body { overscroll-behavior-x: none; }` でブラウザの横オーバースクロールを抑止済み

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
