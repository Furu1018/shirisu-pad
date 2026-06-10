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
    "- characters: 使用した5キャラの名前を順番に並べた配列。",
    "    重要な抽出ルール:",
    "    1) NIKKE名は **必ず正式名称を最後まで** 返す。途中で見切れている場合も、知っているNIKKEなら正式名に補完する。",
    "       例: 画面が \"ブラックシャ\" で切れていても **\"紅蓮：ブラックシャドウ\"** と補完する。",
    "       例: \"ルマーメイド\" → **\"リトルマーメイド\"**、 \"ラピ：レッドフ\" → **\"ラピ:レッドフード\"**。",
    "    2) **スキン/Pilgrim/Anniversary 等の接頭辞は必ず含める**。",
    "       例: \"紅蓮：ブラックシャドウ\"、\"レッドフード:イノセント\"、\"ラピ:レッドフード\"。",
    "       接頭辞は半角 \":\" で区切る (全角 \"：\" は半角 \":\" に統一)。",
    "    3) 名前の前後の記号 (I/II/III/A 等のバースト記号) は除外。",
    "    4) 似ているがOCRゆれ表記には注意 (\"ベルベット\" を \"ベルペット\" と間違えない等)。",
    "    5) 画面に映っていない/判読不能なキャラは null を含めて 5要素を維持。全く取れなければ characters: null。",
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

  bla_my_attacks: [
    "画像はBlaBlaLINK拡張で表示される「メンバー個別のユニオンレイド凸結果一覧」です。",
    "プレイヤー名の下に 1〜3個 の凸結果カードが縦に並んでいます。各カードを attacks 配列に順番に抽出してください。",
    "",
    "各凸の抽出内容:",
    "- bossCode: ボス略称コードを以下から選択 (A.N.M.I. / H.S.T.A. / P.S.I.D. / Z.E.U.S. / D.M.T.R.)。",
    "    ボス名と略称の対応は表記そのまま画像内に「ボス名「コード」」形式で書かれている。例: リビルドキューカンバー「A.N.M.I.」 → A.N.M.I.",
    "- bossName: ボス名 (略称コードは除外、純粋にボス名のみ)。例: \"リビルドキューカンバー\"。",
    "- level: HARD ラベル下の数値 (例: \"Level 2\" なら 2)。読めなければ null。",
    "- totalDamage: 「ダメージ」ラベル右に表示される整数値 (カンマ除去)。",
    "",
    "※ 編成キャラの抽出は不要 (このタスクは消化済み凸の報告で、キャラ衝突検知の用途がないため)。",
    "出力はJSONのみ。コードフェンス禁止。",
    '形式: {"attacks":[{"bossCode":"A.N.M.I.","bossName":"リビルドキューカンバー","level":2,"totalDamage":10618556492}, ...]}',
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
        let promptText = customPrompt || IMAGE_PROMPTS[task];
        if (!promptText) return jsonError("unknown image task: " + String(task), 400);

        // attack_result: 当ユニオン登録済みキャラリストを末尾に注入。
        // 名前が見切れていてもアイコン画像 + リスト内の正式名で識別してもらう
        // (bla_my_attacks は characters 抽出を行わないため対象外)
        if (task === "attack_result" && Array.isArray(body.known_characters) && body.known_characters.length > 0) {
          const list = body.known_characters
            .filter((s: unknown) => typeof s === "string" && (s as string).trim())
            .slice(0, 200)
            .map((s: string) => "  - " + s)
            .join("\n");
          if (list.length > 0) {
            promptText += "\n\n【当ユニオン登録済みキャラ一覧】\n" + list + "\n\n";
            promptText += "===== 重要な照合手順 (順番に従ってください) =====\n";
            promptText += "1) まずキャラのアイコン画像を見て NIKKE のどのキャラか識別する (これが第一優先)。\n";
            promptText += "2) その識別結果が上の一覧にあれば、**必ず一覧の正式名をそのまま** 返す。\n";
            promptText += "3) テキストでは『ブリッド:サイ』と読めても、アイコンが特徴的に別キャラに見える場合は、一覧から正しい候補を再選定する。\n";
            promptText += "4) テキストの1〜2文字目の誤読は頻繁に発生する (グ↔ブ, ヘ↔ベ, ハ↔ミ, ル↔リ など)。一覧に1〜2文字違いの候補があれば、アイコンで最終判断。\n";
            promptText += "5) 名前の前後の I/II/III/IV/V/MAX バースト記号やバッジは **絶対に名前に含めない**。\n";
            promptText += "6) 一覧に該当が無いキャラのみ、テキスト読み取り結果をそのまま返す (このとき正式名称を最後まで補完する)。\n";
          }
        }

        const m = String(image).match(/^data:(image\/[a-z0-9+.\-]+);base64,(.+)$/i);
        if (!m) return jsonError("invalid image data URL", 400);
        const mediaType = m[1];
        const base64Data = m[2];

        // プロンプトキャッシュ最適化:
        // プロンプト本体(指示+登録キャラ一覧)はリクエスト間で同じなのでキャッシュ対象に。
        // 画像は毎回違うので非キャッシュ。content順序は「テキスト先, 画像後」が必須
        // (cache_control 付与ブロックより前の内容も含めてプレフィックスが一致する必要があるため)。
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
                { type: "text", text: promptText, cache_control: { type: "ephemeral" } },
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
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
