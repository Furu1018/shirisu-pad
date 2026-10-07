// ============================================================================
// 🆕 新しくなったこと (更新履歴) の判定 — 2026-10-08 (通知の見える化 F・ユーザー決定 Q3「更新内容は Claude が書く」)
// ----------------------------------------------------------------------------
// data/release-notes.json をリリースごとに 1 項目ずつ書き足す (メンバー向けの言葉で)。
//   { "notes": [ { "id": 2026100801, "date": "2026-10-08", "title": "…", "lines": ["…", "…"] }, … ] }
// ★ id は YYYYMMDDnn の整数で**不変**。端末は「読んだ id」を覚えるので、日付や文言を直しても再表示されない
//   (日付や並びを基準にすると、過去の項目の文言修正で全員に再表示される: Codex指摘 2026-10-08)
// ★ 初めての端末 (まだ何も読んでいない) には直近 FRESH_DAYS 日のものを FRESH_MAX 件まで (全部出すと長い)
// 画面側 (index.html の renderMyReleaseNotes / renderHelpReleaseNotes) は読む・描くだけで、判定はここが唯一
// ============================================================================
(function (root) {
    'use strict';

    const FRESH_DAYS = 30;
    const FRESH_MAX = 3;

    const isId = (v) => Number.isInteger(v) && v >= 2026010100 && v <= 2099123199;
    // 存在する日付だけ (2026-02-30 は Date.parse が繰り上げて通すので、往復して同じ文字列になるかで見る: Codex指摘)
    const isDate = (v) => {
        const s = String(v);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        const t = Date.parse(s + 'T00:00:00Z');
        return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
    };
    const toId = (v) => (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : v;

    /**
     * JSON を読める形に整える。壊れた項目 (id / date / title / lines のどれかが無い) は捨てる。
     * 同じ id が 2 回あれば先のものだけ。**新しい順 (id の降順)** に並べ直す (入力の並びに頼らない)。
     * @param {any} json  { notes: [...] } または配列
     * @returns {{id:number, date:string, title:string, lines:string[]}[]}
     */
    function normalize(json) {
        const list = Array.isArray(json) ? json : (json && Array.isArray(json.notes)) ? json.notes : [];
        const seen = new Set();
        const out = [];
        for (const n of list) {
            if (!n || typeof n !== 'object' || !isId(n.id) || seen.has(n.id)) continue;
            const title = String(n.title ?? '').trim();
            const lines = (Array.isArray(n.lines) ? n.lines : []).map(l => String(l ?? '').trim()).filter(Boolean);
            if (!title || !lines.length || !isDate(n.date)) continue;
            // id の日付部分 (YYYYMMDD) と date は一致させる (id は不変の鍵なので、ずれたまま入ると直せない)
            if (String(n.id).slice(0, 8) !== String(n.date).replace(/-/g, '')) continue;
            seen.add(n.id);
            out.push({ id: n.id, date: String(n.date), title, lines });
        }
        return out.sort((a, b) => b.id - a.id);
    }

    /** いちばん新しい id (読んだ印に覚える値)。無ければ null */
    function latestId(notes) {
        let best = null;
        for (const n of (Array.isArray(notes) ? notes : [])) if (n && isId(n.id) && (best == null || n.id > best)) best = n.id;
        return best;
    }

    /**
     * この端末がまだ読んでいない項目 (新しい順)。
     * @param {Object[]} notes       normalize の結果
     * @param {number|null} lastSeenId  端末が覚えている「読んだ id」。null = 初めて
     * @param {number} [now]         ms。初めての端末の「直近」の基準
     */
    function unseen(notes, lastSeenId, now) {
        const list = (Array.isArray(notes) ? notes : []).filter(n => n && isId(n.id)).slice().sort((a, b) => b.id - a.id);
        const seen = toId(lastSeenId);   // localStorage の値 (数字の文字列) をそのまま渡されても読む
        if (isId(seen)) return list.filter(n => n.id > seen);
        // 「直近 30 日」は**端末のローカル日付**で数える (時刻差だと、その日の 0 時を過ぎた時点で 30 日前の項目が外れる。
        //   UTC の日だと日本の 0〜9 時が前日になる: Codex指摘)。項目の date も同じローカル日付の 0 時として読む
        const t = new Date(Number.isFinite(now) ? now : Date.now());
        const sinceDay = new Date(t.getFullYear(), t.getMonth(), t.getDate() - FRESH_DAYS).getTime();
        const dayOf = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
        return list.filter(n => dayOf(n.date) >= sinceDay).slice(0, FRESH_MAX);
    }

    root.releaseNotesDomain = { FRESH_DAYS, FRESH_MAX, normalize, latestId, unseen, isId };
})(typeof window !== 'undefined' ? window : globalThis);
