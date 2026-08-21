// ============================================================================
// 人気編成の集計 — 純ロジック (DOM・通信なし / tests/run-tests.mjs で検証)
// ----------------------------------------------------------------------------
// 「5キャラの組み合わせ (順不同・完全一致)」を1つの編成として数える。
// ゲーム仕様上、キャラ単体よりPT5人のシナジーが本体のため (ユーザー決定 2026-08-11)。
//
// ★ 材料は「今シーズンの模擬提出」+「過去シーズンの凸記録」の合算 (ユーザー決定 2026-08-21)。
//   模擬はシーズン作成時にリセットされるため、模擬だけでは組み合わせがほぼ重ならない
//   (実測: 9割の編成が1人だけ・最多でも2人)。凸記録は積み上がるので合算で人気が育つ
//   (実測: 風圧 7人→25人・灼熱 2人→9人)。
// ★ 並びは人気順のみ。ダメージ順は単にSLvが高い人の編成、ふるり値順は優秀な
//   バッファー持ちの編成に偏るだけで参考にならない (ユーザー決定 2026-08-11)。
// ★ 凸記録の characters は画像パスで入っている (模擬はキャラ名)。呼び出し側が
//   resolveHist でキャラ名に解決する。解決できない凸行は丸ごと捨てる —
//   部分的に混ぜると「4人だけの別編成」という実在しないグループが生まれる。
//   模擬側は従来どおり寛容 (未解決名は生のまま数える。表記ゆれは resolveMock が吸収)。
(function (root) {
    'use strict';

    /**
     * @param {Object} opts
     * @param {{player_id:*, attribute:string, characters:string[]}[]} opts.mockRows 模擬提出 (キャラ名)
     * @param {{player_id:*, attribute:string, characters:string[]}[]} opts.histRows 過去の凸 (画像パス or 名前)
     * @param {(c:string)=>string|null} opts.resolveMock 名前の表記ゆれ解決 (未解決は生名のままでよい)
     * @param {(c:string)=>string|null} opts.resolveHist パス→キャラ名解決 (未解決は null を返すこと)
     * @returns {Object<string, {total:number, list:{team:string[], count:number, mockCount:number, histCount:number}[]}>}
     *   attribute → { total: その属性で数えた延べ人数(distinct), list: 人気順 }
     *   list[].count = 使用した人数 (distinct)。同一人物が模擬と凸の両方に居ても1人
     */
    function buildPopularTeams({ mockRows, histRows, resolveMock, resolveHist }) {
        const byAttr = {};   // attr -> Map(key -> group)
        const playersByAttr = {};   // attr -> Set(player_id)
        const ensure = (attr) => {
            if (!byAttr[attr]) { byAttr[attr] = new Map(); playersByAttr[attr] = new Set(); }
        };
        const add = (attr, playerId, team, source) => {
            ensure(attr);
            const key = [...new Set(team)].sort().join('|');
            if (!key) return;
            const g = byAttr[attr].get(key)
                || { team, count: 0, mockCount: 0, histCount: 0, players: new Set(), hasMockTeam: false };
            // 表示用の並びは模擬提出のものを優先する (現行の入力に近い順序で5枠へ入るように)
            if (source === 'mock' && !g.hasMockTeam) { g.team = team; g.hasMockTeam = true; }
            if (playerId != null) g.players.add(playerId);
            if (source === 'mock') g.mockCount++; else g.histCount++;
            byAttr[attr].set(key, g);
            if (playerId != null) playersByAttr[attr].add(playerId);
        };

        (mockRows || []).forEach(r => {
            if (!r || !r.attribute) return;
            const team = (r.characters || []).filter(Boolean)
                .map(c => (resolveMock ? (resolveMock(c) || c) : c));
            if (team.length === 0) return;
            add(r.attribute, r.player_id, team, 'mock');
        });
        (histRows || []).forEach(r => {
            if (!r || !r.attribute) return;
            const raw = (r.characters || []).filter(Boolean);
            if (raw.length < 5) return;                       // 編成が5人記録されていない凸は使わない
            const team = raw.map(c => (resolveHist ? resolveHist(c) : c));
            if (team.some(c => !c)) return;                   // 1人でも解決できなければ丸ごと捨てる
            if (new Set(team).size < 5) return;               // 重複解決 (別パス→同キャラ) も不完全扱い
            add(r.attribute, r.player_id, team, 'hist');
        });

        const out = {};
        for (const attr of Object.keys(byAttr)) {
            const list = [...byAttr[attr].values()]
                .map(g => ({ team: g.team, count: g.players.size, mockCount: g.mockCount, histCount: g.histCount,
                    _key: [...new Set(g.team)].sort().join('|') }))
                // 人数 → 延べ使用数 → キー昇順。最後のキー比較まで入れて完全に決定的にする
                .sort((a, b) => (b.count - a.count)
                    || ((b.mockCount + b.histCount) - (a.mockCount + a.histCount))
                    || (a._key < b._key ? -1 : a._key > b._key ? 1 : 0));
            list.forEach(g => { delete g._key; });
            out[attr] = { total: playersByAttr[attr].size, list };
        }
        return out;
    }

    root.popularTeamsDomain = { buildPopularTeams };
})(typeof globalThis !== 'undefined' ? globalThis : this);
