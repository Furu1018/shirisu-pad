---
name: shirisu-verify-ship
description: しりすこPADのコード変更後の検証→コミット→デプロイの定石。変更をpushする前に必ず実行する。テストシーズンを使った安全な動作確認の手順も含む。
---

# 検証 → コミット → デプロイ (しりすこPAD)

## 1. 検証 (push前に必ず全部)

```sh
node tests/run-tests.mjs        # ソルバー単体テスト (18件+)。1件でも落ちたら原因を直す
node --check js/optimal-plan.js
node --check js/supabase-client.js
```

index.html のインライン script は python3 が無い環境でも Node ワンライナーで抽出して検証できる:

```sh
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const re=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;let m,out='';while(m=re.exec(html)){out+=m[1]+'\n;\n'}fs.writeFileSync(process.env.TEMP+'/_inline.js',out)"
node --check "$TEMP/_inline.js"
```

機能を削除・改名したときは、旧シンボルへの参照が残っていないか grep で確認する
(例: ビュー廃止時に `_planGanttHtml|_planShiftHtml` を検索して0件を確認した)。

## ⚠️ 一括置換の事故防止 (実際に起きた事故)

PowerShell の二重引用符内で node ワンライナーを書くと、置換文字列の `$1` が
**PowerShell の変数展開に食われて空になる** (font-size:9.5px → .5px 事故、73箇所破損)。

- 一括置換は必ず **スクリプトをファイルに書いてから** `node script.js` で実行する
- 置換後は「件数が期待どおりか」+「壊れた値のパターンが残っていないか」を機械チェックする
  (例: `font-size:\s*(\.\d|;)` が0件)。node --check は JS 構文のみで CSS 値の破損は検出できない

## 2. コミット

- 日本語で「カテゴリ: 要約」形式 (例: `凸プラン: 時間割ビューを追加`、`ヘルプ: 律速の説明を追加`)
- 本文に変更点を箇条書き。なぜその設計にしたかを1行残す
- main へ push = 本番デプロイ (GitHub Pages / Actions ワークフロー)。ブランチ運用はしていない

## 3. 実機確認 (自分ではできない — ユーザーに依頼する)

ローカルには Supabase データが無く大半のタブが空になるため、実機確認は
https://furu1018.github.io/shirisu-pad/ でユーザーに依頼する。依頼時は
**具体的なチェックリスト** (どのタブで何を押して何を見るか) を必ず添える。

Canvas 描画 (共有画像) は構文チェックでは検証できない。画像系を触ったら
「📸で1枚生成して崩れ確認」を必ず依頼項目に入れる。

## 4. 本番データを汚さない動作確認

🧪 クイックテストシーズン (ユニレ管理タブ) を使う:
- 作成前に player_damages をスナップショット → 終了時に完全復元される
- 模擬戦データが自動シードされる (前回実績 + ランダム補完) ので、
  最適プラン・時間割・配信などのデータ依存機能をすぐ試せる
- 「🧪 テスト終了」で元の状態に戻ることまで確認して初めて完了
