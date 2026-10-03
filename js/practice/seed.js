// ============================================================================
// 練習モードの種データ (架空のユニオン 31 人)
// ============================================================================
// ★ メンバーは**架空の名前** (本物のメンバーと取り違えないため)。数値は乱数を使わず、番号から決める
//   (何度始めても同じ盤面 = 案内どおりに進められる)。
// ★ 表の形は supabase/*.sql と同じ (js/practice/server.js の SCHEMA が既定値を当てる)。
// ============================================================================

export const IDS = { season: 9001, me: 9101, ops: 9102, firstMember: 9103 };
export const ME_NAME = 'あなた (練習)';
export const OPS_NAME = '運営役 (練習)';

// 模擬がまだの 4 人 (運営編の催促の相手)。先頭に置く
const MEMBER_NAMES = ['ミケ', 'ハチ', 'コトラ', 'シロ', 'クロ', 'タマ', 'モモ', 'ソラ', 'レオ', 'ココ', 'マロン', 'チョコ', 'ムギ', 'リン', 'ハナ',
    'ユキ', 'ルナ', 'ベル', 'モカ', 'きなこ', 'あずき', 'こむぎ', 'だいふく', 'おはぎ', 'わらび', 'ごま', 'しらたま', 'よもぎ', 'かりん'];
export const NOT_SUBMITTED = 4;

const ATTRS = ['fire', 'water', 'electric', 'iron', 'wind'];
// ボス: コード → 属性 と 弱点 (js/supabase-client.js の SEASON_ATTR_FROM_CODE / SEASON_WEAKNESS_BY_ATTR と同じ表)
const BOSSES = [
    { boss_number: 1, boss_code: 'H.S.T.A.', name: 'ドリアン',         attribute: 'fire',     weakness: 'water',    tier: 'lord' },
    { boss_number: 2, boss_code: 'Z.E.U.S.', name: 'フィンガーズ',     attribute: 'electric', weakness: 'iron',     tier: 'lord' },
    { boss_number: 3, boss_code: 'A.N.M.I.', name: 'ストームブリンガー', attribute: 'wind',     weakness: 'fire',     tier: 'tyrant' },
    { boss_number: 4, boss_code: 'D.M.T.R.', name: 'グレイブディガー',   attribute: 'iron',     weakness: 'wind',     tier: 'lord' },
    { boss_number: 5, boss_code: 'P.S.I.D.', name: 'クラーケン',         attribute: 'water',    weakness: 'electric', tier: 'tyrant' },
];
const HARD_LV1_HP = { lord: 99856279200, tyrant: 150841813600 };   // supabaseCreateSeason と同じ

// キャラマスタが取れなかったとき (オフライン・テスト) の最小の一覧。アイコンは無い
export const FALLBACK_CHARACTERS = (() => {
    const out = [];
    for (let i = 1; i <= 6; i++) out.push({ canonical_name: `練習B1-${i}`, burst: 'B1' });
    for (let i = 1; i <= 6; i++) out.push({ canonical_name: `練習B2-${i}`, burst: 'B2' });
    for (let i = 1; i <= 18; i++) out.push({ canonical_name: `練習B3-${i}`, burst: 'B3' });
    return out.map(c => ({ ...c, is_confirmed: true, icon_paths: [], aliases: [], sighting_count: 0 }));
})();

const slots = (from, to) => { const out = []; for (let h = from; h !== to; h = (h + 1) % 24) out.push('h' + String(h).padStart(2, '0')); return out; };
// 戦闘可能時間の型 (夜型が多い・朝型と昼型が少し)
const AVAIL_PATTERNS = [slots(19, 0), slots(20, 1), slots(21, 2), slots(18, 23), slots(5, 9), slots(12, 17), slots(22, 3), slots(19, 23)];

/** その人のその属性の編成 (5人)。同じ人の中ではキャラが被らないように回す */
function teamOf(pools, m, k) {
    const pick = (arr, i) => arr.length ? arr[i % arr.length] : null;
    const { b1, b2, b3 } = pools;
    return [pick(b1, m + k), pick(b2, m * 2 + k), pick(b3, m * 3 + k * 3), pick(b3, m * 3 + k * 3 + 1), pick(b3, m * 3 + k * 3 + 2)].filter(Boolean);
}
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {{hardDate:string, characters?:Object[]}} o hardDate = 'YYYY-MM-DD' (練習のレイド日)
 * @returns {Object<string, Object[]>} 表 → 行
 */
export function buildSeed({ hardDate, characters } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hardDate || ''))) throw new Error('hardDate (YYYY-MM-DD) が必要です');
    const master = (Array.isArray(characters) && characters.length >= 20 ? characters : FALLBACK_CHARACTERS)
        .filter(c => c && c.canonical_name);
    // 編成に使うのは 確認済み・アイコンあり を優先 (無ければある分で)
    const usable = master.filter(c => c.is_confirmed !== false && Array.isArray(c.icon_paths) && c.icon_paths.length);
    const base = (usable.length >= 25 ? usable : master).slice().sort((a, b) =>
        (Number(b.sighting_count) || 0) - (Number(a.sighting_count) || 0) || String(a.canonical_name).localeCompare(String(b.canonical_name), 'ja'));
    const pools = { b1: base.filter(c => c.burst === 'B1').map(c => c.canonical_name),
        b2: base.filter(c => c.burst === 'B2').map(c => c.canonical_name),
        b3: base.filter(c => c.burst === 'B3').map(c => c.canonical_name) };

    const players = [], availability = [], sync = [], damages = [], confirms = [], subs = [];
    const add = (id, name, extra = {}) => players.push({ id, name, ...extra });
    add(IDS.me, ME_NAME);
    add(IDS.ops, OPS_NAME, { ops_role: 'ops', ops_appointed_by: 'ふるり' });
    MEMBER_NAMES.forEach((name, i) => add(IDS.firstMember + i, name, { flex_time: i % 9 === 8 }));

    players.forEach((p, m) => {
        const isMe = p.id === IDS.me;
        const idx = m - 2;   // 架空メンバーの通し番号 (0〜)
        const slv = isMe ? 612 : p.id === IDS.ops ? 628 : 566 + ((idx * 37) % 70);
        sync.push({ season_id: IDS.season, player_id: p.id, sync_level: slv });
        const hours = isMe ? slots(19, 0) : AVAIL_PATTERNS[m % AVAIL_PATTERNS.length];
        for (const h of hours) availability.push({ player_id: p.id, time_slot: h });
        const notYet = !isMe && p.id !== IDS.ops && idx < NOT_SUBMITTED;
        // 今期の確認: 自分 (これから練習で押す) と 模擬がまだの人 以外は済み
        if (!isMe && !notYet) confirms.push({ season_id: IDS.season, player_id: p.id, unavailable: false, slot_count: hours.length, slots_snapshot: hours });
        // 通知の購読は全員 (催促は購読者にしか送れない。未提出の人が購読していないと、運営編の催促が押せない)
        subs.push({ player_id: p.id, endpoint: `practice://push/${p.id}`, p256dh: 'practice', auth: 'practice' });
        if (notYet) return;
        // 模擬: 自分は 灼熱PT だけ未提出 (練習で出す)。ほかの人は 3〜5 属性
        ATTRS.forEach((attr, k) => {
            if (isMe && attr === 'fire') return;
            if (!isMe && (m + k) % 5 === 0 && k >= 3) return;   // 一部の人は 4 属性まで
            const dmg = isMe ? { water: 24.6, electric: 26.1, iron: 22.8, wind: 28.4 }[attr]
                : round3(19 + (slv - 560) / 6 + ((m * 7 + k * 5) % 9) * 0.7);
            damages.push({ player_id: p.id, attribute: attr, slot: 1, damage_b: dmg, characters: teamOf(pools, m, k) });
        });
    });

    return {
        seasons: [{ id: IDS.season, month_key: hardDate.slice(0, 7), hard_date: hardDate, current_level: 1, is_active: true, is_test: false }],
        bosses: BOSSES.map(b => ({ season_id: IDS.season, ...b, total_hp_raw: HARD_LV1_HP[b.tier], remaining_hp_raw: HARD_LV1_HP[b.tier] })),
        players,
        availability,
        player_sync_levels: sync,
        player_damages: damages,
        availability_confirmations: confirms,
        push_subscriptions: subs,
        nikke_characters: master.map(c => ({ ...c })),
        app_gate: [{ id: 1, min_client_build: 0, min_plan_schema: 0 }],
    };
}
