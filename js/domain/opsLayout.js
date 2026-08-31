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
     * group = 見出しラベル (DOM 順に連続するよう、締め凸候補は初期化時にメンバー状況の直後へ移す)
     */
    const CARDS = [
        { id: 'opsSecBoss',      title: 'ボス状況',              group: 'ライブ盤面', opsOnly: false, open: { pre: false, day: true } },
        { id: 'opsSecCoord',     title: 'オンライン / 調整中',   group: 'ライブ盤面', opsOnly: false, open: { pre: false, day: false } },
        { id: 'opsSecRemaining', title: '残り戦闘可能メンバー',   group: 'ライブ盤面', opsOnly: false, open: { pre: false, day: true } },
        { id: 'opsSecMembers',   title: 'メンバー状況',          group: 'ライブ盤面', opsOnly: true,  open: { pre: true,  day: true } },
        { id: 'opsSecFinish',    title: '締め凸候補検索',         group: '判断・配信', opsOnly: true,  open: { pre: false, day: false } },
        { id: 'opsSecPlan',      title: '最適凸プラン算出',       group: '判断・配信', opsOnly: true,  open: { pre: true,  day: false } },
        { id: 'opsSecActions',   title: '戦闘中の運営アクション', group: '実行',       opsOnly: true,  always: true },
        { id: 'opsSecPush',      title: '一斉通知',              group: '実行',       opsOnly: true,  open: { pre: false, day: false } },
        { id: 'opsSecSeason',    title: 'シーズン制御',          group: '管理・終了', opsOnly: true,  open: { pre: false, day: false } },
        { id: 'opsSecDiscord',   title: 'Discord 告知テンプレ',  group: '管理・終了', opsOnly: true,  open: { pre: false, day: false } },
    ];
    const STORAGE_KEY = 'shirisuko_ops_card_open_v1';

    const cardById = (id) => CARDS.find(c => c.id === id) || null;

    /**
     * カードを開くべきか。always → 常に true。記憶 (stored[phase][id]) があればそれ、無ければ既定。
     * opsMode=false (メンバー) は常に全開 — 一般メンバーの操作を増やさない
     */
    function resolveOpen(id, phase, stored, opsMode = true) {
        const c = cardById(id);
        if (!c) return true;
        if (!opsMode || c.always) return true;
        const ph = phase === 'day' ? 'day' : 'pre';
        const v = stored && stored[ph] && typeof stored[ph][id] === 'boolean' ? stored[ph][id] : undefined;
        return v !== undefined ? v : !!(c.open && c.open[ph]);
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
     * @param {boolean=} args.published  配信中プランがあるか
     * @param {boolean=} args.planComputed  算出済みプランがあるか
     * @param {string|null=} args.finishAttr  締め凸検索中の属性キー
     * @param {number=} args.now
     * @returns {{summaries: Record<string,{text:string,bad:boolean}>, cockpit: {id:string,key:string,label:string,value:string|number,bad:boolean}[]}}
     */
    function summarize({ season, bosses, players, mbRows, coordList, published, planComputed, finishAttr, now } = {}) {
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
        const finPending = Array.isArray(mbRows) ? mbRows.filter(r => r.finish === 'pending').length : null;

        const summaries = {
            opsSecBoss: season
                ? { text: `Lv${lvl} · 残${alive}体${freshMin != null ? ` · HP更新 ${fmtAgo(freshMin)}${freshWarn ? ' ⚠️' : ''}` : ''}`, bad: freshWarn }
                : { text: '', bad: false },
            opsSecCoord: { text: coordList ? `オンライン ${online}${coordinating ? ` · 調整中 ${coordinating}` : ''}` : '', bad: false },
            opsSecRemaining: { text: season ? `${remainingPlayers.length}名 / ${remainingTotal}凸残` : '', bad: remainingTotal > 0 },
            opsSecMembers: { text: todo == null ? '' : `未完 ${todo}${finPending ? ` · 締め凸未返答 ${finPending}` : ''}`, bad: (todo || 0) > 0 || (finPending || 0) > 0 },
            opsSecFinish: { text: finishAttr ? `${ATTR_JP[finishAttr] || finishAttr} 締め凸を検索中` : '', bad: false },
            opsSecPlan: { text: published ? '配信中' : planComputed ? '算出済み (未配信)' : '未算出', bad: false },
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

    root.opsLayoutDomain = { CARDS, STORAGE_KEY, cardById, resolveOpen, withStored, parseStored, summarize, hpFreshnessMin };
})(typeof window !== 'undefined' ? window : globalThis);
