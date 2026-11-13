# 全体の見直し (2026-11-13〜) の調査の道具

テストではない (run-tests からは呼ばない)。見直しの前 / 後で数字と画面を比べるために使う。Chrome が要る (`CHROME=<実行ファイル>` で場所を指定できる)。
出力はリポジトリの外 (scratchpad など) に置く — 画面写真や計測の結果をコミットしない。

| 道具 | 何をするか | 使い方 (リポジトリの直下で) |
|---|---|---|
| `count.mjs` | index.html の数え上げ (大きさ・文字サイズ・角丸・影・ボタン・alert / confirm・`catch {}` など) | `node scripts/survey/count.mjs .` |
| `shots.mjs` | 練習モード (`?practice=member` / `ops-eve` / `ops-day`) で全タブを開いて画面写真 (スマホ・PC) と数字。本番へは通信しない | `node scripts/survey/shots.mjs . <出力フォルダ>` |
| `perf.mjs` | 本番の DB を**読むだけ** (GET / HEAD / OPTIONS 以外は落とす) で、起動 15 秒と待機 1 分の通信の本数 | `node scripts/survey/perf.mjs . <名乗る人の id> [ops] [CPU の絞り]` |
| `trace.mjs` | perf と同じ条件で、`window.supabase*` を包んで「どの関数が何回読んだか」を数える | `node scripts/survey/trace.mjs . <名乗る人の id> [ops] [CPU の絞り] [tabs]` |

Node 22.4 以降が要る (組み込みの `WebSocket` を使う)。

注意:
- `perf.mjs` / `trace.mjs` は本番を読む。通すのは **表と保存領域の読み取り (`/rest/v1/`・`/storage/v1/` の GET / HEAD / OPTIONS) だけ** — 書き込み・RPC・Edge Function (GET でも) は CDP の Fetch で落とす。
  Service Worker・WebSocket・EventSource は Fetch を通らないので、ページの最初に使えなくしている (アプリは「非対応の端末」と同じ道を通る = 通知まわりは測れない)。それでもレイド当日は動かさない。
- `shots.mjs` は Supabase への通信を全部落とす (練習モードは元から本番を読まない)。フォントと Chart.js の CDN は読む。
- 数字は「そのとき動いているシーズン」と「名乗った人の役割」で変わる。比べるときは同じ条件で (2026-11-13 の数字はリハーサル中・マスターの名乗り)。
- 名乗る人の id は引数で渡す (既定は無い)。
