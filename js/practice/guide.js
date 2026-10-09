// ============================================================================
// 練習モードの案内 (帯・課題カード・押す場所の枠・「〜したことにする」)
// ============================================================================
// ★ このファイルは練習モードのときだけ読み込まれる (js/practice/boot.js が差し込む)。
// ★ 画面と判定は**本物のまま**。ここが足すのは「次にどこを押すか」の案内と、相手 (運営・時間) の動きだけ。
//   - 進み具合は**偽のサーバの中身**から決める (ボタンを押したかではなく、結果が入ったか)。
//     だから再読み込みしても途中から続けられ、案内どおりでない押し方をしても壊れない。
//   - 押す場所は本物のボタンを selector で指す。画面の作りを変えて selector が当たらなくなったら
//     tests/run-tests.mjs が落ちる (PRACTICE_SELECTORS)。
//   - 相手の動きは自動では起きない。必ず「〜したことにする」を自分で押し、「練習だけの仮定」と出す
//     (ユーザー要望 2026-10-02: 本番で「練習ではすぐ返事が来たのに」とならないように)。
// ============================================================================
(function () {
    'use strict';
    var P = window.PAD_PRACTICE;
    if (!P) return;

    // ---------- 小さな道具 ----------
    var eq = function (a, b) { return String(a) === String(b); };
    var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
    var vis = function (el) {
        if (!el || !el.isConnected) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    /** 候補の selector を順に見て、最初に「見えている」要素を返す */
    var q = function () {
        for (var i = 0; i < arguments.length; i++) {
            var list = document.querySelectorAll(arguments[i]);
            for (var j = 0; j < list.length; j++) if (vis(list[j]) && !list[j].disabled) return list[j];
        }
        return null;
    };
    var MODALS = '.player-select-modal.open, .player-modal.open, .fururi-help-modal.open';
    var topModal = function () {
        var list = Array.prototype.filter.call(document.querySelectorAll(MODALS), vis);
        return list.length ? list[list.length - 1] : null;
    };
    var activeTab = function () { var t = document.querySelector('.tab-content.active'); return t ? t.id.replace('tab-', '') : ''; };
    var ymdJst = function (ms) { return new P.clock.RealDate(ms + 9 * 3600000).toISOString().slice(0, 10); };
    var store = P.store;
    var readJson = function (k, d) { try { var v = JSON.parse(store.get(k) || 'null'); return v == null ? d : v; } catch (_) { return d; } };

    // ---------- 押す場所 (本物の画面の selector)。テストが index.html と突き合わせる ----------
    var SEL = {
        navHome: ['.bottom-nav-btn[data-tab="mypage"]', '.tab-button[data-tab="mypage"]'],
        navMock: ['.bottom-nav-btn[data-tab="mock"]', '.tab-button[data-tab="mock"]'],
        availOpen: ['[onclick="openMyAvailModal()"]'],
        availConfirm: ['#myAvailConfirmBox button[onclick="handleConfirmAvailability(false)"]'],
        mockCardFire: ['button[onclick="handleMyTeamEdit(\'fire\', 1)"]'],
        mockTile: ['#myTeamEditModal .te-tile:not(.used):not(.dup)'],   // 選んだ人 (.used) をもう一度押すと外れるので指さない
        mockDamage: ['#myTeamEditDamage'],
        mockSubmit: ['#myTeamEditSubmit'],
        resvOpen: ['[onclick="openMyResvRequest()"]'],
        resvTime21: ['#myResvRequestModal button[onclick*="\'h21\'"]'],
        resvTimeAny: ['#myResvRequestModal button[onclick^="_resvReqPick(\'time\'"]'],
        resvSubmit: ['#myResvRequestModal button[onclick="handleResvReqSubmit()"]'],
        attackOpen: ['button[onclick^="_planReportBoss("]', '#myAttackAddBtn'],   // 配信プランの「報告する ▶」(ボスが入った状態で開く) を優先
        attackManual: ['#myAttackManualToggle'],
        attackDamage: ['#myAttackDamageInput'],
        attackSave: ['#myAttackSaveBtn'],
        finishAccept: ['button[onclick^="handleMyFinishRequestRespond("][onclick*="\'accepted\'"]'],
        finishDecline: ['button[onclick^="handleMyFinishRequestRespond("][onclick*="\'declined\'"]'],
        modalClose: ['button[onclick^="close"]', '[onclick^="close"]'],   // 「閉じる」ボタン。凸報告は div の ✕
        planAck: ['button[onclick="handleAckPlan(this)"]'],
        // 運営編
        navOps: ['.bottom-nav-btn[data-tab="ops"]', '.tab-button[data-tab="ops"]'],
        nudgeMock: ['[onclick="_opsStageAct(\'nudge:mock\')"]'],
        pushSend: ['#pushPreviewSendBtn'],
        planStartDay: ['[onclick="setOpsPlanStartMode(\'day\')"]'],
        planCompute: ['[onclick="computeAndRenderOptimalPlan()"]'],
        planTimetable: ['[onclick="setOpsPlanViewMode(\'timetable\')"]'],
        planPiece: ['#opsOptimalPlan .plan-piece[data-piece]:not(.placed):not(.dim)'],
        planCell: ['#opsOptimalPlan [data-boss][data-h]'],   // どのマスを指すかは placeableCell() が本物の判定で決める
        resvApprove: ['button[onclick^="handleReservationApprove("]'],
        planPublish: ['#opsPlanPublishBtn'],
        swapAuto: ['#planSwapAutoBtn'],
        // 運営編・当日 (締め凸)
        bossHpOpen: ['[onclick="_opsStageAct(\'hp\')"]', '[onclick="openOpsBossHpModal()"]'],   // 先頭のヒーロー「🎯 ボス HP を更新する」が出ていればそれ
        bossHpInput: ['#opsBossHpModal [data-boss-num="1"] input.ops-hp-rem'],
        bossHpSave: ['#opsBossHpModal [data-boss-num="1"] button[onclick^="handleOpsBossHpSave("]'],
        finishPick: ['.dc-boss-card[data-boss-card="1"] .js-finish[data-action="finish-pick"]:not([disabled])'],
        finishWindow4: ['#opsFinishList button[onclick="handleOpsFinishOpt(\'hours\', 4)"]'],
        offerPickNow: ['#opsFinishList button[onclick="handleOpsFinishPick(\'now\')"]'],
        offerPickH4: ['#opsFinishList button[onclick="handleOpsFinishPick(\'h4\')"]'],
        offerPickAny: ['#opsFinishList button[onclick^="handleOpsFinishPick("]'],   // 「今すぐ」「4時間以内」が無い盤面なら、どれでも
        offerSend: ['#opsFinishList button[onclick="handleOpsFinishOfferSend()"]:not([disabled])'],
        offerConfirm: ['#opsFinishList button[onclick^="handleOpsFinishOfferConfirm("]'],
    };
    P.selectors = SEL;
    var pick = function (name) { return q.apply(null, SEL[name]); };

    // ---------- いまの状況 ----------
    function context() {
        var T = P.db ? P.db.tables : null;
        if (!T) return null;
        var season = T.seasons.filter(function (s) { return s.is_active; })[0] || null;
        var meId = P.role === 'ops' ? P.ops.id : P.me.id;
        var allResv = season ? T.plan_reservations.filter(function (r) { return eq(r.season_id, season.id); }) : [];
        var modal = topModal();
        var mine = function (table) { return T[table].filter(function (r) { return eq(r.player_id, meId) && (r.season_id == null || !season || eq(r.season_id, season.id)); }); };
        return {
            T: T, season: season, me: meId, tab: activeTab(), modal: modal, modalId: modal ? modal.id : '',
            day: ymdJst(P.clock.now()) >= P.hardDate ? 'hard' : 'eve',
            mine: mine,
            resv: mine('plan_reservations').filter(function (r) { return r.source_type !== 'finish_request'; }),
            finish: mine('finish_requests'),
            allResv: allResv,
            // 運営編・当日: 同時打診の行 (撃破で消えるので、消えたあとの判定は 撃破の通知・実行済みの約束 で見る)
            offer: season ? T.finish_requests.filter(function (r) { return eq(r.season_id, season.id) && r.offer_id; }) : [],
            notices: season ? T.raid_event_notices.filter(function (r) { return eq(r.season_id, season.id); }) : [],
            pushLog: T.push_notifications_log,
            pub: season ? T.published_plans.filter(function (r) { return eq(r.season_id, season.id); }).sort(function (a, b) { return Number(b.id) - Number(a.id); })[0] || null : null,
        };
    }
    var nav = function (name, label) { return { text: 'メニューの「' + label + '」を開きます。', target: pick(name) }; };
    /** その課題に関係のないシートが開いていたら、まず閉じてもらう */
    var stray = function (c, allowed) {
        if (!c.modal || allowed.indexOf(c.modalId) >= 0) return null;
        var btn = null;
        for (var k = 0; k < SEL.modalClose.length && !btn; k++) {
            var list = c.modal.querySelectorAll(SEL.modalClose[k]);
            for (var i = 0; i < list.length; i++) if (vis(list[i])) { btn = list[i]; break; }
        }
        return { text: '開いているシートを閉じます。', target: btn };
    };

    // ---------- 相手の動き (「〜したことにする」)。必ず自分で押す ----------
    var busy = false;
    function refreshScreen() {
        try {
            if (typeof opsStore !== 'undefined' && opsStore && opsStore.invalidate) opsStore.invalidate();
            if (typeof handleHeaderReload === 'function') return Promise.resolve(handleHeaderReload()).catch(function () { /* 描き直しの失敗で練習を止めない */ });
        } catch (_) { /* noop */ }
        return Promise.resolve();
    }
    /** 運営役がいまの盤面でプランを組んで配信する (本物のソルバーと配信の関数を使う) */
    async function opsPublish(startMode) {
        var c = context();
        var snapshot = await opsStore.load();
        var rows = await window.supabaseLoadReservations(c.season.id);
        var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
        var prevMode = typeof _opsPlanStartMode !== 'undefined' ? _opsPlanStartMode : 'now';
        if (typeof setOpsPlanStartMode === 'function') setOpsPlanStartMode(startMode || 'now');
        var plan;
        try {
            plan = computeOptimalPlan({ reservations: rows, previousPlan: (pub && eq(pub.season_id, c.season.id)) ? pub.plan : null }, snapshot);
        } finally { if (typeof setOpsPlanStartMode === 'function') setOpsPlanStartMode(prevMode); }
        if (!plan) throw new Error('プランを組めませんでした');
        plan.conditions = { who: 'all', from: startMode === 'day' ? 'day' : 'now', prev: pub ? 'keep' : 'fresh', computedAt: new Date().toISOString(), computedBy: P.ops.name,
            reservations: rows.filter(function (r) { return r.status === 'approved'; }).length, excluded: 0, unavailable: 0 };
        var schema = typeof PLAN_SCHEMA !== 'undefined' ? PLAN_SCHEMA : null;
        return window.supabasePublishPlan(plan, P.ops.id, P.ops.name, c.season.id, schema);
    }
    var ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    /** 運営役からの通知。本物と同じ関数で送る → 偽のサーバが「送ったことにして」控え、案内に見本が出て、受け取った通知にも残る */
    function pushAsOps(payload) {
        return window.sendPushNotification(payload, { senderPlayerId: P.ops.id }).catch(function (e) { console.warn('[練習] 通知の見本を出せませんでした:', e && e.message || e); });
    }
    /** 運営役の練習で「メンバーから申請が来た」: 21 時に出られて、その時刻のボスに合う編成を持つ人を 1 人選んで本物の関数で申請する */
    function pickRequester(c) {
        var T = c.T;
        var taken = {};
        c.allResv.forEach(function (r) { if (['requested', 'approved', 'cancel_requested', 'pinned'].indexOf(r.status) >= 0) taken[r.player_id] = true; });
        var players = T.players.filter(function (p) { return !eq(p.id, P.me.id) && !eq(p.id, P.ops.id) && !p.archived && !taken[p.id]; });
        for (var i = 0; i < players.length; i++) {
            var pl = players[i];
            if (!T.availability.some(function (a) { return eq(a.player_id, pl.id) && a.time_slot === 'h21'; })) continue;
            var dmg = T.player_damages.filter(function (d) { return eq(d.player_id, pl.id) && Number(d.damage_b) > 0 && Array.isArray(d.characters) && d.characters.length === 5; })
                .sort(function (a, b) { return Number(b.damage_b) - Number(a.damage_b); })[0];
            if (!dmg) continue;
            var boss = T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && b.weakness === dmg.attribute; })[0];
            if (!boss) continue;
            return { player: pl, dmg: dmg, boss: boss };
        }
        return null;
    }
    /** 時間割で「置ける場所が 1 つ以上ある」模擬ピース (本物の判定 planBoardDomain.canPlace で見る)。いま選んでいる人がそうならそれ */
    function placeablePiece() {
        var dom = window.planBoardDomain, snap = (typeof opsStore !== 'undefined' && opsStore) ? opsStore.get() : null, hours = typeof HOUR_ORDER !== 'undefined' ? HOUR_ORDER : null;
        var pieces = Array.prototype.filter.call(document.querySelectorAll('#opsOptimalPlan .plan-piece[data-piece]:not(.placed)'), vis);
        if (!dom || !snap || !hours || !pieces.length) return null;
        var cells = Array.prototype.slice.call(document.querySelectorAll('#opsOptimalPlan [data-boss][data-h]'));
        var okFor = function (pc) {
            var pl = (snap.players || []).filter(function (x) { return eq(x.id, pc.dataset.piece); })[0];
            if (!pl) return false;
            return cells.some(function (cell) {
                var boss = (snap.bosses || []).filter(function (b) { return eq(b.boss_number, cell.dataset.boss); })[0];
                var h = cell.dataset.h === '' ? null : Number(cell.dataset.h);
                return !!boss && h != null && dom.canPlace({ player: pl, attr: pc.dataset.attr, boss: boss, hourIdx: h, hourOrder: hours }).ok;
            });
        };
        var sel = typeof _opsPlanSel !== 'undefined' ? _opsPlanSel : null;
        var cur = sel && sel.kind === 'piece' ? pieces.filter(function (pc) { return eq(pc.dataset.piece, sel.memberId) && pc.dataset.attr === sel.attr; })[0] : null;
        if (cur && okFor(cur)) return { el: cur, selected: true };
        for (var i = 0; i < pieces.length; i++) if (okFor(pieces[i])) return { el: pieces[i], selected: false };
        return null;
    }
    /** 選んでいるピースを置けるマス (タップ操作では画面に印が出ないので、本物の判定で探して枠を出す) */
    function placeableCell() {
        var dom = window.planBoardDomain, snap = (typeof opsStore !== 'undefined' && opsStore) ? opsStore.get() : null, hours = typeof HOUR_ORDER !== 'undefined' ? HOUR_ORDER : null;
        var sel = typeof _opsPlanSel !== 'undefined' ? _opsPlanSel : null;
        if (!dom || !snap || !hours || !sel) return null;
        var pl = (snap.players || []).filter(function (x) { return eq(x.id, sel.memberId); })[0];
        if (!pl) return null;
        var cells = Array.prototype.filter.call(document.querySelectorAll('#opsOptimalPlan [data-boss][data-h]'), vis);
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            var boss = (snap.bosses || []).filter(function (b) { return eq(b.boss_number, cell.dataset.boss); })[0];
            var h = cell.dataset.h === '' ? null : Number(cell.dataset.h);
            if (boss && h != null && dom.canPlace({ player: pl, attr: sel.attr, boss: boss, hourIdx: h, hourOrder: hours }).ok) return cell;
        }
        return null;
    }
    var ASSUME = {
        // 運営が申請を承認して、組み直して配信した
        approve: async function () {
            var c = context();
            var row = c.resv.filter(function (r) { return r.status === 'requested'; })[0];
            if (!row) return;
            P.db.rpc('reservation_set_status', { p_id: row.id, p_to: 'approved', p_expect_from: 'requested', p_actor: P.ops.name });
            await opsPublish(c.day === 'hard' ? 'now' : 'day');
            // 本番で運営が承認したときに届く通知と同じ文面を、同じ送り方で (受け取った通知の一覧にも残る)
            await pushAsOps({ title: '🔒 予約が承認されました', body: '固定されました。プランは運営が組み直して配信します', url: './?tab=mypage', tag: 'resv-' + row.id, playerIds: [c.me], ignoreAvailability: true, requireInteraction: true });
            note('assume', '運営が承認して配信した、と仮定しました', '本番では運営が確認するまで時間がかかります');
        },
        // 当日の 21 時になった (その間にほかのメンバーが凸を進めている)
        hardDay: async function () {
            var c = context();
            var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
            advanceWorld(c, pub && pub.plan, 21);
            note('assume', '当日の 21 時になった、と仮定しました', 'その間にほかのメンバーが凸を進めています');
            saveFeed();
            P.clock.set('hard', 21);   // 時計を動かすのは、失敗し得ることが全部済んでから (失敗したら盤面も時計も押す前へ戻す)
            if (typeof P.save === 'function') P.save();   // ★ 読み込み直す前に、いま入れた凸を待たずに控える (控えは少し遅れて書かれる)
            location.reload();
            await new Promise(function () { /* 読み込み直しを待つ */ });
        },
        // (運営編) メンバーから予約の申請が来た — 本物の申請の関数と通知の文面で
        memberRequest: async function () {
            var c = context();
            if (c.allResv.some(function (r) { return r.status === 'requested'; })) return;
            var q = pickRequester(c);
            if (!q) { note('assume', '申請できる人が見つかりません', 'この練習ではここまでです'); return; }
            await window.supabaseCreateReservation({ seasonId: c.season.id, playerId: q.player.id, bossNumber: q.boss.boss_number, timeSlot: 'h21', loadoutSlot: Number(q.dmg.slot) || 1,
                characters: q.dmg.characters, expectedDamageB: Number(q.dmg.damage_b), requestedBy: q.player.name });
            await window.sendPushNotification({ title: '🔒 予約の申請', body: q.player.name + ': B' + q.boss.boss_number + ' 21時 編成' + (Number(q.dmg.slot) === 2 ? '②' : '①') + ' (承認待ち)',
                tag: 'ops-resv-request', playerIds: [P.ops.id], ignoreAvailability: true, requireInteraction: true }, { senderPlayerId: q.player.id });
            note('assume', q.player.name + 'さんから「B' + q.boss.boss_number + ' 21時」の申請が来た、と仮定しました', '本番ではいつ・何件来るか分かりません');
        },
        // 運営から締め凸のお願いが来た
        finishRequest: async function () {
            var c = context();
            if (c.finish.some(function (r) { return r.status === 'pending'; })) return;   // もう届いている (二重に出さない)
            var boss = finishTarget(c);
            if (!boss) { note('assume', '締め凸をお願いできるボスがありません', 'この練習ではここまでです'); return; }
            // 締め凸 = 残りが少ないボスにとどめを刺す凸。練習では、あなたの編成で倒し切れる残り HP になったことにする
            var mineDmg = Math.max.apply(null, c.T.player_damages.filter(function (d) { return eq(d.player_id, c.me) && d.attribute === boss.weakness; }).map(function (d) { return Number(d.damage_b) || 0; }));
            var left = Math.min(Number(boss.remaining_hp_raw), Math.round(mineDmg * 0.6 * 1e9));
            P.db.tx(function () { boss.remaining_hp_raw = left; boss.updated_at = new Date().toISOString(); });
            P.db.insert('finish_requests', { season_id: c.season.id, boss_number: boss.boss_number, player_id: c.me, status: 'pending', raid_level: c.season.current_level });
            await pushAsOps({ title: '📣 ' + (ATTR_JP[boss.weakness] || '') + 'PT 締め凸候補', body: (boss.name || boss.boss_code) + ' 残HP ' + (left / 1e9).toFixed(2) + 'B → 凸お願いできる方いますか🙏',
                url: './?tab=mypage&focus=finishreq', playerIds: [c.me], ignoreAvailability: true });
            note('assume', 'ボス' + boss.boss_number + ' の残りが ' + (left / 1e9).toFixed(1) + 'B になり、運営から締め凸のお願いが来た、と仮定しました', '本番ではいつ来るか分かりません (来ないこともあります)');
        },
        // (運営編・当日) 同時に打診した案のうち、案1 の全員が了承した。メンバー側の本物の手順 (枠を取ってから伝える) と運営あての本番の通知で
        finishAnswers: async function () {
            var c = context();
            if (!c.offer.length || c.offer.some(function (r) { return r.status === 'accepted'; })) return;
            var pr = window.finishDomain.offerProgress(c.offer);   // 案の並び (案1 = 先頭) は本物の判定と同じ
            var win = pr.plans[0];
            if (!win) return;
            var ctx = await ensureActiveSeasonLoaded();
            var bn = Number(c.offer[0].boss_number), level = Number(c.season.current_level) || null, names = [];
            for (var i = 0; i < win.members.length; i++) {
                var m = win.members[i];
                var pl = c.T.players.filter(function (x) { return eq(x.id, m.id); })[0];
                var who = { id: m.id, name: pl ? pl.name : String(m.id) };
                // 本番の handleMyFinishRequestRespond と同じ順: 枠 (approved・flex の約束) を取ってから、了承を伝える
                await _reserveForFinishRequest(ctx, who, bn, m.rowId);
                await window.supabaseRespondFinishRequest(c.season.id, bn, m.id, 'accepted', level, m.rowId);
                await _notifyOps({ title: '🗡 締め凸を了承', body: who.name + ': B' + bn, tag: 'ops-finish-answer', except: m.id });
                names.push(who.name);
            }
            if (typeof _refreshFinishRequests === 'function') await _refreshFinishRequests();
            note('assume', '案1 の ' + names.join('・') + ' が了承した、と仮定しました', 'ほかの案はまだ返事がありません。本番では返事はばらばらに届き、期限までに揃わないこともあります');
        },
        // (運営編・当日) 確定した人がゲームで締め凸をして報告した → 運営の端末が撃破を検知する (どちらも本物の関数)
        finishKill: async function () {
            var c = context();
            var rows = c.allResv.filter(function (r) { return r.source_type === 'finish_request' && r.status === 'approved'; })
                .sort(function (a, b) { return (Number(b.expected_damage_b) || 0) - (Number(a.expected_damage_b) || 0); });
            if (!rows.length) { note('assume', '締め凸の約束がありません', 'この練習ではここまでです'); return; }
            var bn = Number(rows[0].boss_number), names = [];
            var boss = c.T.bosses.filter(function (x) { return eq(x.season_id, c.season.id) && eq(x.boss_number, bn); })[0];
            if (!boss) return;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i], left = Number(boss.remaining_hp_raw);
                if (!(left > 0)) break;   // 先の人で倒れたら、あとの人は凸しない
                var pl = c.T.players.filter(function (x) { return eq(x.id, r.player_id); })[0];
                // ゲームは残HPを超えるダメージを記録しない (締め凸の数値は実力より小さい)。最後の人はとどめ
                var dmg = i === rows.length - 1 ? left : Math.min(Math.round((Number(r.expected_damage_b) || 30) * 1e9), left);
                await window.supabaseAddAttack({ seasonId: c.season.id, playerId: r.player_id, attackDate: c.season.hard_date, bossNumber: bn, bossCode: boss.boss_code,
                    damageRaw: dmg, level: c.season.current_level || 1, characters: r.characters_snapshot || [] }, { reservationId: r.id, actorName: pl ? pl.name : null });
                names.push(pl ? pl.name : String(r.player_id));
            }
            note('assume', names.join('・') + ' が締め凸を報告して B' + bn + ' を倒した、と仮定しました', '本番では本人のホームから報告します。運営の端末が 30 秒ごとの見直しで撃破を検知し、割当のある人へ通知します');
            // 運営の端末の定期チェックと同じ関数で検知 (撃破の通知・そのボスの依頼と約束の片付け)
            await _checkRaidEvents();
        },
    };
    /** 配信プランのうち hour 時より前のぶんを、ほかのメンバーが凸したことにする (ボスは倒し切らない)。keepRatio = ボス番号 → 残す割合 (既定 0.12) */
    function advanceWorld(c, plan, hour, keepRatio) {
        var lv = plan && plan.levels && plan.levels[0];
        if (!lv) return;
        var order = ['h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19', 'h20', 'h21', 'h22', 'h23', 'h00', 'h01', 'h02', 'h03', 'h04'];
        var limit = order.indexOf('h' + String(hour).padStart(2, '0'));
        // 自分が予約しているボスは、自分の凸で倒し切らない量を残す (練習の世界ではレベルを進めない)
        var mineB = {};
        c.resv.forEach(function (r) { if (r.status === 'approved') mineB[r.boss_number] = Math.max(mineB[r.boss_number] || 0, (Number(r.expected_damage_b) || 30) * 1.6e9); });
        (lv.bosses || []).forEach(function (b) {
            var boss = c.T.bosses.filter(function (x) { return eq(x.season_id, c.season.id) && eq(x.boss_number, b.bossNumber); })[0];
            if (!boss) return;
            var ratio = (keepRatio && keepRatio[b.bossNumber] != null) ? keepRatio[b.bossNumber] : 0.12;
            var keep = Math.max(Number(boss.total_hp_raw) * ratio, mineB[b.bossNumber] || 0);
            (b.attacks || []).forEach(function (a) {
                // 割当の形は js/optimal-plan.js の出力: { memberId, hourIdx (5時始まりの番号), dmgB, usedB, team, flex, … }
                var pid = a.memberId;
                if (pid == null || eq(pid, c.me) || a.flex) return;
                var idx = a.hourIdx;
                if (!(typeof idx === 'number' && idx >= 0 && idx < limit)) return;
                var dmg = Math.round((Number(a.dmgB) || 0) * 1e9);
                if (!(dmg > 0) || Number(boss.remaining_hp_raw) - dmg < keep) return;   // 倒し切らない (レベルは進めない)
                try {
                    P.db.rpc('report_attack', { p_season_id: c.season.id, p_player_id: pid, p_attack_date: c.season.hard_date, p_boss_number: b.bossNumber,
                        p_boss_code: boss.boss_code, p_damage_raw: dmg, p_level: lv.level || 1, p_characters: a.team || [], p_actor: 'practice' });
                } catch (_) { /* 3凸済みなどは飛ばす */ }
            });
        });
    }
    /** 締め凸をお願いするボス: 自分のまだ使っていない編成の属性が弱点で、残りが少ないもの */
    function finishTarget(c) {
        var usedAttrs = {};
        c.mine('attacks').forEach(function (a) {
            var b = c.T.bosses.filter(function (x) { return eq(x.season_id, c.season.id) && eq(x.boss_number, a.boss_number); })[0];
            if (b) usedAttrs[b.weakness] = true;
        });
        c.resv.forEach(function (r) {
            if (['requested', 'approved', 'cancel_requested'].indexOf(r.status) < 0) return;
            var b = c.T.bosses.filter(function (x) { return eq(x.season_id, c.season.id) && eq(x.boss_number, r.boss_number); })[0];
            if (b) usedAttrs[b.weakness] = true;
        });
        var have = {};
        c.T.player_damages.forEach(function (d) { if (eq(d.player_id, c.me) && Number(d.damage_b) > 0) have[d.attribute] = true; });
        return c.T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && have[b.weakness] && !usedAttrs[b.weakness] && Number(b.remaining_hp_raw) > 0; })
            .sort(function (x, y) { return Number(x.remaining_hp_raw) - Number(y.remaining_hp_raw); })[0] || null;
    }

    // ---------- 編 (シナリオ) と課題 ----------
    // ★ id は js/practice/boot.js の SCENARIOS と同じ一覧 (テストが突き合わせる)。役と開始時刻は boot.js が決める
    var STEPS = {
        member: [
            { key: 'avail', title: '戦闘できる時間を確認する',
                done: function (c) { return c.mine('availability_confirmations').length > 0; },
                guide: function (c) {
                    if (c.modalId === 'myAvailModal') return { text: '前回の時間がそのまま出ています。合っていれば下の「この時間で参加します」を押します (変えるときは時間をタップ)。', target: pick('availConfirm') };
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: 'ホームの「⏰ あなたの戦闘可能時間」で「変更する ›」を押します。', target: pick('availOpen') });
                } },
            { key: 'mock', title: '模擬戦のダメージを提出する',
                done: function (c) { return c.T.player_damages.some(function (d) { return eq(d.player_id, c.me) && d.attribute === 'fire' && Number(d.damage_b) > 0; }); },
                guide: function (c) {
                    if (c.modalId === 'myTeamEditModal') {
                        var filled = Array.prototype.filter.call(document.querySelectorAll('#myTeamEditFields input'), function (i) { return String(i.value || '').trim(); }).length;
                        var dmg = document.getElementById('myTeamEditDamage');
                        if (filled < 5) return { text: '③ の一覧からキャラを 5 人選びます (あと ' + (5 - filled) + ' 人)。練習なので誰でも構いません。', target: pick('mockTile') };
                        if (!dmg || !(Number(dmg.value) > 0)) return { text: '② に模擬で出たダメージを入れます (例: 33.1)。', target: pick('mockDamage') };
                        return { text: '下の「提出する」を押します。', target: pick('mockSubmit') };
                    }
                    return stray(c, []) || (c.tab !== 'mock' ? nav('navMock', '模擬')
                        : { text: 'まだ出していない「灼熱PT」のカードを押します。', target: pick('mockCardFire') });
                } },
            { key: 'resv', title: '「この時刻に・この編成で」を予約する',
                done: function (c) { return c.resv.some(function (r) { return ['approved', 'fulfilled'].indexOf(r.status) >= 0 || (r.status === 'cancel_requested' && r.approved_at); }); },
                guide: function (c) {
                    if (c.resv.some(function (r) { return r.status === 'requested'; })) {
                        return stray(c, []) || { text: '申請しました。ホームの枠は「申請中」になっています。',
                            real: 'ここで待ちます。運営が申請を見て承認するまで「申請中」のままで、すぐ返事が来るとは限りません。承認されると通知が届きます。',
                            assume: ['approve', '⏩ 運営が承認したことにする'] };
                    }
                    if (c.modalId === 'myResvRequestModal') {
                        var submit = pick('resvSubmit');
                        if (submit) return { text: '行き先のボスは編成の属性で決まります。「この内容で申請する」を押します。', target: submit };
                        return { text: 'どの編成で行くかを確かめて、何時に行くかを押します (21時)。', target: pick('resvTime21') || pick('resvTimeAny') };
                    }
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: '「あなたの3凸」の空き枠にある「＋ 自分から申請する」を押します。', target: pick('resvOpen') });
                } },
            { key: 'ack', title: '配信された凸プランを確かめる',
                done: function (c) { return c.pub && c.mine('plan_acks').some(function (a) { return eq(a.plan_id, c.pub.id); }); },
                guide: function (c) {
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: 'ホームの「配信された凸プラン」で自分の割当を読み、下の「✅ 確認しました」を押します。', real: '配信が更新されると通知が届き、確認はもう一度押します。運営は「誰が確認したか」を見て催促します。', target: pick('planAck') });
                } },
            { key: 'attack', title: '当日: 凸を報告する',
                done: function (c) { return c.mine('attacks').length > 0; },
                guide: function (c) {
                    if (c.day !== 'hard') return stray(c, []) || { text: '前日の準備はここまでです。時計をレイド当日に進めます。',
                        real: 'レイド当日は朝 5 時に始まります。予約した時刻になったら、ゲームで凸をしてからここで報告します。',
                        assume: ['hardDay', '⏩ 当日の 21 時に進める'] };
                    if (c.modalId === 'myAttackModal') {
                        var form = document.getElementById('myAttackManualForm'), inp = document.getElementById('myAttackDamageInput');
                        if (!form || !vis(form)) return { text: '本番ではゲームの結果画面のスクショを選ぶと自動で入ります。練習では「画像がないときは手動で入力」を開きます。', target: pick('attackManual') };
                        if (!inp || !(Number(inp.value) > 0)) return { text: 'ゲームで出たダメージを入れます (例: 34.2)。', target: pick('attackDamage') };
                        return { text: '「保存」を押すと報告できます。予約 (🔒) は「実行済み」になります。', target: pick('attackSave') };
                    }
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: '予約した 21 時になりました。ゲームで凸をしたら、🔒 の枠の「報告する ▶」を押します。', target: pick('attackOpen') });
                } },
            { key: 'finish', title: '締め凸のお願いに返事をする',
                done: function (c) { return c.finish.some(function (r) { return r.status !== 'pending'; }); },
                guide: function (c) {
                    if (!c.finish.length) return stray(c, []) || { text: '凸のあと、運営から締め凸 (ボスにとどめを刺す凸) を頼まれることがあります。',
                        real: 'いつ来るかは分かりません。来ないこともあります。来たときは通知が届きます。',
                        assume: ['finishRequest', '⏩ 運営からお願いが来たことにする'] };
                    if (c.tab !== 'mypage') return stray(c, []) || nav('navHome', 'ホーム');
                    // 残り凸が無い (約束・固定 + 実凸 が 3) と了承は断られる → 「今回は難しい」で返事をする
                    var rvd = window.reservationsDomain;
                    var held = c.resv.filter(function (r) { return rvd && (rvd.isPromise(r) || rvd.isPin(r)); }).length;
                    if (held + c.mine('attacks').length >= 3) {
                        return stray(c, []) || { text: '残り凸が無いので引き受けられません。「今回は難しい」で返事をします (運営にすぐ伝わります)。', target: pick('finishDecline') };
                    }
                    return stray(c, []) || { text: 'ホームに届いた「締め凸のお願い」に返事をします。出られないときは「今回は難しい」で構いません (運営にすぐ伝わります)。', target: pick('finishAccept') };
                } },
        ],
        'ops-eve': [
            { key: 'nudge', title: '模擬がまだの人に催促する',
                done: function (c) { return c.T.push_notifications_log.some(function (r) { return /登録のお願い/.test(r.title || ''); }); },
                guide: function (c) {
                    if (c.modalId === 'pushPreviewModal') return { text: '宛先と文面を確かめてから「送信する」を押します。', real: '送っても、相手がいつ提出するかは分かりません。前日の夜にもう一度見ます。', target: pick('pushSend') };
                    return stray(c, []) || (c.tab !== 'ops' ? nav('navOps', '運営')
                        : { text: '運営タブの先頭には、いちばん急ぐ 1 つが出ます。「📣 未提出の人に催促する」を押します。', target: pick('nudgeMock') });
                } },
            { key: 'compute', title: '条件を選んでプランを算出する',
                done: function () { return store.get('ops-eve:computed') === '1'; },
                guide: function (c) {
                    if (typeof _opsLastPlan !== 'undefined' && _opsLastPlan && _opsLastPlan.conditions) { try { store.set('ops-eve:computed', '1'); } catch (_) { /* noop */ } }
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (typeof _opsPlanStartMode !== 'undefined' && _opsPlanStartMode !== 'day') return stray(c, []) || { text: '条件を選びます。前日に組むので「起点」を「朝5時から」にします (時間は「⏰ 厳守」のまま = 出られる時間に合わない凸は組みません)。', target: pick('planStartDay') };
                    return stray(c, []) || { text: '「🧮 この条件で算出」を押します。本物のソルバーが 31 人の 3 凸を組みます (数秒かかります)。', target: pick('planCompute') };
                } },
            { key: 'pin', title: '📌 で 1 つ固定する',
                done: function (c) { return c.allResv.some(function (r) { return r.status === 'pinned'; }); },
                guide: function (c) {
                    // 3 凸ぶん割当のある人にピースを置くと「どれと入れ替えるか」の確認が出る → 練習では「算出に任せる」で固定だけ置く
                    if (c.modalId === 'planSwapModal') return { text: 'この人はもう 3 凸ぶんの割当があります。どれと入れ替えるかを選べますが、ここでは「外す凸は算出に任せる」を押します。', real: '「入れ替えて固定する」は、残す凸も 📌 で固定して算出で動かないようにします。', target: pick('swapAuto') };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (!(typeof _opsLastPlan !== 'undefined' && _opsLastPlan)) return stray(c, []) || { text: 'まず「🧮 この条件で算出」を押します。', target: pick('planCompute') };
                    if (typeof _opsPlanViewMode !== 'undefined' && _opsPlanViewMode !== 'timetable') return stray(c, []) || { text: '「🗓 時間割」に切り替えます。📌 の固定は時間割で置きます。', target: pick('planTimetable') };
                    // ★ ピースは「置ける場所がある人」を指す (夜しか出られない人のピースは、昼で終わる時間割には置けない)
                    var pp = placeablePiece();
                    if (!pp) return stray(c, []) || { text: 'いまの時間割に置ける模擬ピースがありません。「🧮 この条件で算出」をもう一度押してから試します。', target: pick('planCompute') };
                    if (!pp.selected) return stray(c, []) || { text: '下の「🧩 模擬ピース」(まだ盤に無い人の編成) から、枠の付いた 1 つを押します。', real: '📌 は運営の下書きで、本人への約束ではありません。約束にするには 📣 でお願いして引き受けてもらいます。', target: pp.el };
                    return stray(c, []) || { text: '枠の付いたマス (その人が出られる時間 × 合う属性のボス) を押します。📌 として固定され、算出し直されます。', target: placeableCell() };
                } },
            { key: 'request', title: 'メンバーからの申請を承認して組み直す',
                done: function (c) { return c.allResv.some(function (r) { return r.status === 'approved' && r.source_type !== 'finish_request'; }); },
                guide: function (c) {
                    var req = c.allResv.filter(function (r) { return r.status === 'requested'; })[0];
                    if (!req) return stray(c, []) || { text: '前日の夜、メンバーから「この時刻に・この編成で」の申請が届きます。', real: 'いつ・何件来るかは分かりません。届くと運営あての通知が鳴り、運営タブの先頭に出ます。', assume: ['memberRequest', '⏩ メンバーから申請が来たことにする'] };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    var btn = pick('resvApprove');
                    if (!btn) return stray(c, []) || { text: '申請が届いています。運営タブの「🔒 予約」のカードを開きます。', target: q('[onclick="_opsStageAct(\'reserve\')"]', '#opsSecReserve [onclick]') };
                    return stray(c, []) || { text: '「承認する」を押します。確認が出たら OK → 承認した予約を固定して組み直し、差分 (誰の割当が変わるか) が出ます。', real: '承認は本人への約束です。見送るなら理由を添えます。約束を後から動かさないのがこのアプリの目的です。', target: btn };
                } },
            { key: 'publish', title: 'プランを配信する',
                done: function (c) { return !!(c.pub && c.pub.plan && Number(c.pub.plan.reservationCount) >= 1); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (!(typeof _opsLastPlan !== 'undefined' && _opsLastPlan)) return stray(c, []) || { text: 'まず「🧮 この条件で算出」を押します (承認した予約が入ります)。', target: pick('planCompute') };
                    return stray(c, []) || { text: '「📤 このプランを配信」を押します。確認が出たら OK。押すまでメンバーには届きません。', real: '配信するとメンバー全員に通知が届き、ホームの「あなたの3凸」に割当が出ます。配信のあとに申請が来たら、承認 → 組み直し → もう一度配信です。', target: pick('planPublish') };
                } },
        ],
        // 当日 20 時・運営役。盤面は SETUP['ops-day'] が作る (朝 5 時からのプランを配信済み・20 時までの凸が入っている・B1 の残HPがゲームとずれている)
        'ops-day': [
            { key: 'hp', title: 'ゲームの画面を見てボスの残HPを直す',
                done: function (c) { var at = store.get('ops-day:setupAt') || ''; return c.T.bosses.some(function (b) { return eq(b.season_id, c.season.id) && eq(b.boss_number, 1) && String(b.updated_at || '') > at; }); },
                guide: function (c) {
                    if (c.modalId === 'opsBossHpModal') {
                        var inp = pick('bossHpInput');
                        if (!inp) return { text: 'ボスの一覧を読み込んでいます…' };
                        if (Math.abs(Number(inp.value) - 40) > 0.001) return { text: 'ゲームの画面では B1 の残りが 40B でした (練習の設定)。B1 の「残HP」を 40 にします。', target: inp };
                        return { text: 'B1 の「保存」を押します。', real: '残HPが 0 になる保存は撃破として検知されます (通知が飛びます)。数字を確かめてから押します。', target: pick('bossHpSave') };
                    }
                    var b1 = c.T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && eq(b.boss_number, 1); })[0];
                    return stray(c, []) || (c.tab !== 'ops' ? nav('navOps', '運営')
                        : { text: '当日の運営はまずボスの残HPをゲームと合わせます。ここでは B1 が ' + (b1 ? (Number(b1.remaining_hp_raw) / 1e9).toFixed(1) : '?') + 'B のままです。先頭の「🎯 ボス HP を更新する」(無ければ「ボスHP更新」) を押します。',
                            real: '報告がまだの凸や報告のずれで、ここの残HPはゲームと食い違います。30 分以上古いと運営タブの先頭に「HP 更新が古い」と出ます。古い HP で締め凸を出すと無駄凸や取りこぼしが出ます。', target: pick('bossHpOpen') });
                } },
            { key: 'console', title: '締凸検索で「いま打つか、待つか」を読む',
                done: function () { return store.get('ops-day:console') === '1'; },
                guide: function (c) {
                    if (consoleFor('water') && typeof _opsFinish !== 'undefined' && _opsFinish.hours === 4) { try { store.set('ops-day:console', '1'); } catch (_) { /* noop */ } }
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (!consoleFor('water')) return stray(c, []) || { text: '「ボス状況」の B1 のカードで「締凸検索」を押します。締め凸 = 残りが少ないボスにとどめを刺す凸です。', target: pick('finishPick') };
                    return stray(c, []) || { text: '「🏁 いま打つか、待つか」が出ました。いちばん上の 1 行が結論です。「4時間以内」の行を押すと、下の候補がその時間に出られる人で絞られます。',
                        real: '「待つほうがきれい」でも、待つ間に状況は変わります (別のボスの依頼で凸が埋まる・返事が来ない)。迷ったら早いほうを採ります。', target: pick('finishWindow4') };
                } },
            { key: 'offer', title: '2 つの案を同時に打診する',
                done: function (c) { return c.offer.length > 0 || c.pushLog.some(function (r) { return /締め凸 \(案/.test(r.title || ''); }); },
                guide: function (c) {
                    if (c.modalId === 'pushPreviewModal') return { text: '宛先と文面を確かめて「送信する」を押します。文面には「ほかの案と同時にお願いしています」と期限が入っています。', real: '同時に頼んでいることを伏せると、落ちた人が不信になります。期限は 15 分のままで構いません。', target: pick('pushSend') };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (!consoleFor('water')) return stray(c, []) || { text: 'B1 の「締凸検索」を押してコンソールを出します。', target: pick('finishPick') };
                    var picked = typeof _opsFinish !== 'undefined' ? _opsFinish.pick.size : 0;
                    if (picked < 2) {
                        var btn = unpicked('offerPickNow') || unpicked('offerPickH4') || unpicked('offerPickAny');
                        return stray(c, []) || { text: '1 案ずつ順に聞くと返事待ちが積み上がります。「今すぐ」の案と「4時間以内」の案の「同時打診に選ぶ」を押します (あと ' + (2 - picked) + ' 案)。',
                            real: '案は 2 つまで。先に全員がそろった案で確定し、もう片方には「今回は見送り」を伝えます。', target: btn };
                    }
                    return stray(c, []) || { text: '「📣 同時に打診」を押します。プレビューが出ます。', real: '両方の案の全員に通知が届きます。返事が無いまま期限が過ぎたら、返事の無い人を外して組み直すか、もう少し待つかを決めます。', target: pick('offerSend') };
                } },
            { key: 'confirm', title: '先にそろった案で確定する',
                done: function (c) {
                    var settled = c.offer.length > 0 && c.offer.every(function (r) { return r.status !== 'pending'; }) && c.offer.some(function (r) { return r.status === 'accepted'; });
                    return settled || c.allResv.some(function (r) { return r.source_type === 'finish_request' && r.status === 'fulfilled'; }) || c.notices.some(function (r) { return r.kind === 'boss_defeated'; });
                },
                guide: function (c) {
                    if (!c.offer.some(function (r) { return r.status === 'accepted'; })) return stray(c, []) || { text: '打診しました。返事を待ちます。了承した人のホームには「引き受けた凸」として固定 (🔒) が入ります。',
                        real: '返事はばらばらに届き、期限までにそろわないこともあります。返事が来ると運営あての通知が鳴り、「🔁 直近の動き」にも出ます。', assume: ['finishAnswers', '⏩ 案1 の全員が了承したことにする'] };
                    if (c.modalId === 'pushPreviewModal') return { text: '見送りの文面を確かめて「送信する」を押します。', real: '黙って流さないのが決めごとです (黙ると、次から返事が来なくなります)。', target: pick('pushSend') };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (!consoleFor('water')) return stray(c, []) || { text: 'B1 の「締凸検索」を押して、打診の進み具合を出します。', target: pick('finishPick') };
                    var btn = pick('offerConfirm');
                    if (!btn) return stray(c, []) || { text: '「📣 打診中」の箱に「全員そろいました」が出るのを待ちます (少し遅れて描き直されます)。' };
                    return stray(c, []) || { text: '案1 がそろいました。「この案で確定」を押します。確認が出たら OK。', real: '確定すると、もう片方の案の人に「今回は見送り」の通知が届きます。先にそろった案で進めるのが同時打診の約束です。', target: btn };
                } },
            { key: 'kill', title: '締め凸の報告と撃破の検知',
                done: function (c) { return c.notices.some(function (r) { return r.kind === 'boss_defeated' && r.sent; }); },
                guide: function (c) {
                    return stray(c, []) || { text: '確定した人がゲームで凸をして、自分のホームから報告します。運営はそれを待ちます。',
                        real: '運営の端末は 30 秒ごとに盤面を見直し、残HPが 0 になったら撃破を検知して、そのボスに割当のある人へ「撃破」の通知を送り、そのボスの依頼と約束を片付けます。運営の端末が 1 台も開いていない間は検知されません。',
                        assume: ['finishKill', '⏩ 了承した人が締め凸を報告したことにする'] };
                } },
        ],
    };
    var SCENARIOS = {
        'member': { title: 'メンバー編', sub: '前日の準備から当日の凸まで', next: 'ops-eve',
            diff: '練習では運営の返事や時間を「〜したことにする」で進めました。本番では運営が確認するまで待ちます (承認されると通知が届きます)。' },
        'ops-eve': { title: '運営編・前日', sub: '催促 → 算出 → 📌 → 承認 → 配信', next: 'ops-day',
            diff: '練習ではメンバーの申請を「来たことにする」で進めました。本番ではいつ・何件来るか分かりません。配信は押した瞬間に全員へ届きます。' },
        'ops-day': { title: '運営編・当日', sub: 'HP更新 → 締め凸の打診 → 確定 → 撃破', next: 'member',
            diff: '練習では返事と締め凸の報告を「したことにする」で進めました。本番では返事はばらばらに届き、期限までにそろわないこともあります。撃破の検知は運営の端末が 30 秒ごとに行うので、運営の端末が開いていない間は通知が出ません。' },
    };
    /** 締め凸コンソールが、その属性 (= そのボス) で出ているか */
    function consoleFor(attr) {
        var list = document.getElementById('opsFinishList');
        return !!(list && vis(list) && typeof _opsCurrentAttr !== 'undefined' && _opsCurrentAttr === attr && typeof _opsFinishCompare !== 'undefined' && _opsFinishCompare && list.querySelector('button[onclick^="handleOpsFinishPick("]'));
    }
    /** まだ選んでいない (☐ の) 「同時打診に選ぶ」ボタン */
    function unpicked(name) {
        for (var i = 0; i < SEL[name].length; i++) {
            var list = document.querySelectorAll(SEL[name][i]);
            for (var j = 0; j < list.length; j++) if (vis(list[j]) && /^☐/.test(String(list[j].textContent || '').trim())) return list[j];
        }
        return null;
    }
    P.steps = STEPS;
    P.scenarios = SCENARIOS;
    P.assumeKeys = Object.keys(ASSUME);

    // ---------- 相手の動き・通知の見本 (最新の 2 件を課題カードの下に出す) ----------
    var feed = readJson('feed', []);
    var feedId = feed.reduce(function (m, x) { return Math.max(m, x.id || 0); }, 0);
    function saveFeed() { try { store.set('feed', JSON.stringify(feed.slice(0, 4))); } catch (_) { /* noop */ } }
    function note(kind, title, body, to) { feed.unshift({ id: ++feedId, kind: kind, title: title, body: body || '', to: to || '' }); feed = feed.slice(0, 4); saveFeed(); }
    window.addEventListener('padpractice', function (ev) {
        var d = ev.detail || {};
        if (d.type === 'push' && d.item) {
            var T = P.db && P.db.tables, ids = d.item.playerIds;
            // 全員あては「在籍の全員を名指し」で渡る (宛先は js/domain/notifyPolicy.js が決める) → 人数で見分ける
            var everyone = T ? T.players.filter(function (x) { return !x.archived; }).length : 0;
            var names = (!ids || (everyone > 0 && ids.length >= everyone)) ? '全員あて' : ids.map(function (id) {
                if (eq(id, P.me.id)) return 'あなた';
                var p = T && T.players.filter(function (x) { return eq(x.id, id); })[0];
                return p ? p.name : '?';
            }).slice(0, 4).join('・') + (ids.length > 4 ? ' ほか' + (ids.length - 4) + '人' : '') + ' あて';
            note('push', d.item.title, d.item.body, names);
        }
        schedule();
    });

    // ---------- 途中の課題から始める (ツアーの「この操作をやってみる」から入ったとき) ----------
    // 手前の課題を**本物の関数で**済ませてから読み込み直す。相手の動き (承認・時間) も同じ仮定の関数で起こす
    var FF = {
        avail: async function (c) {
            var slots = c.T.availability.filter(function (a) { return eq(a.player_id, c.me); }).map(function (a) { return a.time_slot; });
            await window.supabaseConfirmAvailability(c.season.id, c.me, { slotCount: slots.length, slots: slots });
        },
        mock: async function (c) {
            // 灼熱PT の模擬 = ダメージ + 編成 5 人 (まだ使っていないキャラから)。本物の提出と同じ関数
            var used = {};
            c.T.player_damages.forEach(function (d) { if (eq(d.player_id, c.me)) (d.characters || []).forEach(function (n) { used[n] = true; }); });
            var pick = function (burst, n) { return c.T.nikke_characters.filter(function (x) { return x.burst === burst && !used[x.canonical_name]; }).slice(0, n).map(function (x) { return x.canonical_name; }); };
            var team = pick('B1', 1).concat(pick('B2', 1), pick('B3', 3));
            await window.supabaseSaveMockSubmission(c.me, 'fire', { damageB: 33.1, slot: 1, characters: team.length === 5 ? team : null });
        },
        resv: async function (c) {
            var dmg = c.T.player_damages.filter(function (d) { return eq(d.player_id, c.me) && Array.isArray(d.characters) && d.characters.length === 5; })
                .sort(function (a, b) { return Number(b.damage_b) - Number(a.damage_b); })[0];
            var boss = dmg && c.T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && b.weakness === dmg.attribute; })[0];
            if (!boss) return;
            await window.supabaseCreateReservation({ seasonId: c.season.id, playerId: c.me, bossNumber: boss.boss_number, timeSlot: 'h21', loadoutSlot: Number(dmg.slot) || 1,
                characters: dmg.characters, expectedDamageB: Number(dmg.damage_b), requestedBy: P.me.name });
            await ASSUME.approve();
        },
        ack: async function (c) { var pub = context().pub; if (pub) await window.supabaseAckPlan(c.me, c.season.id, pub.id); },
        attack: async function (c) {
            // 当日 21 時に進めて (ほかの人の凸も入れて)、自分の予約した凸を本物の関数で報告する
            var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
            advanceWorld(context(), pub && pub.plan, 21);
            P.clock.set('hard', 21);
            var c2 = context();
            var res = c2.resv.filter(function (r) { return r.status === 'approved'; })[0];
            if (!res) throw new Error('予約が無いので凸を報告できません');
            var boss = c2.T.bosses.filter(function (b) { return eq(b.season_id, c2.season.id) && eq(b.boss_number, res.boss_number); })[0];
            await window.supabaseAddAttack({ seasonId: c2.season.id, playerId: c2.me, attackDate: c2.season.hard_date, bossNumber: res.boss_number, bossCode: boss ? boss.boss_code : null,
                damageRaw: Math.round((Number(res.expected_damage_b) || 30) * 1e9), level: c2.season.current_level || 1, characters: res.characters_snapshot || [] }, { reservationId: res.id, actorName: P.me.name });
        },
    };
    // ---------- 編の開始状態 (一回きり。種データだけでは足りない編は、本物の関数で盤面を作ってから始める) ----------
    var SETUP = {
        // 運営編・当日 (20 時): 朝 5 時からのプランを配信済み・20 時までの割当は凸したことにする・B1 だけ残りを多めに残し (報告がまだの凸)、
        // HP の更新を 2 時間前にする (運営タブの先頭に「HP 更新が古い」が出る = 最初の課題)
        'ops-day': async function (c) {
            await opsPublish('day');
            var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
            advanceWorld(context(), pub && pub.plan, 20, { 1: 0.45 });
            var stale = new Date(Date.now() - 2 * 3600000).toISOString();
            P.db.tx(function () { c.T.bosses.forEach(function (b) { if (eq(b.season_id, c.season.id)) b.updated_at = stale; }); });
            store.set('ops-day:setupAt', new Date().toISOString());
        },
    };
    async function runSetup() {
        var c = context();
        var snap = P.db.dump(), clockWas = P.clock.get();
        try {
            await SETUP[SC](c);
            store.set('setup:done', '1');
            return true;
        } catch (e) {
            console.warn('[練習] 開始の盤面を作れませんでした:', e && e.message || e);
            try { P.db.restore(snap); P.clock.put(clockWas); } catch (_) { /* noop */ }
            try { store.set('setup:err', String((e && e.message) || e)); } catch (_) { /* noop */ }
            return false;
        }
    }
    var ffBusy = false;
    /** 手前の課題を順に済ませる。★ 途中で失敗したら**全部戻す** (半端に済んだ状態で始めない — Codex指摘 2026-10-03)。戻したら最初から始める */
    async function fastForward(startKey) {
        var list = STEPS[SC] || [];
        var until = list.findIndex(function (s) { return s.key === startKey; });
        if (until < 0) return false;
        var snap = P.db.dump(), clockWas = P.clock.get();
        try {
            for (var i = 0; i < until; i++) {
                var c = context();
                if (!c || !c.season) throw new Error('盤面がまだありません');
                if (list[i].done(c)) continue;
                var fn = FF[list[i].key];
                if (!fn) throw new Error('課題 ' + list[i].key + ' を済ませる手順がありません');
                await fn(c);
                if (!list[i].done(context())) throw new Error('課題 ' + list[i].key + ' が済んだ形になりません');
            }
            return true;
        } catch (e) {
            console.warn('[練習] 手前の課題を済ませられませんでした (最初から始めます):', e && e.message || e);
            try { P.db.restore(snap); P.clock.put(clockWas); } catch (_) { /* 戻せなくても最初から */ }
            return false;
        }
    }

    // ---------- 課題の区切りごとの控え (「↩ 1つ前に戻る」用) ----------
    // 課題 i の**最初**の状態 (盤面・時計・知らせ) を snap:i に控える。戻る = その控えを戻して読み込み直す
    // (ユーザー要望 2026-10-03「操作したあとによく分からなかったときのために、1 つ前のステップに戻れるように」)
    var stepIdx = Number(store.get('stepIdx'));
    if (!Number.isInteger(stepIdx)) stepIdx = -1;
    function saveSnap(i) {
        try { store.set('snap:' + i, JSON.stringify({ db: P.db.dump(), clock: P.clock.get(), feed: feed })); }
        catch (e) { console.warn('[練習] 控えを置けませんでした (戻れなくなるだけ):', e && e.message || e); }
    }
    function hasSnap(i) { return i >= 0 && !!store.get('snap:' + i); }
    function trackStep(i) {
        if (i === stepIdx) return;
        if (i > stepIdx && !hasSnap(i)) saveSnap(i);   // 課題が進んだ瞬間 = 次の課題の最初
        stepIdx = i;
        try { store.set('stepIdx', String(i)); } catch (_) { /* noop */ }
    }
    function goBack(toIdx) {
        var raw = store.get('snap:' + toIdx);
        if (!raw) return false;
        var snap;
        try { snap = JSON.parse(raw); } catch (_) { return false; }
        if (!P.db.restore(snap.db)) return false;
        P.clock.put(snap.clock);
        feed = Array.isArray(snap.feed) ? snap.feed : [];
        saveFeed();
        for (var i = toIdx + 1; i < 20; i++) store.del('snap:' + i);   // 戻った先より後の控えは捨てる (また進めば新しく控える)
        try { store.set('stepIdx', String(toIdx)); } catch (_) { /* noop */ }
        try { store.set('db', P.db.dump()); } catch (_) { /* noop */ }
        P.closed = true;   // ★ 控えたあとに閉じる (閉じると置き場に書けなくなる)。画面を離れるときの控えで、戻したばかりの盤面を上書きしない
        location.reload();
        return true;
    }

    // ---------- 画面 (帯 + 課題カード) ----------
    var CSS = ''
        + 'html[data-practice] body{padding-top:var(--pm-top,0px)}'
        // 上の帯 (ロゴ・名乗り・再読み込み) は練習中は出さない — 案内の直下に貼り付いて、指したマスやボタンと重なる (2026-10-03)。
        //   名乗りは練習の人で固定、再読み込みは引っぱって更新で足りる
        + 'html[data-practice] .header{display:none !important}'
        + 'html[data-practice] .player-select-modal,html[data-practice] .player-modal,html[data-practice] .fururi-help-modal{top:var(--pm-top,0px)}'
        // シートは案内の下に収める (中身が上へはみ出すと「閉じる」が案内に隠れる)。
        // ★ 画面ごとに `#myAvailModal .player-select-content{max-height:92vh !important}` のような指定があるので、
        //   :not(#_) を 2 つ重ねて ID 2 個ぶんの強さにしている (ID を列挙しなくても勝てる)
        + 'html[data-practice] .player-select-modal > *:not(#_):not(#_),html[data-practice] .player-modal > *:not(#_):not(#_),html[data-practice] .fururi-help-modal > *:not(#_):not(#_){max-height:calc(100vh - var(--pm-top,0px) - 8px) !important}'
        + '@supports (height:100dvh){html[data-practice] .player-select-modal > *:not(#_):not(#_),html[data-practice] .player-modal > *:not(#_):not(#_),html[data-practice] .fururi-help-modal > *:not(#_):not(#_){max-height:calc(100dvh - var(--pm-top,0px) - 8px) !important}}'
        + '@media (min-width:1180px),(min-width:768px) and (max-height:559px){html[data-practice] .tab-navigation{top:var(--pm-top,0px)}}'
        // ★ アプリの知らせ (トースト・更新の帯・互換ゲートの帯) は画面の上に出る → 案内の裏に隠れないよう、案内の下へずらす
        //   (実機 2026-10-03: 了承が断られたときの知らせが見えず「押せなかった」に見えた)
        + 'html[data-practice] .notification{top:calc(env(safe-area-inset-top,0px) + 12px + var(--pm-top,0px)) !important}'
        + 'html[data-practice] #appUpdateBanner,html[data-practice] #clientGateBanner{top:calc(env(safe-area-inset-top,8px) + 8px + var(--pm-top,0px)) !important}'
        + '#pmDock{position:fixed;left:0;right:0;top:0;z-index:2147483000;font-family:inherit;color:var(--t-body);box-shadow:0 6px 18px rgba(var(--ink-rgb),.16)}'
        + '#pmDock button{font-family:inherit;cursor:pointer}'
        + '#pmDock .pm-band{background:var(--t-ink);color:var(--card);display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top,0px) + 6px) 12px 6px;font-size:11.5px;font-weight:800}'
        + '#pmDock .pm-band .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '#pmDock .pm-band button{flex:none;border:1px solid rgba(var(--paper-rgb),.55);background:transparent;color:var(--card);border-radius:999px;font-size:11px;font-weight:800;padding:4px 11px}'
        + '#pmDock .pm-body{background:var(--card);border-bottom:2px dashed var(--t-ink);padding:9px 12px 10px}'
        + '#pmDock .pm-in{max-width:720px;margin:0 auto}'
        + '#pmDock .pm-top{display:flex;align-items:center;gap:8px}'
        + '#pmDock .pm-cnt{flex:none;font-size:10px;font-weight:900;background:var(--t-ink);color:var(--card);border-radius:999px;padding:2px 8px}'
        + '#pmDock .pm-top b{flex:1;min-width:0;font-size:13px;font-weight:900;color:var(--t-ink)}'
        + '#pmDock .pm-where{flex:none;border:none;background:var(--s2);color:var(--t-strong);border-radius:999px;font-size:11px;font-weight:800;padding:5px 11px}'
        + '#pmDock p{margin:5px 0 0;font-size:12px;line-height:1.6;color:var(--t-body)}'
        + '#pmDock .pm-real{margin-top:7px;background:var(--s2);border-radius:10px;padding:7px 10px;font-size:11.5px;line-height:1.6;color:var(--t-strong)}'
        + '#pmDock .pm-real b{display:inline-block;background:var(--t-ink);color:var(--card);border-radius:5px;font-size:10px;font-weight:900;padding:1px 6px;margin-right:6px}'
        + '#pmDock .pm-ev{margin-top:8px;width:100%;border:2px dashed var(--t-ink);background:var(--s1);color:var(--t-ink);border-radius:11px;font-size:12.5px;font-weight:900;padding:9px}'
        + '#pmDock .pm-ev[disabled]{opacity:.5;cursor:progress}'
        + '#pmDock .pm-dots{display:flex;gap:4px;margin-top:8px}'
        + '#pmDock .pm-dots i{height:4px;flex:1;border-radius:2px;background:var(--track)}'
        + '#pmDock .pm-dots i.on{background:var(--t-ink)}'
        + '#pmDock .pm-foot{display:flex;justify-content:flex-end;margin-top:6px}'
        + '#pmDock .pm-back{border:none;background:transparent;color:var(--t-muted);font-size:11px;font-weight:800;padding:3px 6px;text-decoration:underline;text-underline-offset:2px}'
        + '#pmDock .pm-feed{margin-top:7px;background:var(--s1);border:1.5px dashed var(--t-muted);border-radius:11px;padding:7px 9px;font-size:11.5px;line-height:1.55;display:flex;gap:8px;align-items:flex-start}'
        + '#pmDock .pm-feed.as{border:2px dashed var(--t-ink);background:var(--card)}'
        + '#pmDock .pm-feed .k{font-size:10px;font-weight:900;color:var(--t-muted)}'
        + '#pmDock .pm-feed.as .k{color:var(--t-ink)}'
        + '#pmDock .pm-feed b{display:block;color:var(--t-ink);font-size:12px;font-weight:900}'
        + '#pmDock .pm-feed .tx{flex:1;min-width:0}'
        + '#pmDock .pm-feed button{flex:none;border:none;background:transparent;color:var(--t-muted);font-size:13px;padding:0 2px}'
        + '#pmDock .pm-done{text-align:center}'
        + '#pmDock .pm-row{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:9px}'
        + '#pmDock .pm-btn{border:none;border-radius:999px;padding:8px 14px;font-size:12px;font-weight:800;background:var(--t-ink);color:var(--card)}'
        + '#pmDock .pm-btn.sub{background:var(--s2);color:var(--t-strong)}'
        + '#pmRing{position:fixed;z-index:2147482999;pointer-events:none;border:3px dashed var(--t-ink);border-radius:12px;box-shadow:0 0 0 3px var(--card);display:none}'
        + '#pmRing span{position:absolute;left:-3px;top:-22px;background:var(--t-ink);color:var(--card);font-size:10px;font-weight:900;border-radius:6px 6px 6px 0;padding:2px 7px;white-space:nowrap}'
        + '#pmRing.flash{animation:pm-flash .45s ease-in-out 3}'
        + '@keyframes pm-flash{50%{transform:scale(1.08)}}'
        + '@media (prefers-reduced-motion:reduce){#pmRing.flash{animation:none}}';

    var dock = null, ring = null, target = null, lastSig = '', folded = store.get('fold') === '1', timer = null, lastAim = '';
    /** 押す場所の真ん中が、いま実際に押せる状態で見えているか (画面の外・案内の下・固定の帯の裏 ではない) */
    function inView(el) {
        var r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (!(cx > 4 && cx < window.innerWidth - 4 && cy > 4 && cy < window.innerHeight - 4)) return false;
        var hit = document.elementFromPoint(cx, cy);   // 枠 (#pmRing) は pointer-events:none なので拾わない
        return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    }
    function bring(el) { try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); } }
    function build() {
        var st = document.createElement('style'); st.id = 'pmStyle'; st.textContent = CSS; document.head.appendChild(st);
        dock = document.createElement('div'); dock.id = 'pmDock'; dock.setAttribute('role', 'region'); dock.setAttribute('aria-label', '練習の案内');
        document.body.appendChild(dock);
        ring = document.createElement('div'); ring.id = 'pmRing'; ring.innerHTML = '<span>ここを押す</span>';
        document.body.appendChild(ring);
        dock.addEventListener('click', onDockClick);
        if (typeof ResizeObserver === 'function') new ResizeObserver(syncTop).observe(dock);
        ['click', 'input', 'change'].forEach(function (t) { document.addEventListener(t, schedule, true); });
        setInterval(update, 400);
        requestAnimationFrame(frame);
        update();
    }
    function syncTop() { document.documentElement.style.setProperty('--pm-top', dock.offsetHeight + 'px'); }
    function schedule() { clearTimeout(timer); timer = setTimeout(update, 60); }

    var SC = P.scenario || 'member';
    function current(c) {
        var list = STEPS[SC] || [];
        for (var i = 0; i < list.length; i++) if (!list[i].done(c)) return { i: i, step: list[i], n: list.length };
        return { i: list.length, step: null, n: list.length };
    }
    function update() {
        var c = context();
        if (!c || !c.season) { render('<div class="pm-band"><span class="t">🎮 練習の準備をしています…</span></div>', 'wait'); target = null; return; }
        // 編の開始状態を作る (一回だけ)。作れなかったら知らせて「もう一度」(半端な盤面で始めない)
        if (SETUP[SC] && store.get('setup:done') !== '1') {
            var err = store.get('setup:err');
            if (err) {
                render('<div class="pm-band"><span class="t">🎮 練習中 — 本番には反映されません</span><button data-pm="quit">やめる</button></div><div class="pm-body"><div class="pm-in"><p>開始の盤面を作れませんでした: ' + esc(err) + '</p>'
                    + '<div class="pm-row"><button class="pm-btn" data-pm="restart">もう一度</button><button class="pm-btn sub" data-pm="quit">練習をやめる</button></div></div></div>', 'setup-err:' + err);
                target = null; return;
            }
            if (!ffBusy) {
                ffBusy = true;
                runSetup().then(function () { if (typeof P.save === 'function') P.save(); location.reload(); });
            }
            render('<div class="pm-band"><span class="t">🎮 当日の盤面を作っています… (配信と 20 時までの凸)</span></div>', 'setup'); target = null; return;
        }
        // 途中の課題から始める指定があれば、手前を済ませてから読み込み直す (1 回だけ)
        var startAt = store.get('start');
        if (startAt && !store.get('ff:done')) {
            if (!ffBusy) {
                ffBusy = true;
                fastForward(startAt).then(function (ok) {
                    // 済ませられたら印を付けて読み込み直す。済ませられなかったら「途中から」をやめて最初から (印を消す)
                    try { if (ok) store.set('ff:done', '1'); else store.del('start'); } catch (_) { /* noop */ }
                    if (!ok) note('assume', '途中の課題から始められませんでした', '最初の課題から始めます');
                    if (typeof P.save === 'function') P.save();
                    location.reload();
                });
            }
            render('<div class="pm-band"><span class="t">🎮 手前の課題を済ませています…</span></div>', 'ff'); target = null; return;
        }
        var cur = current(c), g = cur.step ? (cur.step.guide(c) || {}) : {};
        trackStep(cur.i);
        var backBtn = (cur.i >= 1 && hasSnap(cur.i - 1)) ? '<button class="pm-back" data-pm="back" data-to="' + (cur.i - 1) + '">↩ 1つ前に戻る</button>' : '';
        target = (g.target && vis(g.target)) ? g.target : null;
        // ★ 押す場所が変わったら、見える所まで自動で動かす (横に並ぶカードの外・画面の下など)。
        //   同じ場所を指している間は動かさない (自分でスクロールして読んでいるのを邪魔しない)
        var aim = cur.i + '|' + (g.text || '');
        if (target && aim !== lastAim && !inView(target)) bring(target);
        if (target) lastAim = aim;
        var dots = '<div class="pm-dots">' + (STEPS[SC] || []).map(function (_, i) { return '<i class="' + (i < cur.i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
        // 最新の 1 件だけ出す (閉じると次が出る)。全部並べると案内が画面の半分を取る
        var fd = folded ? '' : feed.slice(0, 1).map(function (x) {
            return '<div class="pm-feed' + (x.kind === 'assume' ? ' as' : '') + '"><div class="tx"><div class="k">'
                + (x.kind === 'push' ? '📩 本番ではこの通知が届きます' + (x.to ? ' (' + esc(x.to) + ')' : '') : '⏩ 練習だけの仮定')
                + (feed.length > 1 ? ' · ほか ' + (feed.length - 1) + ' 件' : '') + '</div><b>' + esc(x.title) + '</b>' + esc(x.body)
                + '</div><button data-pm="dismiss" data-id="' + x.id + '" aria-label="閉じる">✕</button></div>';
        }).join('');
        var scn = SCENARIOS[SC] || { title: '練習', next: 'member' };
        var band = '<div class="pm-band"><span class="t">🎮 練習中 (' + esc(scn.title) + ') — 本番には反映されません</span>'
            + '<button data-pm="fold" aria-expanded="' + (!folded) + '">' + (folded ? '案内を開く' : '畳む') + '</button><button data-pm="quit">やめる</button></div>';
        var body;
        if (!cur.step) {
            var nextSc = SCENARIOS[scn.next];
            body = cur.n ? '<div class="pm-done"><b style="font-size:14px;font-weight:900;color:var(--t-ink)">🎉 ' + esc(scn.title) + ' おしまい</b>'
                    + '<p>本番でも同じ場所・同じボタンです。このまま自由に触ることもできます。</p>'
                    + '<div class="pm-real" style="text-align:left"><b>本番とのちがい</b>' + esc(scn.diff || '') + '</div>'
                    + '<div class="pm-row"><button class="pm-btn sub" data-pm="restart">もう一度</button>' + (backBtn ? '<button class="pm-btn sub" data-pm="back" data-to="' + (cur.i - 1) + '">↩ 1つ前に戻る</button>' : '')
                    + (nextSc ? '<button class="pm-btn" data-pm="goto" data-sc="' + esc(scn.next) + '">次は ' + esc(nextSc.title) + ' →</button>' : '') + '<button class="pm-btn sub" data-pm="quit">練習をやめる</button></div>' + dots + '</div>'
                : '<p>この編はまだ用意されていません。画面は自由に触れます。</p><div class="pm-row"><button class="pm-btn" data-pm="goto" data-sc="member">メンバー編へ</button><button class="pm-btn sub" data-pm="quit">練習をやめる</button></div>';
        } else {
            body = '<div class="pm-top"><span class="pm-cnt">課題 ' + (cur.i + 1) + '/' + cur.n + '</span><b>' + esc(cur.step.title) + '</b>'
                + (target ? '<button class="pm-where" data-pm="where">どこ？</button>' : '') + '</div>'
                + (folded ? '' : '<p>' + esc(g.text || '') + '</p>'
                    + (g.real ? '<div class="pm-real"><b>本番では</b>' + esc(g.real) + '</div>' : '')
                    + (g.assume ? '<button class="pm-ev" data-pm="assume" data-k="' + esc(g.assume[0]) + '"' + (busy ? ' disabled' : '') + '>' + esc(g.assume[1]) + '</button>' : '')
                    + dots + (backBtn ? '<div class="pm-foot">' + backBtn + '</div>' : ''));
        }
        render(band + '<div class="pm-body"><div class="pm-in">' + body + fd + '</div></div>',
            [cur.i, folded, busy, g.text, g.real, g.assume && g.assume[0], !!target, !!backBtn, feed.map(function (x) { return x.id; }).join(',')].join('|'));
    }
    function render(html, sig) {
        if (sig === lastSig) return;
        lastSig = sig;
        dock.innerHTML = html;
        syncTop();
    }
    function frame() {
        if (target && vis(target)) {
            var r = target.getBoundingClientRect();
            var shown = inView(target);
            ring.style.display = shown ? 'block' : 'none';
            if (shown) {
                ring.style.left = (r.left - 5) + 'px'; ring.style.top = (r.top - 5) + 'px';
                ring.style.width = (r.width + 10) + 'px'; ring.style.height = (r.height + 10) + 'px';
            }
        } else ring.style.display = 'none';
        requestAnimationFrame(frame);
    }
    function onDockClick(ev) {
        var b = ev.target.closest('[data-pm]');
        if (!b) return;
        var k = b.getAttribute('data-pm');
        if (k === 'quit') { if (window.confirm('練習をやめて、本番の画面に戻りますか？\n(練習でやったことは残りません)')) P.exit(); return; }
        if (k === 'restart') { P.restart(SC); return; }
        if (k === 'goto') { P.restart(b.getAttribute('data-sc')); return; }
        if (k === 'back') {
            var to = Number(b.getAttribute('data-to')), st = (STEPS[SC] || [])[to];
            if (!st) return;
            if (!window.confirm('課題 ' + (to + 1) + '「' + st.title + '」の最初に戻りますか？\n(そのあとにやったことは消えます)')) return;
            if (!goBack(to)) note('assume', '戻れませんでした', '控えが無いか、壊れています');
            lastSig = ''; update();
            return;
        }
        if (k === 'fold') { folded = !folded; try { store.set('fold', folded ? '1' : '0'); } catch (_) { /* 覚えられなくても畳める */ } lastSig = ''; update(); return; }
        if (k === 'dismiss') { feed = feed.filter(function (x) { return !eq(x.id, b.getAttribute('data-id')); }); saveFeed(); lastSig = ''; update(); return; }
        if (k === 'where' && target) {
            bring(target);
            ring.classList.remove('flash'); void ring.offsetWidth; ring.classList.add('flash');
            return;
        }
        if (k === 'assume' && !busy) {
            var fn = ASSUME[b.getAttribute('data-k')];
            if (!fn) return;
            // ★ 途中で失敗したら、押す前の盤面へ戻す (Codex指摘 2026-10-02)。「承認だけ済んで配信が無い」のような半端が残ると、
            //   課題は済んだ扱いになって押し直せず、このあとの当日の画面が合わなくなる
            var snap = P.db.dump(), feedWas = feedId, clockWas = P.clock.get();
            busy = true; lastSig = ''; update();
            Promise.resolve().then(fn).catch(function (e) {
                console.error('[練習] 仮定を進められませんでした:', e);
                try { P.db.restore(snap); P.clock.put(clockWas); if (typeof P.save === 'function') P.save(); } catch (_) { /* 戻せなくても知らせる */ }
                feed = feed.filter(function (x) { return x.id <= feedWas; });
                note('assume', 'うまく進められませんでした (押す前の状態に戻しました)', 'もう一度押してみてください: ' + String((e && e.message) || e));
            }).then(refreshScreen).then(function () { busy = false; lastSig = ''; update(); });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
