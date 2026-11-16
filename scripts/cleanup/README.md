# 撤去 (使わなくなった画面・機能を消す) の道具

テストではない (run-tests からは呼ばない)。2026-11-16 に「従来の画面」を撤去したときに作った。次の撤去 (運営の「従来の算出・配信」など) でも同じ手順で使う。
どれも **読むだけ** か、`APPLY=1` を付けたときだけ index.html / tests を書き換える。書き換える前の版は git が持っているので、コミットしてから始めること。

## 手順 (この順で)

1. **入口を消す** — 消したい画面の HTML (タブ・カード・シート・ボタン) と、そこへ行く分岐を手で消す。分岐は「常にこっち」に畳む。
   編集は `lib.mjs` の道具 (`must` = 1 か所だけの置き換え / `cut` = 行の範囲 / `cutEl` = 要素 1 つ / `cutStmt` = 1 文) を使った小さいスクリプトで (CRLF を保つ・当たらなければ止まる)。
2. **到達できなくなった関数を消す** — `node scripts/cleanup/reach.mjs .` で一覧 → 名前を見て、残すべきものが混ざっていなければ `APPLY=1`。0 個になるまで繰り返す。
   根 = 関数の外の文 (HTML の onclick・台本の地の文・一覧の配列) と js/ 以下。**注釈の中の名前は数えない**。関数の中からしか呼ばれない関数は、呼ぶ側が消えれば消える (循環も拾う)。
   まだ生きている関数は `node scripts/cleanup/who.mjs . 名前…` で「誰が呼んでいるか」を見て、その 1 行を手で外す。
3. **孤立した変数** — `node scripts/cleanup/orphan-cut.mjs .` (1 行で終わる宣言だけ消す。複数行のものは名前を出すので手で)。`orphans.mjs` は一覧だけ + もう無い id を指す `getElementById` / CSS。
4. **CSS** — 元の版で `LIST=<base.json> node scripts/cleanup/css-orphans.mjs <元の版を置いたフォルダ>` → いまの版で `APPLY=1 BASE=<base.json> node scripts/cleanup/css-orphans.mjs .`
   (今回の撤去で孤立したクラス・id の規則だけを消す・`:not(.x)` の中は数えない・宙に浮いた注釈と使われなくなった @keyframes も)。色のトークンは `tokens.mjs`。
5. **検算** — `node scripts/cleanup/dangling.mjs . <元の版の index.html>` = 消した名前がコード・js/ に残っていないか (残っていれば実行時に ReferenceError)。テストが参照している名前も出る。
   `unused-api.mjs` = 呼ばれなくなった `window.supabaseXxx` とドメインのモジュール。
6. **テスト** — 消した機能だけを見ていたテストファイルは消す。run-tests.mjs は
   `ROUNDS=70 EXTRAS=<消した id・クラスの一覧> node scripts/cleanup/prune.mjs . <元の版の index.html> <記録>` が「消した名前に触れている assert」を 1 周 1 文ずつ外す (記録が残る)。
   ★ **外した記録は必ず読む** — 数え方が変わっただけの見張り (呼び出し口の数・タブの並び・色の上限) は、外すのではなく数字を直して戻す。実行テスト (`new Function` で本体を動かすもの) は機械に任せず手で直す。
   `test-summary.mjs` = テストごとの assert の数 (元 → いま)。ほぼ空になったテストは `libt.mjs` の `dropTest` で丸ごと消すか、「撤去した」ことの見張りに書き直す。
7. **通し確認** — `node tests/practice-e2e.mjs` (PC=1 も)・`node tests/ruler.mjs`。画面の写真 (`scripts/survey/shots.mjs`) で、消していない画面が変わっていないことを見る。

## 道具の一覧

| 道具 | 何をするか |
|---|---|
| `reach.mjs` | 到達できない関数 (字下げ 8 の `function`) の一覧・`APPLY=1` で消す |
| `who.mjs` | 名前を誰が呼んでいるか (関数名つき) |
| `ctx.mjs` | 正規表現に当たる行の前後を関数名つきで出す (分岐を畳むときの下調べ) |
| `orphans.mjs` / `orphan-cut.mjs` | 使われていない台本の変数・もう無い id への参照 / その宣言を消す |
| `css-orphans.mjs` / `tokens.mjs` | 孤立した CSS の規則 / 使われなくなった色のトークン |
| `dangling.mjs` / `unused-api.mjs` | 消した名前への参照の残り / 呼ばれなくなった通信の関数・ドメイン |
| `prune.mjs` / `static-prune.mjs` | run-tests.mjs の assert の仕分け (テストを走らせて 1 文ずつ / 1 つのテストの中をまとめて) |
| `failctx.mjs` / `mk-rtdebug.mjs` / `test-summary.mjs` | 落ちた assert の行の前後 / その元になる写し / テストごとの assert の数 |
| `lib.mjs` / `libt.mjs` | 編集の部品 (index.html・テストファイル) |

## 気をつけること (2026-11-16 に踏んだ)

- `bash` の `node -e` で道具を書き換えない (引用が壊れる)。ファイルを Write / Edit で直す。
- CSS を全体の正規表現で削らない (`:not(.消したクラス)` を含む規則 = 指の端末の押せる範囲、まで消えた)。規則の単位で、`:not()` の中は数えずに。
- assert を機械で外すと、テンプレート文字列の途中で切って構文を壊すことがある → `prune.mjs` は 1 文ごとに `node --check` をして、壊れる切り方はしない。
- 「常に真」に畳んだ結果、いつも呼ばれるようになる再描画が無いか見る (例: ヒーローの描き直しの鍵が常に '' になっていた = 毎回描き直していた。動きを変えないなら、そのことを注釈に書く)。
- 起動時の裏描き (`TAB_REGISTRY` の `prerender`) からタブを消すときは、**通知の送り手が変わらないか**を見る (運営タブの裏描きが盤面を読む = その端末が撃破・時間の通知の送り手になる)。
