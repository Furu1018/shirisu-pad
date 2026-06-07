// ============================================================================
// Supabase Edge Function: analyze-image (Phase 4d拡張)
// Anthropic Haiku Vision / Text プロキシ
// ============================================================================
// 画像解析 (task: attack_result / bla_progress / season_announce)
// テキスト推論 (task: finish_recommend) の両方に対応
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---- 画像系プロンプト ----
const IMAGE_PROMPTS = {
  attack_result: [
    "画像はNIKKEのユニオンレイドの凸結果画面(または戦闘履歴画面)です。以下をJSONで抽出してください。",
    "- bossName: ボス名 (例 ストームブリンガー)。OPERATION COMPLETE や接頭辞 I/II/III/IV/V は除外",
    "- totalDamage: TOTAL DAMAGE の整数値 (カンマ除去)",
    "- bossMaxHp: 結果画面上部のボス最大HP整数値 (Bは10^9倍。判読不能なら null)",
    "- bossRemainingHp: 凸後のボス残HP整数値 (Bは10^9倍。撃破で 0、判読不能なら null)",
    "- characters: 使用した5キャラの名前を順番に並べた配列。NIKKE名は日本語そのまま (例: \"ラピ:レッドフード\", \"アニス:スター\")。",
    "    名前の前後の記号(I/II/III/A 等のバースト記号)は除外。コロンは半角 \":\" で統一。",
    "    画面に映っていない/判読不能なキャラは null を含めて 5要素を維持。取れなければ characters: null。",
    "",
    "出力はJSONのみ。コードフェンス禁止。",
    '形式: {"bossName":"ストームブリンガー","totalDamage":9673613117,"bossMaxHp":99856279200,"bossRemainingHp":42153117000,"characters":["アニス:スター","クラウン","ラピ:レッドフード","レッドフード","レイヴン"]}',
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

// ---- テキスト推論系プロンプト (context をユーザーメッセージで渡す) ----
const TEXT_PROMPTS = {
  finish_recommend: [
    "あなたはNIKKEユニオンレイドの戦況コーチです。",
    "ユーザーが提供する状況 (対象ボス、残HP、PT属性、候補メンバーのリスト) から、",
    "誰に締め凸をお願いするのが最適かを判断してください。",
    "",
    "判定基準:",
    "1. 残HPちょうど削れる人を最優先（過剰ダメは無駄、超過0.5B以内が理想）",
    "2. 同程度の候補が複数いるなら、凸残数が多い人を優先 (残2,3 > 残1)",
    "3. 残HPを大きく下回るダメージしか出せない候補しかいない場合は最大ダメ候補を推薦",
    "",
    "出力はJSONのみ、コードフェンス禁止。",
    '形式: {"recommendedName":"プレイヤー名","reason":"30文字程度の根拠"}',
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
      const context = body.context;
      const model = body.model;

      let useModel = (typeof model === "string" && model.length > 0)
        ? model
        : "claude-haiku-4-5";

      // ---- 画像モード ----
      if (image) {
        const promptText = customPrompt || IMAGE_PROMPTS[task];
        if (!promptText) return jsonError("unknown image task: " + String(task), 400);

        const m = String(image).match(/^data:(image\/[a-z0-9+.\-]+);base64,(.+)$/i);
        if (!m) return jsonError("invalid image data URL", 400);
        const mediaType = m[1];
        const base64Data = m[2];

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
        return await respondFromAnthropic(ar);
      }

      // ---- テキスト推論モード ----
      if (context !== undefined) {
        const systemPrompt = customPrompt || TEXT_PROMPTS[task];
        if (!systemPrompt) return jsonError("unknown text task: " + String(task), 400);

        const userText = (typeof context === "string") ? context : JSON.stringify(context);

        const ar = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: useModel,
            max_tokens: 512,
            system: systemPrompt,
            messages: [{ role: "user", content: userText }],
          }),
        });
        return await respondFromAnthropic(ar);
      }

      return jsonError("image or context is required", 400);
    } catch (err) {
      return jsonError(String((err && err.message) || err), 500);
    }
  },
};

async function respondFromAnthropic(ar) {
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
}
