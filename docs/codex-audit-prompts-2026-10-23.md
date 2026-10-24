# Codex 監査の依頼文 (2026-10-23 の全体監査で使ったもの)

使い方は CLAUDE.md「Codex 監査の投げ方」。3 本とも 210〜260k トークン。1 本ずつ (`codex exec --sandbox read-only --skip-git-repo-check - < A.txt > A.out`)。結果と対応は AUDIT-2026-10-23.md。

---

## A. シンプル化 (不要なボタン・カード・文言・隠したものの裏の動き)

```text
あなたは しりすこPAD (NIKKE ユニオンレイド運営 PWA・単一 index.html 約 30,000 行 + js/domain/*.js 純ロジック + js/practice/ 練習モード) の監査役です。コードは読むだけで変更しないでください。日本語で答えてください。index.html は大きいので、下に書いた行の範囲と関数名で grep して必要な所だけ読んでください。

# 主題: 「シンプルな画面」が本当にシンプルか — 不要なボタン・カード・文言が残っていないか

2026-10-23 のユーザー決定 (前提。これ自体は指摘しないでください):
- member_input=full (✏️ シーズン編集のスイッチ = 従来の画面) でないときは、運営もメンバーも「シンプルな画面」(`_homeSimple()` = `!_memberInputFull()`・`body.home-simple`)。メンバーはさらに `body.member-lite`。判定と付け外しは index.html の `_applyMemberLite` (29390〜29425 行付近)。
- 画面から外したもの (消さずに CSS や判定で隠している — 方針なので指摘不要): ホームの「戦闘」カード (#myBattleCard: 戦闘に入る・ボスの帯・本日の凸履歴・凸報告)、#myBossBoardCard、状態ボタン (#mypageStatusSwitcher / #mypageStatusHint / #mypageStatusTiles)、運営タブ上の #opsOverviewChips、ヒーローの 🎯 あなたの3凸 (_heroPlanStripHtml)、配信カードのタブ (わたしの凸 / 全体 / 時間割)、「この凸を引き受ける」(_planRowResvHtml)、📣 お願い (運営の予約カード・焦点の帯・本人の返事)。CSS は index.html 1018〜1060 行。
- 自分の凸は 📅 きょうの凸 (renderMyTodayBlocks・時刻・Lv・PT・編成・5 キャラ)。配信カードは 🧱 盤 + ✅ 確認しました。予約は「🔒 予約」カードの「枠を予約する」(openMyResvRequest)。
- 運営タブは 👥 メンバー / 🧱 組む / ⚔️ 戦況 / 👑 マスター のサブタブ (js/domain/opsLayout.js の CARDS[].tab)。tab:null のカードは画面から外した (#opsTabHold に移す): 戦闘中の運営アクション (opsSecActions)・オンライン/調整中・残り戦闘可能メンバー・消化のペース・直近の動き・Discord 告知テンプレ。
- 模擬タブは member_input=full のときだけ (body.mock-tab-hidden)。メンバーの戦況タブは無い (body.member-lite [data-tab="ops"])。
- 締め凸は本番では「探すだけ」(_finishAskOn() は練習中だけ true・同時打診は出さない)。
- 残すもの (ユーザー決定): プロフィールと MY設定の「得意属性」、最適凸プラン算出の条件パネル (対象 / 起点 / 時間 / 前回の配信)。
- 呼び方の正本は docs/用語集.md (短いので読んでください)。

# 見てほしいこと (観点ごとに「問題なし」か、file:line つきで指摘)

A. メンバーのホーム — HTML は index.html 4134〜4406 行。描く関数: renderMyNextAction (8118〜8300 付近・ヒーロー)、_heroPlanStripHtml、renderMyTodayBlocks (9715〜)、renderMyPublishedPlan と _renderMyPubBody (9774〜10040)、renderMyReservations (10144〜10235)、renderMyMocksReadonly、renderMyNotificationsInbox、renderMyAvailStrip。
   シンプルな画面 (メンバー) で**見える**ボタン・カード・リンクのうち、押しても意味が無い / 行き先が隠れている / 古い流れ (本人の凸報告・模擬タブ・戦闘準備・📣 お願い・締め凸の返事) を前提にしているものは無いか。
   特にヒーロー (renderMyNextAction) の各分岐 — 当日 A1 (残凸あり) / A2 (3凸済み) / 前日 B1 (部隊不足) / 準備 C0・C1 / 運営の用事 opsNotice / 配信を待つ など — の文言とボタンの行き先 (mockCta・「👀 戦況を見る」・_heroGotoBattle・_heroGotoToday・softBtn・heroSub) が、シンプルな画面でも成り立つか。lite と _homeSimple の両方の分岐があるので、運営モード (lite でないが simple) の見え方も確かめてください。
B. 隠したものが**裏で動き続けて無駄**になっていないか: 戦闘カード・状態ボタン・ボス状況カードの描画 (renderMyBossStrip / renderMyBossBoard / renderMyAttackList / handleMyStatusSwitch まわり / _coordActiveCache やオンライン状況の取得 / 30 秒ティック) は、隠れていても通信や描画を続けているか。続けているなら「止めるべき (通信が増える・誤作動)」か「害が無い」かを判断してください。
C. 運営タブ — HTML は index.html 4487〜4834 行、カードの定義は js/domain/opsLayout.js、ヒーロー・チェックリストは js/domain/opsStage.js、タブの切替は index.html の _renderOpsSubTabs / _applyOpsTabCards / _opsJump / _opsBlockStepGo。
   👥 / 🧱 / ⚔️ / 👑 に見えるカードとボタンのうち、不要・重複・古いものは無いか。特に:
   - ⚔️ 戦況の「ボス状況」カード (opsSecBoss) に **HP を更新する入口があるか**。戦闘中の運営アクション (openOpsBossHpModal のボタン) は tab:null で隠した。_opsBlockStepGo('hp') と opsStage のヒーロー 'hp' (case 'hp': openOpsBossHpModal()) は届くか。
   - 代理凸 (openOpsProxyAttackModal) は 📥 結果の取り込みで置き換わった。ほかからの入口 (index.html 18841 / 24636 付近) は生きているか・要るか。
   - 提出漏れチェック (openOpsAuditModal) / 模擬提出チェック (openOpsMockAuditModal) / 凸履歴・編集 (openOpsAttacksEditModal) は入口が無くなった。無くて困る場面 (例: 誤って登録した凸を消す) があるなら「どこに入口を残すべきか」を提案してください。
   - opsStage.js のヒーロー・チェックリスト (prep / pre / day / end) に、外した機能 (締め凸依頼の返事・残り戦闘可能メンバー・状態ボタン・凸報告の催促) を前提にした文言や action が残っていないか。
   - 👥 メンバー状況 (memberStatus.js の列・催促文) に、本人が押せなくなったもの (模擬タブで提出・凸報告) を促す文言が残っていないか。
D. 設定タブ (index.html 5863〜6300 行): メンバーに見えるもの (data-ops-only / data-master-only 以外) で不要なものは無いか。
E. 古い文言・テンプレート: index.html 25006〜25075 行の _ANNOUNCE_MAIN / _ANNOUNCE_LOGIC (Discord 告知テンプレ・tab:null で隠れている) は古い流れのまま (模擬タブ・戦闘準備・凸報告・⏳隙間型・締め凸のお願い通知)。どうすべきか (直す / 消す)。ほかに、画面に出る文言 (コメント行は除く) で docs/用語集.md の「使わない言い方」(戦闘可能時間・出られる時間・申請・引き受けた凸・📌 固定・締凸検索・模擬戦データ・あなたの3凸・わたしの凸) が残っている箇所 — `grep -n` で見つかった範囲でよい。
F. 練習モード (js/practice/guide.js の STEPS / SEL / 文言): シンプルな画面で消えたボタンを指している selector や、古い流れの文言は無いか (通し確認 tests/practice-e2e.mjs は 5 本通っているが、文言のずれは通る)。

# 出力
観点 A〜F ごとに、重大度 (高 = 押せるのに動かない・誤解を生む / 中 = 不要だが害は無い / 低 = 文言) と file:line、何を外す・直すべきかの一文。最後に「外してよいもの」「入口を残すべきもの」の 2 つの表。
```

---

## B. バグ (10/23 の変更 + 段階 4〜6 の経路)

```text
あなたは しりすこPAD (NIKKE ユニオンレイド運営 PWA・単一 index.html 約 30,000 行 + js/domain/*.js + js/supabase-client.js + js/practice/) の監査役です。コードは読むだけで変更しないでください。日本語で答えてください。index.html は大きいので、関数名と行で grep して必要な所だけ読んでください。

# 主題: 2026-10-23 の変更で壊れたものが無いか + 🧱 段階 4〜6 の経路のバグ

変更の範囲: `git log f5bec93..9015741` = d0f3e28 / b709559 / f83927b / 9c1de20 (シンプルな画面) と 4bd7286 / 2296814 (呼び方の統一・画面の文言だけ)。差分は `git diff f5bec93..9015741 -- index.html js/` (大きいので関数単位で読む)。CLAUDE.md の「## 画面の呼び方 (用語集) とシンプルな画面」と「★ 🧱 段階 4 / 5 / 6」が設計の正本 (そこに書いてある判断は指摘不要)。

前提: テスト (node tests/*.mjs・run-tests 686 件ほか) はすべて通過、練習の通し確認 (Chrome) も 5 本通過。あなたは node を実行できないので読むだけ。

# 見てほしいこと (観点ごとに「問題なし」か指摘。再現の手順を具体的に)

A. シンプルな画面の判定と描き直し — index.html の _memberInputFull / _memberLite / _mockTabHidden / _homeSimple / _homeSimpleLast / _rerenderHomeForSimple / _applyMemberLite (29390〜29430 付近) と、それを呼ぶ _applyOpsMode・renderMyTodayBlocks。
   起動の順序: seasonStore が読める前は _homeSimple() が true (body.home-simple が付く) → シーズンが読めて full なら外れて _rerenderHomeForSimple が 4 つを描き直す。次の 4 つの場面で、ホームの各カードが正しい見え方になるか・描き直しが重なって通信を二重にしないか・無限ループが無いか:
   ① 名乗っていない状態で開く ② 名乗り直し (A → B) ③ 👑 マスターの「メンバーの見え方で見る」⇄「運営の画面に戻す」(toggleOpsMode → _applyOpsMode → _applyMemberLite) ④ ✏️ シーズン編集で member_input を切り替えた直後 (seasonStore.invalidate のあと、どのタイミングで反映されるか)。
B. 📅 きょうの凸の新しい行 — renderMyTodayBlocks (9715〜) の `if (_homeSimple())` 分岐と js/domain/raidBlocks.js の todayRows。planned[] の team / level / loadoutSlot / hourLabel / flex の出どころは配信プランの attacks (js/optimal-plan.js の attack オブジェクト: team は applyPick 697 行付近 `team: teamRegistered ? team : null`、level は lv.level)。5 キャラが実際に出るか、team が null / [] のとき壊れないか、renderTeamSnippet の引数の形 (文字列の配列か {name} か) と合っているか、esc の掛け忘れが無いか。
C. 配信カード — _renderMyPubBody (9980〜10040): view が 'today' のときの本文と ackBtn・各帯 (scopeLine / condLine / updatedBanner / frozenBanner / changeBanner / stale) の出し分け。view が 'board' で plan.blockScope があるとき _myPlanBoardHtml → _planBlockBoardHtml(plan, {ops:false, highlightPlayerId}) がメンバー端末 (opsStore 未ロード・_opsLastPlan 無し・_opsPlanSel 無し) で例外を出さないか。setMyPlanViewMode が simple で呼ばれる経路は残っていないか (localStorage の値が 'board' 以外のまま full に戻ったとき)。
D. 予約の経路 (シンプルな画面) — 「枠を予約する」→ openMyResvRequest → _resvReqRender (10403〜) → 予約の送信 (handleMyResvRequest 系) → 運営の承認 (handleReservationApprove / _resvTransition) → 本人への通知 (_notifyMemberResv) → ホームの「🔒 予約」カード (renderMyReservations)。
   📣 お願いを出さなくしたことで: DB に残る pinned (asked_at あり) の行は、本人の画面 (renderMyReservations の live/done の分け方・rv.isActive / isPin / isAskedPin) と homeSlots (本人に見せる条件 isAskedPin) でどう見えるか — 「返事してください」と出るのに返事する箱が無い、という矛盾は無いか (_planMineHtml 10688 行付近の `📣 運営からのお願い … 「🔒 予約」から返事してください` の文は simple のとき出るか)。
E. 運営の 🔒 確定 (_opsPlanConfirmPin 22609〜) と 仮置きを外す (_opsPlanUnpin) と 期限切れの仮置きをまとめて外す (_opsReleaseExpiredPins): 文言変更で、テスト・正規表現・RPC の期待状態 (expectFrom) に影響が無いか。確認ダイアログの「起きること / 起きないこと」が今の流れ (📣 を使わない) と矛盾しないか。
F. 呼び方の統一 (4bd7286 / 2296814) の置換が、画面の文字列以外に入り込んでいないか: status の値・localStorage の鍵・CSS セレクタ・DB の列・正規表現・activity_log の種別・練習の偽サーバの断り文 (js/practice/server.js) とクライアントの読み替え (js/supabase-client.js の /運営の固定が残凸を超え/ などの正規表現)。
G. 段階 4〜6 の経路 (CLAUDE.md ★ 段階 4 / 5 / 6 を読んでから):
   - handleOpsResultSave (index.html 18083〜18200 付近): 押した時点の写し `d` と live の使い分け、二重押し (busy)、supabaseAddAttack 成功 → supabaseSetAttackConfirmed 失敗 のとき画面と DB がどう食い違うか、_checkRaidEvents → opsStore.invalidate → _opsReloadBoardCards の順序、下書きを消す条件。
   - _notifyBlockPublish (23702〜) と handleOpsPublishPlan (23739〜23900): claim → send → markSent / release の失敗経路、`covered` と L4 (planDiff の通知) の重なり、同じブロックを配信し直したときの changedIds の計算 (prevScope / sameBlock)。
   - renderOpsAttackCheck の skips (skipsGen / skipsVer) の世代ガード、handleOpsAtkSkip の二重押し。
   - _renderOpsBlockSteps / _opsBlockStepGo (22889〜) の遷移先がサブタブの切替 (setOpsTab) を伴うか、_opsBoardCandPlace の添字 (_opsBoardCands) が再描画で古くならないか。
H. 更新履歴 data/release-notes.json の新しい 2 項目 (2026102303 / 2026102304) が js/domain/releaseNotes.js の規則 (id YYYYMMDDnn・date 一致・新しい順) に合っているか。

# 出力
重大度順 (致命的 / 高 / 中 / 低)。各項目: 現象 → 再現の手順 → 原因 (file:line) → 直し方の一文。観点 A〜H ごとに「問題なし」を明記。
```

---

## C. 最適凸プラン (ブロック制のもとでのソルバーのロジック)

```text
あなたは しりすこPAD (NIKKE ユニオンレイド運営 PWA) の最適凸プラン (ソルバー) の監査役です。コードは読むだけで変更しないでください。日本語で答えてください。

対象: js/optimal-plan.js (約 1,500 行・純関数 computeOptimalPlanCore) と、入力を渡す側 — index.html の computeOptimalPlan (22111〜22180 行) / _playersWithBlockCaps (22095) / _reservationImpact (18794〜18830) / _recomputeOptsAfterApproval / _opsPlanBlock (22043) / _planNowSlot (13968)、js/domain/reservations.js の toSolverConstraints / blockWindowOf / UNMET_JP、js/domain/raidBlocks.js の capsOf / scopePlan。
先に CLAUDE.md の「## 最適凸プラン (js/optimal-plan.js) の要点」と、「★ 🧱 ブロック制 ②」「★ 🧱 段階 2b」「★ 🧱 段階 3」「★ 🧱 段階 5」「ソルバーの安定化 (L1)」「凸の予約 (L2)」の段落を読んでください (設計判断の正本。そこに書いてある判断は指摘不要)。テストは tests/run-tests.mjs (ソルバーの節) と tests/solver-fingerprint.mjs (渡さないときの出力が 120 盤面で不変) — あなたは node を実行できないので読むだけ。

# 主題: ブロック制 (次のブロックのぶんだけを組んで配信する運用) のもとで、ソルバーのロジックに穴が無いか

運用: レイドの日 (5時〜翌4時) をブロック (既定: 朝 5-8 / 午前 9-11 / 昼 12-14 / 午後 15-17 / 夕方 18-20 / 夜 21-23 / 深夜 0-4) に分け、運営はブロックの頭に「🧱 ブロックの人」(そのブロックに参加可能時間のある人だけ = onlyAvailableNow + availableAtSlots) で算出し、そのブロックのぶんだけ配信する (メンバーには scopePlan で絞って見せる)。
画面が渡す入力: timeAware=true・timeStrict (既定 true)・excludeTimeUnknown=true・secondB5Lv4Only=true・players[].blockCaps (凸数の上限: ブロックごと max = 本人の希望 − そのブロックで済んだ凸)・reservations (approved / cancel_requested / pinned。ブロック予約は window {fromIdx,toIdx}・timeSlot null)・previousPlan = 直前の配信 (1 日ぶんのプラン)・currentSlot = _planNowSlot (レイド日より前は h05)・crossBoss 既定 true。

# 見てほしいこと (観点ごとに「問題なし」か指摘。できれば 3〜5 人の小さな盤面の例で)

A. **ブロックで絞ると「踏破できない」と判定しやすくならないか**: inScope で後ろのブロックの人が居ないので、Lv3 まで削り切る人手が足りない → frontierLevel / 吸収モード (absorbMode) に入り、このブロックの凸が「撃破を狙わずオーバーキル最小」に配られる。本来は後ろのブロックの人が続きを削るので、このブロックの中では撃破 (= 次のレベルを開ける) を狙うべきでは? runPass の L ループ・fullyClearedThrough・Phase B (温存・probe と機会費用) の判定が、部分的な人手を前提にしていないことによる逆効果が無いか。あるなら、ブロックの人だけの盤面でも「撃破を狙う」に倒す直し方。
B. **前回どおり (previousPlan の sticky) × ブロック**: previousPlan は 1 日ぶん。normalizeSticky / applyPick で、前回のプランの凸のうち hourIdx < nowIdx のもの (もう過ぎた時刻・まだ凸していない) や対象外 (inScope でない) の人の凸はどう扱われるか。sticky が過ぎた時刻の凸を「いま」に置き直してしまわないか。countStickyKept / preferNormalOver の比較が、ブロックの人だけの盤面でも意図どおり (同一盤面不変性) か。
C. **凸数の上限 (blockCaps)**: earliestHourFor の判定 (上限に達したブロックの時刻を飛ばす / 全部上限なら null) と、applyPick (+1) / undoPick (−1) / assignLv4 / restoreSnapshot (capsUsed) の数え方・予約は ignoreCaps で置くが数には入れる — 穴が無いか (例: 吸収モードのやり直しで capsUsed が戻らない経路、Lv4 の assignLv4 が上限を見ない、pullForwardForStranded の置き換えで数が崩れる、trimOverkill の undo)。capsOf の「済んだ凸」は reported_at の時刻 (運営が取り込んだ時刻) で数える — ブロックをまたいで取り込むとずれる (承知の上の設計) 以外の問題が無いか。
D. **secondB5Lv4Only**: lv4Only の候補を外す 2 か所 (listCandidatesFor 609 行 / sticky 970 行) 以外の経路 — pullForwardForStranded の置き換え候補・crossBoss 分岐 (noteDecision / 2 番手の pick)・placeReservation (予約は置く = 意図)・吸収モード — で lv4Only の編成②が Lv1〜3 に置かれないか。Lv4 (assignLv4) では使えるか。1 編成しか無い人は制限しないか (secondLv4Only の条件)。
E. **予約 (約束) の置き方**: resolveReservationLevels の pickInWindow (窓の中で本人が出られる時刻・そのボスがいるレベルが開いている最も早い時刻) — ① 窓が全部 nowIdx より前 ② 窓の中の時刻に本人の参加可能時間が無い ③ そのボスがもう倒れている ④ レベルの開放見込みが窓より後 の 4 つで、どの理由 (time_passed / before_open / no_boss_at_time / out_of_scope / member_gone / char_conflict …) に落ちるか・黙って落ちる (unmet にも outOfScope にも出ない) 経路が無いか。before_open の再解決 (relevel 最大 2 回) の停止条件。placeReservation が凸数の上限・キャラ被り・残凸 0 とぶつかったときの扱い。
F. **timeStrict + pullForwardForStranded × ブロック**: ブロックの人は全員「宣言した時間がブロックの終わりで終わる」ので、踏破時刻がブロックの終わりより後なら全員 stranded。置き換えの繰り返しが収束するか (無限ループ・計算量)、約束 (sticky / 予約) を動かさないか、結果が決定的か。
G. **Lv4 (ボス 5 無限) の検知と割当**: ブロックで絞った盤面では fullyClearedThrough>=3 になりにくい → Lv4 が開かない前提の計画になるが、実際には後ろのブロックで Lv3 を踏破して Lv4 が開く。ボス 5 の弱点の編成を Lv1〜3 で使い切ってしまい、Lv4 の凸が残らない方向のバイアスは無いか (段階 5 の手当て以外に)。Phase B (温存) はブロックの盤面でも効くか。
H. **出力の整合**: plan.unassigned (UNASSIGNED_JP) / membersTimeUnknown / unmetReservations / outOfScopeReservations / stability / conditions の焼き込みが、ブロックの人だけの盤面でメンバーに誤解を生む文言になっていないか (例: 「出番がありません」が 1 日ぶんの判定で出る → homeSlots 側で later_block に置き換えているが、ほかの理由はどうか)。plan.blockScope が付く条件。
I. **決定性と性能**: 同じ入力で同じ出力か (Map / Set の走査順・sort の安定性・Date.now の使用)。30 人・横断分岐あり・ブロック絞りで実行時間が増える要因 (pullForwardForStranded の試行回数・scenarioBudgetFor)。

# 出力
重大度順。各項目: 盤面の例 → 何が起きる → 原因 (file:line) → 直し方 (ソルバーの既定 — 新しい入力を渡さないときの出力 = 指紋 120 盤面 — を変えない直し方を優先)。観点 A〜I ごとに「問題なし」を明記。最後に「ブロック制の運用で運営が知っておくべき挙動 (バグではないが、メンバーや運営に説明すべきこと)」を 3〜5 行。
```

## 9d 置けない理由をその場で (2026-10-24・退避ブランチ 9d-wip-2026-10-24・別 PC で監査)

使い方: 下の文の末尾に `git diff f7391c1 HEAD` を貼って `codex exec --sandbox read-only --skip-git-repo-check - < prompt.txt > out.txt`。読むのは `awk '/^codex$/{buf="";on=1;next} on{buf=buf $0 "\n"} END{print buf}' out.txt`。

```
あなたは「しりすこPAD」(単一ファイル PWA index.html + js/domain/*.js) のコード監査役です。下の diff (f7391c1 → HEAD) を読み、push 可かを判定してください。日本語で答えてください。

## 背景 (運用の見直し 2026-10-24・9d)
- ユーザーの要望: 「ピースをはめるのは自動 + 手動。手動ではめる操作感は後で確かめたい。『なぜかここにはめれない』を無くしたい、ダメな時は理由が出るようになっていてほしい」。設計の約束: **判定は増やさない** (`planBoardDomain.canPlace` = 属性 / 参加可能時間、`reservationsDomain.canPin` = 予約の衝突 / 残凸 / キャラ被り のまま)。
- 既存: 🧱 組む の時間割 (🗓) と 🧱 盤 で、🧩 模擬ピース / 割当のチップを選ぶ (`_opsPlanSel`) → 置けるマス ([data-boss][data-h]) が光る → 押すと `_opsPlanPlace` → canPlace → canPin → 📌。沈んだマスを押しても `_opsPlanPlace` が「置けません: 理由」を出す (この経路は元から)。
  - 時間割の行 (時刻) は **凸のある時刻だけ** (`_planTimetableModel` の hourSet = 凸 + 済んだ凸)。🧱 盤の行の時刻のマス (`railHours`) はブロックのいまより後のすべての時刻。
- 今回 9d:
  1. `planBoardDomain.noPlaceReason({ player, attr, bosses, hourIdxs, hourOrder, remaining })` — 駒がいまの盤 (ボス × 時刻のマス) のどこにも置けない理由 (spent → attr → no_hours → time・置けるなら null)。canPlace を使い回す。
  2. `_opsPlanNoPlaceCheck(el)` — 描いた直後 (`renderOpsPlanView`) とドラッグの塗り直し (`_opsPlanPaintTargets`) から呼ぶ。マスに data-can を付け、1 つも置けなければ「置ける場所がありません: 理由」を 1 回 (同じ選択で `sel.noPlaceTold`)。時間割で time / no_hours なら「🧱 盤 に切り替えると、このブロックのどの時刻にも置けます」を添える。
  3. 🧩 模擬ピースの箱: 未配置の各ピースに「⚠ 置ける所なし: 理由」(箱が見る範囲 = 時間割なら凸のある時刻・盤ならブロックのいまより後の時刻・ボスはプランに居るボス)。
  4. 駒を選ばずにマスを押したら「先に 🧩 模擬ピースか割当のチップを押して、光ったマスを押します」(運営だけ)。
- 同じ commit に 9h の小さな直し: `_notifyBlockPublish` で中身の ref の claim → 送信済み化を自前の try/catch に (失敗しても本体の通知を失敗扱いにしない)。実行テスト追加。

## 観点 (A〜F で番号を振って答えてください)
A. 理由の正しさ: `noPlaceReason` の順 (spent → attr → no_hours → time) で、実際の原因と違う理由を出す状況は無いか (例: 属性のボスは居るが倒れている / ⏳隙間型 / remaining の数え方 = 3 − attackCount が canPin の数え方 (予約 + 📌 + 実凸 ≤ 3) と違う点)。「置ける場所がありません」と言ったのに実は置ける (または逆) が起きる形。
B. 呼ぶ場所と回数: `renderOpsPlanView` は描き直しのたびに走る (ポーリング・算出・選択)。`sel.noPlaceTold` の鍵 (kind|memberId|attr|slot|viewMode) で十分か。`_opsPlanSel` が描き直しで作り直されると鍵が消えて再度出るか。ドラッグ (`_opsPlanPaintTargets`) との二重。
C. 🧩 箱の理由: `viewHours` / `viewBosses` の取り方が、時間割 (`_planTimetableModel` の hourSet: 凸 + 済んだ凸) / 盤 (`railHours`) と食い違う所 (済んだ凸だけの時刻の行・`_planNowIdx`)。描くたびに ピース × 時刻 × ボス の canPlace を回す負荷。
D. 駒を選ばずに押したときの案内が、他の操作 (チップのタップ = 選ぶ・ボタン・メンバー画面) を邪魔しないか (`_opsMode` の条件・`closest('button, a, input, select, label')` の早期 return・`[data-member]` / `[data-piece]` は先に処理)。
E. 9h の小さな直し (try/catch) と実行テストの妥当性。
F. 文書 (CLAUDE.md ★ 9d / 運用の見直し / ROADMAP) と実装の食い違い。release-notes は運営だけの変更なので無し — 妥当か。

## 据え置き (承知のうえ・指摘不要)
- 時間割の行が凸のある時刻だけなのは既存の設計 (盤への案内で補う。行を増やす改修はしない)。
- 判定を増やさない (canPin の残凸・キャラ被りは置こうとした時に出る)。
- 配線テストの固定しすぎは慣習。

## 答え方
- 重大度 (高/中/低) を付けて、該当する diff の行を引用。直し方の提案を 1 行で。
- 最後に「push 可」か「push 不可 (直すべき点: …)」を一行で。

## diff (f7391c1 → HEAD)
```
