// ============================================================================
// 👑 運営担当 (2026-09-12 ユーザー決定「ふるり がマスター運営。ふるり だけが運営担当を任命でき、任命された人が運営判定」)
//   役割は players.ops_role (46_ops_roles.sql): 'master' (1人) / 'ops' (任命された人) / NULL (メンバー)。
//   ★ 認証は無いので、これは**誤操作防止の役割分け**であって認可ではない (RLS anon 全許可・名乗りは自己申告)。
//   ★ 画面の出し分け (resolveMode):
//     master    → 🛠 トグルで 運営画面 ⇄ メンバー画面 を行き来できる (開発中の確認用)。記憶は端末ごと (OPS_MODE_KEY)
//     ops       → 名乗った時点で常に運営画面 (トグルは出さない)
//     null      → 常にメンバー画面 (トグルは出さない)
//     undefined → 役割がまだ読めていない = 従来どおり端末の記憶 (起動直後にちらつかせない・通信断で運営担当を落とさない)
//   ★ 運営あての通知 (予約の申請・取消希望・📣 の返事・締め凸の返事) は opsIds (master + ops、押した本人は除く) へ
// ============================================================================
(function (root) {
    'use strict';
    const ROLES = ['master', 'ops'];
    const ROLE_JP = { master: '👑 マスター運営', ops: '🛠 運営担当' };
    const rank = (r) => (r === 'master' ? 2 : r === 'ops' ? 1 : 0);

    /** players の行 (または {ops_role}) → 'master' | 'ops' | null。知らない値は null (メンバー) */
    function roleOf(player) {
        const r = player && typeof player === 'object' ? player.ops_role : null;
        return ROLES.includes(r) ? r : null;
    }
    function isOps(player) { return roleOf(player) !== null; }
    /** 任命・解任できるのは master だけ */
    function canAppoint(viewer) { return roleOf(viewer) === 'master'; }
    /** 運営あての通知の宛先 (master + ops)。書庫の人は除く。except = 押した本人 */
    function opsIds(players, { except } = {}) {
        return (Array.isArray(players) ? players : [])
            .filter(p => p && isOps(p) && !p.archived && (except == null || String(p.id) !== String(except)))
            .map(p => p.id);
    }
    /**
     * 運営画面にするか。role が undefined (まだ読めていない) のときは端末の記憶 (remembered) に従う。
     * @returns {{mode: boolean, canToggle: boolean, why: string}}
     */
    function resolveMode({ role, remembered } = {}) {
        if (role === undefined) return { mode: remembered === true, canToggle: true, why: 'unknown' };
        if (role === 'master') return { mode: remembered === true, canToggle: true, why: 'master' };
        if (role === 'ops') return { mode: true, canToggle: false, why: 'ops' };
        return { mode: false, canToggle: false, why: 'member' };
    }
    /** 任命パネルの並び: master → ops → 名前順。書庫・仮 (is_temp) は出さない */
    function appointable(players) {
        return (Array.isArray(players) ? players : [])
            .filter(p => p && !p.archived && !p.is_temp)
            .map(p => ({ id: p.id, name: p.name || `#${p.id}`, role: roleOf(p) }))
            .sort((a, b) => (rank(b.role) - rank(a.role)) || String(a.name).localeCompare(String(b.name), 'ja'));
    }

    root.opsRoleDomain = { ROLES, ROLE_JP, roleOf, isOps, canAppoint, opsIds, resolveMode, appointable };
})(typeof window !== 'undefined' ? window : globalThis);
