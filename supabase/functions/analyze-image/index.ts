// ============================================================================
// Supabase Edge Function: analyze-image
// Anthropic Haiku Vision プロキシ。Phase 4a 用。
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPTS = {
  attack_result: [
    "画像はNIKKEのユニオンレイドの凸結果画面です。以下をJSONで抽出してください。",
    "- bossName: ボス名 (例 ストームブリンガー)。OPERATION COMPLETE や接頭辞 I/II/III/IV/V は除外",
    "- totalDamage: TOTAL DAMAGE の整数値 (カンマ除去)",
    "",
    "出力はJSONのみ。コードフェンス禁止。",
    '形式: {"bossName":"ストームブリンガー","totalDamage":9673613117}',
  ].join("\n"),

  bla_progress: [
    "画像はBlaBlaLINK拡張のユニオンレイド進捗画面です。以下をJSONで抽出してください。",
    "- level: 現在レベル数値",
    "- bosses: 5体の配列。各要素 name / currentHp / maxHp",
    "",
    "HPはB表記でも整数で返す (Bは10^9倍)。出力はJSONのみ。",
  ].join("\n"),

  season_announce: [
    "画像はNIKKEのユニオンレイド開幕アナウンスです。以下をJSONで抽出してください。",
    "- startDate: 開始日 YYYY-MM-DD",
    "- bosses: 5体配列。各 position(1-5)/name/weakness(灼熱|水冷|電撃|鉄甲|風圧)/tier(tyrant|lord)",
    "",
    "出力はJSONのみ。",
  ].join("\n"),
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: status || 500,
    headers: Object.assign({}, CORS_HEADERS, { "Content-Type": "application/json" }),
  });
}

export default {
  async fetch(req) {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: CORS_HEADERS });
    }

    try {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) {
        return jsonError("ANTHROPIC_API_KEY not set in Edge Function secrets", 500);
      }

      const body = await req.json().catch(function () { return {}; });
      const image = body.image;
      const task = body.task;
      const customPrompt = body.prompt;
      const model = body.model;

      if (!image) return jsonError("image is required", 400);

      const promptText = customPrompt || PROMPTS[task];
      if (!promptText) return jsonError("unknown task: " + String(task), 400);

      const m = String(image).match(/^data:(image\/[a-z0-9+.\-]+);base64,(.+)$/i);
      if (!m) return jsonError("invalid image data URL", 400);
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
        return jsonError("Anthropic API error (" + ar.status + "): " + errText, 502);
      }
      const data = await ar.json();
      const text = (data && data.content && data.content[0] && data.content[0].text || "").trim();

      let parsed = null;
      let parseError = null;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        parseError = String((e && e.message) || e);
      }

      return new Response(JSON.stringify({
        ok: true,
        result: parsed,
        raw: text,
        parseError: parseError,
        usage: data && data.usage,
      }), {
        headers: Object.assign({}, CORS_HEADERS, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonError(String((err && err.message) || err), 500);
    }
  },
};
