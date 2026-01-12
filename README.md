# しりすこPAD - NIKKE Union Raid Analytics

NIKKE (Goddess of Victory: NIKKE) のユニオンレイドデータ分析ツールです。

## 🌐 アクセス方法

このページをGitHub Pagesで公開後、以下のURLでアクセスできます：

```
https://[あなたのGitHubユーザー名].github.io/shirisu-pad/しりすこPAD.html
```

## 📊 機能

- **プレイヤースコア分析**: ランキング、属性別ダメージ、SLv比較
- **NIKKE編成一覧**: 各ボスへの攻撃編成とダメージスコア
- **データ管理**: 月別データの蓄積と履歴管理

## 🔄 データ更新方法（管理者向け）

1. 最新のJSONファイルを `data/latest.json` として保存
2. GitHubにpush
3. メンバーはURLにアクセスするだけで最新データを閲覧

### 月別アーカイブ

特定の月のデータを保存する場合：
```
data/2025-01.json
data/2024-12.json
```

メンバーはURLパラメータで過去データを閲覧可能：
```
?month=2025-01
?month=2024-12
```

## 📱 スマートフォン対応

レスポンシブデザインでスマートフォンからも快適に閲覧できます。

## 🛠️ 技術スタック

- HTML/CSS/JavaScript (Vanilla)
- Chart.js (グラフ描画)
- Material Design 3 (デザインシステム)
- GitHub Pages (ホスティング)

## 📝 ライセンス

Private Use Only
