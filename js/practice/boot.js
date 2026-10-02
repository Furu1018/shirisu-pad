// ============================================================================
// 練習モードの起動 (本番では読み込まれない)
// ============================================================================
// index.html の <head> 先頭の小さなスクリプトが、練習の印 (sessionStorage) があるときだけこのファイルを読む。
// ほかのどのスクリプトより先に、3 つを差し替える:
//   ① 端末の記憶 (localStorage) → 練習用の別の置き場へ。本番の「名乗り」や設定を 1 つも書き換えない
//   ② 時計 (Date) → 練習の時計。「前日 20 時」「当日 21 時」を自分で進められる
//   ③ 通信 → js/supabase-client.js が window.PAD_PRACTICE を見て偽のサーバ (js/practice/server.js) を使う
// 練習の印は sessionStorage なので、タブ (アプリ) を閉じれば自動で本番に戻る。
// ============================================================================
(function () {
    'use strict';
    var KEY = 'shirisuko_practice_v1';
    var SS = window.sessionStorage, LS = window.localStorage;
    var proto = Storage.prototype;
    var rawGet = proto.getItem, rawSet = proto.setItem, rawDel = proto.removeItem;
    var role = null;
    try { role = rawGet.call(SS, KEY); } catch (_) { role = null; }
    if (role !== 'member' && role !== 'ops') return;

    // 練習の層だけが使う置き場 (差し替えの影響を受けない)
    var store = {
        get: function (k) { try { return rawGet.call(SS, KEY + ':' + k); } catch (_) { return null; } },
        set: function (k, v) { rawSet.call(SS, KEY + ':' + k, String(v)); },
        del: function (k) { try { rawDel.call(SS, KEY + ':' + k); } catch (_) { /* noop */ } },
    };

    // ---- ① 端末の記憶を分ける ----
    var NS = 'pm::';
    var PASS = { 'shirisuko_theme_v1': true };   // 見た目 (ライト/ダーク) だけは本番と共有する
    proto.getItem = function (k) { return (this === LS && !PASS[k]) ? rawGet.call(SS, NS + k) : rawGet.call(this, k); };
    proto.setItem = function (k, v) { return (this === LS && !PASS[k]) ? rawSet.call(SS, NS + k, v) : rawSet.call(this, k, v); };
    proto.removeItem = function (k) { return (this === LS && !PASS[k]) ? rawDel.call(SS, NS + k) : rawDel.call(this, k); };

    // ---- ② 練習の時計 ----
    var RealDate = Date;
    var DAY = 86400000, JST = 9 * 3600000;
    var ymdJst = function (ms) { return new RealDate(ms + JST).toISOString().slice(0, 10); };
    // 練習のレイド日 = 始めた日の翌日 (前日から体験する)。再読み込みしても変えない
    var hardDate = store.get('hard');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hardDate || '')) { hardDate = ymdJst(RealDate.now() + DAY); store.set('hard', hardDate); }
    var atJst = function (ymd, hour) { return RealDate.parse(ymd + 'T' + String(hour).padStart(2, '0') + ':00:00+09:00'); };
    var offset = Number(store.get('clock'));
    if (!isFinite(offset) || store.get('clock') == null) {
        offset = atJst(ymdJst(atJst(hardDate, 12) - DAY), 20) - RealDate.now();   // はじめは 前日の 20 時
        store.set('clock', offset);
    }
    // 引数なしの new Date() と Date.now() だけが練習の時計を読む。日時を指定した new Date(...) は本物と同じ
    class PracticeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
        static now() { return RealDate.now() + offset; }
    }
    window.Date = PracticeDate;

    // ---- 名乗り・初回だけ出るもの ----
    var ME = { id: 9101, name: 'あなた (練習)' };       // js/practice/seed.js の IDS.me / ME_NAME と同じ (テストが突き合わせる)
    var OPS = { id: 9102, name: '運営役 (練習)' };
    if (proto.getItem.call(LS, 'shirisuPad.currentPlayer') == null) {
        proto.setItem.call(LS, 'shirisuPad.currentPlayer', JSON.stringify(role === 'ops' ? OPS : ME));
        proto.setItem.call(LS, 'shirisuPad.tourCompleted', '1');   // 使い方ツアーは自動で始めない
    }

    window.PAD_PRACTICE = {
        role: role, hardDate: hardDate, store: store, db: null, me: ME, ops: OPS, closed: false,
        clock: {
            now: function () { return RealDate.now() + offset; },
            /** 練習の時計を「その日の hour 時 (日本時間)」に合わせる。day: 'eve' = 前日 / 'hard' = 当日 */
            set: function (day, hour) {
                var ymd = day === 'eve' ? ymdJst(atJst(hardDate, 12) - DAY) : hardDate;
                offset = atJst(ymd, hour) - RealDate.now();
                store.set('clock', offset);
            },
            RealDate: RealDate,
        },
        /** 練習をやめて本番へ戻る (練習の記憶をすべて捨てて読み込み直す) */
        exit: function () {
            this.closed = true;   // このあと画面を離れるときに、途中経過を書き戻させない (js/practice/session.js の save)
            try {
                var gone = [];
                for (var i = 0; i < SS.length; i++) { var k = SS.key(i); if (k && (k === KEY || k.indexOf(KEY + ':') === 0 || k.indexOf(NS) === 0)) gone.push(k); }
                gone.forEach(function (k) { rawDel.call(SS, k); });
            } catch (_) { try { rawDel.call(SS, KEY); } catch (__) { /* noop */ } }
            var u = new URL(location.href); u.searchParams.delete('practice');
            location.replace(u.pathname + (u.search || '') + (u.hash || ''));
        },
        /** 練習を最初からやり直す (役を変えるときもこれ) */
        restart: function (nextRole) {
            this.closed = true;
            try {
                var gone = [];
                for (var i = 0; i < SS.length; i++) { var k = SS.key(i); if (k && (k.indexOf(KEY + ':') === 0 || k.indexOf(NS) === 0)) gone.push(k); }
                gone.forEach(function (k) { rawDel.call(SS, k); });
                rawSet.call(SS, KEY, nextRole === 'ops' ? 'ops' : nextRole === 'member' ? 'member' : role);
            } catch (_) { /* noop */ }
            location.reload();
        },
    };
    document.documentElement.setAttribute('data-practice', role);
    // 練習の案内 (帯・課題カード) は画面ができてから動く
    document.write('<script defer src="./js/practice/guide.js"><\/script>');
})();
