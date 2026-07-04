// ============================================================================
// Supabase Edge Function: send-push (Phase 6b)
// ----------------------------------------------------------------------------
// push_subscriptions テーブルに登録されている購読者宛に Web Push 通知を配信。
// VAPID 鍵は Supabase Edge Function Secrets から取得 (公開鍵は本ファイルに
// 同期したものをそのまま使う)。
//
// リクエスト例 (POST):
// {
//   "title": "締め凸候補!",
//   "body": "ヘビーメタル 残3.5B → ふるりさん",
//   "url": "./?tab=ops",
//   "tag": "finish-claim-2026-05-23-2",   // 任意。同タグで上書き
//   "requireInteraction": false,
//   "playerIds": [1, 5, 9]                 // 指定なし=全員に配信
// }
//
// レスポンス:
// { ok: true, sent: 3, target: 3, results: [...] }
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// esm.sh の deno-next ターゲット指定でnpm互換問題を回避
import webpush from "https://esm.sh/web-push@3.6.7?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=denonext";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// VAPID公開鍵 (フロントの window.SHIRISU_VAPID_PUBLIC_KEY と一致させる)
const VAPID_PUBLIC_KEY = "BI6_g-ZWfqkRGqSQRU5NgEmLmyv8EgvvwgPFv-DDQYv2PzC1SFH-ugNcWGpQHH8E-hoBLnnFy4Yl5XFa3rysNrI";

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
      const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
      const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "";
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

      if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
        return jsonError("VAPID_PRIVATE_KEY / VAPID_SUBJECT が Secrets に未設定", 500);
      }
      if (!SUPABASE_URL || !SERVICE_KEY) {
        return jsonError("Supabase env が未設定 (自動付与のはず)", 500);
      }

      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

      const body = await req.json().catch(function () { return {}; });
      const title = (body.title || "しりすこPAD").toString();
      const bodyText = (body.body || "").toString();
      const url = body.url || "./";
      const tag = body.tag || undefined;
      const playerIds = Array.isArray(body.playerIds) ? body.playerIds : null;
      const requireInteraction = !!body.requireInteraction;
      // ignoreAvailability=true (運営の「全員に送信」など) なら availability フィルタを無視
      const ignoreAvailability = !!body.ignoreAvailability;

      // service_role で push_subscriptions を取得 (RLS 回避)
      const sb = createClient(SUPABASE_URL, SERVICE_KEY);
      let query = sb.from("push_subscriptions").select("id, player_id, endpoint, p256dh, auth");
      if (playerIds && playerIds.length > 0) {
        query = query.in("player_id", playerIds);
      }
      const { data: subs, error: sErr } = await query;
      if (sErr) return jsonError("subscriptions fetch failed: " + sErr.message, 500);
      let filteredSubs = subs || [];
      let filteredOutByAvail = 0;

      // availability フィルタ: 現在JST時刻に該当時間帯を許可しているプレイヤーのみ残す
      // ★ オプトイン方式: availability に1行も無いプレイヤーは「全時間帯OFF」として除外
      // ★ notify_all_hours / flex_time のプレイヤーは時間帯に関係なく受け取る
      if (!ignoreAvailability && filteredSubs.length > 0) {
        const jstHour = (new Date().getUTCHours() + 9) % 24;
        // 現行の時間別形式 (h00〜h23)
        const currentSlot = "h" + String(jstHour).padStart(2, "0");
        // 旧5区分形式のデータが残っている環境への後方互換
        const legacySlot = (function () {
          if (jstHour >= 5 && jstHour < 9) return "morning";
          if (jstHour >= 9 && jstHour < 14) return "noon";
          if (jstHour >= 14 && jstHour < 18) return "evening";
          if (jstHour >= 18 && jstHour < 24) return "night";
          return "latenight";
        })();

        const targetPlayerIds = Array.from(new Set(filteredSubs.map(function (s) { return s.player_id; })));

        // 対象プレイヤーの availability を一括取得
        const { data: availRows } = await sb
          .from("availability")
          .select("player_id, time_slot")
          .in("player_id", targetPlayerIds);

        // 「現在 slot を許可している」プレイヤー集合 (hXX / 旧形式 どちらでも可)
        const playersAllowingNow = new Set();
        (availRows || []).forEach(function (r) {
          if (r.time_slot === currentSlot || r.time_slot === legacySlot) playersAllowingNow.add(r.player_id);
        });

        // 🔔 いつでも受け取る / ⏳ 隙間時間型 は時間帯フィルタを通過させる
        // (18_availability_prefs.sql 未適用環境では列が無いのでスキップ)
        try {
          const { data: prefRows } = await sb
            .from("players")
            .select("id, notify_all_hours, flex_time")
            .in("id", targetPlayerIds);
          (prefRows || []).forEach(function (p) {
            if (p.notify_all_hours || p.flex_time) playersAllowingNow.add(p.id);
          });
        } catch (_e) { /* 列未追加環境 */ }

        // 未設定者も含めて全員 opt-in 判定: playersAllowingNow に含まれていなければ除外
        const before = filteredSubs.length;
        filteredSubs = filteredSubs.filter(function (s) {
          return playersAllowingNow.has(s.player_id);
        });
        filteredOutByAvail = before - filteredSubs.length;
      }

      if (filteredSubs.length === 0) {
        return new Response(JSON.stringify({
          ok: true,
          sent: 0,
          target: 0,
          filteredOutByAvail,
          results: [],
        }), {
          headers: Object.assign({}, CORS_HEADERS, { "Content-Type": "application/json" }),
        });
      }

      const payload = JSON.stringify({
        title,
        body: bodyText,
        url,
        tag,
        requireInteraction,
      });

      // 並列送信して結果集計
      const results = await Promise.all(filteredSubs.map(async (sub) => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        try {
          await webpush.sendNotification(subscription, payload);
          return { id: sub.id, ok: true };
        } catch (e) {
          const status = (e && e.statusCode) || 0;
          // 410 Gone / 404 Not Found = 購読期限切れ → 削除
          if (status === 410 || status === 404) {
            try { await sb.from("push_subscriptions").delete().eq("id", sub.id); } catch {}
            return { id: sub.id, ok: false, removed: true, error: "expired" };
          }
          return { id: sub.id, ok: false, error: String((e && e.message) || e), status };
        }
      }));

      const sent = results.filter(function (r) { return r.ok; }).length;
      const removed = results.filter(function (r) { return r.removed; }).length;

      return new Response(JSON.stringify({
        ok: true,
        sent,
        target: filteredSubs.length,
        candidates: (subs || []).length,
        filteredOutByAvail,
        removed,
        results,
      }), {
        headers: Object.assign({}, CORS_HEADERS, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonError(String((err && err.message) || err), 500);
    }
  },
};
