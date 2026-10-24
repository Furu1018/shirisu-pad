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
// 後半は「クレジットの消費を抑える」ための純ロジック (送る画像の大きさ / 同じ画像を二度読まない鍵 / 利用の記録と単価)。
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

    // ===== クレジットの消費を抑える (2026-10-25 ふるり「画像の処理でなるべくクレジットの消費を抑える工夫を」) =====
    // 測った事実 (season_announce・1920×2560 の JPEG 1.5MB と 960×1280 の 350KB): どちらも input 1952 / output 275 トークンで同じ。
    // Anthropic は長辺 1568px・約 1.15 メガピクセルを超える画像を向こうで縮めてから数えるので、それより大きく送っても
    // 料金は変わらない (通信量と時間だけ増える)。だから「縮めて送る」は 速さ・通信量 のため、「同じ画像を二度読まない」が節約の本体。
    /** Anthropic が向こうで縮める限度 (これに合わせて送れば精度は変わらず、送る量だけ減る) */
    const IMAGE_LIMITS = { maxLongEdge: 1568, maxPixels: 1150000 };
    /** 1 ピクセルあたりのトークン (Anthropic の目安: 幅 × 高さ ÷ 750) */
    const PIXELS_PER_TOKEN = 750;
    /** モデルの単価 (USD / 100 万トークン)。値は 2026-10-25 時点の公表価格 */
    const PRICING = {
        'claude-haiku-4-5': { inPerM: 1, outPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
    };
    const DEFAULT_MODEL = 'claude-haiku-4-5';   // Edge Function (dynamic-service) の既定

    /** 限度に収まる大きさ (拡大はしない)。{ w, h, scale } */
    function fitSize(w, h, limits) {
        const L = limits || IMAGE_LIMITS;
        const W = Math.max(1, Math.floor(Number(w) || 1)), H = Math.max(1, Math.floor(Number(h) || 1));
        let scale = 1;
        const long = Math.max(W, H);
        if (long > L.maxLongEdge) scale = Math.min(scale, L.maxLongEdge / long);
        if (W * H * scale * scale > L.maxPixels) scale = Math.min(scale, Math.sqrt(L.maxPixels / (W * H)));
        if (scale >= 1) return { w: W, h: H, scale: 1 };
        // 四捨五入 (2340 × 1568/2340 が浮動小数で 1567.99… になり floor だと 1 ピクセル欠ける)。長辺は限度を超えないように止める
        let rw = Math.min(Math.max(1, Math.round(W * scale)), L.maxLongEdge), rh = Math.min(Math.max(1, Math.round(H * scale)), L.maxLongEdge);
        while (rw * rh > L.maxPixels && rw > 1 && rh > 1) { if (rw >= rh) rw--; else rh--; }   // 丸めで数百ピクセル超えることがある (Codex 監査)
        return { w: rw, h: rh, scale };
    }

    /** その大きさの画像が何トークンになるかの目安 (向こうで縮められたあとの大きさで数える) */
    function estimateImageTokens(w, h) {
        const f = fitSize(w, h);
        return Math.ceil((f.w * f.h) / PIXELS_PER_TOKEN);
    }

    /** 1 回の usage → USD (分からないモデルは既定の単価)。usage が無ければ 0 */
    function costUsd(usage, model) {
        const u = usage && typeof usage === 'object' ? usage : {};
        const p = PRICING[String(model || DEFAULT_MODEL)] || PRICING[DEFAULT_MODEL];
        const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        return (n(u.input_tokens) * p.inPerM + n(u.output_tokens) * p.outPerM
            + n(u.cache_read_input_tokens) * p.cacheReadPerM + n(u.cache_creation_input_tokens) * p.cacheWritePerM) / 1e6;
    }

    /** 同じ画像を二度読まないための鍵 (task + options + 送る画像の中身)。FNV-1a を種違いで 2 本 = 64 ビット相当 */
    function cacheKey(task, options, imageDataUrl) {
        const s = `${String(task || '')}\n${_stableJson(options)}\n${String(imageDataUrl || '')}`;
        return `${_fnv1a(s, 0x811c9dc5)}${_fnv1a(s, 0x1b873593)}`;
    }
    function _fnv1a(str, seed) {
        let h = seed >>> 0;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return h.toString(16).padStart(8, '0');
    }
    function _stableJson(v) {
        if (v == null || typeof v !== 'object') return JSON.stringify(v == null ? null : v);
        if (Array.isArray(v)) return `[${v.map(_stableJson).join(',')}]`;
        return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stableJson(v[k])}`).join(',')}}`;
    }

    /** 今月の利用の記録を 1 回ぶん進める (月が変わればやり直し)。record は { month, calls, cached, input, output, usd } */
    function usageAdd(record, usage, model, now) {
        const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const base = (record && typeof record === 'object' && record.month === month)
            ? record : { month, calls: 0, cached: 0, input: 0, output: 0, usd: 0 };
        const u = usage && typeof usage === 'object' ? usage : null;
        const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        if (!u) return { ...base, calls: n(base.calls) + 1, cached: n(base.cached) + 1 };   // 読み直さずに済んだ回
        return {
            month, calls: n(base.calls) + 1, cached: n(base.cached),
            input: n(base.input) + n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens),
            output: n(base.output) + n(u.output_tokens),
            usd: n(base.usd) + costUsd(u, model),
        };
    }

    /** 画面に出す 1 行 (この端末だけの数字)。記録が無ければ '' */
    function usageLabel(record) {
        if (!record || !(Number(record.calls) > 0)) return '';
        const tok = Number(record.input || 0) + Number(record.output || 0);
        const tokText = tok >= 10000 ? `約 ${(tok / 10000).toFixed(1)} 万` : `約 ${tok.toLocaleString('ja-JP')}`;
        const usd = Number(record.usd || 0);
        const usdText = usd < 0.01 ? '$0.01 未満' : `$${usd.toFixed(2)}`;
        const cached = Number(record.cached || 0) > 0 ? `・読み直さずに済んだ ${Number(record.cached)} 回` : '';
        return `この端末の今月の AI 利用: ${Number(record.calls)} 回・${tokText}トークン (≈ ${usdText})${cached}`;
    }

    root.aiVisionDomain = {
        RULES, explainError, messageOf,
        IMAGE_LIMITS, PIXELS_PER_TOKEN, PRICING, DEFAULT_MODEL,
        fitSize, estimateImageTokens, costUsd, cacheKey, usageAdd, usageLabel,
    };
})(typeof window !== 'undefined' ? window : globalThis);
