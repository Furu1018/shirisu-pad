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
        availOpen: ['[onclick="openMyAvailModal()"]'],
        availPlusNight: ['#myAvailModal button[onclick="_availStepCount(5, 1)"]'],   // 既定のブロックの 6 つ目 = 夜 21〜23時
        availConfirm: ['#myAvailConfirmBox button[onclick="handleConfirmAvailability(false)"]'],
        modalClose: ['button[onclick^="close"]', '[onclick^="close"]'],   // 「閉じる」ボタン
        planAck: ['button[onclick="handleAckPlan(this)"]'],
        // 運営編
        navOps: ['.bottom-nav-btn[data-tab="ops"]', '.tab-button[data-tab="ops"]'],
        nudgeMock: ['[onclick="_opsStageAct(\'nudge:mock\')"]'],
        pushSend: ['#pushPreviewSendBtn'],
        planWhoBlock: ['[onclick="setOpsPlanWho(\'block\')"]'],
        planCompute: ['[onclick="computeAndRenderOptimalPlan()"]'],
        planTimetable: ['[onclick="setOpsPlanViewMode(\'timetable\')"]'],
        planPiece: ['#opsOptimalPlan .plan-piece[data-piece]:not(.placed):not(.dim)'],
        planCell: ['#opsOptimalPlan [data-boss][data-h]'],   // どのマスを指すかは placeableCell() が本物の判定で決める
        resvApprove: ['button[onclick^="handleReservationApprove("]'],
        planPublish: ['#opsPlanPublishBtn'],
        swapAuto: ['#planSwapAutoBtn'],
        // 運営編・当日
        bossHpOpen: ['[onclick="_opsStageAct(\'hp\')"]', '[onclick="openOpsBossHpModal()"]'],   // 先頭のヒーロー「🎯 ボス HP を更新する」が出ていればそれ
        bossHpInput: ['#opsBossHpModal [data-boss-num="1"] input.ops-hp-rem'],
        bossHpSave: ['#opsBossHpModal [data-boss-num="1"] button[onclick^="handleOpsBossHpSave("]'],
        atkConfirm: ['#opsAtkCheckBody .ops-atk-row:not(.done) button.ok'],
        resultTake: ['#opsAtkCheckMissing .ops-atk-row button.act.go'],   // 📥 結果の取り込み: 結果がまだの凸の「📥 取り込む」(段階 4)
        resultDmg: ['#opsResultDmg'],
        resultSave: ['#opsResultSaveBtn'],
        finishPick: ['.dc-boss-card[data-boss-card="1"] .js-finish[data-action="finish-pick"]:not([disabled])'],
        finishCopy: ['#opsFinishPlans button[onclick^="handleOpsFinishPlanCopy("]'],
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
            allResv: allResv,
            notices: season ? T.raid_event_notices.filter(function (r) { return eq(r.season_id, season.id); }) : [],
            pushLog: T.push_notifications_log,
            pub: season ? T.published_plans.filter(function (r) { return eq(r.season_id, season.id); }).sort(function (a, b) { return Number(b.id) - Number(a.id); })[0] || null : null,
        };
    }
    var nav = function (name, label) { return { text: 'メニューの「' + label + '」を開きます。', target: pick(name) }; };
    // 🧱 段階 2.5: 運営タブは 👥 メンバー / 🧱 組む / ⚔️ 戦況 に分かれた。目的のカードが別のタブなら、まずそのタブを押させる
    //   (練習モードは 2.5 のあとに作り直す — それまでの橋渡し)
    var opsTab = function (want) {
        var cur = document.querySelector('#opsSubTabs [aria-selected="true"]');
        if (!cur || cur.getAttribute('data-ops-tab') === want) return null;
        var btn = document.querySelector('#opsSubTabs [data-ops-tab="' + want + '"]');
        var label = btn ? (btn.textContent || '').replace(/\d+$/, '').trim() : want;
        return { text: '運営タブの上の「' + label + '」を押します。カードはいつも同じタブにあります。', target: btn };
    };
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
    /** 運営役がいまの盤面でプランを組んで配信する (本物のソルバーと配信の関数を使う)。blockName を渡すと 🧱 そのブロックの人で組み、そのブロックのぶんだけ配信する */
    async function opsPublish(startMode, blockName) {
        var c = context();
        var snapshot = await opsStore.load();
        var rows = await window.supabaseLoadReservations(c.season.id);
        var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
        var prevMode = typeof _opsPlanStartMode !== 'undefined' ? _opsPlanStartMode : 'now';
        var opts = { reservations: rows, previousPlan: (pub && eq(pub.season_id, c.season.id)) ? pub.plan : null };
        var blk = null;
        if (blockName && window.raidBlocksDomain) {
            var list = window.raidBlocksDomain.blocksOfSeason(c.season);
            for (var k = 0; k < list.length; k++) if (list[k].name === blockName) { blk = list[k]; blk.idx = k; break; }
            if (!blk) throw new Error('ブロック「' + blockName + '」がありません');
            opts.onlyAvailableNow = true; opts.availableAtSlots = blk.slots; opts.availableAtLabel = blk.label; opts.blockStartSlot = _hourKey(blk.from);
        }
        if (typeof setOpsPlanStartMode === 'function') setOpsPlanStartMode(blk ? 'now' : (startMode || 'now'));
        var plan;
        try {
            plan = computeOptimalPlan(opts, snapshot);
        } finally { if (typeof setOpsPlanStartMode === 'function') setOpsPlanStartMode(prevMode); }
        if (!plan) throw new Error('プランを組めませんでした');
        plan.conditions = { who: blk ? 'block' : 'all', block: blk ? blk.label : null, from: blk ? 'block' : (startMode === 'day' ? 'day' : 'now'), prev: pub ? 'keep' : 'fresh',
            computedAt: new Date().toISOString(), computedBy: P.ops.name, time: 'strict',
            reservations: rows.filter(function (r) { return r.status === 'approved'; }).length, excluded: 0, unavailable: 0 };
        if (blk) plan.blockScope = { idx: blk.idx, name: blk.name, label: blk.label, from: blk.from, to: blk.to, slots: blk.slots.slice() };
        var schema = (typeof window._planSchemaOf === 'function') ? window._planSchemaOf(plan) : (typeof PLAN_SCHEMA !== 'undefined' ? PLAN_SCHEMA : null);
        return window.supabasePublishPlan(plan, P.ops.id, P.ops.name, c.season.id, schema);
    }
    var ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    /** 運営役からの通知。本物と同じ関数で送る → 偽のサーバが「送ったことにして」控え、案内に見本が出て、受け取った通知にも残る */
    function pushAsOps(payload) {
        return window.sendPushNotification(payload, { senderPlayerId: P.ops.id }).catch(function (e) { console.warn('[練習] 通知の見本を出せませんでした:', e && e.message || e); });
    }
    /** 運営役の練習で「メンバーから申請が来た」: 朝 7 時に出られて (前日に組むのは朝のブロック)、その時刻のボスに合う編成を持つ人を 1 人選んで本物の関数で申請する */
    var REQ_SLOT = 'h07';
    function pickRequester(c) {
        var T = c.T;
        var taken = {};
        c.allResv.forEach(function (r) { if (['requested', 'approved', 'cancel_requested', 'pinned'].indexOf(r.status) >= 0) taken[r.player_id] = true; });
        var players = T.players.filter(function (p) { return !eq(p.id, P.me.id) && !eq(p.id, P.ops.id) && !p.archived && !taken[p.id]; });
        for (var i = 0; i < players.length; i++) {
            var pl = players[i];
            if (!T.availability.some(function (a) { return eq(a.player_id, pl.id) && a.time_slot === REQ_SLOT; })) continue;
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
    /** (メンバー編) 当日の 20 時にして、運営役が「夜」のぶんを配信する。読み込み直しはしない (呼ぶ側が決める) */
    async function publishNight() {
        var c = context();
        P.clock.set('hard', 20);
        await opsPublish('block', '夜');
        // 🧱 段階 4: 本番と同じく、ブロックの配信は割当のある人へ「あなたの凸」を通知する (本物の関数で・偽のサーバが控える)
        var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
        if (pub && pub.plan && typeof window._notifyBlockPublish === 'function') {
            await window._notifyBlockPublish({ pub: pub, plan: pub.plan, seasonId: c.season.id, me: P.ops, changedIds: new Set(), onlyIds: null }).catch(function (e) { console.warn('[練習] 配信の通知の見本を出せませんでした:', e && e.message || e); });
        }
    }
    var ASSUME = {
        // (メンバー編) 当日の夜の前に、運営が「夜」のぶんを配信した — 本物のソルバー (🧱 ブロックの人・本人の凸数の上限) と配信の関数で
        nightPublish: async function () {
            await publishNight();
            note('assume', '当日の 20 時になり、運営が「夜」のぶんを配信した、と仮定しました', '本番では運営がそのブロックの前に配信します。ホームを開いて確かめます');
            saveFeed();
            if (typeof P.save === 'function') P.save();   // ★ 読み込み直す前に、いま入れた配信を待たずに控える
            location.reload();
            await new Promise(function () { /* 読み込み直しを待つ */ });
        },
        // (メンバー編) 凸をして Discord にスクショを貼った → 運営があなたの凸を登録した (本物の凸の登録の関数・運営の名前で)
        opsRegister: async function () {
            var c = context();
            var plan = c.pub && c.pub.plan;
            var scoped = (plan && plan.blockScope && window.raidBlocksDomain) ? window.raidBlocksDomain.scopePlan(plan, plan.blockScope) : plan;
            var mine = null;
            ((scoped && scoped.levels) || []).forEach(function (lv) { (lv.bosses || []).forEach(function (b) { (b.attacks || []).forEach(function (a) { if (!mine && eq(a.memberId, c.me)) mine = { level: lv.level, bossNumber: b.bossNumber, a: a }; }); }); });
            if (!mine) { store.set('member:noAssign', '1'); note('assume', '夜のぶんにあなたの割当がありませんでした', 'この練習ではここまでです'); return; }
            var boss = c.T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && eq(b.boss_number, mine.bossNumber); })[0];
            if (!boss) return;
            var dmg = Math.min(Math.round((Number(mine.a.dmgB) || 20) * 1e9), Math.max(1, Number(boss.remaining_hp_raw) - 1));   // 練習の世界ではボスを倒し切らない
            P.clock.set('hard', 21);
            await window.supabaseAddAttack({ seasonId: c.season.id, playerId: c.me, attackDate: c.season.hard_date, bossNumber: mine.bossNumber, bossCode: boss.boss_code,
                damageRaw: dmg, level: c.season.current_level || 1, characters: mine.a.team || [] }, { actorName: P.ops.name });
            note('assume', '21 時に凸をして Discord にスクショを貼り、運営があなたの凸を登録した、と仮定しました', '本番では運営がまとめて登録します。登録されるとホームの「きょうの凸」に ✓ が付きます');
        },
        // (運営編・前日) メンバーから「朝 7 時に・この編成で」の予約の申請が来た — 本物の申請の関数と通知の文面で
        memberRequest: async function () {
            var c = context();
            if (c.allResv.some(function (r) { return r.status === 'requested'; })) return;
            var q = pickRequester(c);
            if (!q) { note('assume', '申請できる人が見つかりません', 'この練習ではここまでです'); return; }
            // 🧱 段階 3: メンバーはブロックで申請する (時刻は運営がブロックの中で決める)。本番の申請シートと同じ関数・同じ形
            await window.supabaseCreateReservation({ seasonId: c.season.id, playerId: q.player.id, bossNumber: q.boss.boss_number, block: { from: 5, to: 8 }, loadoutSlot: Number(q.dmg.slot) || 1,
                characters: q.dmg.characters, expectedDamageB: Number(q.dmg.damage_b), requestedBy: q.player.name });
            await window.sendPushNotification({ title: '🔒 予約の申請', body: q.player.name + ': B' + q.boss.boss_number + ' 5〜8時のどこか 編成' + (Number(q.dmg.slot) === 2 ? '②' : '①') + ' (承認待ち)',
                tag: 'ops-resv-request', playerIds: [P.ops.id], ignoreAvailability: true, requireInteraction: true }, { senderPlayerId: q.player.id });
            note('assume', q.player.name + 'さんから「B' + q.boss.boss_number + ' 朝 (5〜8時) のどこか」の申請が来た、と仮定しました', '本番ではいつ・何件来るか分かりません');
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
    // ---------- 編 (シナリオ) と課題 ----------
    // ★ 2026-10-22 作り直し (🧱 ブロック制・段階 2.5 の画面に合わせて): メンバーは「出られる時間と凸数」と「いつ・どの PT で凸するか」だけ、
    //   運営はブロックの頭の手順 (⚔️ HP を直す → ⚔️ 結果の取り込み → 🧱 そのブロックを組む → 配信 → 締凸検索で探す) を本物の画面で動かす。
    // ★ id は js/practice/boot.js の SCENARIOS と同じ一覧 (テストが突き合わせる)。役と開始時刻は boot.js が決める
    var countsOf = function () { return (typeof _availUI !== 'undefined' && _availUI && _availUI.counts) ? _availUI.counts : {}; };
    var STEPS = {
        member: [
            { key: 'avail', title: '出られる時間と「何凸するか」を伝える',
                done: function (c) { return c.mine('availability_confirmations').some(function (r) { return r.block_counts && Object.keys(r.block_counts).length > 0; }); },
                guide: function (c) {
                    if (c.modalId === 'myAvailModal') {
                        if ((Number(countsOf()['21-23']) || 0) < 2) return { text: 'あなたは 19 時から出られます。「夜」の「＋」を押して、夜に 2 凸すると伝えます (あと ' + (2 - (Number(countsOf()['21-23']) || 0)) + ' 回)。',
                            real: '凸数を入れたブロックには、運営はその数より多く割り当てません。入れなければ運営がそのブロックのどこかに割り当てます。', target: pick('availPlusNight') };
                        return { text: '「夜 2」になりました。下の「この時間で参加します」を押します。', target: pick('availConfirm') };
                    }
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: 'ホームの「⏰ あなたの戦闘可能時間」で「変更する ›」を押します。', target: pick('availOpen') });
                } },
            { key: 'wait', title: '運営の配信を待つ',
                done: function (c) { return !!(c.pub && c.pub.plan && c.pub.plan.blockScope); },
                guide: function (c) {
                    return stray(c, []) || { text: '模擬は Discord にスクショを貼るだけです (運営が登録します。ホームの「登録された模擬」で見られます)。あとは運営の配信を待ちます。',
                        real: '運営はブロックごとに、そのブロックに出られる人で凸を組み、ブロックの前に配信します。出られるブロックの前にホームを開いて確かめます。',
                        assume: ['nightPublish', '⏩ 当日の夜の前に、運営が「夜」のぶんを配信したことにする'] };
                } },
            { key: 'ack', title: '「いつ・どの PT で凸するか」を確かめる',
                done: function (c) { return c.pub && c.mine('plan_acks').some(function (a) { return eq(a.plan_id, c.pub.id); }); },
                guide: function (c) {
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: 'ホームの「あなたの凸」に、夜の何時にどのボスへどの PT で行くかが出ています。読んだら「✅ 確認しました」を押します。',
                            real: '配信されるのは次のブロックのぶんだけです。後ろのブロックの割当は、そのブロックの前に運営が配信します。', target: pick('planAck') });
                } },
            { key: 'report', title: '凸したら Discord へ',
                done: function (c) { return c.mine('attacks').length > 0 || store.get('member:noAssign') === '1'; },
                guide: function (c) {
                    return stray(c, []) || { text: '割当の時刻になったらゲームで凸をして、結果の画面のスクショを Discord の #凸報告 へ貼ります。PAD には何も入れません。',
                        real: '凸の登録は運営がスクショを見てまとめて行います。登録されるとホームの「きょうの凸」に ✓ が付きます。',
                        assume: ['opsRegister', '⏩ 凸をして、運営があなたの凸を登録したことにする'] };
                } },
        ],
        'ops-eve': [
            { key: 'nudge', title: '模擬がまだの人に催促する',
                done: function (c) { return c.pushLog.some(function (r) { return /登録のお願い/.test(r.title || ''); }); },
                guide: function (c) {
                    if (c.modalId === 'pushPreviewModal') return { text: '宛先と文面を確かめて「送信する」を押します。', target: pick('pushSend') };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    return stray(c, []) || { text: '運営タブの先頭には、いちばん急ぐ 1 つが出ます。「📣 未提出の人に催促する」を押します。', real: '催促は通知を購読している人にだけ届きます。届かない人は Discord で声をかけます。', target: pick('nudgeMock') };
                } },
            { key: 'compute', title: '🧱 朝のブロックを組む',
                done: function () { return store.get('ops-eve:computed') === '1'; },
                guide: function (c) {
                    if (typeof _opsLastPlan !== 'undefined' && _opsLastPlan && _opsLastPlan.blockScope && _opsLastPlan.blockScope.name === '朝') { try { store.set('ops-eve:computed', '1'); } catch (_) { /* noop */ } }
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    if (typeof _opsPlanWho !== 'undefined' && _opsPlanWho !== 'block') return stray(c, []) || { text: '対象を「🧱 ブロックの人」にします。前日に組むのは当日の最初のブロック「朝」です (既定で選ばれています)。', target: pick('planWhoBlock') };
                    return stray(c, []) || { text: '「🧮 この条件で算出」を押します。朝に出られる人の模擬で、本物のソルバーが組みます (本人が入れた凸数より多くは置きません)。', target: pick('planCompute') };
                } },
            { key: 'pin', title: '📌 で 1 つ固定する',
                done: function (c) { return c.allResv.some(function (r) { return r.status === 'pinned'; }); },
                guide: function (c) {
                    if (c.modalId === 'planSwapModal') return { text: 'この人はもう 3 凸ぶんの割当があります。ここでは「外す凸は算出に任せる」を押します。', target: pick('swapAuto') };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    if (!(typeof _opsLastPlan !== 'undefined' && _opsLastPlan)) return stray(c, []) || { text: 'まず「🧮 この条件で算出」を押します。', target: pick('planCompute') };
                    if (typeof _opsPlanViewMode !== 'undefined' && _opsPlanViewMode !== 'timetable') return stray(c, []) || { text: '「🗓 時間割」に切り替えます。📌 の固定は時間割で置きます。', target: pick('planTimetable') };
                    var pp = placeablePiece();
                    if (!pp) return stray(c, []) || { text: 'いまの時間割に置ける模擬ピースがありません。「🧮 この条件で算出」をもう一度押してから試します。', target: pick('planCompute') };
                    if (!pp.selected) return stray(c, []) || { text: '下の「🧩 模擬ピース」(まだ盤に無い人の編成) から、枠の付いた 1 つを押します。', real: '📌 は運営の下書きです。本人には届かず、配信したときに割当として届きます。', target: pp.el };
                    return stray(c, []) || { text: '枠の付いたマス (その人が出られる時間 × 合う属性のボス) を押します。📌 として固定され、算出し直されます。', target: placeableCell() };
                } },
            { key: 'request', title: 'メンバーからの予約の申請を承認して組み直す',
                done: function (c) { return c.allResv.some(function (r) { return r.status === 'approved' && r.source_type !== 'finish_request'; }); },
                guide: function (c) {
                    var req = c.allResv.filter(function (r) { return r.status === 'requested'; })[0];
                    if (!req) return stray(c, []) || { text: '前日の夜、メンバーから「このブロックに この PT で凸したい」の申請が届くことがあります。', real: 'いつ・何件来るかは分かりません。届くと運営あての通知が鳴ります。', assume: ['memberRequest', '⏩ メンバーから申請が来たことにする'] };
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    var btn = pick('resvApprove');
                    if (!btn) return stray(c, []) || { text: '申請が届いています。「🔒 凸の予約」のカードを開きます。', target: q('[onclick="_opsStageAct(\'reserve\')"]', '#opsSecReserve > .ops-card-head') };
                    return stray(c, []) || { text: '「承認する」を押します。確認が出たら OK → 承認した予約を固定して朝のブロックを組み直し、差分 (誰の割当が変わるか) が出ます。', real: '承認すると本人に通知が届きます。予約は約束なので、本人が入れた凸数より強く効きます。', target: btn };
                } },
            { key: 'publish', title: '朝のぶんを配信する',
                done: function (c) { return !!(c.pub && c.pub.plan && c.pub.plan.blockScope && Number(c.pub.plan.reservationCount) >= 1); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    if (!(typeof _opsLastPlan !== 'undefined' && _opsLastPlan)) return stray(c, []) || { text: 'まず「🧮 この条件で算出」を押します (承認した予約が入ります)。', target: pick('planCompute') };
                    return stray(c, []) || { text: '「📤 朝のぶんを配信」を押します。確認が出たら OK。押すまでメンバーには見えません。', real: '配信すると、朝に割当のある人のホームに割当が出て、「あなたの凸」の通知が届きます (同じブロックを配信し直したときは、割当が変わった人だけ)。後ろのブロックはまだ約束していないので、当日に組み直しても誰も振り回しません。', target: pick('planPublish') };
                } },
        ],
        'ops-day': [
            { key: 'hp', title: '⚔️ ゲームの画面を見てボスの残HPを直す',
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
                        : { text: '夕方 (18〜20時) のブロックの頭です。まずボスの残HPをゲームと合わせます。ここでは B1 が ' + (b1 ? (Number(b1.remaining_hp_raw) / 1e9).toFixed(1) : '?') + 'B のままです。先頭の「🎯 ボス HP を更新する」を押します。',
                            real: '凸の登録がまだのぶん、ここの残HPはゲームと食い違います。古い HP で組むと、無駄凸や取りこぼしが出ます。', target: pick('bossHpOpen') });
                } },
            { key: 'check', title: '⚔️ 前のブロックの結果を取り込む',
                // 取り込んだ凸は ✓ 確認済みになる (段階 4)。結果がまだの凸が無い盤面では、登録済みの凸を ✓ するだけでも済む
                done: function (c) { return c.T.attacks.some(function (a) { return a.confirmed_at; }); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('battle')) return stray(c, []) || opsTab('battle');
                    var dmg = pick('resultDmg');
                    if (dmg) {
                        if (!(Number(dmg.value) > 0)) return { text: 'Discord に貼られた結果の画面のダメージを入れます (例: 25)。ボスと編成は割当から入っています。', target: dmg,
                            real: '本番は「📷 結果のスクショを選ぶ」で読み取れます (ボス・ダメージ・使ったキャラ)。PC はカードにスクショを落とすだけ。' };
                        return { text: '「登録する」を押します。ボスの残HPもダメージぶん減り、この凸は ✓ 確認済みになります。', target: pick('resultSave') };
                    }
                    var take = pick('resultTake');
                    if (take) return stray(c, []) || { text: '「📥 結果の取り込み」の「⏰ 結果がまだの凸」に、配信の時刻を過ぎても結果が入っていない凸が並んでいます。1 つ目の「📥 取り込む」を押します。',
                        real: 'メンバーは凸したら結果のスクショを Discord に貼ります。それを見て運営が取り込みます。凸していなかった人は「凸していない」にすると、次のブロックで組み直します。', target: take };
                    var btn = pick('atkConfirm');
                    if (!btn) return stray(c, []) || { text: '「📥 結果の取り込み」が描かれるのを待ちます…' };
                    return stray(c, []) || { text: '「✅ 凸報告の確認」に、ここまでの凸が配信と突き合わせて並んでいます。問題なければ「✓ 確認」を押します (練習では 1 件で構いません)。',
                        real: '印 (計画にない・予定より低い・時刻のずれ) と「予定を過ぎた未報告」を見て、報告の無い人には Discord で声をかけます。片付けてから次のブロックを組みます。', target: btn };
                } },
            { key: 'compute', title: '🧱 夕方のブロックを組む',
                done: function () { return store.get('ops-day:computed') === '1'; },
                guide: function (c) {
                    if (typeof _opsLastPlan !== 'undefined' && _opsLastPlan && _opsLastPlan.blockScope && _opsLastPlan.blockScope.name === '夕方') { try { store.set('ops-day:computed', '1'); } catch (_) { /* noop */ } }
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    if (typeof _opsPlanWho !== 'undefined' && _opsPlanWho !== 'block') return stray(c, []) || { text: '対象を「🧱 ブロックの人」にします。ブロックは既定で「いま」の夕方です。', target: pick('planWhoBlock') };
                    return stray(c, []) || { text: '「🧮 この条件で算出」を押します。夕方に出られる人の残り凸で、いまの残HPから組みます (前に配信した割当は尊重されます)。', target: pick('planCompute') };
                } },
            { key: 'publish', title: '夕方のぶんを配信する',
                done: function (c) { return !!(c.pub && c.pub.plan && c.pub.plan.blockScope && c.pub.plan.blockScope.name === '夕方'); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    if (!(typeof _opsLastPlan !== 'undefined' && _opsLastPlan)) return stray(c, []) || { text: 'まず「🧮 この条件で算出」を押します。', target: pick('planCompute') };
                    return stray(c, []) || { text: '「📤 夕方のぶんを配信」を押します。確認が出たら OK。', real: '夕方に割当のある人のホームに割当が出ます 、割当のある人に「あなたの凸」の通知が届きます。配信したら Discord の運営スレに「夕方 配信した」と 1 行残すと、交代した運営が迷いません。', target: pick('planPublish') };
                } },
            { key: 'finish', title: '⚔️ 締凸検索で候補を探して声をかける',
                done: function () { return store.get('ops-day:copied') === '1'; },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('battle')) return stray(c, []) || opsTab('battle');
                    var copy = pick('finishCopy');
                    if (!copy) return stray(c, []) || { text: '残りが少ないボスは締め凸 (とどめ) の相手を探します。「ボス状況」の B1 のカードで「締凸検索」を押します。', target: pick('finishPick') };
                    return stray(c, []) || { text: '候補とプランが出ました。「いま打つか、待つか」を読んでから、プランの「📋 名前と文面をコピー」を押します。',
                        real: 'PAD からは頼みません。コピーした文面を Discord に貼って声をかけ、引き受けた人は盤 (📌) に置きます。', target: copy };
                } },
        ],
    };
    var SCENARIOS = {
        'member': { title: 'メンバー編', sub: '出られる時間と凸数 → 配信を待つ → 割当を確かめる → 凸したら Discord へ', next: 'ops-eve',
            diff: '練習では運営の配信と凸の登録を「〜したことにする」で進めました。本番では運営がブロックの前に配信し、スクショを見て凸を登録します。' },
        'ops-eve': { title: '運営編・前日', sub: '催促 → 🧱 朝を組む → 📌 → 予約の承認 → 朝のぶんを配信', next: 'ops-day',
            diff: '練習ではメンバーの申請を「来たことにする」で進めました。本番ではいつ・何件来るか分かりません。配信は押した瞬間に朝に割当のある人のホームへ出て、その人たちに通知が届きます。' },
        'ops-day': { title: '運営編・当日', sub: '夕方のブロックの頭: ⚔️ HP → ⚔️ 結果の取り込み → 🧱 夕方を組む → 配信 → 締凸検索', next: 'member',
            diff: '本番ではこの手順をブロックごとに繰り返します。交代するときは、運営タブのタブの数字 (手を打つべき件数) と「いちばん急ぐこと」から続けます。' },
    };
    // 締凸検索の「📋 名前と文面をコピー」を押したことを覚える (本物の関数をそのまま呼んでから印を付ける)
    if (typeof window.handleOpsFinishPlanCopy === 'function') {
        var _realCopy = window.handleOpsFinishPlanCopy;
        window.handleOpsFinishPlanCopy = async function (kind) {
            var r = await _realCopy(kind);
            try { store.set('ops-day:copied', '1'); } catch (_) { /* noop */ }
            if (typeof schedule === 'function') schedule();
            return r;
        };
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
            await window.supabaseConfirmAvailability(c.season.id, c.me, { slotCount: slots.length, slots: slots, blockCounts: { '21-23': 2 } });
        },
        wait: async function () { await publishNight(); },
        ack: async function (c) { var pub = context().pub; if (pub) await window.supabaseAckPlan(c.me, c.season.id, pub.id); },
    };
    // ---------- 編の開始状態 (一回きり。種データだけでは足りない編は、本物の関数で盤面を作ってから始める) ----------
    var SETUP = {
        // 運営編・当日 (18 時 = 夕方のブロックの頭): 朝 5 時からのプランを配信済み・18 時までの割当は凸したことにする (運営が登録した)・
        // B1 だけ残りを多めに残し (登録がまだの凸)、HP の更新を 2 時間前にする (運営タブの先頭に「HP 更新が古い」が出る = 最初の課題)
        'ops-day': async function (c) {
            await opsPublish('day');
            var pub = await window.supabaseGetPublishedPlan().catch(function () { return null; });
            advanceWorld(context(), pub && pub.plan, 18, { 1: 0.45 });
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
        // ★ やめた・やり直した あと (読み込み直しの直前) は何もしない。exit は印 (sessionStorage) を消してから location.replace するが、
        //   新しい画面が来るまでの数秒に update が回ると、消えた setup:done を見て当日の盤面作りを始め、その reload が replace を
        //   上書きして「やめたのに練習が最初から始まる」(運営編・当日で再現・2026-10-18。遅い端末ほど起きる)
        if (P.closed) return;
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
