// ============================================================================
// Supabase Edge Function: analyze-image
// ============================================================================
// PADフロントエンドから画像 (base64 data URL) を受け取り、Anthropic Haiku Vision
// で構造化抽出して返すプロキシ。ANTHROPIC_API_KEY は環境変数で参照するため、
// クライアント側に絶対に漏れない。
//
// リクエスト例 (POST /analyze-image):
//   { "image": "data:image/png;base64,iVBOR...", "task": "attack_result" }
// レスポンス例:
//   { "ok": true, "result": { "bossName": "ストームブリンガー", "totalDamage": 9673613117 } }
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPTS: Record<string, string> = {
  attack_result:
    `画像はモバイルゲーム「勝利の女神:NIKKE」のユニオンレイドの凸結果画面です。\n` +
    `以下の情報を画像から抽出してJSONで返してください。\n` +
    `- bossName: ボス名（例: "ストームブリンガー"）。"OPERATION COMPLETE" や冒頭のローマ数字接頭辞 (I/II/III/IV/V) は除外\n` +
    `- totalDamage: TOTAL DAMAGE の数値（カンマ除去した整数、例: 9673613117）\n\n` +
    `JSON以外の文字は一切返さない。コードフェンスも禁止。\n` +
    `形式: {"bossName": "ストームブリンガー", "totalDamage": 9673613117}`,

  bla_progress:
    `画像はBlaBlaLINK拡張のユニオンレイド進捗画面です。以下の情報を抽出してJSONで返してください。\n` +
    `- level: 現在のレベル数値 (画像に "Lv.N" や "レベルN" 表示)\n` +
    `- bosses: 5体のボス情報配列。各要素 {"name": "ボス名", "currentHp": 残HP整数, "maxHp": 総HP整数}\n\n` +
    `HPは "1.23B" や "12,345,678,900" 形式があり得るが、必ずカンマ除去した整数で返す。Bは10^9倍する。\n` +
    `JSON以外の文字は一切返さない。`,

  season_announce:
    `画像はNIKKEの公式ユニオンレイド開幕アナウンスです。以下の情報を抽出してJSONで返してください。\n` +
    `- startDate: 開始日 YYYY-MM-DD (年は今年として推測してOK)\n` +
    `- bosses: 5体配列。各要素 {"position": 1〜5, "name": "ボス名", "weakness": "灼熱"|"水冷"|"電撃"|"鉄甲"|"風圧", "tier": "tyrant"|"lord"}\n\n` +
    `JSON以外の文字は一切返さない。`,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return jsonError("ANTHROPIC_API_KEY not set in Edge Function secrets", 500);

    const body = await req.json().catch(() => ({}));
    const { image, task, prompt: customPrompt, model } = body;
    if (!image) return jsonError("image is required (base64 data URL)", 400);

    const promptText = customPrompt || PROMPTS[task as string];
    if (!promptText) return jsonError(`unknown task: ${task}`, 400);

    // "data:image/png;base64,XXXX" 形式をパース
    const m = String(image).match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
    if (!m) return jsonError("invalid image data URL format", 400);
    const mediaType = m[1];
    const base64Data = m[2];

    const useModel = (typeof model === "string" && model.length > 0)
      ? model
      : "claude-haiku-4-5";

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: promptText },
          ],
        }],
      }),
    });

    if (!ar.ok) {
      const errText = await ar.text();
      return jsonError(`Anthropic API error (${ar.status}): ${errText}`, 502);
    }
    const data = await ar.json();
    const text = (data?.content?.[0]?.text || "").trim();

    // JSON パース試行 (コードフェンス除去)
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parseError = String((e as Error)?.message || e);
    }

    return new Response(JSON.stringify({
      ok: true,
      result: parsed,
      raw: text,
      parseError,
      usage: data?.usage,
    }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError(String((err as Error)?.message || err), 500);
  }
});

function jsonError(message: string, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
