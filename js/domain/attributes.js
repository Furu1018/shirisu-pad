// ============================================================================
// ドメイン: 属性 (リアーキ ステップ1 — ARCHITECTURE-AUDIT.md §4-1)
// ----------------------------------------------------------------------------
// このアプリには意味の違う「属性」が3つあり、全て裸文字列で混同事故を起こしてきた:
//   boss.attribute = ボス自身の属性 (表示の基準。色・アイコンはこれ)
//   boss.weakness  = 弱点 = 持っていくPT属性 (凸・編成・採用率はこれ)
//   BOSS_ATTRIBUTES[code].attribute = 旧月次JSON用の「PT想定属性」(大文字。weakness と同義)
// このモジュールが変換の唯一の置き場所。画面側で相性表を持って逆算することを禁じる。
// (DB書き込み側の発生源は supabase-client.js の supabaseCreateSeason — そちらが正)
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {'fire'|'water'|'electric'|'iron'|'wind'} AttrKey
     *   アプリ内の属性キーの正規形 (小文字)。比較タブ系の旧定数は大文字 ('WATER') を
     *   使うため、境界では必ず normalizeAttrKey() を通すこと。
     * @typedef {Object} BossLike
     * @property {string=} attribute ボス自身の属性 (表示基準)
     * @property {string=} weakness  弱点 = 持っていくPT属性 (凸・編成基準)
     */

    /** @type {AttrKey[]} 属性キーの正規リスト (小文字・この順が表示順) */
    const ATTR_KEYS = ['fire', 'water', 'electric', 'iron', 'wind'];

    // ゲームの相性 (2周期): ボス属性 → そのボスに持っていくPT属性 (=弱点)
    const WEAKNESS_BY_BOSS_ATTR = { wind: 'fire', fire: 'water', water: 'electric', electric: 'iron', iron: 'wind' };
    // 逆写像: PT属性 → そのPTが刺さるボスの属性
    const BOSS_ATTR_BY_WEAKNESS = { fire: 'wind', water: 'fire', electric: 'water', iron: 'electric', wind: 'iron' };

    /**
     * 任意の属性表記を正規形 (小文字 AttrKey) に。未知の値は null。
     * 大文字ドメイン (BOSS_ATTRIBUTES / 比較タブ) との境界では必ずこれを通す。
     * @param {unknown} v
     * @returns {AttrKey|null}
     */
    function normalizeAttrKey(v) {
        if (typeof v !== 'string') return null;
        const k = v.trim().toLowerCase();
        return ATTR_KEYS.includes(k) ? /** @type {AttrKey} */ (k) : null;
    }

    /**
     * ボス行 → 持っていくPT属性 (弱点)。
     * DB に保存済みの weakness が正。無い行 (旧データ等) だけ attribute から相性で導出する。
     * 画面側はこの関数だけを使い、相性表を直接持たないこと。
     * @param {BossLike|null|undefined} boss
     * @returns {AttrKey|null}
     */
    function weaknessPtOf(boss) {
        if (!boss) return null;
        return normalizeAttrKey(boss.weakness)
            || WEAKNESS_BY_BOSS_ATTR[normalizeAttrKey(boss.attribute)]
            || null;
    }

    /**
     * ボス行 → ボス自身の属性 (表示基準)。attribute が正、無ければ weakness から逆算。
     * @param {BossLike|null|undefined} boss
     * @returns {AttrKey|null}
     */
    function bossAttributeOf(boss) {
        if (!boss) return null;
        return normalizeAttrKey(boss.attribute)
            || BOSS_ATTR_BY_WEAKNESS[normalizeAttrKey(boss.weakness)]
            || null;
    }

    /**
     * ホームの細いボス帯 (2026-09-11 ユーザー要望)。
     * 「属性」と「戦闘中かどうか」だけをボスの並び順で返す。
     * ★ 残HPや凸数は返さない — 出すと戦況タブの縮小版になってしまう。
     *   ここは「戦闘に入る前にぱっと見る」ための役
     *
     * @param {Object[]} bosses      盤面のボス (boss_number / attribute / remaining_hp_raw)
     * @param {Object[]} coords      いまの調整中リスト (status / boss_number / player_id)
     * @param {number|string|null} meId 自分のプレイヤーid (自分が戦っているボスに印を付ける)
     * @returns {{bossNumber:number, attr:(string|null), live:number, mine:boolean, done:boolean}[]}
     */
    function homeBossStrip(bosses, coords, meId) {
        const live = new Map();
        const mine = new Set();
        for (const c of Array.isArray(coords) ? coords : []) {
            // ★ 「戦闘中」は coordinating だけ。available (オンライン) を混ぜると
            //   誰も戦っていないボスまで光る
            if (!c || c.status !== 'coordinating') continue;
            const n = Number(c.boss_number);
            if (!Number.isInteger(n)) continue;
            live.set(n, (live.get(n) || 0) + 1);
            if (meId != null && String(c.player_id) === String(meId)) mine.add(n);
        }
        return (Array.isArray(bosses) ? bosses : [])
            .filter((b) => b && Number.isInteger(Number(b.boss_number)))
            .slice()
            .sort((a, b) => Number(a.boss_number) - Number(b.boss_number))
            .map((b) => {
                const n = Number(b.boss_number);
                return {
                    bossNumber: n,
                    attr: normalizeAttrKey(b.attribute),
                    live: live.get(n) || 0,
                    mine: mine.has(n),
                    // 残HP が読めないときは「倒した」と決めつけない (未取得と 0 は違う)
                    done: b.remaining_hp_raw != null && Number(b.remaining_hp_raw) <= 0,
                };
            });
    }

    root.ATTR_KEYS = ATTR_KEYS;
    /**
     * ホームの「オンライン / 模擬中 / 戦闘中」の人数と名前 (2026-09-11 ユーザー要望)。
     * スマホ縦は自分の状態ボタンに人数だけ、横画面 (700px〜) はプロフィール直下のタイルに名前ごと出す。
     * ★ 同じ人が2行あっても1人。自分は「あなた」で先頭に。off などは数えない
     * @returns {{available:{count:number,names:string[],mine:boolean}, practicing:..., coordinating:...}}
     */
    function homeStatusCounts(coords, meId) {
        const out = {
            available: { count: 0, names: [], mine: false },
            practicing: { count: 0, names: [], mine: false },
            coordinating: { count: 0, names: [], mine: false },
        };
        const seen = new Set();
        for (const c of Array.isArray(coords) ? coords : []) {
            if (!c || c.player_id == null || !Object.prototype.hasOwnProperty.call(out, c.status)) continue;
            const key = String(c.player_id);
            if (seen.has(key)) continue;
            seen.add(key);
            const slot = out[c.status];
            slot.count += 1;
            if (meId != null && key === String(meId)) { slot.mine = true; slot.names.unshift('あなた'); }
            else slot.names.push(c.name || (c.players && c.players.name) || '?');
        }
        return out;
    }

    /**
     * 横画面のホームに置くボス状況 (2026-09-11 ユーザー要望「空いているスペースにボス状況を」)。
     * 細い帯 (homeBossStrip) より一段詳しい: 残HP% と 残/総HP、交戦者の名前まで。
     * ★ 残HP が読めないときは % も「倒した」も出さない (未取得と 0 は違う)。総HPを超える残HPは 100% で止める
     * @returns {{bossNumber:number, attr:(string|null), name:string, hpPct:(number|null), remainingRaw:(number|null), totalRaw:(number|null), live:number, liveNames:string[], mine:boolean, done:boolean}[]}
     */
    function homeBossBoard(bosses, coords, meId) {
        const live = new Map();
        const mine = new Set();
        for (const c of Array.isArray(coords) ? coords : []) {
            if (!c || c.status !== 'coordinating') continue;   // オンライン (available) は交戦者ではない
            const n = Number(c.boss_number);
            if (!Number.isInteger(n)) continue;
            if (!live.has(n)) live.set(n, []);
            if (meId != null && String(c.player_id) === String(meId)) { mine.add(n); live.get(n).unshift('あなた'); }
            else live.get(n).push(c.name || (c.players && c.players.name) || '?');
        }
        return (Array.isArray(bosses) ? bosses : [])
            .filter((b) => b && Number.isInteger(Number(b.boss_number)))
            .slice()
            .sort((a, b) => Number(a.boss_number) - Number(b.boss_number))
            .map((b) => {
                const n = Number(b.boss_number);
                const rem = b.remaining_hp_raw == null ? null : Number(b.remaining_hp_raw);
                const total = b.total_hp_raw == null ? null : Number(b.total_hp_raw);
                const hasRem = rem != null && Number.isFinite(rem);
                const hasTotal = total != null && Number.isFinite(total) && total > 0;
                const names = live.get(n) || [];
                return {
                    bossNumber: n,
                    attr: normalizeAttrKey(b.attribute),
                    name: String(b.name || b.boss_code || ''),
                    hpPct: hasRem && hasTotal ? Math.max(0, Math.min(100, (rem / total) * 100)) : null,
                    remainingRaw: hasRem ? Math.max(0, rem) : null,
                    totalRaw: hasTotal ? total : null,
                    live: names.length,
                    liveNames: names,
                    mine: mine.has(n),
                    done: hasRem && rem <= 0,
                };
            });
    }

    root.homeBossStrip = homeBossStrip;
    root.homeStatusCounts = homeStatusCounts;
    root.homeBossBoard = homeBossBoard;
    root.normalizeAttrKey = normalizeAttrKey;
    root.weaknessPtOf = weaknessPtOf;
    root.bossAttributeOf = bossAttributeOf;
})(typeof window !== 'undefined' ? window : globalThis);
