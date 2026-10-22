// ============================================================================
// ドメイン: 戦況タブのカード構成 (折りたたみ + コックピット) — 運営改修 2026-09-01
// ----------------------------------------------------------------------------
// 戦況タブが縦に長く「管理が大変」になったため、カード単位で折りたたみ、前日/当日で既定の
// 開閉を変え、手動の開閉は前日/当日ごとに記憶する (Codex と議論した B 案 + 2×2 コックピット)。
// 畳んだカードの見出しには1行サマリー、最上部には「HP更新 / 残凸 / 未完 / 締め凸未返答」を出す。
//
// ここは純ロジックだけ: カード定義・開閉の解決・サマリー文字列・コックピット値。DOM は index.html。
// 「どのカードを既定で開くか」を変えるときはここの CARDS だけを直す。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * 戦況タブのカード。id は DOM の id、title はカード内の見出し文字列 (タグ付けに使う)。
     * open = フェーズ別の既定 (always は常時開・折りたたみ不可)。opsOnly = 運営ONのときだけ表示。
     * span = 2列/12カラム (700px〜) での幅。700〜1099px は 12 以外すべて半分。表を持つカードは全幅 (12) でないと読めない。
     * stages = 運営ONで本文に出す段階 (opsStage.js の 準備 prep / 前日 pre / 当日 day / 終了 end)。
     *          段階外は末尾の「その他」へ (消さない)。[] = どの段階でも「その他」。運営OFF (メンバー) は従来どおり全部
     * group = 見出しラベル (いまはどちらのモードでも隠している)
     *
     * ★ 配列の順 = 画面の並び (HTML の順は使わない。index.html の _initOpsTabStructure が並べ直す)。
     *   2列/12カラムでは隣り合うカードの幅の組で行が決まるので、順番そのものが見た目を決める
     *   (7 の次に 12 が来ると改行して 7 は独りになる — 2026-09-11 まで実際そうなっていて全段階が1列だった)。
     *   1本の順で 準備/前日/当日/終了/メンバー のどれを取り出しても各行が 12 に揃うように並べてある:
     *     当日     = 運営アクション12 / ボス7 + 締め凸5 / ペース7 + 直近5 / 残り12 / プラン12
     *     前日     = メンバー状況12 / 予約7 + Discord5 / プラン12
     *     準備     = シーズン制御7 + 一斉通知5
     *     終了     = Discord5 + シーズン制御7 / 育成12
     *     メンバー = ボス7 + オンライン5 / 残り12
     *   崩すとテスト (各行の span 合計 = 12) が落ちる。カードを足すときは相方も決めること。
     */
    const CARDS = [
        // 当日の最上部: コックピットの直下に帯として置く (幅12・常時開)
        { id: 'opsSecActions',   title: '戦闘中の運営アクション', group: '実行',       opsOnly: true,  always: true,                    stages: ['day'], span: 12, tab: null },
        { id: 'opsSecMembers',   title: 'メンバー状況',          group: 'ライブ盤面', opsOnly: true,  open: { pre: true,  day: true },  stages: ['pre'], span: 12, tab: 'members' },
        { id: 'opsSecBoss',      title: 'ボス状況',              group: 'ライブ盤面', opsOnly: false, open: { pre: false, day: true },  stages: ['day'], span: 7, tab: 'battle' },
        { id: 'opsSecFinish',    title: '締め凸候補検索',         group: '判断・配信', opsOnly: true,  open: { pre: false, day: false }, stages: ['day'], span: 5, tab: 'battle' },
        // 段階4 (2026-09-11): 交代して入った運営が 10 秒で状況を読むための2枚。純ロジックは js/domain/pace.js
        { id: 'opsSecPace',      title: '消化のペース',          group: 'ライブ盤面', opsOnly: true,  open: { pre: false, day: true },  stages: ['day'], span: 7, tab: null },
        { id: 'opsSecRecent',    title: '直近の動き',            group: 'ライブ盤面', opsOnly: true,  open: { pre: false, day: true },  stages: ['day'], span: 5, tab: null },
        { id: 'opsSecCoord',     title: 'オンライン / 調整中',   group: 'ライブ盤面', opsOnly: false, open: { pre: false, day: false }, stages: [], span: 5, tab: null },
        { id: 'opsSecRemaining', title: '残り戦闘可能メンバー',   group: 'ライブ盤面', opsOnly: false, open: { pre: false, day: true },  stages: ['day'], span: 12, tab: null },
        // 📥 結果の取り込み (🧱 段階 4・2026-10-23 / 旧 ✅ 凸報告の確認 ③-f): Discord の結果を運営が取り込んで登録・配信と突き合わせて ✓。当日は開く (当日の運営の主作業)、
        //   終了にも出す (BlaBlaLINK との突き合わせ・報告漏れの確認)。幅 12 で単独の行 (当日 = 残り12 の次、終了 = 先頭)
        { id: 'opsSecAttackCheck', title: '結果の取り込み',      group: 'ライブ盤面', opsOnly: true,  open: { pre: false, day: true },  stages: ['day', 'end'], span: 12, tab: 'battle' },
        // 📸 模擬の取り込み (🧱 ブロック制 ③-e・2026-10-18): Discord に貼られたスクショを運営が本人の代わりに登録。準備〜当日 (当日は畳む)。
        //   幅 12 で単独の行 — 前日は メンバー状況12 の次、当日は 残り12 の次、準備は先頭 (各行 12 のまま)
        { id: 'opsSecMockIntake', title: '模擬の取り込み',        group: '判断・配信', opsOnly: true,  open: { pre: true,  day: false }, stages: ['prep', 'pre', 'day'], span: 12, tab: 'members' },
        // 当日は畳む — 承認待ちの件数は見出しの1行サマリーに出るので気づける
        // (当日に開くカードを増やすと縦に長くなり、折りたたみを入れた意味が消える)
        { id: 'opsSecReserve',   title: '凸の予約',              group: '判断・配信', opsOnly: true,  open: { pre: true,  day: false }, stages: ['pre'], span: 12, tab: 'build' },
        // 前日 (告知) と終了 (結果報告) の両方で使う
        { id: 'opsSecDiscord',   title: 'Discord 告知テンプレ',  group: '管理・終了', opsOnly: true,  open: { pre: false, day: false }, stages: ['pre', 'end'], span: 5, tab: null },
        { id: 'opsSecPlan',      title: '最適凸プラン算出',       group: '判断・配信', opsOnly: true,  open: { pre: true,  day: false }, stages: ['pre', 'day'], span: 12, tab: 'build' },
        { id: 'opsSecSeason',    title: 'シーズン制御',          group: '管理・終了', opsOnly: true,  open: { pre: false, day: false }, stages: ['prep', 'end'], span: 12, tab: 'master' },
        // 一斉通知は準備段階の道具に (告知を出す段階。2026-09-11 ユーザー判断)
        { id: 'opsSecPush',      title: '一斉通知',              group: '実行',       opsOnly: true,  open: { pre: false, day: false }, stages: ['prep'], span: 12, tab: 'members' },
        // 使われたキャラが確定するのはレイド後 (終了・2026-09-09)。準備段階にも出す — 新メンバーが入ったとき、その人のぶんを
        // 前のレイドの記録として取り直す (2026-09-15 ユーザー要望。相手は ② の絞り込みで決める)。準備の行は 7+5 / 12
        { id: 'opsSecGrowth',    title: '育成データの取り込み',   group: '管理・終了', opsOnly: true,  open: { pre: false, day: false }, stages: ['prep', 'end'], span: 12, tab: 'master' },
    ];
    const STORAGE_KEY = 'shirisuko_ops_card_open_v2';   // v2 = 段階 2.5 のタブ (開閉の記憶を取り直す: タブの中は既定で開く)

    /**
     * 🧱 段階 2.5 (2026-10-22 ユーザー決定): 運営タブを 3 つ (+ マスター) に分ける。**カードはいつも同じタブ** (日付で動かさない)。
     *   tab = 'members' (👥 人の準備) / 'build' (🧱 次のブロックを組んで配信) / 'battle' (⚔️ 当日ずっと) / 'master' (👑 ふるりだけ・準備と管理) /
     *   null = 画面から外す (コードは残す: 運営アクション・オンライン・残り戦闘可能・直近の動き・Discord 告知・消化のペース — 戦況の見出しの 1 行に畳む)。
     *   日によって変わるのは「開いたときのタブ」(defaultTab) と「いちばん急ぐこと」だけ。モック docs/運営タブ整理モック_2026-10-22.html
     */
    const TABS = [
        { key: 'members', label: '👥 メンバー', sub: '模擬・出られる時間と凸数・通知の準備' },
        { key: 'build',   label: '🧱 組む',     sub: '次のブロックを組んで配信' },
        { key: 'battle',  label: '⚔️ 戦況',     sub: 'ボスの HP・凸の報告・締凸検索' },
        { key: 'master',  label: '👑 マスター', sub: '準備と管理 (マスター運営だけ)', masterOnly: true },
    ];
    const TAB_KEYS = TABS.map(t => t.key);
    const tabOf = (id) => { const c = cardById(id); return c ? (c.tab || null) : null; };
    /** 開いたときのタブ: 当日・終了 = ⚔️ 戦況 / それより前 = 👥 メンバー */
    const defaultTab = (stage) => (stage === 'day' || stage === 'end') ? 'battle' : 'members';
    /**
     * いま出すタブ。記憶 ({ tab, stage }) は**同じ段階のあいだだけ**効く (日が変わったら既定に戻す)。
     * マスターでない人の 'master' と、知らないタブは既定へ
     */
    function resolveTab(stored, stage, isMaster) {
        const t = stored && typeof stored === 'object' ? stored.tab : null;
        const ok = TAB_KEYS.includes(t) && (t !== 'master' || !!isMaster) && stored.stage === stage;
        return ok ? t : defaultTab(stage);
    }
    /**
     * 各タブの名前の横に出す「手を打つべき数」(交代で入った運営がどこから手を付けるかを数字で決める)。未ロードは null (0 と混同させない)
     * @param {{mbRows?: Object[]|null, reservations?: {pending:number, expired?:number}|null, attackCounts?: {total:number, confirmed:number, missing:number}|null}} a
     */
    function tabCounts({ mbRows, reservations, attackCounts } = {}) {
        return {
            members: Array.isArray(mbRows) ? mbRows.filter(r => r && r.todo).length : null,
            build: reservations ? (Number(reservations.pending) || 0) + (Number(reservations.expired) || 0) : null,
            battle: attackCounts ? Math.max(0, (Number(attackCounts.total) || 0) - (Number(attackCounts.confirmed) || 0)) + (Number(attackCounts.missing) || 0) : null,
            master: null,
        };
    }

    const cardById = (id) => CARDS.find(c => c.id === id) || null;

    /**
     * カードを開くべきか。always → 常に true。記憶 (stored[phase][id]) があればそれ、無ければ既定。
     * opsMode=false (メンバー) は常に全開 — 一般メンバーの操作を増やさない
     */
    function resolveOpen(id, phase, stored, opsMode = true, tabbed = false) {
        const c = cardById(id);
        if (!c) return true;
        if (!opsMode || c.always) return true;
        const ph = phase === 'day' ? 'day' : 'pre';
        const v = stored && stored[ph] && typeof stored[ph][id] === 'boolean' ? stored[ph][id] : undefined;
        // 🧱 段階 2.5: タブに分けたので、タブの中のカードは既定で開く (畳むのは運営が自分で畳んだときだけ)
        return v !== undefined ? v : (tabbed ? true : !!(c.open && c.open[ph]));
    }

    /** 記憶を更新した新しいオブジェクトを返す (元は変えない) */
    function withStored(stored, phase, id, open) {
        const ph = phase === 'day' ? 'day' : 'pre';
        const next = { pre: { ...(stored?.pre || {}) }, day: { ...(stored?.day || {}) } };
        next[ph][id] = !!open;
        return next;
    }

    /** localStorage の文字列 → 記憶。壊れていれば空 */
    function parseStored(raw) {
        try {
            const v = JSON.parse(raw || 'null');
            if (!v || typeof v !== 'object') return { pre: {}, day: {} };
            return { pre: (v.pre && typeof v.pre === 'object') ? v.pre : {}, day: (v.day && typeof v.day === 'object') ? v.day : {} };
        } catch { return { pre: {}, day: {} }; }
    }

    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    const MAX_ATTACKS = 3;

    /** HP鮮度: bosses.updated_at の最新から何分前か。無ければ null */
    function hpFreshnessMin(bosses, now) {
        const upds = (Array.isArray(bosses) ? bosses : []).map(b => b && b.updated_at).filter(Boolean).map(t => new Date(t).getTime()).filter(Number.isFinite);
        if (!upds.length) return null;
        const nowMs = typeof now === 'number' ? now : Date.now();
        return Math.max(0, Math.floor((nowMs - Math.max(...upds)) / 60000));
    }
    const fmtAgo = (min) => min == null ? '—' : min < 1 ? 'たった今' : min < 60 ? `${min}分前` : `${Math.floor(min / 60)}時間前`;

    /**
     * 畳んだカードの見出しに出す1行サマリーと、コックピットの値。
     * @param {Object} args
     * @param {Object|null=} args.season  opsStore の season
     * @param {Object[]=} args.bosses
     * @param {Object[]=} args.players   opsStore の players (attackCount)
     * @param {Object[]|null=} args.mbRows  memberStatusDomain.buildRows の結果 (未ロードなら null)
     * @param {Object[]=} args.coordList  {status:'available'|'coordinating'|'off'}[]
     * @param {boolean|null=} args.published  配信中プランがあるか (null = 未取得)
     * @param {boolean=} args.planComputed  算出済みプランがあるか
     * @param {string|null=} args.finishAttr  締め凸検索中の属性キー
     * @param {{pending:number, approved:number}|null=} args.reservations  予約の件数 (未ロード/未適用なら null)
     * @param {Object[]|null=} args.finishRequests  締め凸依頼の行 (現在レベル。未ロードなら null = 何も出さない)
     * @param {number=} args.now
     * @returns {{summaries: Record<string,{text:string,bad:boolean}>, cockpit: {id:string,key:string,label:string,value:string|number,bad:boolean}[]}}
     */
    function summarize({ season, bosses, players, mbRows, coordList, published, planComputed, finishAttr, reservations, finishRequests, now } = {}) {
        const bs = Array.isArray(bosses) ? bosses : [];
        const ps = Array.isArray(players) ? players : [];
        const lvl = season ? Number(season.current_level) || 1 : null;
        const alive = bs.filter(b => (Number(b.remaining_hp_raw) || 0) > 0).length;
        const freshMin = hpFreshnessMin(bs, now);
        const freshWarn = freshMin != null && freshMin >= 30;
        const remainingPlayers = ps.filter(p => (Number(p.attackCount) || 0) < MAX_ATTACKS);
        const remainingTotal = remainingPlayers.reduce((s, p) => s + (MAX_ATTACKS - (Number(p.attackCount) || 0)), 0);
        const online = (Array.isArray(coordList) ? coordList : []).filter(c => c && (c.status === 'available' || c.status === 'coordinating')).length;
        const coordinating = (Array.isArray(coordList) ? coordList : []).filter(c => c && c.status === 'coordinating').length;
        const todo = Array.isArray(mbRows) ? mbRows.filter(r => r.todo).length : null;
        // 📈 消化: 定員 = 今回参加できる人 × 3。凸が定員を超えていたら定員を合わせる (pace.js と同じ決め)
        const doneAttacks = ps.reduce((s, p) => s + (Number(p.attackCount) || 0), 0);
        const capacity = Math.max(doneAttacks, ps.filter(p => !p.unavailableThisSeason).length * MAX_ATTACKS);
        // 🔁 返事待ち = 締め凸依頼で status が pending の行 (未ロードなら null)
        const askWaiting = Array.isArray(finishRequests) ? finishRequests.filter(r => r && r.status === 'pending').length : null;
        // ★ 締め凸依頼を取得できなかったときは「未返答 0」ではなく「—」(全体監査 2026-09-14 #4)
        const finPending = !Array.isArray(mbRows) ? null
            : mbRows.some(r => r && r.finishUnknown) ? null
            : mbRows.filter(r => r.finish === 'pending').length;

        const summaries = {
            opsSecBoss: season
                ? { text: `Lv${lvl} · 残${alive}体${freshMin != null ? ` · HP更新 ${fmtAgo(freshMin)}${freshWarn ? ' ⚠️' : ''}` : ''}`, bad: freshWarn }
                : { text: '', bad: false },
            opsSecCoord: { text: coordList ? `オンライン ${online}${coordinating ? ` · 調整中 ${coordinating}` : ''}` : '', bad: false },
            opsSecRemaining: { text: season ? `${remainingPlayers.length}名 / ${remainingTotal}凸残` : '', bad: remainingTotal > 0 },
            opsSecMembers: { text: todo == null ? '' : `未完 ${todo}${finPending ? ` · 締め凸未返答 ${finPending}` : ''}`, bad: (todo || 0) > 0 || (finPending || 0) > 0 },
            // 承認待ちは「運営が見ていないと予約が成立しない」状態なので bad 扱いにする
            opsSecReserve: reservations
                ? { text: `承認待ち ${reservations.pending} · 固定中 ${reservations.approved}${(reservations.expired || 0) > 0 ? ` · ⏰ 期限切れ ${reservations.expired}` : ''}`, bad: (reservations.pending || 0) > 0 || (reservations.expired || 0) > 0 }   // ⏰ = 返事の無い 📣 (全体監査 #7)
                : { text: '', bad: false },
            opsSecFinish: { text: finishAttr ? `${ATTR_JP[finishAttr] || finishAttr} 締め凸を検索中` : '', bad: false },
            opsSecPace: { text: season ? `${doneAttacks} / ${capacity}凸` : '', bad: false },
            // 返事待ちは「誰かが待っている」状態なので目立たせる
            opsSecRecent: { text: askWaiting == null ? '' : (askWaiting ? `返事待ち ${askWaiting}` : '返事待ちなし'), bad: (askWaiting || 0) > 0 },
            // published: true=配信中 / false=未配信 / null=まだ取得できていない (未配信と混同させない。Codex再監査 2026-09-08)
            opsSecPlan: { text: published === null ? '配信を確認中' : published ? '配信中' : planComputed ? '算出済み (未配信)' : '未算出', bad: false },
            opsSecActions: { text: '', bad: false },
            opsSecPush: { text: '', bad: false },
            opsSecSeason: { text: season ? `${season.month_key || ''}${season.is_test ? ' 🧪' : ''} · Lv${lvl}` : 'シーズン無し', bad: !season },
            opsSecDiscord: { text: '', bad: false },
        };
        const cockpit = [
            { id: 'opsSecBoss',      key: 'hp',     label: 'HP更新',      value: season ? fmtAgo(freshMin) : '—', bad: freshWarn },
            { id: 'opsSecRemaining', key: 'remain', label: '残凸 合計',   value: season ? remainingTotal : '—', bad: remainingTotal > 0 },
            { id: 'opsSecMembers',   key: 'todo',   label: '未完メンバー', value: todo == null ? '—' : todo, bad: (todo || 0) > 0 },
            { id: 'opsSecMembers',   key: 'finish', label: '締め凸 未返答', value: finPending == null ? '—' : finPending, bad: (finPending || 0) > 0 },
        ];
        return { summaries, cockpit };
    }

    root.opsLayoutDomain = { CARDS, STORAGE_KEY, cardById, resolveOpen, withStored, parseStored, summarize, hpFreshnessMin, TABS, TAB_KEYS, tabOf, defaultTab, resolveTab, tabCounts };
})(typeof window !== 'undefined' ? window : globalThis);
