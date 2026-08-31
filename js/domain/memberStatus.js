// ============================================================================
// ドメイン: メンバー状況ボード (運営改修 #1 — 2026-09-01)
// ----------------------------------------------------------------------------
// 戦況タブ「👥 メンバー状況」カードの純ロジック。運営が「次に誰へ何を頼むか」を
// 1画面で判断できるよう、前日 (模擬・SLv・時間帯・通知) と当日 (凸・代理・締め凸返答) の
// 状態を1人1行にまとめ、「要対応」の理由を機械的に付ける。
//
// 入力は opsStore の盤面 (players[] — damagesByAttr / attacks / availableSlots / syncLevel /
// flexTime / notifyAllHours) と、追加取得した extras (通知購読・今季SLv登録・締め凸依頼・代理凸ログ)。
// 「要対応」の定義はここが唯一の置き場所 — 画面側で判定を書き足さないこと。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const ATTR_KEYS = ['fire', 'water', 'electric', 'iron', 'wind'];
    const ATTR_JP = { fire: '灼熱', water: '水冷', electric: '電撃', iron: '鉄甲', wind: '風圧' };
    const MAX_ATTACKS = 3;
    // 模擬の必要範囲は「キャラ被りなしで3属性」(= 3凸を別キャラで回せる)。5属性は運営が助かる加点扱いで強制しない
    // (2026-09-01 ユーザー判断)。同じキャラは1日1回しか使えないため、提出属性数ではなく
    // 「互いにキャラが被らない属性の最大数」で判定する
    const MOCK_REQUIRED = 3;

    // キャラ照合キーは模擬・ソルバー側 (mockLevelsDomain.charKey / optimal-plan.js) と同じ規則を使う。
    // 独自に空白除去などを足すと「同一キャラ」の判定が画面ごとにズレる (Codex指摘) — 実体があれば委譲
    const charKey = (c) => {
        const shared = root.mockLevelsDomain && root.mockLevelsDomain.charKey;
        return shared ? shared(c) : (typeof c === 'string' ? c : '').normalize('NFKC').trim().toLowerCase();
    };

    /**
     * 提出済み属性のうち、互いにキャラが被らない属性の最大数。
     * 各属性は複数の編成 (slot 1/2 = loadoutsByAttr) を持ちうるので、「属性ごとにどの編成を採るか」も
     * 含めて総当たりする (5属性 × 最大2編成 なので十分小さい)。slot1 同士が被っていても slot2 で
     * 回せるなら OK にする (代表編成だけ見ると偽陰性になる — Codex指摘)。
     * 編成が未記録の属性は「被り判定できない」= どの属性とも両立するものとして数える
     * (提出自体は済んでいるのに、記録の欠落で要対応にしない)。
     * @param {string[]} mockAttrs
     * @param {Record<string, {team?:string[]}[]>=} loadoutsByAttr  opsStore 盤面の loadoutsByAttr (優先)
     * @param {Record<string, string[]>=} teamsByAttr  代表編成 (loadouts が無い環境の後方互換)
     */
    function maxDisjointAttrs(mockAttrs, loadoutsByAttr, teamsByAttr) {
        const attrs = Array.isArray(mockAttrs) ? mockAttrs : [];
        const toSet = (chars) => new Set((Array.isArray(chars) ? chars : []).map(charKey).filter(Boolean));
        // 属性ごとの候補編成 (Set の配列)。候補が無い = ワイルドカード
        const cands = attrs.map(a => {
            const lo = Array.isArray(loadoutsByAttr?.[a]) ? loadoutsByAttr[a].map(l => toSet(l?.team)).filter(s => s.size > 0) : [];
            if (lo.length) return lo;
            const t = toSet(teamsByAttr?.[a]);
            return t.size ? [t] : [];
        });
        const disjoint = (a, b) => { for (const c of a) if (b.has(c)) return false; return true; };
        // idx の属性群について、各属性から編成を1つずつ選んで互いに被らない組合せがあるか (バックトラック)
        const feasible = (idx) => {
            const chosen = [];
            const rec = (k) => {
                if (k === idx.length) return true;
                const options = cands[idx[k]];
                if (!options.length) return rec(k + 1);          // ワイルドカード
                for (const s of options) {
                    if (chosen.every(c => disjoint(c, s))) { chosen.push(s); if (rec(k + 1)) return true; chosen.pop(); }
                }
                return false;
            };
            return rec(0);
        };
        let best = 0;
        for (let mask = 1; mask < (1 << attrs.length); mask++) {
            const idx = []; for (let i = 0; i < attrs.length; i++) if (mask & (1 << i)) idx.push(i);
            if (idx.length <= best) continue;
            if (feasible(idx)) best = idx.length;
        }
        return best;
    }

    /** ローカル日付 YYYY-MM-DD (hard_date との比較用。運用は日本時間の端末前提) */
    function localDateStr(d) {
        const x = d instanceof Date ? d : new Date(d);
        const p = (n) => String(n).padStart(2, '0');
        return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
    }

    /**
     * 自動フェーズ判定: ハード日当日以降は 'day'、それより前は 'pre'。
     * @param {string|null|undefined} hardDate  'YYYY-MM-DD'
     * @param {Date|number=} now
     */
    function phaseFor(hardDate, now) {
        if (!hardDate) return 'pre';
        const today = localDateStr(now == null ? new Date() : now);
        return today >= String(hardDate).slice(0, 10) ? 'day' : 'pre';
    }

    const toIdSet = (v) => new Set((v instanceof Set ? [...v] : Array.isArray(v) ? v : []).map(Number));

    /**
     * 1人1行の状態を組み立てる。
     * @param {Object} args
     * @param {Object[]} args.players  opsStore 盤面の players
     * @param {{pushPlayerIds?:any, slvThisSeasonIds?:any, finishRequests?:{player_id:number,status:string,requested_at?:string}[], proxyEvents?:{player_id:number}[]}=} args.extras
     * @param {'pre'|'day'} args.phase
     * @returns {Object[]} rows (未ソート)
     */
    function buildRows({ players, extras, phase } = {}) {
        const ex = extras || {};
        const pushSet = toIdSet(ex.pushPlayerIds);
        const slvSet = toIdSet(ex.slvThisSeasonIds);
        const finishBy = new Map();
        for (const r of (Array.isArray(ex.finishRequests) ? ex.finishRequests : [])) {
            const pid = Number(r?.player_id);
            if (!Number.isFinite(pid)) continue;
            // pending が1件でもあれば「未返答」で固定。無ければ最後に見たステータス
            if (r.status === 'pending') finishBy.set(pid, 'pending');
            else if (finishBy.get(pid) !== 'pending') finishBy.set(pid, r.status);
        }
        const proxyBy = new Map();
        for (const e of (Array.isArray(ex.proxyEvents) ? ex.proxyEvents : [])) {
            const pid = Number(e?.player_id);
            if (!Number.isFinite(pid)) continue;
            proxyBy.set(pid, (proxyBy.get(pid) || 0) + 1);
        }
        const isDay = phase === 'day';
        return (Array.isArray(players) ? players : []).map(p => {
            const id = Number(p.id);
            const dmg = p.damagesByAttr || {};
            const mockAttrs = ATTR_KEYS.filter(a => (Number(dmg[a]) || 0) > 0);
            const missingAttrs = ATTR_KEYS.filter(a => !mockAttrs.includes(a));
            const mockUsable = maxDisjointAttrs(mockAttrs, p.loadoutsByAttr, p.teamsByAttr);   // キャラ被りなしで回せる属性数 (全編成を考慮)
            const mockOk = mockUsable >= MOCK_REQUIRED;
            const slots = Array.isArray(p.availableSlots) ? p.availableSlots : [];
            const flex = !!p.flexTime;
            const slvKnown = !p.syncLevelEstimated && Number(p.syncLevel) > 0;
            const slvNow = slvSet.has(id) && slvKnown ? Number(p.syncLevel) : null;
            const slvPrev = slvNow == null && slvKnown ? Number(p.syncLevel) : null;
            const attacks = (Array.isArray(p.attacks) ? p.attacks : []).map(a => ({
                level: a?.level == null ? null : Number(a.level),
                bossNumber: a?.boss_number == null ? null : Number(a.boss_number),
            }));
            const atkCount = Math.min(attacks.length, MAX_ATTACKS);
            const push = pushSet.has(id);
            const proxyCount = proxyBy.get(id) || 0;
            const finish = finishBy.get(id) || null;

            const reasons = [];
            if (isDay && atkCount < MAX_ATTACKS) reasons.push({ key: 'attacks', label: `凸 残${MAX_ATTACKS - atkCount}` });
            if (isDay && finish === 'pending') reasons.push({ key: 'finish', label: '締め凸 未返答' });
            if (!mockOk) {
                reasons.push({
                    key: 'mock',
                    label: mockUsable < mockAttrs.length
                        ? `模擬 被りなし${mockUsable}/${MOCK_REQUIRED} (提出${mockAttrs.length}属性・キャラ被り)`
                        : `模擬 被りなし${mockUsable}/${MOCK_REQUIRED}`,
                });
            }
            if (slvNow == null) reasons.push({ key: 'slv', label: slvPrev ? `SLv未登録 (前回 ${slvPrev})` : 'SLv未登録' });
            if (!slots.length && !flex) reasons.push({ key: 'slots', label: '時間帯未登録' });
            if (!push) reasons.push({ key: 'push', label: '通知購読なし' });

            return {
                id, name: String(p.name ?? ''),
                avatarChar: p.avatar_character || null,
                avatarUrl: p.avatar_url || null,
                strong: Array.isArray(p.strong_attributes) ? p.strong_attributes : [],
                mockCount: mockAttrs.length, missingAttrs, mockUsable, mockOk,
                slvNow, slvPrev,
                slots, flex, allHours: !!p.notifyAllHours,
                push,
                attacks, atkCount, proxyCount, finish,
                reasons, todo: reasons.length > 0,
            };
        });
    }

    /** 表示順: 'why' = 要対応が多い順 → 名前 / 'name' = 名前順 */
    function sortRows(rows, mode) {
        const out = [...(Array.isArray(rows) ? rows : [])];
        const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
        if (mode === 'name') return out.sort(byName);
        return out.sort((a, b) => (b.reasons.length - a.reasons.length) || byName(a, b));
    }

    /** 上段の集計。value/total、bad = 注意色にするか */
    function summarize(rows, phase) {
        const rs = Array.isArray(rows) ? rows : [];
        const n = rs.length;
        const cnt = (f) => rs.filter(f).length;
        if (phase === 'day') {
            const done = cnt(r => r.atkCount >= MAX_ATTACKS);
            const remaining = rs.reduce((s, r) => s + (MAX_ATTACKS - r.atkCount), 0);
            const pending = cnt(r => r.finish === 'pending');
            return [
                { key: 'done', label: '3凸 完了', value: done, total: n, bad: done < n },
                { key: 'remaining', label: '残凸 合計', value: remaining, total: null, bad: remaining > 0 },
                { key: 'proxy', label: '代理 登録', value: cnt(r => r.proxyCount > 0), total: null, bad: false },
                { key: 'finish', label: '締め凸 未返答', value: pending, total: null, bad: pending > 0 },
            ];
        }
        const mock = cnt(r => r.mockOk);
        const mockFull = cnt(r => r.mockCount >= ATTR_KEYS.length);
        const slv = cnt(r => r.slvNow != null);
        const slots = cnt(r => r.slots.length > 0 || r.flex);
        const push = cnt(r => r.push);
        return [
            { key: 'mock', label: '模擬 3属性 (被りなし)', value: mock, total: n, bad: mock < n, sub: `5属性 ${mockFull}` },
            { key: 'slv', label: 'SLv 登録', value: slv, total: n, bad: slv < n },
            { key: 'slots', label: '時間帯 登録', value: slots, total: n, bad: slots < n },
            { key: 'push', label: '通知 購読', value: push, total: n, bad: push < n },
        ];
    }

    /**
     * 催促Push の文面 (その人の要対応理由から組み立てる)。届かない人 (通知未購読) は null
     * @returns {{title:string, body:string, url:string}|null}
     */
    function nudgeMessage(row, phase) {
        if (!row || !row.push) return null;
        const keys = new Set((row.reasons || []).map(r => r.key));
        if (phase === 'day' && keys.has('attacks')) {
            return { title: '📝 凸報告のお願い', body: `凸が残り${MAX_ATTACKS - row.atkCount}件です。凸したらホーム → ⚔️ 凸報告 から提出お願いします🙏`, url: './?tab=mypage' };
        }
        if (phase === 'day' && keys.has('finish')) {
            return { title: '🔔 締め凸依頼の返答をお願いします', body: '締め凸の依頼が届いています。ホームから 受ける / 見送る を選んでください🙏', url: './?tab=mypage' };
        }
        const parts = [];
        if (keys.has('mock')) {
            const need = Math.max(0, MOCK_REQUIRED - (row.mockUsable || 0));
            parts.push(row.mockUsable < row.mockCount
                ? `模擬戦データ (キャラ被りなしで${MOCK_REQUIRED}属性必要・あと${need}属性。未提出: ${row.missingAttrs.map(a => ATTR_JP[a]).join('・') || 'なし'})`
                : `模擬戦データ (キャラ被りなしで${MOCK_REQUIRED}属性必要・あと${need}属性: ${row.missingAttrs.map(a => ATTR_JP[a]).join('・')})`);
        }
        if (keys.has('slv')) parts.push('シンクロレベル');
        if (keys.has('slots')) parts.push('戦闘可能時間');
        if (!parts.length) return null;
        return { title: '🪞 レイド前の登録のお願い', body: `${parts.join(' / ')} が未登録です。ホーム・模擬タブから登録お願いします🙏`, url: './?tab=mypage' };
    }

    root.memberStatusDomain = { ATTR_KEYS, ATTR_JP, MAX_ATTACKS, MOCK_REQUIRED, phaseFor, buildRows, sortRows, summarize, nudgeMessage, localDateStr, maxDisjointAttrs };
})(typeof window !== 'undefined' ? window : globalThis);
