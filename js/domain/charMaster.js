// ============================================================================
// ドメイン: キャラマスタの手動登録と二者確認 (運営改修 #6 — 2026-08-31)
// ----------------------------------------------------------------------------
// 背景: 2026-08-21 に手動登録した素体ソリン/ブリッドがスキン版と混同されて B1 (正: B3) で
// 入り、誰も検証しないまま GB の編成ピッカーまで波及した。運営の手動登録は
// 「要確認 (is_confirmed=false + registered_by)」で入れ、登録者とは別の運営が根拠URLを見て
// 確定する。1人運営の逃げ道として、登録から24時間経てば本人でも確定できる。
//
// is_confirmed=false でも編成・OCR解決には使える (除外する経路は無い)。表示と GB のゴースト
// 判定 (未確認 + バースト無し + アイコン無し) にだけ効くので、バーストを必須にしておけば
// 要確認キャラが GB から落ちることはない。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    /** 登録者本人が自己確定できるまでの時間 */
    const SELF_VERIFY_AFTER_MS = 24 * 60 * 60 * 1000;

    const normName = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();

    /**
     * 行の確認状態。一覧のバッジと編集モーダルの表示に使う。
     * @param {{is_confirmed?:boolean, registered_by?:string|null, verified_by?:string|null}} row
     * @returns {{kind:'verified'|'needs_review'|'unconfirmed', label:string}}
     */
    function verificationState(row) {
        if (!row) return { kind: 'unconfirmed', label: '⚠未確定' };
        if (row.is_confirmed) return { kind: 'verified', label: row.verified_by ? `✅確定 (${row.verified_by})` : '✅確定' };
        if (row.registered_by) return { kind: 'needs_review', label: `🔍要確認 (登録: ${row.registered_by})` };
        return { kind: 'unconfirmed', label: '⚠未確定' };
    }

    /**
     * 「この人が今この行を確定してよいか」。
     * - 確認者を特定できない (ホームで自分を選んでいない) → 不可
     * - 登録者本人 → 登録から SELF_VERIFY_AFTER_MS 経過後のみ可
     * - それ以外 (別の運営) → 可
     * @param {{registeredBy?:string|null, registeredAt?:string|number|Date|null, actorName?:string|null, now?:number}} args
     * @returns {{ok:boolean, reason:string, selfVerify:boolean}}
     */
    function canVerify({ registeredBy, registeredAt, actorName, now } = {}) {
        const actor = normName(actorName);
        if (!actor) return { ok: false, selfVerify: false, reason: '確認者を特定できません — ホームで自分を選択してから操作してください' };
        const reg = normName(registeredBy);
        if (!reg || reg !== actor) return { ok: true, selfVerify: false, reason: '' };
        const t = registeredAt ? new Date(registeredAt).getTime() : NaN;
        const nowMs = typeof now === 'number' ? now : Date.now();
        if (Number.isFinite(t) && nowMs - t >= SELF_VERIFY_AFTER_MS) {
            return { ok: true, selfVerify: true, reason: '登録から24時間以上経過しているため本人でも確定できます' };
        }
        const left = Number.isFinite(t) ? Math.max(0, Math.ceil((SELF_VERIFY_AFTER_MS - (nowMs - t)) / 3600000)) : null;
        return {
            ok: false, selfVerify: true,
            reason: `登録者本人は確定できません (別の運営が根拠を見て確定するのが原則${left != null ? `。あと約${left}時間で本人でも可` : ''})`,
        };
    }

    /** 根拠URLとして受け付ける形式 (http/https の絶対URL・空白なし) */
    function isValidSourceUrl(s) {
        return typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
    }

    root.charMasterDomain = { verificationState, canVerify, isValidSourceUrl, SELF_VERIFY_AFTER_MS };
})(typeof window !== 'undefined' ? window : globalThis);
