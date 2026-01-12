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
2. `latest.json` としてこのフォルダに配置
3. GitHubにpush
4. 自動的にメンバーに反映
