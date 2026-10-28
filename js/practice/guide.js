// ============================================================================
// 練習モードの案内 (帯・課題カード・押す場所の枠・「〜したことにする」)
// ============================================================================
// ★ このファイルは練習モードのときだけ読み込まれる (js/practice/boot.js が差し込む)。
// ★ 画面と判定は**本物のまま**。ここが足すのは「次にどこを押すか」の案内と、相手 (運営・時間) の動きだけ。
//   - 進み具合は**偽のサーバの中身**から決める (ボタンを押したかではなく、結果が入ったか)。
//     だから再読み込みしても途中から続けられ、案内どおりでない押し方をしても壊れない。
//   - 押す場所は本物のボタンを selector で指す。画面の作りを変えて selector が当たらなくなったら
//     tests/practice.mjs が落ちる (押す場所が index.html に実在するかを見る)。
// ★ シンプル化 S5 (2026-10-27): 予約・催促・配信・結果の取り込み の練習をやめ、新しい流れに作り直した
//   (メンバー = Discord で伝える → 📅 レイド予定表 → 凸したら Discord へ / 運営・前日 = 📸 模擬を登録 → 朝を組む → 午前も組む → 決定 /
//    運営・当日 = 🎯 HP → ✓ 凸の記録 → いまのブロックを組み直す → 決定し直す → 締め凸検索)
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
        navRaid: ['.bottom-nav-btn[data-tab="raid"]', '.tab-button[data-tab="raid"]'],   // 📅 レイド予定表 (S5)
        modalClose: ['button[onclick^="close"]', '[onclick^="close"]'],   // 「閉じる」ボタン
        planAck: ['button[onclick="handleAckPlan(this)"]'],   // ✅ 確認しました (ホームの配信カード / レイド予定表 — 見えている方)
        // 運営編・前日
        navOps: ['.bottom-nav-btn[data-tab="ops"]', '.tab-button[data-tab="ops"]'],
        mockPlus: ['#opsMockIntakeBody .mk-plus'],   // ▶︎ 模擬ダメージ表の「＋」(人と属性は mockPlusFor が実行時に選ぶ)
        mockDmg: ['#myDmgPreviewDmgInput'],
        mockSave: ['#myDmgPreviewSaveBtn'],
        obBlock: ['#opsBuild [data-ob-blk]'],
        obPiece: ['#opsBuild .obt:not(.off)'],
        obRow: ['#opsBuild .obr.can .obr-h'],   // ★ 行の真ん中は 📌 の駒 (押すと外れる) → 見出しを指す
        obAuto: ['[onclick="_obAuto()"]'],
        obDecide: ['[onclick="_obDecide()"]'],
        // 運営編・当日
        bossHpOpen: ['[onclick="_opsStageAct(\'hp\')"]', '[onclick="openOpsBossHpModal()"]'],   // 先頭のヒーロー「🎯 ボス HP を更新する」が出ていればそれ
        bossHpInput: ['#opsBossHpModal [data-boss-num="1"] input.ops-hp-rem'],
        bossHpSave: ['#opsBossHpModal [data-boss-num="1"] button[onclick^="handleOpsBossHpSave("]'],
        tapDone: ['#opsAtkTapBody [data-tap-done]'],   // ✓ 凸の記録 の盤の、まだ ✓ の無い名前の札 (S5・2026-10-28 から組むと同じ盤)
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
    /**
     * 運営役が本物の関数で組んで決定する (🧱 組む の「🧮 残りを自動で組む」と「✅ 決定」と同じ材料: ソルバー → blockBuild.overview → decidePlan.build → 決定の配信)。
     * names = 決めるブロックの名前 (続いていなくてよい)。first = 盤面を進める最初のブロック (省略 = 決めるブロックの最初)。notify = 本物の関数で通知の見本も出す
     */
    async function opsDecide(names, opts) {
        opts = opts || {};
        var c = context();
        var rb = window.raidBlocksDomain, bb = window.blockBuildDomain, dp = window.decidePlanDomain;
        if (!rb || !bb || !dp) throw new Error('凸プランを組む機能を読み込めません');
        var snapshot = await opsStore.load();
        var blocks = rb.blocksOfSeason(c.season);
        var want = names.map(function (nm) { var i = blocks.findIndex(function (b) { return b.name === nm; }); if (i < 0) throw new Error('ブロック「' + nm + '」がありません'); return i; });
        var first = opts.first != null ? opts.first : Math.min.apply(null, want);
        var last = Math.max.apply(null, want);
        var hpOf = typeof _obHpOf === 'function' ? _obHpOf : function () { return 0; };
        var board = { season: snapshot.season, bosses: snapshot.bosses, players: snapshot.players };
        var plans = {};
        var planOf = function (idx) { return plans[idx] || null; };
        // 前のブロックを組んだとおりに進めた盤面で、次のブロックを組む (画面の「残りを自動で組む」を順に押したのと同じ)
        for (var k = first; k <= last; k++) {
            if (want.indexOf(k) < 0) continue;
            var ov0 = bb.overview({ board: board, blocks: blocks, first: first, planOf: planOf, hpOf: hpOf });
            var o = ov0[k];
            if (!o || !o.startBoard) break;
            var blk = blocks[k];
            plans[k] = computeOptimalPlan({ onlyAvailableNow: true, availableAtSlots: blk.slots, availableAtLabel: blk.label, blockStartSlot: _hourKey(blk.from), previousPlan: null, reservations: [] }, o.startBoard);
        }
        var ov = bb.overview({ board: board, blocks: blocks, first: first, planOf: planOf, hpOf: hpOf });
        var pubs = await window.supabaseGetPublishedPlans();
        var prev = dp.latestDecided((pubs || []).filter(function (r) { return eq(r.season_id, c.season.id); }));
        var plan = dp.build({ blocks: blocks, ov: ov, newIdxs: want, prevPlan: prev ? prev.plan : null, bosses: snapshot.bosses, at: new Date().toISOString(), hpOf: hpOf });
        plan.seasonId = c.season.id;
        var schema = (typeof window._planSchemaOf === 'function') ? window._planSchemaOf(plan) : (typeof PLAN_SCHEMA !== 'undefined' ? PLAN_SCHEMA : null);
        var pub = await window.supabasePublishDecidedPlan(plan, P.ops.id, P.ops.name, c.season.id, schema, prev ? prev.id : 0);
        if (opts.notify && typeof window._obNotifyDecide === 'function') {
            await window._obNotifyDecide({ pub: pub, plan: plan, prev: prev, seasonId: c.season.id, me: P.ops, blocks: blocks }).catch(function (e) { console.warn('[練習] 決定の通知の見本を出せませんでした:', e && e.message || e); });
        }
        return { pub: pub, plan: plan, blocks: blocks };
    }
    /** (メンバー編) 当日の 20 時にして、運営役が「夕方・夜」を決定する (通知の見本も)。読み込み直しはしない (呼ぶ側が決める)。
     *   本番の決定は いまのブロック (20 時 = 夕方) から続くところまで — 夜だけの決定は画面からは作れない (S5 レビュー PR-4) */
    async function decideNight() {
        P.clock.set('hard', 20);
        await opsDecide(['夕方', '夜'], { notify: true });
    }
    /** 決定の凸のうち、その人の凸 (ブロックの鍵つき) */
    function myDecidedAttack(c) {
        var dp = window.decidePlanDomain, plan = c.pub && c.pub.plan;
        if (!dp || !plan || !plan.decided) return null;
        return dp.flat(plan).filter(function (a) { return eq(a.memberId, c.me); })[0] || null;
    }
    var ASSUME = {
        // (メンバー編) 当日の夜の前に、運営が「夕方・夜」を決定した — 本物のソルバー (🧱 ブロックの人・本人の凸数の上限) と決定の関数で
        nightDecide: async function () {
            await decideNight();
            note('assume', '当日の 20 時になり、運営が「夕方・夜」を決定した、と仮定しました', '本番では運営が見通しのつくブロックまで決定します。📅 レイド予定表で確かめます');
            saveFeed();
            if (typeof P.save === 'function') P.save();   // ★ 読み込み直す前に、いま入れた決定を待たずに控える
            location.reload();
            await new Promise(function () { /* 読み込み直しを待つ */ });
        },
        // (メンバー編) 前日に Discord へ『夜に 2 凸』と書いた → 運営が PAD に登録した (🗣 9a・本物の関数で・運営の名前で代理の印)
        opsAvail: async function () {
            var c = context();
            var slots = c.T.availability.filter(function (a) { return eq(a.player_id, c.me); }).map(function (a) { return a.time_slot; });
            await window.supabaseSaveAvailability(c.me, slots, { actorName: P.ops.name });
            await window.supabaseConfirmAvailability(c.season.id, c.me, { slotCount: slots.length, slots: slots, blockCounts: { '21-0': 2 }, actorName: P.ops.name });
            note('assume', '運営が Discord の報告『夜に 2 凸』を PAD に登録した、と仮定しました', '本番では運営が 👥 メンバー状況の ⏰ から登録します。ホームの ⏰ に出ます');
        },
        // (メンバー編) 凸をして Discord にスクショを貼った → 運営が ✓ 凸の記録 で ✓ を付けた (本物の関数・ダメージ 0・HP は動かさない)
        opsTap: async function () {
            var c = context();
            var a = myDecidedAttack(c);
            if (!a) { store.set('member:noAssign', '1'); note('assume', '決定にあなたの凸がありませんでした', 'この練習ではここまでです'); return; }
            var boss = c.T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && eq(b.boss_number, a.bossNumber); })[0];
            P.clock.set('hard', 21);
            await window.supabaseMarkAttackDone({ seasonId: c.season.id, playerId: c.me, attackDate: c.season.hard_date, bossNumber: a.bossNumber, bossCode: boss ? boss.boss_code : null,
                level: a.level, characters: a.team || [], plannedDamageRaw: (Number(a.dmgB) || 0) * 1e9, planKey: window.decidePlanDomain.planKey(a), reservationId: a.reservationId == null ? null : a.reservationId }, { byOps: true, actorName: P.ops.name });
            note('assume', '21 時に凸をして Discord にスクショを貼り、運営が ✓ を付けた、と仮定しました', '本番では運営が Discord を見て ✓ 凸の記録 で付けます。ホームの「きょうの凸」と 📅 レイド予定表 に ✓ が出ます');
        },
    };
    /**
     * 決定のうち hour 時より前に終わるブロックの凸を、ほかのメンバーが凸して運営が ✓ を付けたことにする (✓ = mark_attack_done の ops_tap)。
     * ゲームのボスの HP も減らす (運営はまだ 🎯 で合わせていない — B1 は keepRatio で多めに残す)。ボスは倒し切らない。最後の 1 凸は ✓ を付けずに残す (✓ 凸の記録 の練習)
     */
    function advanceWorld(c, plan, hour, keepRatio) {
        var dp = window.decidePlanDomain, rb = window.raidBlocksDomain;
        if (!dp || !rb || !plan || !plan.decided) return;
        var order = ['h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19', 'h20', 'h21', 'h22', 'h23', 'h00', 'h01', 'h02', 'h03', 'h04'];
        var limit = order.indexOf('h' + String(hour).padStart(2, '0'));
        var endOf = {};
        rb.blocksOfSeason(c.season).forEach(function (b) { endOf[dp.keyOf(b)] = b.toIdx; });
        var list = dp.flat(plan).filter(function (a) { return a.block != null && endOf[a.block] != null && endOf[a.block] < limit && !eq(a.memberId, c.me); });
        list.forEach(function (a, i) {
            if (i === list.length - 1) return;   // 1 つは ✓ を付けずに残す (Discord に報告が来たのに、まだ ✓ が付いていない凸)
            var boss = c.T.bosses.filter(function (x) { return eq(x.season_id, c.season.id) && eq(x.boss_number, a.bossNumber); })[0];
            if (!boss) return;
            try {
                P.db.rpc('mark_attack_done', { p_season_id: c.season.id, p_player_id: a.memberId, p_attack_date: c.season.hard_date, p_boss_number: a.bossNumber, p_boss_code: boss.boss_code,
                    p_level: a.level || 1, p_characters: a.team || [], p_planned_damage_raw: Math.round((Number(a.dmgB) || 0) * 1e9), p_plan_key: dp.planKey(a), p_source: 'ops_tap', p_actor: 'practice' });
            } catch (_) { return; /* 3凸済みなどは飛ばす */ }
            // ゲームの HP (運営は 🎯 で合わせる): 倒し切らない量だけ減らす
            var ratio = (keepRatio && keepRatio[a.bossNumber] != null) ? keepRatio[a.bossNumber] : 0.12;
            var keep = Number(boss.total_hp_raw) * ratio;
            var dmg = Math.round((Number(a.dmgB) || 0) * 1e9);
            if (dmg > 0 && Number(boss.remaining_hp_raw) - dmg >= keep) P.db.tx(function () { boss.remaining_hp_raw = Number(boss.remaining_hp_raw) - dmg; });
        });
    }
    /** ▶︎ 模擬ダメージ表で、模擬がまだの人 (種データの 4 人のうち朝に出られるコトラ) の「＋」 */
    function mockTarget(c) {
        var who = c.T.players.filter(function (p) { return p.name === 'コトラ'; })[0];
        return who || null;
    }
    // ---------- 編 (シナリオ) と課題 ----------
    // ★ S5 (2026-10-27) 作り直し: メンバーは Discord で伝える → 📅 レイド予定表で確かめる → 凸したら Discord へ (PAD に入力しない)、
    //   運営・前日は 📸 模擬の登録 → 🧱 朝を組む (📌 → 残りを自動で) → 午前も組む → ✅ 決定、
    //   運営・当日 (17 時) は 🎯 HP → ✓ 凸の記録 → 🧱 夕方を組み直す → ✅ 決定し直す → 締め凸検索 を本物の画面で動かす。
    // ★ id は js/practice/boot.js の SCENARIOS と同じ一覧 (テストが突き合わせる)。役と開始時刻は boot.js が決める
    var obIdx = function () { return (typeof _ob !== 'undefined' && _ob) ? _ob.idx : null; };
    var obBuilt = function (i) { return typeof _ob !== 'undefined' && _ob && _ob.plans && _ob.plans.has(i) && !_ob.stale.has(i); };
    /** 決定の行に、その名前のブロックが入っているか */
    var decidedHas = function (c, name) { return !!(c && c.pub && c.pub.plan && c.pub.plan.decided && c.pub.plan.decided.blocks.some(function (b) { return b && b.name === name; })); };
    // 「済んだ」を端末の印 (store) で決める課題の印。「↩ 1つ前に戻る」の控えに入れて一緒に戻す (控えに入れないと、戻っても課題が戻らなかった: S5 レビュー PR-1)
    var MARKS = ['ops-eve:morning', 'ops-eve:more', 'ops-day:rebuilt', 'ops-day:copied', 'member:noAssign'];
    /** 組む画面で「そのブロックを開く」→「(📌 を置く)」→「🧮 残りを自動で組む」の案内 (印は store に残す: 自動の結果はこの端末のメモリだけ) */
    function buildGuide(c, idx, name, flagKey, withPin) {
        if (obBuilt(idx) && (!withPin || pinnedIn(c, idx))) { try { store.set(flagKey, '1'); } catch (_) { /* noop */ } }
        if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
        if (opsTab('build')) return stray(c, []) || opsTab('build');
        if (obIdx() !== idx) return stray(c, []) || { text: '「' + name + '」のブロックのボタンを押します。ボタンの中に、そのブロックの Lv・置いた凸の数・ボスの HP の帯が出ます。', target: q('#opsBuild [data-ob-blk="' + idx + '"]') };
        if (withPin && !pinnedIn(c, idx)) {
            var sel = typeof _ob !== 'undefined' && _ob ? _ob.sel : null;
            var rigid = q('#opsBuild .obt:not(.off) .rigid');   // 🔒 この時間だけ出られる人を先に
            if (!sel) return stray(c, []) || { text: '下に「この時間帯に出られる人の模擬」のピースが並んでいます。🔒 (この時間だけ出られる人) を先に置きます。ピースを 1 つ押します。',
                real: 'Discord で『朝に このボスへ行きたい』と希望が来たら、その人をここで先に置きます (予約の代わり)。', target: rigid ? rigid.closest('.obt') : pick('obPiece') };
            return stray(c, []) || { text: '置けるボスの行 (枠が付いた行) の見出しを押します。📌 として置かれ、幅 = ダメージぶんボスの残り HP が減ります。', target: pick('obRow') };
        }
        return stray(c, []) || { text: '「🧮 残りを自動で組む」を押します。手で置いた 📌 は動かさず、残りの凸を本物のソルバーが組みます。',
            real: '組んだ結果はこの端末だけにあります (決定するまでメンバーには見えません)。', target: pick('obAuto') };
    }
    function pinnedIn(c, idx) {
        var rb = window.raidBlocksDomain, blk = rb ? rb.blocksOfSeason(c.season)[idx] : null;
        return !!blk && c.allResv.some(function (r) { return r.status === 'pinned' && r.time_mode === 'block' && eq(r.block_from, blk.from) && eq(r.block_to, blk.to); });
    }
    var STEPS = {
        member: [
            { key: 'discord', title: '出られるブロックと凸数を Discord で伝える',
                // 🗣 運用の見直し (2026-10-24 Q1): メンバーは PAD に入力しない。前日に Discord へ報告し、運営が PAD に登録する → 済んだ形 = 本人の確認の行に凸数が入っている
                done: function (c) { return c.mine('availability_confirmations').some(function (r) { return r.block_counts && Object.keys(r.block_counts).length > 0; }); },
                guide: function (c) {
                    return stray(c, []) || (c.tab !== 'mypage' ? nav('navHome', 'ホーム')
                        : { text: '前日: 出られるブロック (と凸数・凸先の希望) を Discord で運営に伝えます。あなたは 19 時から出られるので『夜に 2 凸』と書きます。PAD には何も入れません。',
                            real: '運営が PAD に登録すると、ホームの「⏰ ユニオンレイド参加可能時間」に出ます。違っていたら Discord で運営へ (PAD で直す操作はありません)。',
                            assume: ['opsAvail', '⏩ 運営が『夜に 2 凸』を登録したことにする'] });
                } },
            { key: 'schedule', title: '📅 レイド予定表で「いつ・どのボスに・誰と」を確かめる',
                // S5: 決定の行があり、それを ✅ 確認した (レイド予定表の ✅ = ホームの ✅ と同じ記録)
                done: function (c) { return !!(c.pub && c.pub.plan && c.pub.plan.decided) && c.mine('plan_acks').some(function (a) { return eq(a.plan_id, c.pub.id); }); },
                guide: function (c) {
                    if (!(c.pub && c.pub.plan && c.pub.plan.decided)) {
                        return stray(c, []) || { text: '模擬は Discord にスクショを貼るだけです (運営が登録します)。あとは運営の決定を待ちます。決まると通知が届き、📅 レイド予定表 に出ます。',
                            real: '運営はブロックごとに、出られる人の模擬で凸を組み、見通しのつくブロックまで決定します。',
                            assume: ['nightDecide', '⏩ 当日の夜の前に、運営が「夕方・夜」を決定したことにする'] };
                    }
                    if (c.tab !== 'raid') return stray(c, []) || nav('navRaid', 'レイド予定表');
                    var ack = pick('planAck');
                    if (!ack) return stray(c, []) || { text: 'レイド予定表を読み込んでいます…' };
                    return stray(c, []) || { text: '「ブロックごとの凸 (盤)」のブロックのボタン (夜) を押すと、ボスごとに誰が行くかが出ます (帯の幅 = ダメージ・下に名前の札・★ と太い枠があなた)。下の「みんなの模擬」で、ほかの人の編成とダメージも見られます。読んだら「✅ 確認しました」を押します。',
                        real: '運営が組み直して決定し直すと、変わった人だけに通知が届きます。✅ はそのときの文の出し分けに使います。', target: ack };
                } },
            { key: 'report', title: '凸したら Discord へ',
                done: function (c) { return c.mine('attacks').some(function (a) { return a.source === 'ops_tap'; }) || store.get('member:noAssign') === '1'; },
                guide: function (c) {
                    return stray(c, []) || { text: 'ブロックの時間になったらゲームで凸をして、結果の画面のスクショを Discord へ貼ります。PAD には何も入れません (✓ も押しません)。',
                        real: '運営が Discord を見て、PAD の ✓ 凸の記録 で ✓ を付けます。付くとホームの「きょうの凸」と 📅 レイド予定表 に ✓ が出ます。',
                        assume: ['opsTap', '⏩ 凸をして、運営が ✓ を付けたことにする'] };
                } },
        ],
        'ops-eve': [
            { key: 'mock', title: '📸 Discord の模擬を登録する (手で入力)',
                // S5: 模擬がまだのコトラ (朝に出られる) の模擬を、▶︎ 模擬ダメージ表の「＋」から手で入れる → player_damages に行が入れば済み
                done: function (c) { var who = mockTarget(c); return !!who && c.T.player_damages.some(function (d) { return eq(d.player_id, who.id) && Number(d.damage_b) > 0; }); },
                guide: function (c) {
                    var who = mockTarget(c);
                    if (!who) return { text: '模擬の相手が見つかりません。この課題は飛ばします。' };
                    // 案内どおりキャラの枠を押すとアイコンのシートが上に開く — 「閉じます」と止めない (S5 レビュー PR-5)
                    if (c.modalId === 'iconPickerModal') return { text: 'キャラを選びます (分からなければ閉じても保存できます)。' };
                    if (c.modalId === 'myDmgPreviewModal') {
                        var inp = pick('mockDmg');
                        if (inp && !(Number(inp.value) > 0)) return { text: 'Discord に貼られた模擬のスクショのダメージを入れます (例: 31.2)。キャラは分かれば選びます (無くても保存できます)。', target: inp };
                        return { text: '「保存」を押します。▶︎ 模擬ダメージ表のコトラさんの行に入り、組む画面のピースになります。', target: pick('mockSave') };
                    }
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('members')) return stray(c, []) || opsTab('members');
                    return stray(c, []) || { text: '前日、メンバーは模擬のスクショを Discord に貼ります。運営が PAD に登録します。▶︎ 模擬ダメージ表で、まだ模擬の無いコトラさんの行の「＋」を押します。',
                        real: '本番はスクショを「📷 スクショを選ぶ」で読み取れます (PC はカードに落とすだけ)。読めないときに手で入れます。', target: q('#opsMockIntakeBody .mk-plus[onclick^="_opsMockManual(' + Number(who.id) + ',"]') };
                } },
            { key: 'buildMorning', title: '🧱 朝を組む (📌 を 1 つ置く → 残りを自動で)',
                // 組んだ結果はこの端末のメモリだけ — 読み込み直して消えたら、決定するまでは組み直す (印だけで済ませると、押せない「✅ 決定」に進んでいた: S5 レビュー PR-1)
                done: function (c) { return store.get('ops-eve:morning') === '1' && (decidedHas(c, '朝') || obBuilt(0)); },
                guide: function (c) { return buildGuide(c, 0, '朝', 'ops-eve:morning', true); } },
            { key: 'buildMore', title: '🧱 午前も組む',
                done: function (c) { return store.get('ops-eve:more') === '1' && (decidedHas(c, '午前') || obBuilt(1)); },
                guide: function (c) { return buildGuide(c, 1, '午前', 'ops-eve:more', false); } },
            { key: 'decide', title: '✅ 朝〜午前を決定してメンバーに配信する',
                done: function (c) { return !!(c.pub && c.pub.plan && c.pub.plan.decided && c.pub.plan.decided.blocks.some(function (b) { return b.name === '朝'; })); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    var btn = pick('obDecide');
                    if (!btn) return stray(c, []) || buildGuide(c, 0, '朝', 'ops-eve:morning', false);
                    return stray(c, []) || { text: '組めたブロックの下にある決定のボタン (' + (btn.textContent || '').trim() + ') を押します。確認が出たら OK。',   // 名前はボタンから (朝だけのときもずれない: S5 レビュー PR-6)
                        real: '決定すると、メンバーの 📅 レイド予定表 に出て、割当のある人に「あなたの凸が決まりました」の通知が届きます。先のブロックは見通しがついたら組んで、決定し直します。', target: btn };
                } },
        ],
        'ops-day': [
            { key: 'hp', title: '🎯 ゲームの画面を見てボスの残HPを合わせる',
                done: function (c) { var at = store.get('ops-day:setupAt') || ''; return c.T.bosses.some(function (b) { return eq(b.season_id, c.season.id) && eq(b.boss_number, 1) && String(b.updated_at || '') > at; }); },
                guide: function (c) {
                    if (c.modalId === 'opsBossHpModal') {
                        var inp = pick('bossHpInput');
                        if (!inp) return { text: 'ボスの一覧を読み込んでいます…' };
                        if (Math.abs(Number(inp.value) - 40) > 0.001) return { text: 'BlaBlaLINK の画像では B1 の残りが 40B でした (練習の設定)。B1 の「残HP」を 40 にします。', target: inp };
                        return { text: 'B1 の「保存」を押します。', real: '残HPが 0 になる保存は撃破として検知されます (通知が飛びます)。数字を確かめてから押します。', target: pick('bossHpSave') };
                    }
                    var b1 = c.T.bosses.filter(function (b) { return eq(b.season_id, c.season.id) && eq(b.boss_number, 1); })[0];
                    return stray(c, []) || (c.tab !== 'ops' ? nav('navOps', '運営')
                        : { text: '夕方 (17〜20時) のブロックの頭です。まずボスの残HPを BlaBlaLINK の画像と合わせます。PAD の B1 は ' + (b1 ? (Number(b1.remaining_hp_raw) / 1e9).toFixed(1) : '?') + 'B のままです。先頭の「🎯 ボス HP を更新する」を押します。',
                            real: '✓ にはダメージが入らないので、PAD の残HPは 30 分〜1 時間おきに画像で合わせます。古い HP で組むと、無駄凸や取りこぼしが出ます。', target: pick('bossHpOpen') });
                } },
            { key: 'tap', title: '✓ Discord の報告を見て ✓ を付ける',
                done: function (c) { var at = store.get('ops-day:setupAt') || ''; return c.T.attacks.some(function (a) { return a.source === 'ops_tap' && String(a.reported_at || '') > at; }); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('battle')) return stray(c, []) || opsTab('battle');
                    var btn = pick('tapDone');
                    if (!btn) return stray(c, []) || { text: '「✓ 凸の記録」を読み込んでいます…' };
                    return stray(c, []) || { text: 'Discord に、まだ ✓ の無い人の結果のスクショが貼られた、とします。「✓ 凸の記録」の盤で その人の名前の札を押すと ✓ が付きます (札が塗りになる・数字は入れません)。',
                        real: '✓ を付けると、その人の残り凸と使ったキャラが減り、次のブロックを組むときに正しくなります。押し間違えたら、塗りの札をもう一度押して取り消し。', target: btn };
                } },
            { key: 'rebuild', title: '🧱 夕方 (いまのブロック) を組み直す',
                // 印に加えて「いま組んだ結果がある」か「もう決定し直した」(読み込み直して消えたら組み直す: S5 レビュー PR-1)
                done: function (c) {
                    var at = store.get('ops-day:setupAt') || '';
                    return store.get('ops-day:rebuilt') === '1' && (!!(c && c.pub && c.pub.plan && c.pub.plan.decided && String(c.pub.plan.decided.at || '') > at)
                        || (typeof _ob !== 'undefined' && _ob && _ob.plans && _ob.plans.has(3) && _ob.plans.get(3).fromDecided == null && !_ob.stale.has(3)));
                },
                guide: function (c) {
                    // 決定から読み戻した結果 (fromDecided) ではなく、いま組んだ結果がある = 組み直した
                    if (typeof _ob !== 'undefined' && _ob && _ob.plans && _ob.plans.has(3) && _ob.plans.get(3).fromDecided == null && !_ob.stale.has(3)) { try { store.set('ops-day:rebuilt', '1'); } catch (_) { /* noop */ } }
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    if (obIdx() !== 3) return stray(c, []) || { text: '「夕方」のブロックのボタンを押します。', target: q('#opsBuild [data-ob-blk="3"]') };
                    return stray(c, []) || { text: '夕方は前の決定のままです。いまの HP と ✓ (済んだ凸) から組み直します。「🧮 残りを自動で組む」を押します。',
                        real: 'ゲームの進み方が模擬とずれたら、いまのブロックから組み直して決定し直します。変わった人だけに通知が届きます。', target: pick('obAuto') };
                } },
            { key: 'decide', title: '✅ 決定し直す',
                done: function (c) { var at = store.get('ops-day:setupAt') || ''; return !!(c.pub && c.pub.plan && c.pub.plan.decided && String(c.pub.plan.decided.at || '') > at); },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('build')) return stray(c, []) || opsTab('build');
                    var btn = pick('obDecide');
                    if (!btn) return stray(c, []) || { text: 'まず夕方を組み直します。', target: pick('obAuto') };
                    return stray(c, []) || { text: '決定のボタン (' + (btn.textContent || '').trim() + ') を押します。確認が出たら OK。',
                        real: '過ぎたブロックと組み直していないブロックは前の決定のまま残ります。夕方の割当が変わった人だけに通知が届きます。配信したら Discord の運営スレに 1 行残すと、交代した運営が迷いません。', target: btn };
                } },
            { key: 'finish', title: '⚔️ 締め凸検索で候補を探して声をかける',
                done: function () { return store.get('ops-day:copied') === '1'; },
                guide: function (c) {
                    if (c.tab !== 'ops') return stray(c, []) || nav('navOps', '運営');
                    if (opsTab('battle')) return stray(c, []) || opsTab('battle');
                    var copy = pick('finishCopy');
                    if (!copy) return stray(c, []) || { text: '残りが少ないボスは締め凸 (とどめ) の相手を探します。「ボス状況」の B1 のカードで「締め凸検索」を押します。', target: pick('finishPick') };
                    return stray(c, []) || { text: '候補とプランが出ました。「いま打つか、待つか」を読んでから、プランの「📋 名前と文面をコピー」を押します。',
                        real: 'PAD からは頼みません。コピーした文面を Discord に貼って声をかけます。', target: copy };
                } },
        ],
    };
    var SCENARIOS = {
        'member': { title: 'メンバー編', sub: 'Discord で出られるブロックを伝える → 📅 レイド予定表で確かめる → 凸したら Discord へ', next: 'ops-eve',
            diff: '練習では運営の登録・決定・✓ を「〜したことにする」で進めました。本番では前日に Discord へ報告し、運営が PAD に登録して決定し、凸のスクショを見て ✓ を付けます。PAD で入力する操作はありません。' },
        'ops-eve': { title: '運営編・前日', sub: '📸 模擬を登録 → 🧱 朝を組む (📌 → 残りを自動で) → 午前も組む → ✅ 決定', next: 'ops-day',
            diff: '練習では 1 人ぶんの模擬だけ手で入れました。本番では前日に Discord に貼られたスクショを人ごとに登録し (📷 で読み取り)、見通しのつくブロックまで組んで決定します。決定は押した瞬間に割当のある人へ通知が届きます。' },
        'ops-day': { title: '運営編・当日', sub: '夕方のブロックの頭: 🎯 HP → ✓ 凸の記録 → 🧱 夕方を組み直す → ✅ 決定し直す → 締め凸検索', next: 'member',
            diff: '本番ではこの手順をブロックごとに繰り返します。HP は 30 分〜1 時間おきに BlaBlaLINK の画像で合わせます。交代するときは、運営タブのタブの数字と「いちばん急ぐこと」から続けます。' },
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
        discord: async function (c) {
            var slots = c.T.availability.filter(function (a) { return eq(a.player_id, c.me); }).map(function (a) { return a.time_slot; });
            await window.supabaseConfirmAvailability(c.season.id, c.me, { slotCount: slots.length, slots: slots, blockCounts: { '21-0': 2 }, actorName: P.ops.name });   // 🗣 9a: 運営が代理で登録した形
        },
        schedule: async function (c) { await decideNight(); var pub = context().pub; if (pub) await window.supabaseAckPlan(c.me, c.season.id, pub.id); },
    };
    // ---------- 編の開始状態 (一回きり。種データだけでは足りない編は、本物の関数で盤面を作ってから始める) ----------
    var SETUP = {
        // 運営編・当日 (17 時 = 夕方のブロックの頭): 朝〜夕方を決定済み (前日に運営が決めた形)・17 時までの凸は運営が ✓ を付けた (最後の 1 つだけ ✓ がまだ)・
        // ゲームの HP はそのぶん減っているが、B1 だけ多めに残す。HP の更新は 2 時間前 (運営タブの先頭に「HP 更新が古い」が出る = 最初の課題)
        'ops-day': async function (c) {
            // 決定は前日 20 時の時計で (ソルバーの「いま」は 時計 と ブロックの頭 の遅いほう — 当日 17 時のままだと朝〜午後に凸を置けない)。そのあと 17 時に戻す
            // ★ 戻す先は控えた値ではなく編の開始時刻 (boot.js の SCENARIOS と同じ当日 17 時)。盤面作りの途中で読み込み直すと、
            //   置き場に前日 20 時が残り、それを控えて戻していた = 前日の段階で当日の練習が始まって進めなかった (S5 レビュー PR-2)
            var res;
            P.clock.set('eve', 20);
            try { res = await opsDecide(['朝', '午前', '午後', '夕方'], { first: 0 }); } finally { P.clock.set('hard', 17); }
            advanceWorld(context(), res.plan, 17, { 1: 0.45 });
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
            try { P.db.restore(snap); if (SC === 'ops-day') P.clock.set('hard', 17); else P.clock.put(clockWas); } catch (_) { /* noop */ }   // 当日は控えが前日 20 時のことがある (S5 レビュー PR-2)
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
        var marks = {};
        MARKS.forEach(function (k) { var v = store.get(k); if (v != null) marks[k] = v; });
        try { store.set('snap:' + i, JSON.stringify({ db: P.db.dump(), clock: P.clock.get(), feed: feed, marks: marks })); }
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
        // 課題の印も控えた時点に戻す (控えに無い印は消す・S5 レビュー PR-1)
        var marks = snap.marks && typeof snap.marks === 'object' ? snap.marks : {};
        MARKS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(marks, k)) store.set(k, marks[k]); else store.del(k); });
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
            render('<div class="pm-band"><span class="t">🎮 当日の盤面を作っています… (朝〜夕方の決定と 17 時までの凸)</span></div>', 'setup'); target = null; return;
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
