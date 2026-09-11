# しりすこPAD プロジェクトガイド

NIKKE ユニオンレイド運営ツール。**定員32人96凸**の内輪ユニオン向け PWA
(第44回は在籍31人・1人が凸忘れで実績90凸)。

**★ いま何のために改修しているか**: 第44回 (2026-09-05) の反省は「未消化凸が多かった」ことでは**なく**、
**当日のプラン再生成でメンバーを振り回したこと**。第45回の目的は
「計画した凸が計画どおり消化され、一度決めた約束が後から覆らない状態」で、
順位や総与ダメの最大化より**約束を守ることを優先**する。詳細と5層の対策は ROADMAP.md 冒頭
「🎯 改修の目的」。**ROADMAP の古い記述 (未消化49凸を実害の筆頭とするもの) を前提に実装しないこと**。

`.claude/skills/` に作業手順スキルあり (git 同期・どのPC/モデルでも共通):
`shirisu-verify-ship` (検証→デプロイ) / `shirisu-supabase-migration` (SQL追加) /
`shirisu-mobile-ui` (UIの落とし穴) / `evidence-first-dev` (進め方の型)。該当作業の前に読むこと。
現状サマリー・実戦検証タスク・既知の穴・機能候補は **ROADMAP.md** に集約されている。

## Codex 併用レビュー (トグル・既定OFF)

ユーザーが「**Codexも併用して**」(同義の依頼含む) と言ったら:
```sh
touch .claude/hooks/.codex-on      # ON
```
以降、**作業を終えるたびに Stop フック (`.claude/hooks/codex-review.sh`) が未pushの差分を
Codex CLI にレビューさせる**。バグ・境界条件・セキュリティの指摘があれば Stop がブロックされ
stderr に指摘が返るので、**対応してから作業を終えること**。
**⚠ 監査を通さない push は禁止** (2026-07-22 に8コミットが未監査で本番に入った事故あり)。
**標準フロー (2026-07-25 更新・ユーザー指示)**: 実装 → commit → **同一ターン内で
codex:codex-rescue へ明示レビューを依頼** → 指摘対応 → **同一ターンで push まで完了**。
ターンを跨ぐと実機確認が止まるため、push 前で区切らないこと。Stop フックは
「レビューされないまま残った未push差分」を拾う保険として引き続き機能する
(明示レビュー後に push 済みなら差分ゼロで素通り = 正常)。

「**Codexオフ**」等で解除:
```sh
rm -f .claude/hooks/.codex-on      # OFF
```
既定は OFF (フックは即終了するので無負荷)。ON中は毎ターン10〜60秒 + APIコストがかかる。
前提: `codex` CLI が PATH 上にあること。レビュー実行の記録は `.claude/hooks/_fired.log`。
**フラグは .gitignore 済み = PCごとの設定**。別PCに移ったら ON にし直すこと (APIコストが出るので同期しない)。

## アーキテクチャ

- **模擬提出シート (編成編集モーダル) は 2026-09-08 に再設計** (モック a3a7b6e9・ユーザー承認)。
  並びは ① 編成 (スクショ読み取りは見出しの横の小さな入口) → ② ダメージ → ③ キャラを選ぶ (5人そろうと畳む)。
  **提出バーをシートの下に固定** (`.te-bar` は `position:sticky; bottom:0`。`.player-select-content.te-sheet` は
  padding/gap を 0 にして本文 `.te-body` が余白を持つ)。バーは `_renderTeamEditBar` が
  要約 (属性・編成・ダメージ、提出済みと違えば「33.1B → 35B」) と足りないものを出し、
  5人+ダメージで黒く点灯、ダメージだけ/編成だけでも提出はできる (暗い灰色)、何も無ければ押せない。
  編成の変更 (`updateMyTeamEditIcon`)・ダメージ入力 (`_renderTeamEditLevelNote`)・開いたとき・提出のあと に描き直す。
  「保存」は「提出する」に言い換え (模擬タブは「提出」で統一)。削除は赤い小リンク。予約 (🔒) は区画でなく
  バーの1行の導線 (`_renderTeamEditResv` が `#myTeamEditResvSec` に描く)。「よく使う編成」と「人気編成の参考」は
  ③ の中の1つの折りたたみ (`toggleTeamEditTopTeams` → `_teSyncPopular`)。実行テスト `tests/submit-bar.mjs`
- **モーダルが開いている間は body を固定する** (`_syncModalLock`・2026-09-08 実機FB「中を触っているのに後ろが動く」)。
  開閉は各所で classList の `open` を足し引きしているだけなので、`MutationObserver` で監視して一箇所で
  `body.modal-lock` (position:fixed + top:-scrollY) を付け外しする。閉じたら元の位置へ戻し `_navShowNow()` で
  下部ナビの自動隠しを抑止する (戻した瞬間に隠れる)。★ 固定中は `window.scrollY` が 0 — スクロール位置を
  読む処理をモーダル中に増やすときは `_modalLockY` を見ること。
  ソフトキーボード中 (入力欄にフォーカス) は `body.kb-open` で下部ナビを隠す (iOS は fixed 要素を可視領域の下端へ寄せる)
- **模擬カードの予約の印と削除ガード** (2026-09-08)。`renderMyDamagePanels` が
  自分の生きている予約を `_myMockResv` ('attr|slot' → 行) に畳み、表示中の編成に印を出す。
  ★ 印は**カード全体の薄い鍵の透かし (class `resv approved|requested|cancel_requested`) + 属性名の横の小さな文字**。
  右上のピルはダメージの数字と重なって読めなかった (実機FB)。数字や編成の上には何も置かない。
  ★ **配信プランが置けなかった予約 (`plan.unmetReservations`) は鍵ではなく「!」の透かし (`resv unmet`) と「⚠ 置けていません」**。
  ホームの3枠も `homeSlots` が `unmet` を持ち「組み直し待ち」とは区別する (stale にも「配信後の予約」にも数えない)。
  `_deleteMyTeamEditSlot` は削除の直前に本人の予約を取り直し、予約中の編成は削除させない (先にホームから取り消しを希望してもらう)
- **予約中の編成とキャラが被る編成は申請も承認もできない** (2026-09-08 実機で発覚: PT1 を予約→承認のあと同じキャラを含む
  PT2 が申請・承認でき、PT1 が置けなくなった。同じキャラは1日1回)。
  申請側は `reservationsDomain.canRequest` に編成 (`characters`) を渡すと `char_conflict` で止まる —
  **申請の3経路 (ホームの行 / 申請シート / 模擬タブの予約欄) すべてで渡すこと** (配線テストが数える)。
  承認側は `approvalImpact(..., candidateId, candidateMemberId)` の `breaks` (承認すると新たに置けなくなる固定済みの予約)。
  **本人の予約が壊れる = キャラ被り → `blockingHard` で承認不可**。他人の予約が壊れるのは枠の取り合いなので強く警告して運営が判断
- **申請シートはボスを選ばせない** (2026-09-08 ユーザー指摘)。編成の弱点属性で行くボスが決まる (`_resvReqBossOf`)。
  並びは どの編成で (全属性・ボス順) → 何時に。行き先は「→ ボス3 に行きます」の1行だけ
- **模擬タブの編成入力はタイルピッカー** (2026-08-12)。GB (`~/Desktop/shirisu-pad-global` の
  `js/tiles.js`) の「キャラ画像 + バースト帯」の構造を参考にしたが、**持ち込んだのはUIの構造だけ** —
  GBのゲームアセット全廃方針は本家に持ち込まない (本家は BlaBlaLINK 図鑑アイコンを使用)。
  ★ **値の保持先は `#myTeamEditFields` の5つの input のまま**。ピッカーは `_teSetSlot` で
  そこへ書き、再描画は `updateMyTeamEditIcon` に集約している。この形にしたのは、保存・OCR・
  人気編成の適用・アイコンピッカーという既存の読み書き経路を一切変えずに済ませるため。
  マスタに無いキャラ用に手入力欄も折りたたみで残してある
- **index.html**(約17,000行) にUI・CSS・アプリロジックのほぼ全てが入った単一ファイル構成。
  **リアーキ進行中** (ARCHITECTURE-AUDIT.md — B:段階的モジュール分割を2026-07-22に承認・着手)
- **js/supabase-client.js** — Supabase への読み書きを `window.supabaseXxx` 関数として公開
- **js/optimal-plan.js** — 最適凸プランのソルバー (純関数、単体テストあり)
- **js/domain/attributes.js** — 属性ドメイン (リアーキ ステップ1)。ボス属性⇄弱点PT属性の変換は
  ここが唯一の置き場所。画面側は `weaknessPtOf(boss)` / `bossAttributeOf(boss)` /
  `normalizeAttrKey(v)` を使う — **相性表を画面に再定義しないこと** (DB書き込み側の発生源は
  supabaseCreateSeason の COUNTER のみ)
- **ソルバーの安定化 (L1・2026-09-07)** — `computeOptimalPlanCore` に `input.previousPlan` を渡すと、
  **同じ盤面を「前回どおりを先に置いた解」と「拘束なしの通常解」で2回解いて辞書順で選ぶ**。
  ★ 渡さなければ従来と1ビットも変わらない出力になること (`node tests/solver-fingerprint.mjs` が固定)。
  拘束は `normalizeSticky` で {memberId, level, bossNumber, loadoutSlot} に畳み**安定ソート**してから
  `runLevel` の貪欲ループの前に `applyPick` で置く (残凸・キャラ・編成・残HP・必須枠の扱いを貪欲と揃えるため)。
  置けないものは黙って諦める。`trimOverkill` は約束した凸を外さない (`stickyPlaced`)。
  採否は `preferNormalOver`: 踏破改善 → 時間リスク増 → **拘束解の方が約束を壊す** → `max(5%, 30B)` の改善、
  の順で通常解へ倒す。3つ目 (`countStickyKept`) が**同一盤面不変性の要**:
  約束を先に置くと貪欲の途中状態がずれて、かえって前回の割当を壊すことがある。
  盤面が動いていなければ通常解 = 前回そのものなので、この判定で必ず通常解が選ばれる。
  これが無いと「盤面が1つも動いていないのに人が入れ替わる」が 3.5〜4.5% の盤面で起きる
  (最小盤面では再現できないので、回帰検出は `tests/bench-stability.mjs` の ① が担う)。
  結果は `plan.stability` に出る (applied / reason / creditedGapB / thresholdB)。
  画面は **配信中のプラン**を基準に渡す (手元の直前の算出ではない — 約束は配信したもの)。
  運営は 🔗前回を尊重 / 🆕ゼロから で切り替えられる (端末ごと・既定は尊重)
- **凸の予約 (L2・2026-09-07 / 2026-09-08 改訂)** — `39_plan_reservations.sql` / `40_attack_with_reservation_rpc.sql` /
  `42_reservations_level_optional.sql`。純ロジックは `js/domain/reservations.js`。

- **ユニオンメンバーの育成データ (BlaBlaLINK 由来)** — 前提SQL `43_member_growth.sql`
  (`players.blabla_openid` + `member_growth` + `member_growth_status`)。純ロジックは `js/domain/growth.js`。
  「A さんのこの編成すごいな」→ その人の育成と自分の同じキャラを並べる (2026-09-08 決定 A1/B3/C1/D1)。
  ★ **取れるのは BlaBlaLINK でゲームカードを公開している人だけ** — 非公開は API が `1301002` で拒否し、
  同じユニオンでも突破できない (2026-09-08 実機確認)。だから「取れなかった」を欠測にせず
  `member_growth_status` に **private / no_openid / error** で残す (催促の相手を間違えないため)。
  ★ **オーバーロードは option_id でしか来ない。意味は `state_effects` が無いと分からない**ので、
  取り込みの時点で解決して `overload` に日本語キーで保存する (あとから復元できない)。
  ★ `name_code` と PAD のキャラ名の対応は `data/blabla-name-codes.json`
  (`scripts/build-blabla-name-codes.mjs --apply` で BlaBlaLINK の CDN から再生成)。
  **CDN では name_code 1012 と 3015 の日本語名がどちらも「サクラ」**なので、名前で突き合わせると
  鈴原サクラがニケ本編のサクラに化ける — 生成側の `OVERRIDES` とテストの両方で固定してある。
  ★ 取得は **DevTools を閉じてブックマークレット**で行う。blablalink.com は `debugger` を
  作り続ける anti-debug を入れており、開発者ツールを開いたままだと `setTimeout` も `fetch` も返らない。
  ★ **取り込みパネルは運営タブの段階「終了」だけ** (`opsLayout.CARDS` の `stages: ['end']`) —
  使われたキャラが確定するのはレイド後。4段: ① 識別子のひも付け (`parseOpenid` が `?uid=` のリンクをそのまま受ける。
  関係ない数字は拾わない — 取り違えは他人の育成が別人に付く事故) → ② ブックマークレットを作る
  (`wantedCodesFor(usedCharacters(attacks), 対応表)`。対応表に無い名前は `missing` で名指し) →
  ③ 貼り付けて取り込む → ④ 取れなかった人。
  ★ **保存は upsert のみ・削除しない** (2026-09-09 の決定①)。部分的な結果で既存の記録を欠けさせない。
  ★ **取り込みの材料は開始時に写しを取る** — 1人ずつ await する間に `renderOpsGrowth` が走ると
  `_growth.players / used / seasonId` が次のシーズンに入れ替わる (Codex指摘)。
  ★ **識別子を外しただけで、取り込み済み (ok) の状態を `no_openid` で上書きしない**。
  ★ `parseImportPayload` は **非同期** (gzip 展開)。await を忘れると `box` が Promise になり取り込みが必ず失敗する —
  実行テスト `tests/growth-panel.mjs` (描画 + 取り込み本体) がここを固定している。
  ★ **名簿の一括読み取り** (`buildRosterSnippet`): ユニオンの情報を**自分から問い合わせる**
  (GetMyGuildInfo → guild_id → GetGuildDetail / GetUnionRaidData / …)。待ち受け (fetch/XHR) は保険。
  経路は自分のユニオンぶんだけ使い、他ユニオンの募集カード・掲示板 (CardList / Dynamics / Tourist) は捨てる。
  **ユニオン名を人の名前にしない** (ギルド情報は「ユニオン名 + 団長の識別子」を持つので、素直に組むと団長が化ける)。
  名前の無い識別子は出さない (名前でしか突き合わせられない)。空振りしたら**診断** (どのページ / 経路と応答コード /
  聞こえた通信) を出す。突き合わせは `parseRoster` → `matchRoster` (apply / same / unmatched / missing / conflicts /
  **clear = 付け替えの前に外す人**)。同名が2人・同じ識別子が2回・同じ人に2行は自動で当てない。
  ★ **ブックマークレットは `asBookmarklet` (encodeURIComponent) を通す**。生のまま URL に置くと
  「#」以降が捨てられ、日本語が化ける (実機で動かなくなった)。箱は右下の小さいパネルで、閉じるボタンと Esc がある。
- **🧬 育成くらべ** (分析タブの「育成」ビュー・2026-09-09 に作り直し)。レイドが終わったあとに
  スコアを詰める場所。判定は `growthDomain` が唯一 (画面で勝ち負けを書き足さない)。
  ★ **どのレイドを見ているかを画面が持つ** — 実機で2つ壊れていた:
  ① `member_growth_status` の**最大シーズン**を見ていたので、検証用のテスト回に取り込みの跡が
     1件あるだけで、本番の回で取れた14人が全員「未取得」に見えた。
     → `supabaseLoadGrowthSeasonSummary` で回ごとの取り込み人数を出し、既定は
     `defaultGrowthSeason` = **取り込めた人がいる本番の最新回**。画面上部で選び直せる。
  ② 編成を盤面の `loadoutsByAttr` から取っていた。盤面は**アクティブシーズン (＝テスト回) の模擬編成**
     なので、終わったレイドの振り返りに別の回の模擬が出ていた。
     → `usedTeams(attacks, playerId)` で**その回の凸記録**から作る (同じ5人はまとめ、代表は最大ダメージ)。
     `squadsFor` は同じ間違いを書けないよう削除した。
  ★ 構造は **相手 × 見方** の2軸 (ユーザー決定 2026-09-09):
  - **相手** = メンバー、または **「👥 ユニオン全体」**。全体を選ぶと同じ画面がそのまま順位表になる
  - **見方** = 「使った編成でくらべる」/「キャラ別にくらべる」
  - 相手がメンバーなら、編成の基準を「自分が使った / その人が使った」で切り替えられる
  - 相手がユニオン全体 × 使った編成 = **自分の編成の5体それぞれがユニオン内で何位か**
    (どの体から手を入れるかが決まる、いちばん使う画面)
  ★ `unionRanking` は**持っていない人を 0 として最下位に並べない** — 「持っていない」と
  「育っていない」は別。並べ替えは `SORT_FIELDS` の9項目すべてで効く。
  ★ 読み方 (2026-09-09 モック 6f9d0510 で決定): 結論を先に (何体で上か / 合計と差) →
  **差の大きい順** (`rankSquad`) → **差のある項目だけ**チップに (戦闘力は横棒で出すのでチップにしない) →
  全9項目とオーバーロードは畳んでおく。合計と「何体で上か」は**両方の戦闘力がある体だけ**で数える。
  引き分け (same) を負けと同じ見た目にしない。
  ★ **名前を onclick に埋めない** — 引用符で属性が壊れて全員タップできなくなり、注入もできる。
  渡すのは `_gv.chars` の**添字**とプレイヤー **id** だけ。
  ★ 一覧は**キャラアイコン + バーストのバッジ**で出す (名前だけだと編成が読めない)。検索と B1/B2/B3/BΛ で絞れる。
  ★ 読み出しは `supabaseLoadGrowthSeasonRows` が**ページ送りする** — 1シーズン 600行を超えるので、
  Supabase の既定上限 1000 で黙って切れると後ろのメンバーだけ「未取得」に見える。
  ★ レイド一覧 (`supabaseLoadGrowthSeasonSummary`) は**オフセットで送らない** (Codex指摘 2026-09-09) —
  読んでいる途中に status が1行でも増えると境界がずれ、既読を二重に数えて新しい行を読み落とす
  (取り込みは過去のレイドにも書ける)。`gt('season_id', after)` で**シーズンの区切りを鍵に**読み直し、
  いちばん後ろの回は途中で切れている前提でいったん置いて、次の周で読み直す。
  入口は分析タブのセグメントと、運営タブ「残り戦闘可能メンバー」の名前 (`openGrowthCompare` が
  その人を相手にして育成ビューへ送る)。比較シートのモーダルは廃止した (同じ画面を2つ育てない)。
  ★ **火力役** (2026-09-10 ユーザー要望)。ユニオンレイドの火力は**火力役の有利コードと攻撃の OP**で
  決まるので、バフ役まで混ぜた合計は実際の火力差と関係が薄い。`dpsOf` が編成から火力役を選び、
  `dpsScore` がその体だけの「有利コード＋攻撃」を出す。
  - 既定は **バースト3** (`DPS_BURST`)。第44回の実データが裏づけ: 全凸300枠のうち B3 が**144枠**
    (1編成あたり2.4体) / B2 93 / B1 59 / BΛ 4。使用トップも B3 は レッドフード・紅蓮・リバーレリオ、
    B1/B2 は クラウン・アニス:スター・モラン とバフ役できれいに分かれる
  - アイコンを押すと**手で足し引き**できる (上限なし)。`localStorage` に端末ごとに覚える
  - ★ **選んで終わりにしない** (実機FB 2026-09-10「選択したうえでの機能がまだ無い」)。効かせる先は3つ:
    ① 編成カードごとの帯 `_gvDpsBar` (⚡火力役 2体 有利＋攻撃 / 自分 / 相手 / 差)
    ② ユニオン全体では `unionDpsRanking` で**その編成の火力役の合計が何位か** —
       ここで効かないと、いちばん使う画面で選んだ意味が無くなる
    ③ キャラ別の「⚡ 火力役だけ」の絞り込み
  - ★ `unionDpsRanking` は**その体をすべて持っている人だけ**を並べる。1体でも欠けている人を混ぜると、
    違う顔ぶれの合計を並べて「順位」と呼ぶことになる
  - ★ **「何体で上」を出さない** (実機FB 2026-09-10)。勝ち負けの見せ方にしないし、体数を数えても
    実際の火力差にはならない。出すのは 自分の値 / 相手の値 / 差 の3つだけ
  ★ **アイコンの下のクイック** (2026-09-10)。開かずに 突破 / S1・S2・バースト / 攻撃 / 有利コード が
  読める。★ 出す値は**その編成の持ち主**のもの (自分の編成なら自分、相手の編成なら相手)、
  色は**自分と相手のどちらが上か**。混ぜると「誰の数字を見ているのか」が分からなくなる。
  さらに詳しく見たいときだけ「この5体を1体ずつくらべる」を開く。
  ★ 相手えらびの名前は**2行まで折り返す** — 幅を決め打ちすると「ユニオン全体」が「ユニオン…」に切れる。
  ★ **属性は属性アイコン** (`PT_ATTRS[].icon` = `./属性アイコン/*.png`)。名前は `title` と
  `aria-label` に残す。**バーストはアイコンの素材が無い**ので色で見分ける
  (`GV_BURST_COLOR = TE_BURST_COLOR`)。
  ★ **バーストの色の表は1組だけ** (ユーザー決定 2026-09-10「編成エディタの色でOK」)。
  `TE_BURST_COLOR` (B1緑/B2黄/B3赤/BΛ紫) が唯一の出どころで、`_BURST_COLOR` (キャラ管理) と
  `GV_BURST_COLOR` (育成くらべ) はそこを指すだけ。以前はキャラ管理だけ別の色 (B1紫/B2緑) で、
  同じ B1 が画面によって色違いになっていた。**2組に戻す変異はテストで落ちる**。
  ★ 色は**文字や枠には使わない** — B2 の黄色 #F2B705 は白地に対して 1.8:1 しかなく読めない。
  意味は文字 (B1〜BΛ) が担い、色は**縁のある点**が担う (縁は白地に対して 3.9:1)。
  背景に色を敷く小さなバッジだけは `_gvBurstInk` で黒と白のうちコントラストの高いほうを選ぶ。
  実行テスト `tests/growth-compare.mjs`
- **🧬 未公開の人への働きかけ** (B3・2026-09-09)。取れるのは BlaBlaLINK で**ゲームカードを公開**している人だけで、
  同じユニオンでも突破できない (`code 1301002`)。だから「取れなかった」は欠測ではなく**状態**として残し、
  本人に頼むしかない。両側から声をかける:
  - 運営タブ ④ に「📣 非公開の人に公開をお願いする」。相手は `growthDomain.privateTargets` が決める =
    ★ **private の人だけ**。未ひも付け (no_openid) は**運営の作業待ち**なので送らない (本人には何もできない)
  - 本人のホームに `#myGrowthNoticeCard`。★ 出すのは**自分が private のときだけ** —
    43未適用 (`supabaseLoadMyGrowthStatus` が null) や取得失敗は「未取り込み」と混同せず、黙って隠す
  - ★ 非同期の2つの守り: `_growthNoticeSeq` で**追い越した古い応答を捨てる** / 待機中に名乗り直したら
    (`getCurrentIdentity()` が別人) 何も書かない。どちらも実行テストで変異検出する
  文面は `growthDomain.PUBLISH_ASK` (画面に散らさない)。送る前に必ず `showPushPreview` を通す。
  - ★ **確認ダイアログの前に握った宛先をそのまま使わない** (Codex指摘 2026-09-09)。await の間に
    別の運営が取り込んで ok になる / その人を書庫に入れる、が起こる。
    ★★ **手元の写し (`_growth.statusRows`) を見直すだけでは足りない** — 別端末の変更はこの状態に
    来ないので、競合はそのまま残る (2回目の Codex 指摘)。確認のあと
    `supabaseLoadMemberGrowthStatus` と `supabaseLoadPlayersWithOpenid` を**引き直し**、
    **確認した顔ぶれとの積集合**だけに送る (広げない・減らすのは安全側)。引けなかったら送らない。
    書庫入りは特に危険で、プレイヤー一覧から消えても Push の購読は残る = PAD にいない人に届く。
  - ★ `_growth.sending` は**確認のあと・通信の前**に立て、`finally` で外す。
    プレビュー前に立てるとキャンセルで固まり、通信の後に立てると通信中に二重送信できる。
    引き直しの通信も **try の中**に置く (片方だけ失敗したときに送信中のまま固まる)。
  - ★ 確認の前に `_growth.gen` と `_growth.seasonId` を控え、送る直前に照合する。
    待っている間にレイドを変えられた / ↻ で開き直されたら、**古い画面で確認した顔ぶれ**になる。
  - ★ 積集合の id は**両側とも `String()` で比べる** (画面が文字列・DB が数値だと全員落ちる)。
  - ★ **残る穴 (承知のうえ)**: 送信要求が Edge Function に届くまでの数百ミリ秒は、まだ状況が変わり得る。
    完全に塞ぐには `supabase/functions/send-push/index.ts` で在籍と状態を再判定する必要があるが、
    31人のユニオンへのお願い1通にそこまでの作りは要らないと判断した (窓は「ダイアログを開いている間」
    = 分単位 → 「通信1往復」= ミリ秒単位まで縮んでいる)。
  - ★ 宛先はソースの文字列一致では守れない。`tests/growth-panel.mjs` が
    **await をまたいで実際に実行し `playerIds` を見る** (privateTargets の行を残したまま
    送信側だけ全員に広げる変異がすり抜けるため)。
  実行テスト `tests/growth-panel.mjs`
  **ソルバーを拘束するのは isFixed** (approved と承認済み起点の cancel_requested。requested は提案層で計算に効かせない)。
  `input.reservations` に `toSolverConstraints` の結果を渡すと、貪欲より先に盤面へ置かれる。
  ★ **予約はレベルを持たない** (2026-09-08)。メンバーの約束は「この時刻に・この弱点のボスへ・この編成で」で、
  ボスは全レベル共通 (HP だけ違う)。メンバー発は raid_level NULL、締め凸依頼の了承だけ運営がレベル付きで作る。
  レベル無しは `resolveReservationLevels` が「約束の時刻にそのボスがいるレベル」へ置く (レベル付きだけで1回解いて
  窓を得る → 割り当て → 予約込みで解き直してもう1回)。決まらないものは level=null のまま未達へ (黙らせない)。
  ★ **後のレベルに予約がある人の残り凸・予約した編成・そのキャラは手前のレベルで使わない** (`reservedLater`) —
  無いと残り1凸の人の Lv2 の予約が Lv1 の貪欲に使われて置けない (実際に起きた)。
  ★ `plan.unassigned` = 残り凸があるのに割当が無い人と理由 (本人のホームの空き枠に日本語で出す)。
  ★ **本人のホームは3枠** (`reservationsDomain.homeSlots`): 予約で固定 → 配信の割当 → 空き枠 (理由)。
  ヒーローと「わたしの凸」が同じ関数で組む。配信が予約を知らない間は「運営が組み直し中」の帯。
  ★ **承認 = 承認して組み直す → 差分 → 配信は明示の1タップ** (`_recomputeAndOfferPublish`)。自動配信はしない。
  押さなければ運営ホームのヒーロー「配信後の予約があります」(`pendingRepublish`) が促す。
  ★ 置けない理由・選ばれなかった理由は**日本語だけ** (`UNMET_JP` / `UNASSIGNED_JP` / `unmetText`)。コードを画面に出さない。
  ★ **予約は時刻まで守る** — レベルが開く前の時刻を約束していたら**置かない**
  (ソルバーが後ろへずらすと約束の意味が消える。運営が解除して組み直す)。
  ★ **温存 (Phase B) より予約が勝つ**。★ 圧縮 (trimOverkill) でも外さない。
  ★ 置けなかった予約は `plan.unmetReservations` に理由つきで出る —
  **運営が解除しないとその人の枠を押さえたまま**になるので必ず画面に出すこと。
  ★ 未達の突き合わせには**時刻も含める** (同じ人が同じボスでも別の時刻なら守れていない)。
  状態と遷移表は **SQL と JS の両方**にあり、`tests/run-tests.mjs` が機械的に突き合わせる —
  片方だけ変えると「画面では押せるのにサーバで弾かれる」。
  凸報告は `report_attack` RPC (採番・insert・残HP減算・予約の消し込みを1トランザクション)。
  **従来の3リクエスト方式へ落ちるのは RPC が存在しないときだけ** — 「3凸済み」等の
  意味のある拒否を握り潰して落ちると、拒否したはずの凸が入る。
  attacks ⇄ 予約のリンクは **`attacks.reservation_id` の片方向だけ**
  (相互FKは循環参照になり、バックアップ復元の順序が決まらない)
- **js/domain/availability.js** — 戦闘可能時間 ('hXX' の配列) の読み方 (2026-09-08)。5時始まりの並びで区間にまとめ
  (`rangesOf` / `labelOf` → 「5〜9時・21〜翌2時 (11時間)」)、区間の始まりか (`windowStartsAt`)、今から N 時間に出られるか
  (`canAttackWithin`)、当日の「戦闘可能時間になりました」の相手 (`reminderTargets`: 残凸あり・今期参加できる・隙間型でない・
  その時刻が区間の始まり)。ホームの帯 (`renderMyAvailStrip`)・開始の通知 (`_checkAvailReminders`)・締め凸検索の範囲
  (`finishDomain.filterByWindow`) が同じ読み方を共有する。★ **翌4時と5時は同じレイド日の両端** — 5時は常に区間の始まり。
  ★ 開始の通知は運営端末の定期チェック (30秒ごと・`_opsMode`) が送り手で、二重送信は `raid_event_notices` の
  kind `avail_start` / ref `${playerId}:hXX` の一意制約で防ぐ (撃破通知と同じ 確保 → 送信 → 完了記録 / 失敗なら確保を戻す)。
  運営端末が1台も開いていない時間は届かない (サーバ側 cron ではない)
- **js/domain/planDiff.js** — 配信プランの差分 (L4 通知抑制 / L5 運営ガード / L3 本人への提示)。
  前回の配信と次のプランを**人ごと**に突き合わせ、変化の種類 (gone/added/boss/time/team) を1つ返す。
  ★ **列として比べる** — 種類ごとに sort して集合で比べると「Lv1B1が21時 / Lv2B3が23時」→
  「Lv1B1が23時 / Lv2B3が21時」の入れ替えを見逃す (最初の実装がこれで、変異テストで発覚)。
  `rowsByPlayer` が (level, bossNumber, hourIdx, loadoutSlot) で決定的に並べるのが前提。
  時刻と編成も約束の一部なので変化に数える (2026-09-07 ユーザー決定)。⏳隙間型は flex に畳む
- **js/domain/** (fururi/ocr/finish/format/mockCompare) — ふるり値計算・OCR後処理・締め凸候補選別・
  ダメージ整形・ユニオン事前比較 (模擬タブ) の純ロジック。全て引数渡し・テストあり。
  該当領域の計算式を index.html に書き足さないこと。mockCompare のふるり値は
  fururiDomain.calcPerAttackFururi を属性キー=bossCode で再利用 (式の二重実装禁止)
- **js/state/opsStore.js** — 運営ダッシュボード盤面 {season,bosses,players} の単一ストア
  (リアーキ ステップ3)。**直接代入・部分書き換え禁止** — get/load/isStale/invalidate/
  patchBosses/patchPlayer を使う。TTL等の不変条件はファイル冒頭に記載
- **戦況タブの折りたたみ + コックピット** (2026-09-01) — カード定義 (id / 見出し / 運営限定 / 前日・当日の既定開閉 /
  グループ) は `js/domain/opsLayout.js` の CARDS が唯一。`_initOpsTabStructure` が先頭行を折りたたみヘッダ、残りを
  `.ops-card-body` にラップする (**畳んでも DOM は残す** — 各 renderer は畳まれていても更新し続ける)。手動開閉は
  localStorage `shirisuko_ops_card_open_v1` に前日/当日別で記憶。運営OFF は全開・開閉不可。旧 sticky ジャンプナビは廃止し、
  最上部に 2×2 コックピット (HP更新・残凸・未完・締め凸未返答 → タップで該当カードを開く)。畳まれたカードの見出しには
  `opsLayoutDomain.summarize` の1行サマリー。**カードを足したら CARDS に1行追加** (先頭行が見出しであること)
- **運営モードの段階 (準備 / 前日 / 当日 / 終了)** (運営UI再設計 2026-09-08・ユーザー決定 A〜D)。「情報量が多すぎる」→
  運営タブの主語をカードから段階へ。判定・チェックリスト・ヒーロー (いちばん急ぐ1つ)・催促の対象は `js/domain/opsStage.js` が唯一。
  ★ 段階は自動 (`detect`: シーズン無し=準備 / ハード日前=前日 / ハード日 5時〜翌4時=当日 / 翌日 5時以降でまだアクティブ=終了)。
  テスト用に運営が手動で上書きできる (`handleOpsStageOverride`・localStorage `shirisuko_ops_stage_override_v1`・端末とシーズンごと。
  自動と同じ段階を選んだら記憶しない)。**カードの前日/当日の既定と👥メンバー状況の前日/当日も段階に従う** (`_opsCardPhase` / `_mbCurrentPhase`)。
  ★ 運営タブの先頭は 🛠トグル → 段階ヘッダ (`_opsStageBarHtml`) → ヒーロー (`_opsStageHeroHtml`) → チェックリスト (`_opsStageListHtml`・前日と終了だけ)
  → コックピット (当日だけ)。すべて `_renderOpsStage` が `_renderOpsCockpit` と同じ材料 (盤面・_mb.rows・_resv.rows・配信) で描く。
  ★ 段階外のカードは消さず末尾の「その他」(`#opsEtc`) へ移す — **`opsLayout.CARDS` の `stages` が唯一の定義** (`[]` = 常にその他)。
  DOM は残るので各 renderer はそのまま更新し続ける。運営OFF (メンバー) は何もせずカードを元の並びに戻す (`_applyOpsStageCards(null)`)。
  ★ **設定タブの運営ブロック (版のしめ切り・通知状況・メンバー管理・アクティビティ・キャラマスタ・バックアップ) は
  「その他 › メンテナンス」へ移した** (`_initOpsEtc` が DOM ごと移し `opsMaint*` の id を付ける)。中身は「その他」を開いたときに描く
  (`_setOpsEtcOpen`)。`renderSettingsTab` はもう運営ブロックを描かない。
  ★ シーズン制御のボタンは `data-stage="prep"` (作成・テスト作成は小リンク) / `data-stage="end"` (終了・リセット) で段階の描画が出し分ける。
  催促 (`_opsNudgeGroup`) は `memberStatus.nudgeMessage` の1人ずつの文面で、通知購読者かつ「今回は難しい」でない人にだけ送る。
  実行テスト `tests/ops-stage.mjs`
- **最適凸プランの「条件を選んで → 算出」(パズル盤 ①②・2026-09-11)**。ユーザーの言葉「今の算出がどのような状態で
  算出されたものか分かりにくかった」。純ロジックは `js/domain/planBoard.js` (`conditionsOf` / `conditionSummary` /
  `windowOf` / `stiffness` / `mockUpdatesSince`) が唯一。モックは `docs/最適凸プラン_パズル盤モック.html`。
  - 条件は **3つだけ** (対象 `_opsPlanWho` / 起点 `_opsPlanStartMode` / 前回の配信 `_opsPlanSticky`) をセグメントで選び、
    `🧮 この条件で算出` が**唯一の算出ボタン**。以前は「全員」「⏰凸可能のみ」という2つの算出ボタンが条件を兼ね、
    状態トグルと同じ列に並んでいた。自動で効くもの (🔒予約・🚫除外・✋難しい・📤配信中) は読み取り専用のチップ
    (`_renderOpsPlanAutoChips`、コックピットと同じ材料で描く。未ロードは 0 でなく —)
  - ★ **結果に「この条件で組んだ」を焼き込む** (`plan.conditions`、`_opsLastPlan = plan` の前に付ける)。
    配信されたプランにも残るので、交代した運営が読める。結果の頭にスタンプ (`_planCondStampHtml`)、ホームの配信カードにも1行
  - ★ 承認後の組み直しなど、呼び出し側が `onlyAvailableNow` を明示したときは**そちら**を使い、画面の選択は変えない
    (`options = { ...options, onlyAvailableNow: onlyNow }` に畳んでから渡す — `computeOptimalPlan({ ...options, previousPlan, reservations: … })`
    の行はテストが文字列で固定している)
  - きっかけ: `renderOpsPlanCue` が「前回の算出 (無ければ配信) のあとに模擬が N 件更新」を出す
    (`supabaseCountMockUpdatesSince` は head:true で数えるだけ。世代ガードあり)。締め凸の手詰まり (候補なし) には「プランを組み直す ›」
  - ② 時間割 (運営だけ): チップをタップ (`data-member`、委譲) → その人の戦闘可能時間の行だけ残して他を沈める
    (`opts.focusWindow`) + 黒い帯に「出られる時間 / 動かせる幅」。チップには **硬い / 狭い** の札だけ出す (柔らかい人には出さない)。
    ホームの時間割には渡さない。算出し直したら選択は捨てる
  - ★ 旧トグル `toggleOpsPlanSticky()` / `toggleOpsPlanStartMode()` は互換のため残す (テストが名前を固定)。
    実体は `setOpsPlanSticky(on)` / `setOpsPlanStartMode(mode)` / `setOpsPlanWho(who)` → `_syncOpsPlanCondUi()`
  - **③④ 📌 運営の固定 / 🧩 模擬ピース / 📣 お願い → 🔒** (2026-09-11・前提SQL `45_reservation_pins.sql`)。
    📌 = `plan_reservations.status = 'pinned'` の**運営の下書き** (レベル無し・`pinned_by/at`・`asked_at/ask_deadline_at`)。
    ★ **拘束にはなるが約束ではない**: `isFixed` (ソルバー・指紋) には入り、`ACTIVE` (残凸の枠・部分一意索引・凸報告 RPC) には**入れない**。
    凸報告の消し込み `matchForAttack` と本人の3枠 `homeSlots` は `isPromise` (approved 系) を見る。
    `homeSlots` は **お願い済み (`isAskedPin`) の固定だけ**本人に見せる。状態遷移は `pinned → approved | released` (SQL 45 と JS で同じ表)。
    ★ 置ける場所は `planBoardDomain.canPlace` (有利属性 × 戦闘可能時間) と `reservationsDomain.canPin`
    (本人の申請・予約があるカードには置かない / 残凸 = 約束 + 固定 + 実凸 / キャラ被り) が唯一。**レベルは見ない** (算出が決める)。
    置く = `_opsPlanPlace(boss, hourIdx)` — 予約は押した時点の DB から取り直す → `supabaseCreateReservation({status:'pinned'})` か
    `supabaseMovePin` (置き直し) → `computeAndRenderOptimalPlan()`。**タップもドロップも同じ関数**。ドラッグは
    `(hover: hover) and (pointer: fine)` のときだけ。ドラッグ中は描き直さず `_opsPlanPaintTargets` で塗る (描き直すと掴んだ要素が消える)。
    🔒 (約束) は掴めない。🧩 模擬ピース = `planBoardDomain.piecesOf` (残凸が多い人 → 強い順、placed とどこにあるか)。
    📣 お願い = `supabaseAskPin` + Push → 本人のホーム「引き受けた凸」に出て `handleAcceptPin` (→ approved) / `handleDeclinePin`
    (→ released・member_declined)。本人の申請を承認したら同じカードの 📌 は `superseded` で外す (`_resvTransition`)。
    実行テスト `tests/plan-cond.mjs` (操作帯)
- **ホームの一目 (2026-09-11 ユーザー要望「空いているスペースにオンライン表示とボス状況を」)**。判定は `js/domain/attributes.js` の
  `homeStatusCounts` / `homeBossBoard` (細い帯の `homeBossStrip` の隣) が唯一。出し分けは**幅だけ** (CSS、700px が境):
  - **スマホ縦 (〜699px)**: ボス状況は戦闘カードの細い帯 (`#mypageBossStrip`) のまま。オンライン状況は
    **自分の状態ボタン (オンライン / 模擬中 / 戦闘中) の人数バッジ** (`.dc-status-cnt`、0 なら消える)
  - **横画面 (700px〜)**: プロフィール直下に3枚のタイル (`#mypageStatusTiles`、人数 + 名前)、右列の空きに
    **ボス状況カード** (`#myBossBoardCard`・`data-span="6"`・戦闘カードの直後に置くと2列の右列に入る)。
    残HP% / 残・総HP / 交戦者の名前 / 撃破。細い帯とバッジは隠す
  ★ カードのクラスは `mp-bbcard` — `mp-bossboard-card` にすると横スクロール走査 (`\bmp-bossboard\b`) が
  カード本体まで拾って data-no-swipe を要求する。
  ★ 帯を描く場所 (`renderMyBossStrip`) では必ず `renderMyBossBoard` も描く (呼ぶ数が揃うテストがある)。
  ★ **30 秒ごとのボスHP取り直しはホームだけの端末でも動く** — 以前は戦況タブを開いたことのある端末
  (opsStore あり) しか取り直さず、ホームのボス状況が止まっていた。撃破の検知・予約の点検・時間の通知は
  従来どおり運営側 (opsStore あり) だけ (`if (_opsSeasonLoaded) { ... }` で包む。中の if 文はテストが文字列で固定)。
  ★ **HP更新の鮮度は目立つピル** (`_hpFreshHtml` → `.hp-fresh` / 30分以上で `.warn`)。戦況のボス状況の見出しと
  ホームのカードの両方が同じ関数を使う。判定は `opsLayoutDomain.hpFreshnessMin`。
  実行テスト `tests/home-glance.mjs`
- **ナビの「戦況」⇄「運営」** (2026-09-11 ユーザー要望)。運営ONのときは下メニュー・左メニューとも
  「運営」+ レンチのアイコンになる。文字と title/aria-label は `_applyOpsMode` (ON/OFF と名乗り直しの両方が通る唯一の場所)、
  アイコンは CSS (`body.ops-mode [data-tab="ops"] .nav-ic-std/.nav-ic-ops`)。HTML の文字は「戦況」のまま
  (ナビの名前を数えるテストがある)。左メニューの文字は `<span class="tab-lb">` で包んである
- **📈 消化のペース / 🔁 直近の動き** (運営ボード 当日・2列表示の段階4・2026-09-11)。当日の運営は交代しながら
  見るので、入った人が 10 秒で「どこまで消化したか / 誰に何を頼んでいて誰の返事を待っているか」を読むための2枚。
  純ロジックは `js/domain/pace.js` (`paceModel` / `recentModel`) が唯一で、画面は材料集めと描画だけ。
  ★ 材料は**盤面そのもの** (`opsStore` の `players[].attacks` — このために `ATK_COLS` に `reported_at` を足した)。
  別クエリにせず残り戦闘可能メンバーと同じ鮮度で読む。打診の返事だけは 10 秒のポーリング
  (`_refreshFinishRequests` → `renderOpsRecent`) に乗せる (盤面の取り直しを待たない)。
  ★ 📈 の「使い切る見込み」は直近 2 時間のペースで割るが、**窓は最初の凸より前に遡らない**
  (開始 30 分で 2 時間で割ると実態の 1/4 に見える)。翌 5 時を越えるなら赤で「使い切れない」。
  定員 = 「今回は難しい」でない人 × 3 で、凸が定員を超えたら定員を合わせる (34/33 にしない)。
  ★ 🔁 の主役は**締め凸の打診の状態** (同時打診は offer_id + plan_key で 1 案、1 案ずつの依頼は
  **ボス + レベル + 依頼時刻**で 1 組 — 1 回の依頼は 1 文の insert なので `requested_at` がそろう。
  時刻を鍵に入れないと別の回の「不可」が新しい「確認中」に混ざる: Codex指摘 2026-09-11。
  同じ人の 2 行は同じ回の中だけで進んだ返事を採る)。手を打つべきもの (返事待ち・期限切れ) を上に。直近の凸は添え。
  ★ **運営の交代 (誰が当番か) は扱わない** (ユーザー決定 2026-09-11)。持ち込む変異はテストで落ちる。
  棒は div + トークン (canvas に色を焼き込まない = テーマ切り替えに追随する)。実行テスト `tests/ops-pace.mjs`
- **👥 メンバー状況ボード** (戦況タブ・運営ONのみ・運営改修 #1 2026-09-01) — 前日 (模擬/SLv/時間帯/通知) と
  当日 (凸Lv/代理/締め凸返答) を1人1行に。**「要対応」の定義は `js/domain/memberStatus.js` だけ**
  (模擬は「キャラ被りなしで3属性」が必要範囲 — 5属性は加点で強制しない・2026-09-01 ユーザー判断)
  (画面側で判定を書き足さない)。盤面は opsStore を再利用し、追加取得は `supabaseLoadMemberStatusExtras`
  の4クエリ (通知購読・今期SLv・締め凸依頼・代理凸ログ)。代理凸は attacks に印が無いので activity_log の
  proxy_attack を数える (v2 で attacks.is_proxy/reported_by を足す予定)
- **supabase/** — スキーマ・RLS・シードSQL。RLSは anon 全許可 (内輪運用の割り切り)。
  バックアップ復元 (設定タブ) は `23_restore_helpers.sql` の RPC が SQL Editor で適用済みであること。
  📌 運営の固定 (パズル盤 ③④) は `45_reservation_pins.sql` (未適用だと固定を置けないだけで、予約と算出は従来どおり)。
  ★ 45 未適用の判定は**読み出し**が覚える (`supabaseReservationPinColsMissing`)。insert まで行かせると PostgREST の
  「pinned_by 列が schema cache に無い」が `plan_reservations` の名を含み、39 未適用と誤読する (2026-09-11 実機で起きた) —
  `supabaseCreateReservation` は 📌 の列欠損を 39 より先に判定し、`_opsPlanPlace` は置く前に止め、ピース箱の頭にも出す。
  凸プラン配信 (📤) は `17_published_plans.sql`、戦闘可能時間の運用オプション
  (⏳隙間時間型 / 🔔いつでも通知) は `18_availability_prefs.sql`、
  設定タブの詳細アクティビティログは `19_activity_log.sql`、
  ボスHP鮮度表示 (HP更新 ○分前) は `20_bosses_updated_at.sql`、
  模擬の1属性2編成 (同属性2凸) は `21_player_damages_slots.sql` の適用が前提
  (主キーが (player_id, attribute, slot) に変わる — upsert は _upsertPlayerDamages 経由必須)。
  **⚠ 模擬の「測定ボスレベル」は 2026-09-06 に概念ごと廃止** (課題A)。列とデータは残っているが
  **1編成 = ダメージ1つ**として読む。`30_player_damages_level.sql` (`boss_level`) と
  `31_player_damages_levels.sql` (`levels` JSONB) は**廃止前の互換のために残っている列**で、
  新規保存は単一値。読み取りは `js/domain/mockLevels.js` の **`representativeDamage` (複数値なら中央値)** が唯一の実装で、
  画面側は `mockDamageOf(row)` 経由で全画面が同じ値を見る。**`damage_b` を直接読まないこと**
  (廃止前の互換ミラー = 最大値なので、複数測定が残る行だけ数字がずれる)。
  廃止の根拠: 「Lv1で測った値をLv3に流用すると過大評価」という想定を実データが否定した
  (同一編成のレベル違い6件すべて Lv1比 96〜105%)。
  **スロット数は 2** — 30 で 3 に増やしたが、31 でレベルがスロットの中に入り「1スロット = 1編成」に
  なったため `32_player_damages_slots_back_to_2.sql` で戻した
  (⚠ 32 は slot>=3 の行を削除する破壊的マイグレーション)。
  levels の不変条件 (damage_b=levels最大値 / boss_level=そのキーの互換ミラー) の維持は
  `_upsertPlayerDamages` に集約したままで、未適用環境は levels を落として静かに劣化する。
  締め凸依頼のステータス追跡 (pending/accepted/declined) は `22_finish_requests.sql` が前提。
  **依頼は「そのレベルのそのボスへの依頼」** (`36_finish_requests_level.sql` の `raid_level`)。
  撃破・レベル進行で `_clearFinishRequestsFor` が有効な依頼を消す — **履歴は残さない**
  (残すと次のレベルの依頼と見分けがつかない。第44回の実害)。代わりに activity_log へ
  「Lv・ボス・対象者・返答状態」を書く。★ 順序は **対象の確定 → 削除 → (実際に消せたときだけ) ログ → 通知**。
  削除より先にログを書くと、複数端末の同時検知で「2台が解除と記録したのに消したのは1台」になる。
  ログ・通知には**削除で返った行**を使う (確定した行を使うと、その間に本人が了承した場合に古い status で扱う)。
  `raid_level` が NULL の行は 36 適用前の旧データ = 現在レベルの依頼として扱わない。
  36 未適用環境ではレベルで絞れないので**何も消さない** (別レベルを巻き込むため)
  **互換ゲート**は `41_client_gate.sql` (`app_gate` 1行 + `published_plans.plan_schema`)。
  予約を知らない古いアプリが「凸プランの表示・凸の報告・プランの配信」をするのを止める。
  ★ **2段階リリースが前提** — 既定は `min_client_build = 0` = 誰も止めない。
  ゲートを配る回に締めると、締められた側に更新経路が無くなる。全員に行き渡ってから
  設定タブ (運営) で締める。★ **fail-open** — 読めない・壊れているときは通す
  (fail-closed にすると一時的な通信断で全員のアプリが止まる)。これは事故防止であって認可ではない。
  ★ 止めるのは**3機能だけ**。判定は `js/domain/clientGate.js` が唯一で、
  凸報告は `supabaseAddAttack`、配信は `supabasePublishPlan` の**入口1箇所**で止める
  (呼び出し側に散らすと必ず足し忘れる。凸報告の呼び出し口は4つある)。
  クライアントの版は index.html の `CLIENT_BUILD` (手で上げる YYYYMMDDnn の整数) —
  `app-build` はコミットSHAなので大小比較できない。
  **今期の戦闘可能時間の確認**は `37_availability_confirmations.sql`
  (season_id + player_id / confirmed_at / unavailable / slot_count / slots_snapshot)。
  ★ **時間帯そのものは持たない** — 現在の時間帯は `players.availability` が唯一の正で、37 が持つのは
  「いつ確認したか」「今回は難しいか」「確認時点の枠のスナップショット」だけ。二重に持つと必ず食い違う。
  ★ **未確認は空欄と同じ「未確定」**として催促対象にする (「前回のまま有効」とみなさない)。
  ★ **`unavailable=true` の人は盤面ローダーが `unavailableThisSeason` を立て、
  availableSlots=[] / flexTime=false にして全候補経路から外す** — 時間帯を空にするだけだと
  `timeUnknown` = 「いつでも可」に化けて逆効果になる。除外はソルバー・残凸表・締め凸候補・時間別候補の4箇所。
  この人には催促Pushも送らない (`memberStatus.nudgeMessage` が null を返す)。
  ★ **未適用環境は `supabaseLoadAvailabilityConfirmations` が null を返す** ([] にしないこと —
  「37適用済みで全員が未確認」と区別がつかず、実行できない確認の催促を送る)。
  `js/domain/memberStatus.js` は配列でない値を「機能未適用」として確認の理由も集計欄も出さない。
  ★ **確認まわりの保存は直列化する** (`_availSaveChain` / `_availEnqueue` / `_availDoSaveInner`) —
  `clearTimeout` は未開始のタイマーしか止めないので、自動保存が通信中に時間を変えて確認すると
  古い保存が遅れて着地して巻き戻る。確認は「保存 → 書き込み」を1単位でキューに積み、
  **スナップショットには `_availDoSaveInner` の戻り値** (実際にサーバへ載せた時間帯) を使う。
  ⚠ キューに積む関数の中から `_availDoSave`/`_availEnqueue` を呼ぶと自分待ちで返らなくなる。
  ★ **取得失敗を「未確認」に偽装しない** — `_loadMyAvailConfirm` は `{ loadFailed: true }` を立て、
  確認ボタンを出さない (偽装すると確認済みの人に「確認がまだです」と出て、押すと保存エラーになる)。
  キャラのバースト区分は `24_nikke_burst.sql` (burst) + `25_nikke_burst_alt.sql` (burst_alt =
  複数バーストで使えるキャラのサブ枠。例: ラピ:レッドフード は表示B3・B1枠でも可)。
  編成ピッカーのバースト絞り込みがこれを読む。25未適用でも読みは静かに劣化する
  (サブ無し扱い) が、サブの保存だけはエラーで案内する。
  戦況の通知 (ボス撃破・レベル開放) の二重送信よけは `29_raid_event_notices.sql`
  (未適用だと通知が出ないだけで本処理は壊れない)。
  **検知は盤面の差分を見る `_checkRaidEvents` に一本化**してある — 残HPを0にする経路は
  凸報告の自動減算/OCR適用/代理凸/ダメージ編集/運営の各種保存など複数あり、
  書き込み側にフックを足すと必ず漏れる。純ロジックは `js/domain/raidEvents.js`。
  配信プランの「確認しました」と再配信時の更新通知は `28_plan_acks.sql`
  (未適用だと確認ボタンがエラーになり、再配信しても通知が飛ばない — 配信自体は動く)。
  **`23_restore_helpers.sql` は 2026-08-31 に finish_requests / activity_log を追加したので再実行が必要**
  (2026-08-03 の published_plans 追加に続く2回目。CREATE OR REPLACE なので何度でも安全。
  未再実行だと復元後の配信・締め凸依頼・監査ログの INSERT が採番衝突で失敗し得る)。
  バックアップ対象 (`_BACKUP_TABLES`) と復元順 (`_RESTORE_TABLES`) は **supabase/ の全テーブルと一致**させる —
  `tests/run-tests.mjs` の「バックアップ整合」が突き合わせる (新テーブルを作ったら両方に追加)。
  テスト終了 (🧪 ✕ 終了) は `33_nikke_test_origin.sql` でテスト中の自動学習にタグを付け、
  確認モーダル (`supabasePreviewTestSeasonEnd` → `js/domain/testSeason.js` で分類) で運営が選んだ行だけ削除する。
  **未指定なら何も消さない** (旧「スナップショット差分を全削除」はテスト中の正規登録を巻き込んだため廃止)。
  **手動キャラ登録は「要確認」** (`34_nikke_verification.sql`: registered_by / verification_source / verified_by / verified_at)。
  事前登録フォームはバースト・根拠URL必須で is_confirmed=false のまま入り、**登録者とは別の運営**が
  編集モーダルの「確認済みにする」で確定する (本人は24時間経過後のみ — 判定は `js/domain/charMaster.js`)。
  is_confirmed=false でも編成・OCR解決には使える (除外する経路は無い)。2026-08-21 の素体ソリン/ブリッド
  誤バースト (B1↔B3・スキン版との混同) の再発防止。
  **配信プランの「組み直し中」と履歴の保持** (`38_published_plans_freeze.sql`: frozen_at / frozen_by — L3・2026-09-07)。
  ★ **配信は旧行を消さない** (以前は自分より古い行を delete していた)。
  「前回の配信と比べて誰の割当が変わったか」を後から引けるようにするため。
  読みは常に **season_id が同じ中で id 最大の1件** (`published_at` で並べない — 端末の時計ずれで最新が入れ替わる)。
  ★ **「配信中止」は削除ではなく凍結**。消すとメンバーは自分の割当を見られず plan_acks も失われる
  (第44回は 8.5時間その状態だった)。凍結中もプランは表示され「運営が組み直し中です」が出る。
  新しい配信を入れれば自動で解除される (新しい行の frozen_at は NULL)。
  完全削除は `supabaseDeleteAllPublishedPlans` に残してあるが**通常運用では使わない**。
  差分の判定は `js/domain/planDiff.js` が唯一 — 運営の事前提示・更新通知の絞り込み・
  本人への「前回から変わったか」の3つが同じ判定を使う (画面側で書き足さない)。
  **模擬提出の運営除外** (`35_player_damages_exclusion.sql`: excluded_at / excluded_by / excluded_reason — 2026-09-05 ハード日の緊急改修)。
  戦況タブ → 残り戦闘可能メンバー → 🧹整理 でセルの ✕ を押すと行 (player_id, attribute, slot) に印が付き、
  **盤面ローダ (`supabaseLoadOpsDashboardData`) と `_selectUsableDamages` が読み取り時に外す** — ソルバー・締め凸候補・残凸表・
  事前比較・👥メンバー状況・提出状況・SLv推定の全部から一括で外れる (除外行は `excludedByAttr` に別立て。画面側で判定を書き足さない)。
  行は消さない — 本人の模擬パネルに「⚠ 運営除外 (理由)」が出て、**本人が保存し直す (提出・単値保存・測定削除) と
  `_exclusionClear()` で自動解除**。凸報告の焼き戻し (characters のみ) では解除しない。純ロジックは `js/domain/mockExclusion.js`。
  未適用環境は読み取りが除外なしに静かに劣化し、除外操作だけエラーで 35 の適用を案内する。
  シーズン確認・編集 (戦況タブ→シーズン制御→✏️) の原子的保存は `26_season_meta_rpc.sql`、
  属性 (ボスコード) の修正対応は `27_season_boss_edit_rpc.sql` (26を5引数版で置き換え)。
  メタ・ボス名のみの保存は未適用でもガード付き逐次にフォールバックするが、
  **属性変更の保存は27必須** (未適用時は保存前にエラーで適用を案内 — 非原子的な入替は不整合が残るため)。
  通知の時間帯フィルタは Edge Function `send-push` (サーバ側) — 変更時は再デプロイが必要。
  **`99_check_applied.sql` を SQL Editor で実行すると未適用マイグレーションを一覧検出できる** (新環境・別PC時の必須チェック)
- **sw.js** — Web Push 用 Service Worker。キャッシュは実質不変の画像のみ
  (character-images/属性アイコン)。HTML/JS/データは即時反映のため非キャッシュ
- 認証なし。プレイヤーは自己申告で選択 (localStorage)
- **運営モード (`_opsMode` / `body.ops-mode` / `data-ops-only`)**: `🛠運営` スイッチで運営向けUIを
  出し入れする仕組み。戦況タブ (旧ユニレ管理) と設定タブで共有 (localStorage `shirisuko_ops_mode`)。
  CSS は `body:not(.ops-mode) [data-ops-only]{display:none}` のグローバル1行なので、
  **どのタブでも `data-ops-only` を付けるだけで運営送りにできる** (逆に OFF 時だけ出すのは
  `data-ops-off-only`)。設定タブは OFF の間そもそも運営データを取得しない (`renderSettingsTab`)。
  **これは認可ではなく誤操作防止の表示トグル。誰でも切り替えられるのが意図した仕様**
  (内輪運用の割り切り)。RLS が anon 全許可 + anon キー公開なので UI で隠しても保護にはならない。
  「クライアント側の権限チェックが甘い」という指摘は的外れ — 直すなら RLS 側であって UI ではない

## テスト

```sh
node tests/run-tests.mjs      # ソルバー+ドメイン+ストアの単体テスト
node tests/plan-hp-modal.mjs  # ⚔️戦闘予想モーダルの実行テスト (index.html から切り出して実行)
node tests/check-raid-event-hooks.mjs  # 戦況の通知フックの網羅チェック
node tests/team-picker.mjs    # 編成編集モーダルのタイルピッカーの実行テスト
node tests/member-board.mjs   # 👥 メンバー状況ボードの描画 (_mbPaint) の実行テスト
node tests/kill-badge.mjs     # 締め凸「締」バッジ・注記の実行テスト (実データ整合も見る)
node tests/solver-fingerprint.mjs        # ソルバーの出力指紋 (リファクタで挙動が変わっていないか)
node tests/solver-fingerprint.mjs <file> # 保存した指紋と突き合わせる (FP_SOLVER で別実装を指定可)
node tests/bench-stability.mjs           # L1 安定化の効果と代償 (BENCH_N で件数指定・既定150)
node tests/finish-requests.mjs # 締め凸依頼の後片付け (撃破・レベル進行での解除) の実行テスト
node tests/avail-save.mjs     # 戦闘可能時間の保存キュー + 今期の確認 の実行テスト
node tests/mock-panels.mjs    # 模擬タブの提出カード (renderMyDamagePanels) の実行テスト
node tests/home-slots.mjs     # 本人のホーム「あなたの3凸」(3枠) の描画の実行テスト
node tests/avail-strip.mjs    # ホーム「⏰ あなたの戦闘可能時間」の帯の描画の実行テスト
node tests/submit-bar.mjs     # 模擬提出シートの提出バー (_renderTeamEditBar) の実行テスト
node tests/ops-stage.mjs      # 運営タブの段階ヘッダ・ヒーロー・チェックリストの描画の実行テスト
node tests/growth-panel.mjs   # 育成データの取り込みパネルの描画 + 取り込み本体 (handleGrowthImport) の実行テスト
node tests/growth-compare.mjs # 🧬 育成をくらべるシート (_gcRender) の実行テスト
node tests/theme-switch.mjs   # 見た目 (ライト/ダーク) の切り替えの実行テスト
node tests/finish-console.mjs # 🏁 締め凸コンソール (今 vs 待つ) + 複数案の同時打診 の実行テスト
node tests/ops-pace.mjs       # 📈 消化のペース / 🔁 直近の動き (運営ボード 当日) の描画の実行テスト
node tests/home-glance.mjs    # ホームの一目: 横画面のボス状況カード / 状態ボタンの人数とタイル / HP鮮度ピル の実行テスト
node tests/plan-cond.mjs      # 最適凸プランの条件: 焼き込みのスタンプ / 自動で効くもの / きっかけ / 動かせる幅 の実行テスト
```
**変異テスト (ガードが本当に効くかを確かめる)** — 新しいテストを足したら必ず1周する。
わざと壊して、落ちなければそのテストは無意味。scratchpad にスクリプトを書いて回す。
- ★ `node mut.mjs | grep ...` と**パイプにすると終了コードが grep のもの**になり、
  `&& git commit` の門が効かない。`set -o pipefail` を付けるか、出力をファイルに落として `$?` を取ること
  (2026-09-11 に弱いテストのままコミットが通ってしまった)
- ★ 「どこかに `X = ''` がある」式のガードは弱い。同じ形が2箇所あると**片方だけ壊しても通る**。
  関数本体を切り出して**全ての代入を見る**こと

`plan-hp-modal.mjs` は index.html の関数本体を切り出してスタブ実行する。
**単体テストでは絶対に出ない実行経路のバグ** (2026-08-08 に const の TDZ で
「カードをタップすると ReferenceError」が入った) を拾うためのもの。
関数のシグネチャや依存を変えたらスタブも直すこと。
`team-picker.mjs` は編成タイルピッカーを切り出してスタブ実行する。
**値の保持先は従来どおり `#myTeamEditFields` の5つの input** で、ピッカーはそこへ書くだけ —
この契約が崩れると保存・OCR・人気編成の適用がまとめて壊れるので、テストで固定してある。
枠のバースト絞り込み・上位10体の折りたたみ・5人そろったら自動で畳む、の状態遷移も見る。

`mock-panels.mjs` は模擬タブの提出カードを切り出して実行する。
**2026-09-07 に本番で「5枚のカードが1枚も出ない」障害**を起こしたため追加した —
測定ボスレベルを廃止したとき (8a5265f) に `lvTitle` の定義だけ消え、テンプレート内の参照が残った。
カード生成の map の中で ReferenceError になるので**全滅**するが、単体テスト333件は1つも落ちなかった。
★ **テンプレートリテラルの中の未定義参照は実行しないと出ない**。
画面を組み立てる関数を大きく触ったら、実行テストがあるか確認すること。

`avail-save.mjs` は保存キュー (`_availEnqueue`/`_availDoSave`/`handleConfirmAvailability`) を
切り出し、**保存を止められるスタブ**で実際に走らせる。ソース文字列の検査では
「本当に前の保存の完了を待っているか」「rethrow が呼び出し元に届くか」を保証できないため
(Codex指摘 2026-09-07)。守っているのは 巻き戻さない / キューが詰まらない / 二重クリックで
確認が2回書かれない の3点。⚠ 切り出しは**引数のデフォルト値 (`opts = {}`) を本体と誤認しない**よう
引数リストの `)` を先に対応で探している。

`check-raid-event-hooks.mjs` は「ボスの残HPを動かす呼び出しの直後に `_checkRaidEvents()` があるか」を
機械的に確認する。**HPを動かす経路を足したら invalidate の前にフックを呼ぶこと** —
呼ばないとその操作で倒れたときに撃破通知を落とす (2026-08-09 にレビュー6往復で
ようやく全経路が埋まった。人力の grep では漏れる)。

UI の目視確認は実機 (GitHub Pages) で行う運用。
**構文チェックは `node tests/check-syntax.mjs` に一本化**した — 手で
「python3 で抜き出して `node --check`」をやっていた頃、2026-08-12 に
コマンドの連結ミスで構文エラーのまま commit した。手順ではなく仕組みで防ぐ。

## デザインシステム: ClaudeDesign

**注意: 旧 Material は色 (2026-07-24 全廃 d9031a6)・形状 (2026-07-25 一括変換) とも撤去済み**。
`var(--md-sys-color-*)` を書くと未定義参照になるので絶対に使わない。
新規UIは以下に従うこと (font-weight は 700 以上・細枠アウトラインボタンは使わない)。

### トーン

- 白カード + 大きめ角丸 + ソフトシャドウ。フォントは Noto Sans JP、見出しは font-weight 900
- 属性カラーを機能的に使う (枠線・ピル・バー・アイコン背景)

### カラー — ★ 2026-09-10 に**トークン制**へ移行。色を直に書かない

```css
/* 文字 (4段・どれも地に対して 4.5:1 以上)。★ 文字にはこれ以外を使わない */
var(--t-ink)     /* いちばん濃い (見出し・数字) */
var(--t-strong)  /* 強めの本文 */
var(--t-body)    /* 本文 */
var(--t-muted)   /* 添え字。これより薄い文字は無い */

/* 面・線。★ 文字には使わない (薄いままでよい) */
var(--card) var(--bg) var(--s1) var(--s2) var(--line) var(--track) var(--dim) var(--ghost)

/* 状態・属性。4つの顔を持つ:
   (無印)=文字 / -deep=濃い文字(7:1) / -solid=塗り / -ink=その塗りの上の文字 /
   -bg=薄く敷く / -on=薄い地の上の文字 */
var(--ops) var(--ok) var(--warn) var(--bad)
var(--attr-fire) var(--attr-water) var(--attr-electric) var(--attr-iron) var(--attr-wind)

/* 塗りの上の文字 */
var(--on-fill)      /* 色つきの塗り (紫・黒いオーバーレイ) の上。両テーマとも白 */
var(--card)         /* ★ var(--t-ink) を塗りに使ったときの上の文字 (ダークで反転する) */
var(--X-ink)        /* ★ 明るい塗り (緑 --ok-solid / 橙 --attr-iron-solid) の上は白だと 2.3:1 */

/* 地に薄く重ねるベール。★ ライトは黒・ダークは白に裏返る */
rgba(var(--ink-rgb), 0.08)    /* 線・輪郭・淡い面 */
rgba(var(--paper-rgb), 0.7)   /* その裏返し (濃い地の上に置く半透明の面) */
```

**★ 決めごと (ユーザー決定 2026-09-10 「B」)**: 「文字の色」と「線・面の色」を分ける。
文字は4段とも **4.5:1 以上**、線・面は薄いままでよい。混ぜない
(以前は同じ `#8A9097` を薄文字にも枠にも使っていて、文字だけ濃くすると枠まで濃くなった)。

**★ 2つのテーマは同じ顔ぶれ**。`:root, :root[data-theme="light"]` と `:root[data-theme="dark"]` に
同じ名前が並ぶ。片方にしか無いトークンはテストで落ちる。

**★ 直書きの上限がテストで固定されている** (`<style>` の hex 14 / rgba 212 / インライン 430)。
増やすと落ちる。**減らしたら上限も下げること** (下げ忘れると戻っても気づけない)。

### 見た目の切り替え (ライト / ダーク / 端末に合わせる)

設定タブの「見た目」。保存は `localStorage['shirisuko_theme_v1']` で、値は `'light' | 'dark'`
(auto は**キーを消す**)。実体は `<head>` の起動スクリプト:
- ★ **描画の前に `<html data-theme>` を立てる**。あとから立てると一瞬ライトが見える
- ★ **auto でも明示で立てる** (matchMedia で解決)。こうするとトークンは2ブロックのままでよく、
  `@media (prefers-color-scheme)` に同じ 100 行超を二重に書かずに済む
- auto のあいだだけ端末設定の変化に追随する
- ブラウザUI (`<meta name="theme-color">`) は色を書かず `--bg` を読む。
  `<head>` の時点ではスタイルシートがまだ無いので、DOMContentLoaded でもう一度合わせる

**★ キャンバスと Chart.js は CSS 変数を解決できない** — トークン名のまま渡しても
**黙って無視される** (エラーも出ない)。描くときに `themeVar()` / `chartColors()` で
実際の色にして渡し、切り替えの合図 `window 'padthemechange'` で描き直す。
**色を焼き込んで innerHTML に入れている画面も同じ** (散布図の点のキャッシュ `_scatterIconCache`、
育成くらべ `_gvPaint`)。焼き込む画面を増やしたら合図の受け口に足すこと。
★ 共有画像 (Discord 用の canvas・`const COL = {...}`) は**明るい見た目で固定**する —
配る紙なので端末のテーマに左右させない。

**★ バーストの色** (`_burstInk` / `_burstTint` / `_burstOnBg`) は地に合わせて計算する。
地は `--burst-bg` = **バッジが載り得るいちばん厳しい地**で、★ 厳しい側はテーマで入れ替わる
(ライトはいちばん暗い `--s1` / ダークはいちばん明るい `--card`)。
`_burstOnBg` は地の明暗を見て黒へ寄せるか白へ寄せるかを変える —
以前の `_burstOnLight` は暗くする方向にしか動かず、ダークでは寄せるほど沈んだ。

### 2列レイアウト (2026-09-10 戦況タブだけ → 2026-09-11 全タブへ)

★ **CSS だけで完結**させている。タブの切り替え・カードの折りたたみ・段階の出し分けは
モバイルと同じ JS がそのまま動く (DOM は1つ・PC用に作り分けない)。段は3つ:
- **700px〜**: タブ本文 (`.tab-page.tab-content > .container`) と「その他」の中を12カラムのグリッドに。
  700〜1099px は `data-span` のあるカードを**すべて半分 (6)**、`12` だけ全幅。
  条件つきで消えるカードが多いので、半分ずつなら**どれが消えても必ず2列に収まる**
- **1100px〜**: `data-span` の値どおりの細かい幅 (4〜8)。コックピットは 2×2 → 1×4
- **サイドバー**: `1180px〜` **または スマホ横 (768px〜 で縦559px以下)**。上の横タブを
  `--side-w` 幅の左サイドバーにし、`body { padding-left }` で本文を寄せる。
  PC は 232px、スマホ横だけ 176px (232px だと本文が620pxになり、2列の1枚が縦持ちより狭い)。
  ★ 置き換えるのは**上のタブ帯 (768px〜)** であって、下の浮きナビ (〜767px) ではない
  ★ **サイドバーのときは上の帯 (`.header`) も出さない** (2026-09-11 ユーザー要望)。見出しはロゴが担い、
  帯にあった 名前の切替 と 再読み込み はサイドバーの足元 `.side-foot` に置く。名前と絵は `updateIdentityHeader` が
  `[data-identity-name]` / `[data-identity-avatar]` にも書き、↻ の回転は `handleHeaderReload` が `.hdr-reload-ic` を全部回す
  (帯と足元で別の関数にしない — 片方だけ古くなる)。隠すのはサイドバーの幅だけ (他の幅で隠すと切替と再読み込みが消える)
  ★ 足元は `position: sticky; bottom: 0` — 縦が短いスマホ横ではロゴ + 5タブ + 足元が可視高を超え、末尾に押し出されて
  初期表示で見えない (Codex指摘)。スマホ横は足元を1行 (名前 + ↻ のアイコンだけ) にする。
  ★ `updateIdentityHeader` の写真は `_identityAvatarSeq` で追い越しを捨てる (A→B と素早く名乗り直すと「B の名前 + A の写真」)。
  未選択・名簿にいない人は写真を消す。名簿がまだ無いときは触らない。
  ★ 帯の月表示 (`#headerSubtitle`) は移さない — 分析タブの見出しが同じことを出している (判断)

**幅の決め方 (`data-span`)**
- 戦況タブ: `opsLayout.CARDS` の `span` **だけ**が唯一 (span → `data-span` → CSS)。
  index.html 側に幅を書き足さない (カードを足すたび2箇所直すことになる)
- 他の4タブ: HTML の `.dc-card` に直接書く。**本文直下のカードには必ず付ける**
  (付け忘れると黙って全幅 = そのカードだけ1列。テストが見張る)
- 表・グラフ・横に広い中身は **12 で固定** — 横に切れると読めない
  (残り戦闘可能メンバー / メンバー状況 / 最適凸プラン / メンバー管理 / 24時間の帯 など)

★★ **行の組み方は「カードの並び順」が決める**。グリッドは自動配置なので、
幅7の次に幅12が来ると改行し、**7が独りで残る**。2026-09-11 まで実際そうなっていて、
12カラムを実装済みなのに**全段階が実質1列**だった (span も CSS も正しかった)。
- 戦況タブの並びは `CARDS` の配列順が唯一。`_initOpsTabStructure` が起動時に並べ直す
  (運営OFF のまま開くと `_applyOpsStageCards` が走らないので、初期化でも揃えている)
- 準備/前日/当日/終了/メンバー(運営OFF) の**どれを取り出しても各行の合計が12**になるよう組んである。
  カードを足すときは**相方も決める**こと。崩すとテストが落ちる
- 例外: 「その他」(`#opsEtcCards` / `#opsEtcMaint`) は段階外の寄せ集めで幅の組が揃わないので
  **全幅の縦並び**。この指定は 1100px の幅指定より**後ろ**に置く (同じ特異性・後勝ち)
- 空の箱 (`#myFinishRequestArea` など JS が中身を描く div) は `:empty` で隠す —
  0高さでも1行ぶん占有して前後の組を割るため

### 下メニュー (2026-09-09 刷新)

**白い帯 + いま居るタブだけ黒い円で持ち上げる**。以前は黒い帯 + 丸アイコン5つ + センターだけ大丸だった
(モック 6f9d0510・ユーザー決定 A「黒い円で統一」)。
- タブに**名前を出す** (模擬 / 戦況 / ホーム / 分析 / 設定)。いま居るタブだけ太字、他は薄い
- いま居るタブの `.nav-icon-wrap` を `position:absolute; top:-26px` の黒い円にし、
  `border: 5px solid var(--nav-ring)` で**地の色で切って**帯から飛び出して見せる
- ★ **センターが特別、ではなくなった**。`nav-home` のクラスは互換のため残すが見た目の差は無い
- ★ ラベルは DOM 上ではアイコンより**前**に置き、CSS の `order` で下に出す —
  5つの閉じタグが同じで、後ろに差し込む目印に使えないため
- 自動隠し (`nav-hidden`)・キーボード中の非表示 (`body.kb-open`)・下端の余白 (112px) は据え置き

### Codex 監査の投げ方 (2026-09-11 更新: Bash から直接叩くのが確実)

★ **`codex exec` を Bash から直接呼ぶ**のが、いちばん確実で速い:
```sh
# 依頼文は必ずファイルに書く (長いのでインラインだと壊れる)
codex exec --sandbox read-only --skip-git-repo-check "$(cat prompt.txt)" < /dev/null > out.txt 2>&1
```
- ★ **`< /dev/null` を必ず付ける**。付けないと `Reading additional input from stdin...` で
  止まったまま返ってこない (2026-09-11 に1回空振りした)
- ★ 数分かかるので `run_in_background` で投げ、通知を待つ。出力は 300〜500KB になる。
  最後の回答だけ読むなら `awk '/^codex$/{buf="";on=1;next} on{buf=buf $0 "\n"} END{print buf}' out.txt`
- ★ 読み取り専用なので Codex は `node` を実行できない (= テストを走らせられない)。
  テストはこちらで走らせる前提で読ませること
- ★ 依頼文には「前提 (指摘しないでほしい設計判断)」と「重点的に見てほしい観点 A〜F」を書く。
  観点ごとに「問題なし」と返させると、**読み飛ばしていないかが分かる**

**`codex:codex-rescue` エージェントは使わない** — `task` に転送するだけの薄いラッパで
`status` / `result` を呼べず、依頼文が長いと勝手に背景実行を選んで job id しか返さない。
2026-09-10 に何度も空振りしたので、上の直接呼び出しに切り替えた。
- ★ 「修正しないで、指摘だけ」と書くと Codex は**読み取り専用**で起動し、`node` も実行できない
  (= テストを走らせられない)。テストはこちらで走らせる前提で読むこと

### 頻出パターン

- **ピル**: `border-radius:999px; font-size:10-11px; font-weight:800-900; padding:3px 9px; color:var(--X-on); background:var(--X-bg)`
- **カード**: `.dc-card` / `background:var(--card)` + `border-radius:13-15px` + `border:1px solid rgba(var(--ink-rgb), 0.05)`
- **ボトムシート**: `player-select-modal` 系。ハンドル(::before) + 下スワイプで閉じる (`_enableSheetSwipeDismiss`)
- **ボタン**: `var(--t-ink)` が主ボタン (上の文字は `var(--card)`)、`var(--s2)` がサブ。
  誘導ボタンは紫グラデ `linear-gradient(var(--grad-ops-a), var(--grad-ops-b))` + `var(--on-fill)`
- ★ **16進+alpha の連結 (`${c}1A` `${c}33`) はトークンにできない** — 連結する値だけは実際の色である必要がある
  (`var(--x)1A` は無効)。色表 (`TE_BURST_COLOR` / `DC_ATTR_COLORS` / `ATTR_VISUAL`) が
  直値のまま残っているのはこのため。`color-mix()` に寄せるまでは触らないこと

## データモデルの要注意ポイント

- **`bosses.attribute` = ボス自身の属性 / `bosses.weakness` = 弱点(持っていくPT属性)**。
  表示は attribute 基準に統一済み。「○○PTで凸」の文脈だけ weakness を使う。混同しやすいので注意
- **SLv (`player_sync_levels`)**: シーズン別履歴。読み込みは「最新シーズン(アクティブ優先→hard_date順)から引き継ぎ」、
  書き込みはホームタブ (旧マイページ) のSLvチップ → アクティブシーズンへ upsert。
  さらに月次JSON到着時に確定SLvを該当シーズンへ自動同期 (supabaseSyncSlvFromJson、差分のみ・冪等)
- ダメージは `_raw` (生値) と B単位 (10億=1B) が混在。表示はほぼ B 単位
- 比較・ふるり値タブの対象は「完了した実シーズン」のみ (is_test=false, is_active=false)
- **締め凸 (撃破した凸) は月次JSON の `attacks[].isKill`**。BlaBlaLINK が撃破した凸のダメージを
  **赤字**で出しているのを、Chrome拡張 (`~/Desktop/NIKKE/nikke-analytics-extension` v4.8.1〜) が
  文字色から判定して JSON に載せる (`metadata.hasKillFlags: true`)。
  ゲームは残HPを超えたダメージを記録しないので、**締め凸の数値は実力より小さい** —
  実績・ふるり値の行に「締」バッジと注記を出すのはこのため (数値自体は動かさない)。
  ★ **推定してはいけない**: 「合計==HPのとき最小の凸が締め」は実データで外れた
  (P.S.I.D. Lv2 の実際の締めは STREKOZA 34.24B・最小は銀狐リン 32.82B)。
  締め凸は最小の凸とは限らず、凸の時系列順が無いと特定できない。
  ★ `isKill` が無い過去シーズン (拡張 v2.4 以前) は **null = 不明**。false と混ぜると
  「締め凸ゼロのシーズン」に見える。判定は `_attackIsKill` / `_seasonHasKillFlags` に集約
- **BlaBlaLINK スクショの情報量**: ユニオン全体画面は「メンバー別の凸回数と合計ダメージ」のみで
  **どのボスへの凸かは写らない** → 全体画面からの凸自動登録は不可 (attacks はボス必須)。
  全体画面は「提出漏れの検出」まで、凸登録は個人の凸一覧画面 (ボスが写る) で行う役割分担

## 最適凸プラン (js/optimal-plan.js) の要点

- **決定的ソルバー (AI不使用)**。押した時点の盤面 (実残HP / 消化済み凸 / 現在時刻以降の時間帯)
  から毎回組み直す。算出前に60秒より古いダッシュボードキャッシュは自動再取得
- **目的関数は総与ダメ (credited) 最大化** (2026-07 再設計)。ゲーム仕様 (2025-05-30 改修後):
  ハード日は1日だけ、ランキング=累計与ダメ、有限ボスは min(dmg, 残HP) しか入らない、
  **Lv3踏破で即日「Lv4 = ボス5のみ・HP無限」が開き全額計上**。撃破は吸収容量を開ける手段
- **Lv4 検知は自動**: boss_number=5 が存在し踏破想定 (fullyClearedThrough>=3) なら levels[] 末尾に
  `{level:4, infinite:true}` を追加。**Infinity は使わない** (📤配信のJSONB保存で null 化し
  旧クライアントの .toFixed() が落ちる) — 数値は有限 + infinite フラグで表現
- **温存 (Phase B)**: probe (温存なし) → 機会費用つき再パスの決定的2パス。機会費用 =
  「ボス5で入るはずの与ダメの減少分」(potential 差分 — 弱点属性の編成消費もスロット逼迫も1式)。
  Lv3クリア想定時刻以降に出られない人は温存させない。温存で credited が増えないなら probe に倒す
- **吸収 (Phase C)**: 踏破できないレベル (frontierLevel) は撃破を狙わず、全ボス横断で
  オーバーキル最小の割当に切り替える (スナップショット→やり直し)
- **得意属性 (strong_attributes) はソルバーで使わない (2026-09-08 ユーザー決定)**。予約 (L2) があれば本人が
  得意属性のカードを予約すればよく、「必ず消化」の枠予約は要らない。申告はコミュニティの表示 (プロフィール・
  メンバー一覧) として残す。枠予約 (mandatory / lockedNow / lv4Mandatory / W_STRONG) は**仕組みごと撤去済み**
  — 復活させないこと (出せる属性への凸まで封じる事故を何度も起こした)
- **1属性2編成 (player_damages.slot=1|2)**: キャラが被らない別編成なら同属性2凸を提案 (ボス5にも2凸可)。
  凸済み回数ぶん上位 (高ダメージ) 編成から消費済みとみなす。候補は全ロードアウトをスコアリング
  (残HPの小さいボスには2編成目の方がオーバーキルが小さいことがある)
- **測定ボスレベルは廃止 (2026-09-06・課題A)**。**1編成 = ダメージ1つ**で、どのレベルにも使える。
  ソルバーのレベル絞り込み (`usableAtLevel` / `resolveAtLevel`)・「Lv不足」表示・📏厳格/無視トグルは
  すべて撤去済み。**この概念を復活させないこと** — 「Lv1で測った値をLv3に流用すると過大評価」という
  想定は実データが否定している (同一編成のレベル違い提出6件すべてが Lv1比 96〜105%・
  実凸90件のSLv補正集計でもレベル上昇による低下傾向なし)。値は
  `js/domain/mockLevels.js` の `representativeDamage` (複数値なら**中央値**。最大値は試行のブレの
  上振れを固定する) が唯一の実装で、画面側は `mockDamageOf(row)` 経由。**`damage_b` は廃止前の
  互換ミラー (=最大値) なので直接読まない**。`bestAtLevel` はバックアップ復元など廃止前データを
  そのまま読む箇所のためだけに `@deprecated` で残してある
- 時間: 凸可能時間内でレベル開放以降の最速枠に割当。⏳隙間型は時刻を約束しない flex 扱い
  (律速にしない)。ハイブリッド=登録時間内は確約・時間外は flex
- **ボス横断の限定分岐 (フェーズ2)**: 貪欲は「そのボスで最良」を選ぶので、別ボスでしか
  使えない人材を先に消費してしまう。僅差の決定点で2番手を採るシナリオを解き直し、
  基準解より credited・実現可能性・踏破Lv のいずれも下げない案だけ採用する
  (幅16・深さ3 = 基準解を含め最大49シナリオ。30人ユニオンでは `scenarioBudgetFor` は60を返すので
  実際の制約は幅・深さ側。40人超で40、60人超で20に落とすのが異常入力への保険)。**実時間で打ち切らない** — 配信は「押すたびに同じ
  指示が出る」ことが前提。`crossBoss: false` で無効化
- **L1 の効果測定と回帰検出は `node tests/bench-stability.mjs`**。cross-boss とは**目的が違う**ので別系統 —
  L1 はわざと `max(5%, 30B)` までの改善を捨てて約束を守るので、悪化0 の規約では評価できない。
  測るのは ① 同一盤面不変性 (前回と同じ盤面なら1人も動かない・必須) ② 振り回し (前回から割当が変わった人数を
  安定化あり/なしで比較) ③ 代償 (捨てた与ダメの分布) ④ 安全性 (約束を守った盤面で踏破Lv低下0・時間リスク増0・必須)
  ⑤ 採否の内訳。盤面の動かし方は当日に実際に起きること (HP減 / 実凸 / 時間帯 / 模擬再提出) を1つずつ
- **効果測定は `node tests/bench-crossboss.mjs`** (seed固定の乱数2000盤面)。
  ソルバーの選択ロジックを触ったら必ず流し、**悪化0・踏破Lv低下0** を確認する。
  盤面は本番前提 (レベル別HP定数・B1,2,4=lord/B3,5=tyrant・`loadoutsByAttr`) に合わせ、
  キャラ被りの強さは**本番 player_damages の実測分布**で較正してある
  (編成ペアの共通キャラ数 平均0.30 / **1人の中で3編成以上に登場するキャラは実測0件**なので、
  共有キャラはペア専用にすること — コピー方式だと3編成以上へファンアウトして現実に無い歪みが出る)。
  **`damagesByAttr` だけの盤面で測ると slot/ord・同属性2凸・キャラ被りが評価されず数字が良く出すぎ、
  逆に被りを盛りすぎると全員1日1凸の退化盤面になる** (2026-08-03 に両方やった)。
  ベンチ出力の「割当 N (x%)」が9割を切ったら盤面を疑うこと
- **ソルバーは同期実行でメインスレッドを止める** (30人・横断探索ありで Node 実測 p95 約350ms・
  大きい盤面で1秒前後、スマホは3〜4倍。**実行時間は端末・負荷で大きくばらつくので上限としては読めない**)。
  算出前に「🧮 最適な3凸を計算中…」を出し、2フレーム待ってから回している。
  探索の幅を増やすときはこの体感を必ず確認すること
- **変更したら必ず tests/run-tests.mjs にテストを足す** (ソルバー+ドメイン+ストア)。
  探索まわりのテストは「機能を外すと落ちるか」まで確認すること
  (通るだけのテストは回帰を検出しない)

## デプロイ

- リポジトリ: https://github.com/Furu1018/shirisu-pad
- 公開URL: https://furu1018.github.io/shirisu-pad/ (GitHub Pages, main へ push で反映)
- ローカルでは Supabase データが無いと大半のタブが空になる → 実機確認はユーザーに依頼する
