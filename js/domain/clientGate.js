// ============================================================================
// ドメイン: 互換ゲート (L2 ⑦ — 41_client_gate.sql)
// ----------------------------------------------------------------------------
// 「予約を知らない古いアプリ」が事故を起こすのを止めるための純ロジック。
// 古いアプリは ①予約を無視したプランを表示し ②凸を直に insert して予約を消し込まず
// ③配信し直して予約入りのプランを上書きする。どれも約束を守る仕組みを内側から壊す。
//
// ★ 2段階リリースが前提: 先にゲートを配り (min_client_build = 0 のまま = 誰も止めない)、
//   全員に行き渡ってから運営が値を上げる。ゲートを配る回に締めると、
//   締められた側に更新経路が無くなる。
//
// ★ **fail-open**。ゲートが読めない・値が壊れているときは通す。
//   一時的な通信断でユニオン全員のアプリを止める方が害が大きい。
//   これは事故防止であって認可ではない (RLS は anon 全許可のまま — CLAUDE.md 参照)。
//
// ★ 止めるのは **プラン表示・凸報告・配信の3つだけ**。模擬の提出・時間帯の登録・
//   キャラ図鑑まで止めると、更新できない人が何もできなくなる。
//
// DOM/Supabase 非依存で node からテスト可: node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    // ゲートが止められる操作。これ以外は何があっても通す
    const FEATURES = ['plan', 'attack', 'publish'];

    const FEATURE_JP = {
        plan: '凸プランの表示',
        attack: '凸の報告',
        publish: 'プランの配信',
    };

    const DEFAULT_MESSAGE = 'アプリが古いため、この操作は止めています。ページを再読み込みしてください。';

    // 数値として読める値だけを採る。null/undefined/文字列ゴミは「制限なし」に倒す (fail-open)。
    // ★ 安全整数だけを通す (Codex指摘 2026-09-07) — SQL の BIGINT は JS の安全整数を超え得るし、
    //   1.5 のような小数や valueOf が投げる値を版番号として扱うと比較が壊れる
    function _num(v, fallback = 0) {
        let n;
        try { n = Number(v); } catch { return fallback; }
        return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
    }

    /**
     * ゲート行を正規化する。読めなければ null (= 制限なし)。
     * @param {{min_client_build?:any, min_plan_schema?:any, message?:any}|null|undefined} row
     */
    function normalizeGate(row) {
        if (!row || typeof row !== 'object') return null;
        // ★ 値の取り出しごと try で囲む (Codex指摘 2026-09-07)。
        //   getter が投げる行を渡されても、ゲートは「制限なし」に倒すだけで落ちてはいけない
        const pick = (k) => { try { return row[k]; } catch { return undefined; } };
        const raw = pick('message');
        const msg = typeof raw === 'string' ? raw.trim() : '';
        return {
            minClientBuild: _num(pick('min_client_build'), 0),
            minPlanSchema: _num(pick('min_plan_schema'), 0),
            message: msg || '',
        };
    }

    /**
     * このクライアントが止められるか。
     * @param {{build:number, gate:object|null}} args
     * @returns {{blocked:boolean, minBuild:number, build:number, message:string}}
     */
    function evaluate({ build, gate } = {}) {
        const g = normalizeGate(gate);
        const b = _num(build, 0);
        // ★ ゲートが無い / 読めない / 0 なら通す
        const minBuild = g ? g.minClientBuild : 0;
        return {
            blocked: minBuild > 0 && b < minBuild,
            build: b,
            minBuild,
            message: (g && g.message) || DEFAULT_MESSAGE,
        };
    }

    /** 指定の操作が使えるか。止める対象は FEATURES の3つだけ */
    function allows(verdict, feature) {
        if (!verdict || !verdict.blocked) return true;
        return !FEATURES.includes(feature);
    }

    /**
     * 配信プランを表示してよいか。
     * ★ プランの版が **自分の読める版より新しい** ときも表示しない —
     *   予約入りのプランを予約を知らない画面で描くと、実際とは違う指示を見せることになる。
     * @param {{planSchema:any, supportedSchema:number, gate:object|null}} args
     */
    function planReadable({ planSchema, supportedSchema, gate } = {}) {
        const g = normalizeGate(gate);
        const ps = _num(planSchema, 0);           // 版を持たない旧配信は 0
        const mine = _num(supportedSchema, 0);
        if (ps > mine) return { readable: false, reason: 'too_new', planSchema: ps, supported: mine };
        // 運営が「この版より古い配信は読ませない」と決めたとき (旧配信の掃除)
        const min = g ? g.minPlanSchema : 0;
        if (min > 0 && ps < min) return { readable: false, reason: 'too_old', planSchema: ps, supported: mine };
        return { readable: true, reason: null, planSchema: ps, supported: mine };
    }

    /** 画面に出す一文 */
    function describe(verdict) {
        if (!verdict || !verdict.blocked) return '';
        return `${verdict.message} (いまの版 ${verdict.build} / 必要な版 ${verdict.minBuild})`;
    }

    root.clientGateDomain = {
        FEATURES, FEATURE_JP, DEFAULT_MESSAGE,
        normalizeGate, evaluate, allows, planReadable, describe,
    };
})(typeof window !== 'undefined' ? window : globalThis);
