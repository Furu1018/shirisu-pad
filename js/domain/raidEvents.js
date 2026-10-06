// ============================================================================
// 戦況の変化 (ボス撃破 / レベル開放 / 残り 1 体) の検知と、定時の戦況まとめ — 純ロジック
// ----------------------------------------------------------------------------
// 「前回見た盤面」と「いまの盤面」を比べて、通知すべき変化だけを返す。
// DOM も通信も触らないので単体テストできる (tests/run-tests.mjs)。
//
// なぜ差分で見るのか:
//   「残HPが0のボス」を毎回そのまま通知対象にすると、アプリを開いた時点で
//   既に倒れているボスを一斉に「撃破!」と流してしまう。
//   テストシーズンのシード (残HPを0にする) でも誤爆する。
//
// なぜ総HP0のボスを除くのか:
//   total_hp_raw が未記録 (0) だと「撃破」と「まだHPを入れていない」を区別できない。
//   古いシーズンは5体とも未記録なので、これを撃破扱いすると全部誤爆する。
// ============================================================================
(function (root) {
    'use strict';

    // 盤面から「倒れているボス番号の集合」を作る
    function deadBossNumbers(bosses) {
        const out = new Set();
        (bosses || []).forEach(b => {
            const total = Number(b.total_hp_raw) || 0;
            const rem = Number(b.remaining_hp_raw) || 0;
            if (total > 0 && rem <= 0) out.add(Number(b.boss_number));
        });
        return out;
    }

    // まだ生きているボス番号 (総HPが入っていて残りがある)。総HP 0 = 未設定のボスは数えない
    function aliveBossNumbers(bosses) {
        const out = [];
        (bosses || []).forEach(b => {
            const total = Number(b.total_hp_raw) || 0;
            const rem = Number(b.remaining_hp_raw) || 0;
            if (total > 0 && rem > 0) out.push(Number(b.boss_number));
        });
        return out.sort((a, b) => a - b);
    }

    // 盤面のスナップショット (前回との比較に使う最小限)
    function snapshotBoard(season, bosses) {
        return {
            seasonId: season ? season.id : null,
            level: Number(season && season.current_level) || 1,
            dead: deadBossNumbers(bosses),
            alive: aliveBossNumbers(bosses),
        };
    }

    /**
     * 前回と今回を比べて、通知すべき変化を返す。
     * @param {{seasonId:*, level:number, dead:Set<number>, alive?:number[]}|null} prev 前回のスナップショット
     * @param {{seasonId:*, level:number, dead:Set<number>, alive?:number[]}} cur いまのスナップショット
     * @returns {{defeated:number[], levelOpened:number|null, from:number|null, lastBoss:number|null}}
     *   prev が無い / シーズンが違う場合は何も返さない (初回観測は記録だけ)
     *   lastBoss = 「このレベルは残り 1 体」になったときの、その 1 体のボス番号 (チームの状況として全員に知らせる節目)。
     *     ★ **いま誰かが倒した結果**として 1 体になったときだけ (defeated があるとき)。
     *       レベルが開いた直後に運営がボスHPを 1 体ずつ入れている途中 (生きているのが 1 体) を「残り 1 体」と言わない。
     *     ★ レベルが上がった差分では出さない (新しいレベルの話なのか前のレベルの話なのか決まらない)。
     *     ★ もともと 1 体しか居ないレベル (Lv4 = ボス5 だけ) では出さない (倒れた + 生きている が 2 体以上のときだけ)
     */
    function diffRaidEvents(prev, cur) {
        const none = { defeated: [], levelOpened: null, from: null, lastBoss: null };
        if (!prev || !cur) return none;
        if (String(prev.seasonId) !== String(cur.seasonId)) return none;   // シーズンが変わった
        const defeated = [...cur.dead].filter(n => !prev.dead.has(n)).sort((a, b) => a - b);
        const up = Number(cur.level) > Number(prev.level);
        const alive = Array.isArray(cur.alive) ? cur.alive : null;
        const lastBoss = (!up && defeated.length > 0 && alive && alive.length === 1 && (cur.dead.size + alive.length) >= 2)
            ? alive[0] : null;
        return {
            defeated,
            levelOpened: up ? Number(cur.level) : null,
            from: up ? Number(prev.level) : null,
            lastBoss,
        };
    }

    // ---- 定時の戦況まとめ (チームの状況・2026-10-07 ユーザー決定「節目だけ全員に」) ----
    // レイド当日の 12・18・21・24 時に 1 通ずつ。送り手は運営端末の定期チェックで、二重送信は raid_event_notices の一意制約で防ぐ。
    const DIGEST_HOURS = [12, 18, 21, 0];   // JST。0 = 24 時 (同じレイド日の深夜)

    /** その時刻 (JST の時 0-23) が定時まとめの時刻なら、その印 ('h12' など)。違えば null */
    function digestSlot(hourJst) {
        // ★ null・空は「分からない」(Number(null) は 0 = 24 時のまとめに化ける)
        if (hourJst == null || hourJst === '') return null;
        const h = Number(hourJst);
        return DIGEST_HOURS.includes(h) ? `h${String(h).padStart(2, '0')}` : null;
    }

    /**
     * 定時まとめの文面。★ 数字は盤面そのもの (運営の HP 更新と凸報告) — 画面と別の数え方をしない
     * @param {Object} a
     * @param {number} a.hourJst      0-23
     * @param {number} a.level        いまのレベル
     * @param {{boss_number:number, name?:string, total_hp_raw:number, remaining_hp_raw:number}[]} a.bosses
     * @param {number} a.done         報告された凸の数
     * @param {number} a.capacity     定員 (「今回は難しい」でない人 × 3。paceDomain と同じ数え方)
     * @returns {{title:string, body:string}}
     */
    function digestText({ hourJst, level, bosses, done, capacity } = {}) {
        const h = Number(hourJst) || 0;
        const lv = Number(level) || 1;
        const d = Math.max(0, Number(done) || 0);
        const cap = Math.max(d, Number(capacity) || 0);
        const left = cap - d;
        const list = (Array.isArray(bosses) ? bosses : []).slice().sort((x, y) => Number(x.boss_number) - Number(y.boss_number));
        let line;
        if (lv >= 4) {
            // Lv4 = ボス5 だけ・HP 無限。割合は出せない
            line = 'Lv4: ボス5 に入れた分がそのまま与ダメになります';
        } else {
            line = list.map(b => {
                const total = Number(b.total_hp_raw) || 0, rem = Number(b.remaining_hp_raw) || 0;
                if (!(total > 0)) return `B${b.boss_number} —`;
                if (rem <= 0) return `B${b.boss_number} 撃破`;
                return `B${b.boss_number} 残${Math.max(1, Math.round(rem / total * 100))}%`;
            }).join(' · ');
        }
        return {
            title: `📊 戦況まとめ (${h === 0 ? 24 : h}時) — Lv${lv}・残り ${left} 凸`,
            body: `凸 ${d}/${cap}${left === 0 ? ' (全員完了)' : ''}\n${line}`,
        };
    }

    root.raidEventsDomain = { deadBossNumbers, aliveBossNumbers, snapshotBoard, diffRaidEvents, DIGEST_HOURS, digestSlot, digestText };
})(typeof globalThis !== 'undefined' ? globalThis : this);
