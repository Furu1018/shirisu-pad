// ============================================================================
// 練習モードのセッション: 偽のサーバを用意して js/supabase-client.js に渡す
// ============================================================================
// ★ ここは練習モードのときだけ読み込まれる (js/supabase-client.js が window.PAD_PRACTICE を見て import する)。
// ★ 本物の DB への書き込みは**構造的に無い**: 本物の Supabase クライアントを作らない。
//   本物に触れるのは下の fetchCharacters の **GET 1 回だけ** (キャラの名前とアイコンの表を読む。書かない)。
// ============================================================================
import { createPracticeClient } from './server.js';
import { buildSeed, FALLBACK_CHARACTERS } from './seed.js';

async function fetchCharacters(url, key) {
    try {
        const res = await fetch(`${url}/rest/v1/nikke_characters?select=*`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length >= 20) return rows;
    } catch (e) { console.warn('[練習] キャラの表を読めませんでした (名前だけの見本で続けます):', e?.message || e); }
    return FALLBACK_CHARACTERS;
}

export async function createPracticeSupabase(P, { url, key }) {
    let timer = null;
    const emit = (type, detail) => { try { window.dispatchEvent(new CustomEvent('padpractice', { detail: { type, ...detail } })); } catch (_) { /* 古い環境 */ } };
    // 途中経過の控え。書き込みのたびに少し待ってからまとめて控える (連続した書き込みで毎回 100KB 超を書かない)。
    // ★ 読み込み直す前・画面を離れる前は**待たずに**控える (P.save)。待っている間に読み込み直すと、直前の書き込みが消える
    //   (2026-10-02 に実際に踏んだ: 「当日に進める」で入れたほかのメンバーの凸が、読み込み直しで消えていた)
    const save = () => {
        clearTimeout(timer); timer = null;
        if (P.closed) return;   // やめた・やり直した あとは控えない (画面を離れるときの控えが、消したばかりの記憶を書き戻す)
        try { P.store.set('db', client.__db.dump()); } catch (e) { console.warn('[練習] 途中経過を保存できません:', e?.message || e); }
    };
    const client = createPracticeClient({
        now: () => Date.now(),   // 練習の時計 (boot.js が Date を差し替えている)
        onChange: () => {
            clearTimeout(timer);
            timer = setTimeout(save, 150);
            emit('change', {});
        },
        onPush: (item) => emit('push', { item }),
    });
    P.save = save;
    try { window.addEventListener('pagehide', save); } catch (_) { /* 画面の無い環境 (テスト) */ }
    const saved = P.store.get('db');
    let restored = false;
    if (saved) { try { restored = client.__db.restore(saved); } catch (_) { restored = false; } }
    if (!restored) {
        client.__db.load(buildSeed({ hardDate: P.hardDate, characters: await fetchCharacters(url, key) }));
        save();
    }
    P.db = client.__db;
    return client;
}
