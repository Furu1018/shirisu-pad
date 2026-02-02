# しりすこPAD プロジェクトガイド

## デザインシステム: shadcn/ui 準拠

このプロジェクトのUIコンポーネントはshadcn/uiのデザイン原則に従います。

### 基本原則

- **シンプルで洗練されたデザイン**: 過度な装飾を避け、機能性を重視
- **一貫性のあるスペーシング**: 8pxグリッドシステム（8px, 16px, 24px, 32px, 48px）
- **アクセシビリティ**: コントラスト比を確保し、フォーカス状態を明示

### カラーパレット

```
プライマリ: var(--md-sys-color-primary)
背景: var(--md-sys-color-surface)
テキスト: var(--md-sys-color-on-surface)
サブテキスト: var(--md-sys-color-on-surface-variant)
ボーダー: var(--md-sys-color-outline-variant)
```

### コンポーネントスタイル

#### Alert / 注意書き
```html
<div style="display: flex; align-items: flex-start; gap: 12px; padding: 16px; margin-bottom: 24px; background: var(--md-sys-color-surface-variant); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 8px; border-left: 4px solid #f59e0b;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; margin-top: 2px;">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
    <p style="margin: 0; font-size: 14px; line-height: 1.5; color: var(--md-sys-color-on-surface);">
        メッセージテキスト
    </p>
</div>
```

#### Card
```html
<div class="card" style="padding: 24px; border-radius: 12px; border: 1px solid var(--md-sys-color-outline-variant);">
    <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: var(--md-sys-color-on-surface);">タイトル</h3>
    <p style="margin: 0; font-size: 14px; color: var(--md-sys-color-on-surface-variant);">説明文</p>
</div>
```

#### 工事中ページ
```html
<div style="display: flex; align-items: center; justify-content: center; min-height: 60vh; padding: 24px;">
    <div class="card" style="max-width: 480px; width: 100%; text-align: center; padding: 48px 32px; border-radius: 16px; border: 1px solid var(--md-sys-color-outline-variant);">
        <div style="width: 80px; height: 80px; margin: 0 auto 24px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center;">
            <!-- アイコンSVG -->
        </div>
        <h2 style="margin: 0 0 12px 0; font-size: 24px; font-weight: 600; color: var(--md-sys-color-on-surface);">タイトル</h2>
        <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: var(--md-sys-color-on-surface-variant);">説明文</p>
    </div>
</div>
```

### アラートカラーバリエーション

| タイプ | ボーダー左色 | アイコン色 |
|--------|--------------|------------|
| Warning（警告） | #f59e0b | #f59e0b |
| Error（エラー） | #ef4444 | #ef4444 |
| Success（成功） | #22c55e | #22c55e |
| Info（情報） | #3b82f6 | #3b82f6 |

### border-radius

- 小さい要素: 6px
- カード・ボタン: 8px
- 大きいカード: 12px
- モーダル・特殊: 16px

### フォントサイズ

- 見出し1: 24px, font-weight: 600
- 見出し2: 18px, font-weight: 600
- 本文: 14px-15px, font-weight: 400
- 補足: 13px, font-weight: 400

### GitHub Pages公開

リポジトリ: https://github.com/Furu1018/shirisu-pad
公開URL: https://furu1018.github.io/shirisu-pad/
