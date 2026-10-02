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
        finishAccept: ['button[onclick^="handleMyFinishRequestRespond("]'],
        modalClose: ['button[onclick^="close"]', '[onclick^="close"]'],   // 「閉じる」ボタン。凸報告は div の ✕
    };
    P.selectors = SEL;
    var pick = function (name) { return q.apply(null, SEL[name]); };

    // ---------- いまの状況 ----------
    function context() {
        var T = P.db ? P.db.tables : null;
        if (!T) return null;
        var season = T.seasons.filter(function (s) { return s.is_active; })[0] || null;
        var meId = P.role === 'ops' ? P.ops.id : P.me.id;
        var modal = topModal();
        var mine = function (table) { return T[table].filter(function (r) { return eq(r.player_id, meId) && (r.season_id == null || !season || eq(r.season_id, season.id)); }); };
        return {
            T: T, season: season, me: meId, tab: activeTab(), modal: modal, modalId: modal ? modal.id : '',
            day: ymdJst(P.clock.now()) >= P.hardDate ? 'hard' : 'eve',
            mine: mine,
            resv: mine('plan_reservations').filter(function (r) { return r.source_type !== 'finish_request'; }),
            finish: mine('finish_requests'),
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
            P.clock.set('hard', 21);
            note('assume', '当日の 21 時になった、と仮定しました', 'その間にほかのメンバーが凸を進めています');
            saveFeed();
            if (typeof P.save === 'function') P.save();   // ★ 読み込み直す前に、いま入れた凸を待たずに控える (控えは少し遅れて書かれる)
            location.reload();
            await new Promise(function () { /* 読み込み直しを待つ */ });
        },
        // 運営から締め凸のお願いが来た
        finishRequest: async function () {
            var c = context();
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
    };
    /** 配信プランのうち hour 時より前のぶんを、ほかのメンバーが凸したことにする (ボスは倒し切らない) */
    function advanceWorld(c, plan, hour) {
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
            var keep = Math.max(Number(boss.total_hp_raw) * 0.12, mineB[b.bossNumber] || 0);
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

    // ---------- 課題 (メンバー編) ----------
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
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: 'ホームに届いた「締め凸のお願い」に返事をします。出られないときは断って構いません (運営にすぐ伝わります)。', target: pick('finishAccept') });
                } },
        ],
        ops: [],
    };
    P.steps = STEPS;
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
            var names = !ids ? '全員あて' : ids.map(function (id) {
                if (eq(id, P.me.id)) return 'あなた';
                var p = T && T.players.filter(function (x) { return eq(x.id, id); })[0];
                return p ? p.name : '?';
            }).slice(0, 4).join('・') + (ids.length > 4 ? ' ほか' + (ids.length - 4) + '人' : '') + ' あて';
            note('push', d.item.title, d.item.body, names);
        }
        schedule();
    });

    // ---------- 画面 (帯 + 課題カード) ----------
    var CSS = ''
        + 'html[data-practice] body{padding-top:var(--pm-top,0px)}'
        + 'html[data-practice] .header{top:calc(env(safe-area-inset-top,0px) + 10px + var(--pm-top,0px))}'
        + 'html[data-practice] .player-select-modal,html[data-practice] .player-modal,html[data-practice] .fururi-help-modal{top:var(--pm-top,0px)}'
        // シートは案内の下に収める (中身が上へはみ出すと「閉じる」が案内に隠れる)。
        // ★ 画面ごとに `#myAvailModal .player-select-content{max-height:92vh !important}` のような指定があるので、
        //   :not(#_) を 2 つ重ねて ID 2 個ぶんの強さにしている (ID を列挙しなくても勝てる)
        + 'html[data-practice] .player-select-modal > *:not(#_):not(#_),html[data-practice] .player-modal > *:not(#_):not(#_),html[data-practice] .fururi-help-modal > *:not(#_):not(#_){max-height:calc(100vh - var(--pm-top,0px) - 8px) !important}'
        + '@supports (height:100dvh){html[data-practice] .player-select-modal > *:not(#_):not(#_),html[data-practice] .player-modal > *:not(#_):not(#_),html[data-practice] .fururi-help-modal > *:not(#_):not(#_){max-height:calc(100dvh - var(--pm-top,0px) - 8px) !important}}'
        + '@media (min-width:1180px),(min-width:768px) and (max-height:559px){html[data-practice] .tab-navigation{top:var(--pm-top,0px)}}'
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

    function current(c) {
        var list = STEPS[P.role] || [];
        for (var i = 0; i < list.length; i++) if (!list[i].done(c)) return { i: i, step: list[i], n: list.length };
        return { i: list.length, step: null, n: list.length };
    }
    function update() {
        var c = context();
        if (!c || !c.season) { render('<div class="pm-band"><span class="t">🎮 練習の準備をしています…</span></div>', 'wait'); target = null; return; }
        var cur = current(c), g = cur.step ? (cur.step.guide(c) || {}) : {};
        target = (g.target && vis(g.target)) ? g.target : null;
        // ★ 押す場所が変わったら、見える所まで自動で動かす (横に並ぶカードの外・画面の下など)。
        //   同じ場所を指している間は動かさない (自分でスクロールして読んでいるのを邪魔しない)
        var aim = cur.i + '|' + (g.text || '');
        if (target && aim !== lastAim && !inView(target)) bring(target);
        if (target) lastAim = aim;
        var dots = '<div class="pm-dots">' + (STEPS[P.role] || []).map(function (_, i) { return '<i class="' + (i < cur.i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
        // 最新の 1 件だけ出す (閉じると次が出る)。全部並べると案内が画面の半分を取る
        var fd = folded ? '' : feed.slice(0, 1).map(function (x) {
            return '<div class="pm-feed' + (x.kind === 'assume' ? ' as' : '') + '"><div class="tx"><div class="k">'
                + (x.kind === 'push' ? '📩 本番ではこの通知が届きます' + (x.to ? ' (' + esc(x.to) + ')' : '') : '⏩ 練習だけの仮定')
                + (feed.length > 1 ? ' · ほか ' + (feed.length - 1) + ' 件' : '') + '</div><b>' + esc(x.title) + '</b>' + esc(x.body)
                + '</div><button data-pm="dismiss" data-id="' + x.id + '" aria-label="閉じる">✕</button></div>';
        }).join('');
        var band = '<div class="pm-band"><span class="t">🎮 練習中 — 本番には反映されません</span>'
            + '<button data-pm="fold" aria-expanded="' + (!folded) + '">' + (folded ? '案内を開く' : '畳む') + '</button><button data-pm="quit">やめる</button></div>';
        var body;
        if (!cur.step) {
            body = cur.n ? '<div class="pm-done"><b style="font-size:14px;font-weight:900;color:var(--t-ink)">🎉 メンバー編 おしまい</b>'
                    + '<p>本番でも同じ場所・同じボタンです。このまま自由に触ることもできます。</p>'
                    + '<div class="pm-real" style="text-align:left"><b>本番とのちがい</b>練習では運営の返事や時間を「〜したことにする」で進めました。本番では運営が確認するまで待ちます (承認されると通知が届きます)。</div>'
                    + '<div class="pm-row"><button class="pm-btn sub" data-pm="restart">もう一度</button><button class="pm-btn" data-pm="quit">練習をやめる</button></div>' + dots + '</div>'
                : '<p>この役の練習はまだ用意されていません。画面は自由に触れます。</p>';
        } else {
            body = '<div class="pm-top"><span class="pm-cnt">課題 ' + (cur.i + 1) + '/' + cur.n + '</span><b>' + esc(cur.step.title) + '</b>'
                + (target ? '<button class="pm-where" data-pm="where">どこ？</button>' : '') + '</div>'
                + (folded ? '' : '<p>' + esc(g.text || '') + '</p>'
                    + (g.real ? '<div class="pm-real"><b>本番では</b>' + esc(g.real) + '</div>' : '')
                    + (g.assume ? '<button class="pm-ev" data-pm="assume" data-k="' + esc(g.assume[0]) + '"' + (busy ? ' disabled' : '') + '>' + esc(g.assume[1]) + '</button>' : '')
                    + dots);
        }
        render(band + '<div class="pm-body"><div class="pm-in">' + body + fd + '</div></div>',
            [cur.i, folded, busy, g.text, g.real, g.assume && g.assume[0], !!target, feed.map(function (x) { return x.id; }).join(',')].join('|'));
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
        if (k === 'restart') { P.restart(P.role); return; }
        if (k === 'fold') { folded = !folded; store.set('fold', folded ? '1' : '0'); lastSig = ''; update(); return; }
        if (k === 'dismiss') { feed = feed.filter(function (x) { return !eq(x.id, b.getAttribute('data-id')); }); saveFeed(); lastSig = ''; update(); return; }
        if (k === 'where' && target) {
            bring(target);
            ring.classList.remove('flash'); void ring.offsetWidth; ring.classList.add('flash');
            return;
        }
        if (k === 'assume' && !busy) {
            var fn = ASSUME[b.getAttribute('data-k')];
            if (!fn) return;
            busy = true; lastSig = ''; update();
            Promise.resolve().then(fn).then(refreshScreen).catch(function (e) {
                console.error('[練習] 仮定を進められませんでした:', e);
                note('assume', 'うまく進められませんでした', String((e && e.message) || e));
            }).then(function () { busy = false; lastSig = ''; update(); });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
