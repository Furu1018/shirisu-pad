// ============================================================================
// 通知の宛先を決める — 純ロジック (2026-10-07 ユーザー決定)
// ----------------------------------------------------------------------------
// 「誰に届けるか」の判定はここが唯一。送る側 (js/supabase-client.js の sendPushNotification) が
// 必ずここを通し、Edge Function には**決まった宛先だけ**を渡す (時間帯フィルタは使わない)。
//
// 通知は 3 種類:
//   direct  あなた宛      本人の約束・行動が要るもの (締め凸の打診・📣 お願い・予約の承認・割当の変更・催促)。必ず届ける
//   team    チームの状況   全員で共有する節目 (Lv 開放・最後の 1 体・定時の戦況まとめ・疎通確認・運営の一斉連絡)。在籍の全員へ
//   test    テスト        テスト回 (seasons.is_test) の通知すべて と、運営が「テストとして送る」を選んだもの。
//                        運営担当 (master / ops) と「テスト通知を受け取る」を ON にした人 (players.notify_test・SQL 48) だけ
//
// なぜこの形か (実データ 2026-10-07):
//   - 通知を自分で解除した人は 3 か月で 0 人。届かない原因はアプリ側の絞り込み (戦闘可能時間のフィルタ) だった
//   - うるさかったのはテスト回の通知。テストを運営担当だけにすれば、メンバーが通知を切る理由が無くなる
//   - だから「アプリの中の通知 OFF」は置かない。代わりに「テスト通知を受け取るか」だけを本人が選ぶ
//
// 決めごと:
//   - 書庫に入った人 (archived) には何も送らない (プレイヤー一覧から消えても購読は残る = PAD にいない人に届いていた)
//   - 名簿が取れなかった (players: null) ときは**絞らない** (fail-open)。絞ると通信の不調で本人あての連絡が消える。
//     テスト回で名簿が取れないと全員に届き得るが、うるさいだけで実害は無い — 逆 (本番で届かない) を避ける
//   - シーズンが分からない (season: null) ときは、**全員あて・チームの状況だけ**テストと同じ絞り込みにする (Codex指摘 2026-10-07)。
//     テスト回かもしれない通知を全員に流さない。あなた宛 (名指し) は絞らない — 本人の連絡を通信の不調で消さない
//   - 名簿に居ない id は落とさない (登録したばかりの人。名簿の写しは少し古いことがある)。落とすのは「書庫と分かっている id」だけ。
//     ただしテストは「協力者と分かっている id」だけに送る
// ============================================================================
(function (root) {
    'use strict';

    const KINDS = ['direct', 'team', 'test'];
    const TIER_JP = { direct: 'あなた宛', team: 'チームの状況', test: '🧪 テスト' };

    /** 運営担当か (master / ops)。46 未適用 (ops_role が無い) なら誰も運営担当ではない */
    const isOps = (p) => !!p && (p.ops_role === 'master' || p.ops_role === 'ops');
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

    /**
     * @param {{kind?:string, playerIds?:any[]|null}} req  playerIds 省略・null・[] = 全員あて
     * @param {{players?:({id:any, archived?:boolean, ops_role?:string|null, notify_test?:boolean}[]|null), season?:({is_test?:boolean}|null)}} [aud]
     *   players: null = 名簿が取れなかった / season: null = アクティブなシーズンが分からない (テスト回とは見なさない)
     * @returns {{playerIds:number[]|null, tier:'direct'|'team'|'test', broadcast:boolean, restricted:boolean,
     *            dropped:{archived:number, notTester:number}}}
     *   playerIds: null = 絞れなかった (名簿なし・全員あて) → 送る側は全購読者へ / [] = 送る相手が居ない (送らない)
     *   restricted: テストの絞り込みをしたか (true のとき「全員あて」と記録しない)。シーズンが分からない全員あても true
     */
    function resolve(req, aud) {
        const r = req || {}, a = aud || {};
        const asked = Array.isArray(r.playerIds) ? r.playerIds.map(num).filter(v => v != null) : [];
        const broadcast = asked.length === 0;
        const isTest = r.kind === 'test' || !!(a.season && a.season.is_test);
        const tier = isTest ? 'test' : ((broadcast || r.kind === 'team') ? 'team' : 'direct');
        // シーズンが読めなかった (null / undefined) → チームの状況はテストと同じ絞り込み (テスト回かもしれない通知を全員に流さない)
        const seasonUnknown = a.season == null;
        const restrict = isTest || (seasonUnknown && tier === 'team');
        const dropped = { archived: 0, notTester: 0 };
        const roster = Array.isArray(a.players) ? a.players : null;
        if (!roster) {
            // 名簿なし: 絞らない (fail-open)。重複だけ除く
            return { playerIds: broadcast ? null : [...new Set(asked)], tier, broadcast, restricted: false, dropped };
        }
        const archived = new Set(), active = [], testers = new Set();
        for (const p of roster) {
            const id = num(p && p.id);
            if (id == null) continue;
            if (p.archived) { archived.add(id); continue; }
            active.push(id);
            if (isOps(p) || p.notify_test) testers.add(id);
        }
        let ids = broadcast ? active.slice() : [...new Set(asked)].filter(id => {
            if (archived.has(id)) { dropped.archived++; return false; }
            return true;
        });
        if (restrict) {
            ids = ids.filter(id => {
                if (testers.has(id)) return true;
                dropped.notTester++;
                return false;
            });
        }
        return { playerIds: ids, tier, broadcast, restricted: restrict, dropped };
    }

    /** プレビューや記録に出す、その通知の種類の名前 */
    const tierLabel = (tier) => TIER_JP[tier] || TIER_JP.direct;

    root.notifyPolicyDomain = { KINDS, resolve, tierLabel, isOps };
})(typeof globalThis !== 'undefined' ? globalThis : this);
