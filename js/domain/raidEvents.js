// ============================================================================
// 戦況の変化 (ボス撃破 / レベル開放) の検知 — 純ロジック
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

    // 盤面のスナップショット (前回との比較に使う最小限)
    function snapshotBoard(season, bosses) {
        return {
            seasonId: season ? season.id : null,
            level: Number(season && season.current_level) || 1,
            dead: deadBossNumbers(bosses),
        };
    }

    /**
     * 前回と今回を比べて、通知すべき変化を返す。
     * @param {{seasonId:*, level:number, dead:Set<number>}|null} prev 前回のスナップショット
     * @param {{seasonId:*, level:number, dead:Set<number>}} cur いまのスナップショット
     * @returns {{defeated:number[], levelOpened:number|null, from:number|null}}
     *   prev が無い / シーズンが違う場合は何も返さない (初回観測は記録だけ)
     */
    function diffRaidEvents(prev, cur) {
        const none = { defeated: [], levelOpened: null, from: null };
        if (!prev || !cur) return none;
        if (String(prev.seasonId) !== String(cur.seasonId)) return none;   // シーズンが変わった
        const defeated = [...cur.dead].filter(n => !prev.dead.has(n)).sort((a, b) => a - b);
        const up = Number(cur.level) > Number(prev.level);
        return {
            defeated,
            levelOpened: up ? Number(cur.level) : null,
            from: up ? Number(prev.level) : null,
        };
    }

    root.raidEventsDomain = { deadBossNumbers, snapshotBoard, diffRaidEvents };
})(typeof globalThis !== 'undefined' ? globalThis : this);
