#!/usr/bin/env bash
# Stop フック: 作業終了時に未pushの差分を Codex でレビューする。
# 指摘があれば Stop をブロックして Claude に差し戻す (exit 2)。
# クロスプラットフォーム: Windows(Git Bash) / macOS 両対応。bash 明示起動・LF改行・node でJSON解析。
set -euo pipefail

# 0=発火ログのみ (テスト) / 1=codexレビュー有効。まず0で発火確認 → 1に切替。
CODEX_ENABLED=0

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# --- 1) Stop フックの stdin JSON を受け取り、ループ防止 ---
INPUT="$(cat)"
ACTIVE="$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).stop_hook_active===true?"1":"0")}catch(e){process.stdout.write("0")}})' || echo 0)"
[ "$ACTIVE" = "1" ] && exit 0

# --- 2) 本家リポジトリのルートへ (セッションのCWDに依存しない) ---
cd "$SELF_DIR/../.." || exit 0

# 未pushの全変更 = upstream→作業ツリー (コミット直後でも残る)。upstream未設定なら未コミット分。
BASE="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo HEAD)"
DIFF="$(git diff "$BASE" || true)"

# --- 3) テスト版: diff の有無に関わらず「発火した」ことをログに残す (発火確認用) ---
if [ "$CODEX_ENABLED" != "1" ]; then
    printf '%s  fired (base=%s, diff=%d bytes)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BASE" "${#DIFF}" >> "$SELF_DIR/_fired.log"
    exit 0
fi

# 本番は diff が空ならレビュー不要
[ -z "$DIFF" ] && exit 0

# --- 4) 本番: Codex にレビューさせる (read-only sandbox・ephemeral・差分は stdin) ---
# --output-last-message で最終メッセージだけをファイルに取り (バナー等のノイズを除去)。
PROMPT='以下は git diff です。バグ・境界条件・セキュリティ問題だけを「ファイル:行 → 問題 → 修正案」の形式で簡潔に指摘してください。問題が無ければ「問題なし」とだけ答えてください。実装や修正はしないでください。'
TMP="$(mktemp 2>/dev/null || echo "$SELF_DIR/.codex_last.$$")"
printf '%s' "$DIFF" | codex exec --sandbox read-only --ephemeral -o "$TMP" "$PROMPT" >/dev/null 2>&1 || true
OUT="$(cat "$TMP" 2>/dev/null || true)"
rm -f "$TMP"

# --- 5) 判定 ---
# codexが無出力/失敗 → fail-open (レビュー不能で Stop をブロックしない)。
[ -z "$OUT" ] && exit 0
# 「問題なし」なら通過、指摘があれば stderr に出して Stop をブロック。
if printf '%s' "$OUT" | grep -q '問題なし'; then
    exit 0
fi
printf 'Codex レビューの指摘:\n%s\n' "$OUT" >&2
exit 2
