#!/usr/bin/env bash
# Stop フック: 「Codexも併用して」でONにしている間だけ、未pushの差分を Codex にレビューさせる。
# 指摘があれば Stop をブロックし (exit 2)、Claude に差し戻して対応させる。
#
# トグル: .claude/hooks/.codex-on が存在すれば有効。無ければ即終了 = 通常時は完全に無負荷。
#   ON  : touch .claude/hooks/.codex-on
#   OFF : rm -f .claude/hooks/.codex-on
#
# クロスプラットフォーム: Windows(Git Bash) / macOS 両対応 (bash明示起動・LF改行・node でJSON解析)。
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
FLAG="$SELF_DIR/.codex-on"

INPUT="$(cat)"

# --- 1) トグルOFF なら何もしない (既定。レビュー不要な普段のターンは即終了) ---
[ -f "$FLAG" ] || exit 0

# --- 2) ループ防止: 指摘で差し戻した後の再Stopでは再レビューしない ---
ACTIVE="$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).stop_hook_active===true?"1":"0")}catch(e){process.stdout.write("0")}})' || echo 0)"
[ "$ACTIVE" = "1" ] && exit 0

# --- 3) 本家リポジトリのルートへ (セッションのCWDに依存しない) ---
cd "$SELF_DIR/../.." || exit 0

# 未pushの全変更 = upstream→作業ツリー (コミット直後でも残る)。upstream未設定なら未コミット分。
BASE="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo HEAD)"
# git の警告 (CRLF等) が Claude への差し戻しに混ざらないよう stderr は捨てる
DIFF="$(git diff "$BASE" 2>/dev/null || true)"

# git diff は未追跡ファイルを含まない = 新規作成されたコードが丸ごとレビュー対象外になる。
# 新規ファイルこそ未レビューだと危ないので、明示的に差分化して足す (.gitignore 対象は除外)。
# -z (NUL区切り) で列挙: ファイル名に空白・改行・glob文字(*,?)が入っても壊れない。
while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    DIFF="$DIFF
$(git diff --no-index -- /dev/null "$f" 2>/dev/null || true)"
done < <(git ls-files --others --exclude-standard -z 2>/dev/null)

[ -z "$DIFF" ] && exit 0

STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

# --- 4) Codex にレビューさせる (read-only sandbox・ephemeral・差分は stdin) ---
# --output-last-message で最終メッセージだけを取る (バナー等のノイズを除去)。
PROMPT='以下は git diff です。バグ・境界条件・セキュリティ問題だけを「ファイル:行 → 問題 → 修正案」の形式で簡潔に指摘してください。問題が無ければ「問題なし」とだけ答えてください。実装や修正はしないでください。'
# mktemp 失敗時に予測可能な名前へフォールバックしない (シンボリックリンク攻撃を避ける)。
TMP="$(mktemp 2>/dev/null || true)"
if [ -z "$TMP" ]; then
    printf '%s  review: SKIP (mktemp失敗)\n' "$STAMP" >> "$SELF_DIR/_fired.log"
    exit 0
fi
printf '%s' "$DIFF" | codex exec --sandbox read-only --ephemeral -o "$TMP" "$PROMPT" >/dev/null 2>&1 || true
OUT="$(cat "$TMP" 2>/dev/null || true)"
rm -f "$TMP"

# --- 5) 判定 ---
# codexが無出力/失敗 → fail-open (レビュー不能で Stop をブロックしない)
if [ -z "$OUT" ]; then
    printf '%s  review: SKIP (codex応答なし, diff=%d bytes)\n' "$STAMP" "${#DIFF}" >> "$SELF_DIR/_fired.log"
    exit 0
fi
# 「問題なし」なら通過。
# ※ grep での部分一致は不可: 指摘文中に「問題なし」の語が含まれると本物の指摘を握りつぶす
#    (実際にこのバグを踏んだ)。空白を除いた全体が「問題なし」のときだけ通過させる。
CLEAN="$(printf '%s' "$OUT" | tr -d '[:space:]' | sed 's/[。．.!！]*$//')"
if [ "$CLEAN" = "問題なし" ]; then
    printf '%s  review: OK (diff=%d bytes)\n' "$STAMP" "${#DIFF}" >> "$SELF_DIR/_fired.log"
    exit 0
fi
# 指摘あり → stderr に出して Stop をブロック (Claude が対応する)
printf '%s  review: NG (diff=%d bytes)\n' "$STAMP" "${#DIFF}" >> "$SELF_DIR/_fired.log"
printf 'Codex レビューの指摘 (対応してから作業を終えてください):\n%s\n' "$OUT" >&2
exit 2
