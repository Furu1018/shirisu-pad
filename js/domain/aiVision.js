// ============================================================================
// ドメイン: 画像認識 (AI Vision) の失敗を日本語で説明する (2026-10-25)
// ----------------------------------------------------------------------------
// 「新シーズン作成時の AI画像認識が起動しない」(ふるり 2026-10-24) の実体は Anthropic の
// 「Your credit balance is too low」(前払いクレジット切れ) だった。Edge Function (dynamic-service) は
// Anthropic の失敗を HTTP 502 の本文 { ok:false, error:"Anthropic API error (400): …" } で返すが、
// supabase-js の functions.invoke は非 2xx を「Edge Function returned a non-2xx status code」という
// error 1 つにまとめるので、画面には理由が出ず「何をすればいいか」が分からなかった。
// ここは純ロジックだけ: 失敗の本文 → 日本語の説明 (何が起きた・誰が何をする)。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// 新しい失敗の種類を見つけたら RULES に 1 行足す (説明が無ければ元の文がそのまま出る)。
// ============================================================================
(function (root) {
    'use strict';

    /** [正規表現, 日本語の説明]。上から順に最初に合ったもの */
    const RULES = [
        [/credit balance is too low|Plans & Billing|insufficient[_ ]credit/i,
            'AI の利用枠 (Anthropic の前払いクレジット) が切れています。console.anthropic.com → Plans & Billing で補充するとまた使えます (ふるりの管理)'],
        [/ANTHROPIC_API_KEY not set/i, 'Edge Function に ANTHROPIC_API_KEY が設定されていません (ふるりの管理: Supabase の secrets)'],
        [/authentication_error|invalid x-api-key|invalid api key/i, 'Anthropic の API キーが無効です (ふるりの管理: Edge Function の secrets を確認)'],
        [/permission_error|\(403\)/i, 'Anthropic の API キーにこの操作の権限がありません (ふるりの管理)'],
        [/rate_limit_error|rate limit|\(429\)/i, 'AI が混み合っています (レート制限)。1 分ほど待ってからもう一度'],
        [/overloaded_error|\(529\)|overloaded/i, 'AI 側が過負荷です。少し待ってからもう一度'],
        [/not_found_error[\s\S]*model|model[\s\S]*not[_ ]found/i, 'AI のモデルが見つかりません (Edge Function のモデル名が古い可能性・ふるりの管理: 再デプロイ)'],
        [/unknown image task/i, 'この画像認識の種類 (task) が Edge Function に無い (ふるりの管理: 再デプロイ)'],
        [/Failed to send a request to the Edge Function|Failed to fetch|NetworkError|Load failed/i, 'ネットワークにつながりません (または Edge Function に届きません)。電波を確かめてもう一度'],
        [/Requested function was not found|NOT_FOUND/, 'Edge Function (dynamic-service) が見つかりません (ふるりの管理: デプロイ名を確認)'],
    ];

    /** 失敗の本文 (文字列 / Error) → 日本語の説明。分からなければ null (呼ぶ側が元の文を出す) */
    function explainError(raw) {
        const s = String(raw == null ? '' : (raw && raw.message != null ? raw.message : raw)).trim();
        if (!s) return null;
        for (const [re, jp] of RULES) if (re.test(s)) return jp;
        return null;
    }

    /**
     * 画面に出す 1 文。detail = Edge Function の本文から読めた理由 (無ければ '')、fallback = invoke の error.message。
     * 日本語の説明があればそれ。無ければ「AI Vision呼び出し失敗: (本文の理由 か 素のメッセージ)」
     */
    function messageOf(detail, fallback) {
        const d = String(detail || '').trim();
        const f = String(fallback || '').trim();
        const jp = explainError(d) || explainError(f);
        if (jp) return jp;
        return `AI Vision呼び出し失敗: ${d || f || '不明なエラー'}`;
    }

    root.aiVisionDomain = { RULES, explainError, messageOf };
})(typeof window !== 'undefined' ? window : globalThis);
