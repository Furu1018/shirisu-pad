// ============================================================================
// ドメイン: 配信プランの差分 (L4 通知抑制 / L5 運営ガード の共通土台)
// ----------------------------------------------------------------------------
// 第44回 (2026-09-05) の反省は「当日のプラン再生成でメンバーを振り回したこと」。
// 当日は配信5回・中止2回で、再配信のたびに **前の配信を確認した人全員** へ
// 「🔄 プランが更新されました」を送っていた — 自分の割当が1文字も変わっていない人にもである。
// 何が変わったか分からないまま「確認しろ」とだけ言われるのが振り回しの実体だった。
//
// ここは「前回の配信プラン」と「これから配信するプラン」を突き合わせ、
// **人ごとに変わったかどうか**を出す純ロジック。2つの出口が同じ判定を使う:
//   - 運営 (L5): 配信ボタンを押す前に「何人の割当が変わるか・誰が」を見せる
//   - 通知 (L4): 「🔄 更新されました」を **変わった人にだけ** 送る。
//     変わらなかった人は plan_acks を新しい plan_id へ引き継いで、更新バナーも出さない
//
// ★ 判定の単位は「人」。1人の割当は複数凸あるので、**凸の集合として**比べる
//   (配列の位置で比べると、Lv2の凸が1つ減っただけで後続が全部ズレて「全部変わった」になる)。
// ★ 変化の種類は boss > time > team の順に1つだけ返す (最も重い差分で代表させる)。
//   ユーザー決定 (2026-09-07) により **時刻と編成も約束の一部**なので、
//   ボスが同じでも時刻が動いたら「変わった」に数える。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM/Supabase 非依存で node からテスト可:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /** 変化の種類。重い順 — 1人につき最も重いものを代表として返す */
    const KIND_ORDER = ['gone', 'added', 'boss', 'time', 'team'];
    const KIND_JP = {
        gone:  '割当が無くなった',
        added: '割当が増えた',
        boss:  'ボス・レベルが変わった',
        time:  '時刻が変わった',
        team:  '編成が変わった',
    };

    const norm = (v) => (typeof v === 'string' ? v : '').normalize('NFKC').trim().toLowerCase();

    /**
     * プラン全体を「人ごとの凸の配列」に畳む。
     * @param {Object|null} plan computeOptimalPlanCore の出力 (published_plans.plan)
     * @returns {Map<*, Object[]>} playerId → rows (level/bossNumber/... を持つ)
     */
    function rowsByPlayer(plan) {
        const out = new Map();
        const levels = Array.isArray(plan && plan.levels) ? plan.levels : [];
        levels.forEach(lv => {
            const level = Number(lv && lv.level) || 1;
            const bosses = Array.isArray(lv && lv.bosses) ? lv.bosses : [];
            bosses.forEach(b => {
                const bossNumber = Number(b && b.bossNumber);
                const attacks = Array.isArray(b && b.attacks) ? b.attacks : [];
                attacks.forEach(a => {
                    if (!a || a.memberId == null) return;
                    const key = a.memberId;
                    if (!out.has(key)) out.set(key, []);
                    out.get(key).push({
                        memberId: a.memberId,
                        memberName: a.memberName || '',
                        level,
                        bossNumber,
                        bossName: (b && b.name) || '',
                        weakness: (b && b.weakness) || '',
                        hourIdx: a.hourIdx == null ? null : Number(a.hourIdx),
                        hourLabel: a.hourLabel == null ? null : String(a.hourLabel),
                        flex: !!a.flex,
                        loadoutSlot: Number(a.loadoutSlot) || 1,
                        team: Array.isArray(a.team) ? a.team.filter(Boolean) : null,
                        dmgB: Number(a.dmgB) || 0,
                    });
                });
            });
        });
        // 決定的な順序に揃える (同じ盤面なら同じ並び = 差分が揺れない)
        out.forEach(rows => rows.sort((x, y) =>
            (x.level - y.level)
            || (x.bossNumber - y.bossNumber)
            || ((x.hourIdx ?? 99) - (y.hourIdx ?? 99))
            || (x.loadoutSlot - y.loadoutSlot)));
        return out;
    }

    /** 「どのレベルのどのボスか」 — 最も重い差分の判定に使う */
    function coreKey(row) { return `L${row.level}/B${row.bossNumber}`; }
    /** 約束した時刻。⏳隙間型は時刻を約束しないので flex で1つの値に畳む */
    function timeKey(row) { return row.flex ? 'flex' : (row.hourLabel || '-'); }
    /** 編成。スロット番号だけだと、同じスロットの中身が入れ替わった場合を拾えない */
    function teamKey(row) {
        const t = Array.isArray(row.team) ? row.team.map(norm).filter(Boolean).sort() : [];
        return `S${row.loadoutSlot}:${t.join(',')}`;
    }

    // ★ **並び替えずに** 連結する。rowsByPlayer が (level, bossNumber, hourIdx, loadoutSlot) で
    //   すでに決定的に並べてあるので、同じ割当なら同じ列になる。
    //   ここで種類ごとに sort し直すと**位置の対応が失われ、入れ替えを見逃す**:
    //   「Lv1B1が21時 / Lv2B3が23時」→「Lv1B1が23時 / Lv2B3が21時」は
    //   時刻の集合が同じなので「変化なし」に化ける (実際には2人分の約束が入れ替わっている)。
    //   ボスの集合が同じことを先に確かめてあるので、列として突き合わせてよい
    const seq = (rows, fn) => rows.map(fn).join('|');

    /**
     * 1人ぶんの before/after を比べ、最も重い変化の種類を返す。
     * @returns {string|null} KIND_ORDER のいずれか。変化なしは null
     */
    function classify(before, after) {
        const b = Array.isArray(before) ? before : [];
        const a = Array.isArray(after) ? after : [];
        if (b.length === 0 && a.length === 0) return null;
        if (b.length > 0 && a.length === 0) return 'gone';
        if (b.length === 0 && a.length > 0) return 'added';
        // 凸数が変わった場合も列が一致しないので coreKey の比較で 'boss' になる
        // (長さの明示チェックは冗長。変異テストで素通りしたので落とした)
        if (seq(b, coreKey) !== seq(a, coreKey)) return 'boss';
        if (seq(b, timeKey) !== seq(a, timeKey)) return 'time';
        if (seq(b, teamKey) !== seq(a, teamKey)) return 'team';
        return null;
    }

    /** 「Lv2 B3 21時」形式の1行。運営への提示と本人への通知に使う */
    function describeRow(row) {
        const t = row.flex ? '⏳隙間' : (row.hourLabel || '時刻未定');
        return `Lv${row.level} B${row.bossNumber} ${t}`;
    }
    function describeRows(rows) {
        const list = Array.isArray(rows) ? rows : [];
        return list.length === 0 ? '割当なし' : list.map(describeRow).join(' / ');
    }

    /**
     * 前回の配信プランと、これから配信するプランを突き合わせる。
     * @param {Object|null} prevPlan 前回の配信 (無ければ null = 初回配信)
     * @param {Object|null} nextPlan これから配信するプラン
     * @returns {{first:boolean, changed:Object[], unchanged:Object[], totalAfter:number}}
     *   changed[] = { memberId, memberName, kind, kindLabel, before, after, beforeText, afterText }
     *   unchanged[] = { memberId, memberName }  ← plan_acks を引き継いでよい人
     */
    function diffPlans(prevPlan, nextPlan) {
        const nextRows = rowsByPlayer(nextPlan);
        const totalAfter = nextRows.size;
        // 初回配信 (前回が無い) は「全員が変わった」ではなく first=true で別扱いにする。
        // 変更通知の対象は plan_acks 側で決まるので、ここで全員を changed に積む必要はない
        if (!prevPlan) return { first: true, changed: [], unchanged: [], totalAfter };

        const prevRows = rowsByPlayer(prevPlan);
        const ids = [];
        const seen = new Set();
        // 決定的な順序: 前回に居た人 → 今回だけの人。どちらも元の列挙順を保つ
        prevRows.forEach((_, id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } });
        nextRows.forEach((_, id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } });

        const changed = [], unchanged = [];
        ids.forEach(id => {
            const before = prevRows.get(id) || [];
            const after = nextRows.get(id) || [];
            const name = (after[0] && after[0].memberName) || (before[0] && before[0].memberName) || '';
            const kind = classify(before, after);
            if (kind) {
                changed.push({
                    memberId: id, memberName: name, kind, kindLabel: KIND_JP[kind] || kind,
                    before, after,
                    beforeText: describeRows(before), afterText: describeRows(after),
                });
            } else {
                unchanged.push({ memberId: id, memberName: name });
            }
        });
        // 重い変化から並べる (運営が上から読めば影響の大きい人から把握できる)
        changed.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind)
            || String(x.memberName).localeCompare(String(y.memberName), 'ja'));
        return { first: false, changed, unchanged, totalAfter };
    }

    /**
     * 配信前の確認ダイアログ用の要約文。
     * @param {Object} diff diffPlans の戻り値
     * @param {number=} maxNames 名前を並べる上限
     */
    function summaryText(diff, maxNames = 8) {
        if (!diff) return '';
        if (diff.first) return `初回の配信です (${diff.totalAfter}名に割当があります)。`;
        const n = diff.changed.length;
        if (n === 0) return `前回の配信から割当の変わる人はいません (${diff.unchanged.length}名そのまま)。`;
        const names = diff.changed.slice(0, maxNames).map(c => c.memberName || '?');
        const rest = n > maxNames ? ` ほか${n - maxNames}名` : '';
        const byKind = {};
        diff.changed.forEach(c => { byKind[c.kind] = (byKind[c.kind] || 0) + 1; });
        const kinds = KIND_ORDER.filter(k => byKind[k]).map(k => `${KIND_JP[k]} ${byKind[k]}名`).join(' / ');
        return `${n}名の割当が変わります (そのまま ${diff.unchanged.length}名)。\n${kinds}\n対象: ${names.join('、')}${rest}`;
    }

    /** 変わった人の ID 配列 (Push の宛先を絞るのに使う) */
    function changedIds(diff) {
        return (diff && Array.isArray(diff.changed) ? diff.changed : []).map(c => c.memberId);
    }
    /** 変わらなかった人の ID 配列 (plan_acks を新しい plan_id へ引き継ぐ対象) */
    function unchangedIds(diff) {
        return (diff && Array.isArray(diff.unchanged) ? diff.unchanged : []).map(c => c.memberId);
    }

    root.planDiffDomain = {
        KIND_ORDER,
        KIND_JP,
        rowsByPlayer,
        coreKey,
        timeKey,
        teamKey,
        classify,
        describeRow,
        describeRows,
        diffPlans,
        summaryText,
        changedIds,
        unchangedIds,
    };
})(typeof window !== 'undefined' ? window : globalThis);
