// ============================================================================
// ドメイン: テストシーズン終了時のキャラマスタ整理 (運営改修 #3 — 2026-08-31)
// ----------------------------------------------------------------------------
// 旧仕様は「テスト作成時のスナップショットに無い名前を全部削除」だった。テスト中に
// 運営が正規に手動登録した新キャラ (2026-08-20 のペルソナ3体 + 素体2体) まで巻き込むため、
// 終了前に候補を分類して運営に見せ、削除は明示的に選ばれた行だけにする。
//
// 分類ルール (消し過ぎない側に倒す):
//   - スナップショットにある名前          → 候補にしない (テスト前から居た)
//   - created_by_test_season_id == 今回   → 'test'   既定ON  (テスト中の OCR 自動学習)
//   - created_by_test_season_id が別の値  → 'other-test' 既定OFF (要確認)
//   - タグ無し・観測0・確定               → 'manual' 既定OFF (運営の手動登録)
//   - タグ無し・観測>0・未確定            → 'ocr'    既定OFF (33適用前の自動学習。由来不明)
//   - それ以外                            → 'unknown' 既定OFF
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /**
     * @typedef {Object} CharRow  nikke_characters の行 (必要な列だけ)
     * @property {string} canonical_name
     * @property {number=} sighting_count
     * @property {boolean=} is_confirmed
     * @property {number|null=} created_by_test_season_id  33_nikke_test_origin 未適用環境では undefined
     */

    /**
     * テスト終了で削除候補になるキャラを分類する。
     * @param {{snapshotNames?: string[]|null, currentRows?: CharRow[]|null, testSeasonId?: number|null}} args
     * @returns {{canonical_name:string, origin:string, defaultDelete:boolean, reason:string, sighting_count:number, is_confirmed:boolean}[]}
     *   既定ON (defaultDelete=true) を先頭に、以降は名前順
     */
    function classifyTestSeasonChars({ snapshotNames, currentRows, testSeasonId } = {}) {
        const snap = new Set(Array.isArray(snapshotNames) ? snapshotNames : []);
        const sid = (testSeasonId == null || testSeasonId === '') ? null : Number(testSeasonId);
        const out = [];
        for (const r of (Array.isArray(currentRows) ? currentRows : [])) {
            const name = r && typeof r.canonical_name === 'string' ? r.canonical_name : null;
            if (!name || snap.has(name)) continue;
            const tag = (r.created_by_test_season_id == null) ? null : Number(r.created_by_test_season_id);
            const seen = Number(r.sighting_count) || 0;
            const confirmed = !!r.is_confirmed;
            let origin, defaultDelete, reason;
            if (tag != null && sid != null && tag === sid) {
                origin = 'test'; defaultDelete = true;
                reason = `テスト中に自動学習 (観測${seen}回)`;
            } else if (tag != null) {
                origin = 'other-test'; defaultDelete = false;
                reason = `別のテスト (#${tag}) 由来 — 要確認`;
            } else if (seen === 0 && confirmed) {
                origin = 'manual'; defaultDelete = false;
                reason = '運営の手動登録 (観測0・確定) — 残す';
            } else if (seen > 0 && !confirmed) {
                origin = 'ocr'; defaultDelete = false;
                reason = `自動学習 (観測${seen}回・未確定) — 由来不明のため既定は残す`;
            } else {
                origin = 'unknown'; defaultDelete = false;
                reason = `観測${seen}回・${confirmed ? '確定' : '未確定'} — 既定は残す`;
            }
            out.push({ canonical_name: name, origin, defaultDelete, reason, sighting_count: seen, is_confirmed: confirmed });
        }
        out.sort((a, b) => (Number(b.defaultDelete) - Number(a.defaultDelete)) || a.canonical_name.localeCompare(b.canonical_name, 'ja'));
        return out;
    }

    /**
     * 実際に削除してよい名前だけに絞る (安全弁)。
     * スナップショットに含まれる名前・文字列でないもの・重複を落とす。
     * @param {string[]|null|undefined} requested  運営が選んだ名前
     * @param {string[]|null|undefined} snapshotNames
     */
    function filterDeletableChars(requested, snapshotNames) {
        const snap = new Set(Array.isArray(snapshotNames) ? snapshotNames : []);
        const seen = new Set();
        const out = [];
        for (const n of (Array.isArray(requested) ? requested : [])) {
            if (typeof n !== 'string' || !n || snap.has(n) || seen.has(n)) continue;
            seen.add(n); out.push(n);
        }
        return out;
    }

    // ========================================================================
    // 🧪 本番の写しでリハーサル (2026-11-12 ふるり「テストと本番は明確に切り分けつつ、本番同様の状態でテストを」)
    // ------------------------------------------------------------------------
    // それまでのテストは 模擬を全部消して作り物 (乱数のダメージ・キャラ名の順の編成) を入れていた →
    // 「よく使う編成」に作り物が出る・動きが本番と違う。いまは **何も作らない**:
    //   - 模擬・編成・参加可能時間は DB にある本物をそのまま使う (始めるときに控え、終わるときに控えへ戻す)
    //   - ボス・ブロックの区切り・再編成時間・メンバーの入力の出し方 は直前の本番シーズンから写す
    //   - テストのシーズンは運営担当 (と「テスト通知を受け取る」の人) の端末にだけ見せる
    // ここは形を決めるだけ (DOM・通信なし)。
    // ========================================================================
    const PLACEHOLDER_CODES = ['A.N.M.I.', 'D.M.T.R.', 'H.S.T.A.', 'P.S.I.D.', 'Z.E.U.S.'];
    const PLACEHOLDER_TIERS = ['lord', 'lord', 'tyrant', 'lord', 'tyrant'];   // B1,2,4=lord / B3,5=tyrant
    const DAY_MS = 86400000;
    const p2 = (n) => String(n).padStart(2, '0');
    // JST の壁時計を UTC の欄で読める Date にする
    const jst = (ms) => new Date(Number(ms) + 9 * 3600000);
    const ymd = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;

    /** いまのレイド日 (JST・5 時始まり) の 'YYYY-MM-DD'。0〜4 時は前の日 */
    function raidDayOf(nowMs) {
        return ymd(new Date(jst(nowMs).getTime() - 5 * 3600000));
    }

    /**
     * リハーサルのシーズンの形。
     * @param {{ start?: 'eve'|'day', nowMs: number, prev?: { season?: object, bosses?: object[] }|null, defaultRebuild?: number }} a
     *   start: 'eve' = 前日として (ハード日 = 次のレイド日) / 'day' = 当日として (ハード日 = いまのレイド日)
     *   prev:  直前の本番シーズンとそのボス (無ければプレースホルダ)
     * @returns {{ start, hardDate, monthKey, bosses: {bossNumber,bossCode,name,tier}[], meta: object, from: string|null, placeholder: boolean }}
     */
    function rehearsalSpec({ start, nowMs, prev, defaultRebuild } = {}) {
        const st = start === 'day' ? 'day' : 'eve';
        const today = raidDayOf(nowMs);
        const hardDate = st === 'day' ? today : ymd(new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS));
        const j = jst(nowMs);
        const monthKey = `TEST-${j.getUTCFullYear()}${p2(j.getUTCMonth() + 1)}${p2(j.getUTCDate())}${p2(j.getUTCHours())}${p2(j.getUTCMinutes())}${p2(j.getUTCSeconds())}`;

        // ボス: 直前の本番の 5 体 (番号 1〜5 がそろい、コードがあるときだけ)。そろわなければプレースホルダ
        const src = Array.isArray(prev && prev.bosses) ? prev.bosses : [];
        const byNo = new Map();
        for (const b of src) {
            const n = Number(b && b.boss_number);
            if (Number.isInteger(n) && n >= 1 && n <= 5 && typeof b.boss_code === 'string' && b.boss_code && !byNo.has(n)) byNo.set(n, b);
        }
        const placeholder = byNo.size !== 5;
        const bosses = placeholder
            ? PLACEHOLDER_CODES.map((code, i) => ({ bossNumber: i + 1, bossCode: code, name: `テストボス${i + 1}`, tier: PLACEHOLDER_TIERS[i] }))
            : [1, 2, 3, 4, 5].map(n => {
                const b = byNo.get(n);
                return { bossNumber: n, bossCode: b.boss_code, name: (typeof b.name === 'string' && b.name) ? b.name : null, tier: b.tier === 'tyrant' ? 'tyrant' : 'lord' };
            });

        // 設定: 本番の写し。再編成時間は直前の本番に入っていればその値、無ければ新しい本番と同じ既定
        const pm = (prev && prev.season && prev.season.metadata && typeof prev.season.metadata === 'object' && !Array.isArray(prev.season.metadata)) ? prev.season.metadata : {};
        const meta = {};
        if (Array.isArray(pm.blocks) && pm.blocks.length) meta.blocks = pm.blocks;
        if (pm.member_input === 'full') meta.member_input = 'full';
        const rb = Number(pm.rebuild_minutes);
        const dr = Number(defaultRebuild);
        if (Number.isInteger(rb) && rb >= 0 && rb <= 59 && pm.rebuild_minutes != null) { if (rb > 0) meta.rebuild_minutes = rb; }
        else if (Number.isInteger(dr) && dr > 0 && dr <= 59) meta.rebuild_minutes = dr;

        const from = (prev && prev.season && typeof prev.season.month_key === 'string') ? prev.season.month_key : null;
        return { start: st, hardDate, monthKey, bosses, meta, from, placeholder };
    }

    /**
     * テストのシーズンを見せる相手か。運営担当 (master / ops) と「テスト通知を受け取る」を ON にした人だけ。
     * 役割がまだ読めていない (undefined) 間は、この端末が前に決めた値 (remembered) のまま — 初めての端末は見せない。
     * @param {{ role?: 'master'|'ops'|null, notifyTest?: boolean, remembered?: boolean }} a
     */
    function canSeeTest({ role, notifyTest, remembered } = {}) {
        if (role === 'master' || role === 'ops') return true;
        if (role === undefined) return !!remembered;
        if (notifyTest === undefined) return !!remembered;   // メンバーだがスイッチが読めていない
        return notifyTest === true;
    }

    const mockKey = (r) => `${r.player_id}|${r.attribute}|${Number(r.slot) || 1}`;
    const mockSig = (r) => JSON.stringify([Number(r.damage_b) || 0, Array.isArray(r.characters) ? r.characters : [], r.levels ?? null, r.excluded_at ?? null]);

    /**
     * テスト中に変わったもの (終了で控えに戻るもの) を数える。
     * @returns {{ mocks: number|null, availPlayers: number|null }}  数えられないものは null (0 と言わない)
     */
    function snapshotDiff({ damagesSnap, damagesNow, availSnap, availNow } = {}) {
        let mocks = null, availPlayers = null;
        if (Array.isArray(damagesSnap) && Array.isArray(damagesNow)) {
            const a = new Map(damagesSnap.filter(Boolean).map(r => [mockKey(r), mockSig(r)]));
            const b = new Map(damagesNow.filter(Boolean).map(r => [mockKey(r), mockSig(r)]));
            mocks = 0;
            for (const [k, v] of a) if (b.get(k) !== v) mocks++;
            for (const k of b.keys()) if (!a.has(k)) mocks++;
        }
        if (Array.isArray(availSnap) && Array.isArray(availNow)) {
            const fold = (rows) => {
                const m = new Map();
                for (const r of rows) { if (!r) continue; const k = String(r.player_id); if (!m.has(k)) m.set(k, []); m.get(k).push(String(r.time_slot)); }
                for (const [k, v] of m) m.set(k, v.sort().join(','));
                return m;
            };
            const a = fold(availSnap), b = fold(availNow);
            availPlayers = 0;
            for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) || '') !== (b.get(k) || '')) availPlayers++;
        }
        return { mocks, availPlayers };
    }

    /**
     * 控えの参加可能時間のうち、戻せる行 (いまも居る人・正しい時間帯・重複なし)。
     * テスト中に消されたメンバーの行を入れると外部キーで全部が失敗する。
     */
    function restorableAvailability(snapshot, playerIds) {
        const alive = new Set((Array.isArray(playerIds) ? playerIds : []).map(String));
        const seen = new Set();
        const out = [];
        for (const r of (Array.isArray(snapshot) ? snapshot : [])) {
            if (!r || r.player_id == null || typeof r.time_slot !== 'string') continue;
            if (!/^h(0[0-9]|1[0-9]|2[0-3])$/.test(r.time_slot)) continue;
            if (!alive.has(String(r.player_id))) continue;
            const k = `${r.player_id}|${r.time_slot}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ player_id: r.player_id, time_slot: r.time_slot });
        }
        return out;
    }

    root.testSeasonDomain = { classifyTestSeasonChars, filterDeletableChars, raidDayOf, rehearsalSpec, canSeeTest, snapshotDiff, restorableAvailability };
})(typeof window !== 'undefined' ? window : globalThis);
