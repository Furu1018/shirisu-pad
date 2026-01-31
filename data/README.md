# データフォルダ

## ファイル配置方法

### 最新データ
`latest.json` - 常に最新のレイドデータを配置

### 月別アーカイブ
- `2025-01.json` - 2025年1月のデータ
- `2024-12.json` - 2024年12月のデータ

## JSONファイル形式

BlablaLINK JSON形式 v8.0+ に対応

```json
{
  "metadata": {
    "version": "8.0",
    "extractedAt": "2025-01-12T00:00:00Z"
  },
  "raidData": {
    "month": "2025-01"
  },
  "players": [
    {
      "player": "プレイヤー名",
      "totalDamage": 70000000000,
      "syncLevel": 700,
      "attacks": [...]
    }
  ]
}
```

## 更新手順

1. BlablaLINKからJSONファイルをダウンロード
2. **重要**: JSONファイルを開き、`metadata` セクションに `unionRank` を追加
   ```json
   {
     "players": [...],
     "metadata": {
       "unionRank": 0.78,    ← ここに現在のユニオン順位（%）を追加
       "extractedAt": "2026-01-31T21:56:02.834Z",
       "playerCount": 31,
       "totalDamage": 1046030000000,
       "source": "BlaBlaLINK Chrome Extension",
       "version": "2.3",
       "hasDetailedAttacks": true,
       "imagesDownloaded": true
     }
   }
   ```
3. `latest.json` としてこのフォルダに配置
4. GitHubにpush
5. 自動的に全メンバーに反映（ユニオン順位も含む）

### ユニオン順位について

- `metadata.unionRank` に現在のユニオン順位（パーセント）を設定してください
- 例: 0.78% → `"unionRank": 0.78`
- この値を設定すると、全メンバーの画面で自動的に同じ順位が表示されます
- **ユニオン順位を必ず最初に設定してください**（一番上に配置すると見やすいです）
