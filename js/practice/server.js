// ============================================================================
// しりすこPAD 練習モード: 端末の中だけで動く「偽のサーバ」
// ============================================================================
// 練習モード (ヘルプ ›「🎮 練習する」) では、本番の画面と js/supabase-client.js の関数を**そのまま**動かす。
// 差し替えるのはここだけ = Supabase クライアントと同じ口 (from / rpc / functions / storage) を、
// 端末のメモリの中の表で受ける。だから練習中は本物の DB へ 1 行も届かない (そもそも本物のクライアントを作らない)。
//
// ★ 本番と揃えるもの (supabase/*.sql を写している。SQL を変えたらここも直すこと):
//   - 表ごとの主キー・一意制約・既定値 (SCHEMA)
//   - plan_reservations のトリガー (39 残凸の枠 / 39 状態は RPC 経由のみ・承認後は中身を変えない / 47 📌 と約束の枠)
//   - RPC: report_attack (40) / reservation_set_status (47)
//   揃えないもの (承知のうえ): CHECK 制約の大半・外部キーの存在確認・player_damages の levels 畳み直し (31。新しいクライアントは常に揃えて送る)
// ★ 使える問い合わせの口は BUILDER_METHODS が唯一。js/supabase-client.js がここに無い口を使ったら
//   tests/run-tests.mjs が落ちる (本番にだけ足して練習が黙って壊れる、を防ぐ)
// ============================================================================

const NOW = Symbol('now');
const ACTIVE = ['requested', 'approved', 'cancel_requested'];
const HOLD_RE = /^h(0[0-9]|1[0-9]|2[0-3])$/;

export const BUILDER_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'in', 'is', 'or', 'contains', 'order', 'limit', 'range', 'single', 'maybeSingle'];

// 表の定義。uniques は { cols, where? } (where = 部分一意索引の条件)。
// ★ 列は「pk ∪ required (NOT NULL で既定値なし) ∪ defaults の鍵」で言い尽くす。supabase/*.sql に列を足したら
//   ここにも足すこと — tests/run-tests.mjs が SQL と突き合わせ、ずれていたら落ちる
export const SCHEMA = {
    players: { pk: ['id'], required: ['name'], serial: 'id', touch: 'updated_at', uniques: [{ cols: ['name'] }, { cols: ['blabla_openid'] }],
        defaults: { finish_alert: true, is_temp: false, notes: null, auth_user_id: null, created_at: NOW, updated_at: NOW, archived: false,
            avatar_url: null, avatar_character: null, strong_attributes: () => [], flex_time: false, notify_all_hours: false,
            blabla_openid: null, ops_role: null, ops_appointed_by: null, ops_appointed_at: null, notify_test: false } },
    player_damages: { pk: ['player_id', 'attribute', 'slot'], required: ['player_id', 'attribute'], touch: 'updated_at',
        defaults: { damage_b: 0, updated_at: NOW, characters: () => [], slot: 1, boss_level: null, levels: null,
            excluded_at: null, excluded_by: null, excluded_reason: null } },
    seasons: { pk: ['id'], required: ['month_key', 'hard_date'], serial: 'id', uniques: [{ cols: ['month_key'] }],
        defaults: { current_level: 1, union_rank: null, is_active: false, metadata: () => ({}), created_at: NOW, is_test: false } },
    bosses: { pk: ['season_id', 'boss_number'], required: ['season_id', 'boss_number', 'boss_code', 'attribute', 'weakness', 'tier'], touch: 'updated_at', uniques: [{ cols: ['season_id', 'boss_code'] }],
        defaults: { name: null, total_hp_raw: 0, remaining_hp_raw: 0, updated_at: NOW } },
    player_sync_levels: { pk: ['season_id', 'player_id'], required: ['season_id', 'player_id'], defaults: { sync_level: 0 } },
    attacks: { pk: ['id'], required: ['season_id', 'player_id', 'attack_date', 'attack_number'], serial: 'id', uniques: [{ cols: ['reservation_id'] }],
        defaults: { boss_number: null, boss_code: null, damage_raw: 0, level: 1, characters: () => [], reported_at: NOW, reservation_id: null } },
    day_offs: { pk: ['player_id', 'date'], required: ['player_id', 'date'], defaults: {} },
    availability: { pk: ['player_id', 'time_slot'], required: ['player_id', 'time_slot'], defaults: {} },
    finish_claims: { pk: ['season_id', 'level', 'boss_number', 'date'], required: ['season_id', 'level', 'boss_number', 'date'], defaults: { claimed_by: null, claimed_at: null } },
    fururi_simulation_scores: { pk: ['season_id', 'boss_code'], required: ['season_id', 'boss_code', 'damage_raw'], defaults: {} },
    push_subscriptions: { pk: ['id'], required: ['player_id', 'endpoint', 'p256dh', 'auth'], serial: 'id', uniques: [{ cols: ['endpoint'] }], defaults: { user_agent: null, created_at: NOW } },
    push_notifications_log: { pk: ['id'], required: ['title'], serial: 'id',
        defaults: { sent_at: NOW, body: '', url: null, target_kind: 'all', target_player_ids: null, sender_player_id: null, sent_count: 0, target_count: 0 } },
    nikke_characters: { pk: ['canonical_name'], required: ['canonical_name'],
        defaults: { aliases: () => [], sighting_count: 0, first_seen: NOW, last_seen: NOW, is_confirmed: false, notes: null, icon_paths: () => [],
            burst: null, burst_alt: null, created_by_test_season_id: null, registered_by: null, verification_source: null, verified_by: null, verified_at: null } },
    finish_coordinations: { pk: ['player_id'], required: ['player_id', 'expires_at'],
        defaults: { boss_number: null, attribute: null, note: null, started_at: NOW, updated_at: NOW, status: 'coordinating' } },
    published_plans: { pk: ['id'], required: ['season_id', 'plan'], serial: 'id',
        defaults: { published_by: null, published_by_name: null, published_at: NOW, frozen_at: null, frozen_by: null, plan_schema: null } },
    activity_log: { pk: ['id'], required: ['event_type', 'detail'], serial: 'id', defaults: { player_id: null, player_name: null, actor_name: null, created_at: NOW } },
    finish_requests: { pk: ['id'], required: ['season_id', 'boss_number', 'player_id'], serial: 'id', uniques: [{ cols: ['offer_id', 'plan_key', 'player_id'] }],
        defaults: { status: 'pending', requested_at: NOW, responded_at: null, raid_level: null, offer_id: null, plan_key: null, deadline_at: null } },
    plan_acks: { pk: ['season_id', 'player_id'], required: ['season_id', 'player_id', 'plan_id'], defaults: { acked_at: NOW } },
    raid_event_notices: { pk: ['season_id', 'kind', 'ref'], required: ['season_id', 'kind', 'ref'], defaults: { claimed_at: NOW, sent: false, notified_by: null } },
    availability_confirmations: { pk: ['season_id', 'player_id'], required: ['season_id', 'player_id'],
        defaults: { confirmed_at: NOW, unavailable: false, slot_count: null, slots_snapshot: null } },
    plan_reservations: { pk: ['id'], required: ['season_id', 'player_id', 'boss_number', 'loadout_slot'], serial: 'id',
        uniques: [
            { cols: ['season_id', 'player_id', 'boss_number', 'loadout_slot'], where: (r) => ACTIVE.includes(r.status) },   // 42 uq_plan_reservations_active_card
            { cols: ['season_id', 'player_id', 'boss_number', 'loadout_slot'], where: (r) => r.status === 'pinned' },        // 45 uq_plan_reservations_pin_card
        ],
        defaults: { raid_level: null, time_mode: 'fixed', time_slot: null, characters_snapshot: () => [], expected_damage_b: null,
            source_type: 'self', source_plan_id: null, source_finish_request_id: null, status: 'requested', requested_by: null, requested_at: NOW,
            approved_by: null, approved_at: null, approved_plan_id: null, released_by: null, released_at: null, release_reason: null, updated_at: NOW,
            pinned_by: null, pinned_at: null, asked_at: null, ask_deadline_at: null } },
    plan_reservation_events: { pk: ['id'], required: ['reservation_id', 'to_status'], serial: 'id', appendOnly: true, defaults: { from_status: null, actor_name: null, reason: null, created_at: NOW } },
    app_gate: { pk: ['id'], required: [], defaults: { id: 1, min_client_build: 0, min_plan_schema: 0, message: null, updated_by: null, updated_at: NOW } },
    member_growth: { pk: ['season_id', 'player_id', 'character_name'], required: ['season_id', 'player_id', 'character_name'],
        defaults: { name_code: null, grade: null, core: null, lv: null, skill1_lv: null, skill2_lv: null, ulti_skill_lv: null, combat: null, attractive_lv: null,
            harmony_cube_tid: null, harmony_cube_lv: null, favorite_item_tid: null, favorite_item_lv: null, equip: null, overload: null, fetched_at: NOW } },
    member_growth_status: { pk: ['season_id', 'player_id'], required: ['season_id', 'player_id', 'status'], defaults: { detail: null, character_count: null, checked_at: NOW } },
};
// ON DELETE CASCADE (親の行を消したら子も消す)。{ 親: [[子, 列], ...] }
const CASCADE = {
    seasons: Object.keys(SCHEMA).filter(t => ['bosses', 'player_sync_levels', 'attacks', 'finish_claims', 'fururi_simulation_scores', 'published_plans',
        'finish_requests', 'plan_acks', 'raid_event_notices', 'availability_confirmations', 'plan_reservations', 'member_growth', 'member_growth_status'].includes(t)).map(t => [t, 'season_id']),
    players: ['player_damages', 'player_sync_levels', 'attacks', 'day_offs', 'availability', 'push_subscriptions', 'finish_coordinations', 'finish_requests',
        'plan_acks', 'availability_confirmations', 'plan_reservations', 'member_growth', 'member_growth_status'].map(t => [t, 'player_id']),
    plan_reservations: [['plan_reservation_events', 'reservation_id']],
};
// 埋め込み (select の `players(name)`)。{ 埋め込む表: 自分の側の列 }
const EMBED_FK = { players: 'player_id', seasons: 'season_id' };

class PgError extends Error {
    constructor(code, message) { super(message); this.code = code; }
    toJSON() { return { code: this.code, message: this.message, details: null, hint: null }; }
}
const check = (msg) => new PgError('23514', msg);
const clone = (v) => (v == null || typeof v !== 'object') ? v : JSON.parse(JSON.stringify(v));
const isNumLike = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()));
const isDateLike = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
function eqv(a, b) {
    if (a == null || b == null) return false;   // SQL の = は NULL に一致しない
    if (isNumLike(a) && isNumLike(b)) return Number(a) === Number(b);
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
}
function cmp(a, b) {
    if (isNumLike(a) && isNumLike(b)) return Number(a) - Number(b);
    if (isDateLike(a) && isDateLike(b)) { const x = Date.parse(a), y = Date.parse(b); if (Number.isFinite(x) && Number.isFinite(y)) return x - y; }
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function literal(s) { return s === 'null' ? null : s === 'true' ? true : s === 'false' ? false : s; }
// select の列の並びを読む: 'a, b, players(name, avatar_url)'
function parseSelect(cols) {
    const out = []; let depth = 0, buf = '';
    for (const ch of String(cols == null ? '*' : cols)) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(buf); buf = ''; } else buf += ch;
    }
    out.push(buf);
    return out.map(s => s.trim()).filter(Boolean).map(s => {
        const m = s.match(/^([A-Za-z_][\w]*)(?:![\w]+)?\((.*)\)$/s);
        if (m) return { embed: m[1], cols: parseSelect(m[2]) };
        const a = s.split(':');
        return a.length === 2 ? { name: a[1].trim(), alias: a[0].trim() } : { name: s };
    });
}

/**
 * @param {{tables?:Object<string,Object[]>, now?:()=>number, onChange?:(db)=>void, onPush?:(payload,info)=>void}} opts
 */
export function createPracticeClient(opts = {}) {
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const nowIso = () => new Date(now()).toISOString();
    const T = {};       // 表 → 行の配列
    const SEQ = {};     // 表 → 次の連番
    const outbox = [];  // 送ったことにした通知
    for (const name of Object.keys(SCHEMA)) { T[name] = []; SEQ[name] = 1; }

    const withDefaults = (table, values) => {
        const sc = SCHEMA[table], row = {};
        for (const [k, d] of Object.entries(sc.defaults || {})) row[k] = d === NOW ? nowIso() : (typeof d === 'function' ? d() : d);
        for (const [k, v] of Object.entries(values || {})) if (v !== undefined) row[k] = clone(v);
        if (sc.serial && row[sc.serial] == null) row[sc.serial] = SEQ[table]++;
        if (sc.serial && Number(row[sc.serial]) >= SEQ[table]) SEQ[table] = Number(row[sc.serial]) + 1;
        return row;
    };
    const uniqueSets = (table) => [{ cols: SCHEMA[table].pk }, ...(SCHEMA[table].uniques || [])];
    function assertUnique(table, row, self) {
        for (const u of uniqueSets(table)) {
            if (u.where && !u.where(row)) continue;
            if (u.cols.some(c => row[c] == null)) continue;   // NULL は互いに別物
            const hit = T[table].find(r => r !== self && (!u.where || u.where(r)) && u.cols.every(c => eqv(r[c], row[c])));
            if (hit) throw new PgError('23505', `duplicate key value violates unique constraint on ${table} (${u.cols.join(', ')})`);
        }
    }

    // ---- plan_reservations のトリガー (39 / 45 / 47)。発火順は本番と同じ名前順: capacity → pin_check → status_via_rpc ----
    function doneAttacks(seasonId, playerId) {
        const hard = T.seasons.find(s => eqv(s.id, seasonId))?.hard_date ?? null;
        return T.attacks.filter(a => eqv(a.season_id, seasonId) && eqv(a.player_id, playerId) && (hard == null || a.attack_date === hard)).length;
    }
    function resvBefore(op, NEW, OLD, ctx) {
        if (NEW.time_mode === 'fixed' ? !HOLD_RE.test(String(NEW.time_slot || '')) : NEW.time_slot != null) {
            throw check('時刻の形が違います (fixed は hXX / flex は時刻なし)');
        }
        // 39 capacity (BEFORE INSERT OR UPDATE OF status, player_id, season_id)
        const touched = op === 'insert' || ctx.setCols.some(c => ['status', 'player_id', 'season_id'].includes(c));
        if (touched && ACTIVE.includes(NEW.status)) {
            const active = T.plan_reservations.filter(r => r !== OLD && eqv(r.season_id, NEW.season_id) && eqv(r.player_id, NEW.player_id) && ACTIVE.includes(r.status)).length;
            const done = doneAttacks(NEW.season_id, NEW.player_id);
            if (active + done + 1 > 3) throw check(`残凸を超える予約はできません (生きている予約 ${active} 件 + 実凸 ${done} 件)`);
        }
        // 47 pin_check: 📌 を置くとき と 約束を作るとき
        if (touched && ['pinned', 'approved'].includes(NEW.status)
            && !(op === 'update' && OLD.status === NEW.status && eqv(OLD.player_id, NEW.player_id) && eqv(OLD.season_id, NEW.season_id))) {
            const held = T.plan_reservations.filter(r => r !== OLD && eqv(r.season_id, NEW.season_id) && eqv(r.player_id, NEW.player_id)
                && (['approved', 'pinned'].includes(r.status) || (r.status === 'cancel_requested' && r.approved_at != null))
                && !(r.status === 'pinned' && NEW.status === 'approved' && eqv(r.boss_number, NEW.boss_number) && eqv(r.loadout_slot, NEW.loadout_slot))).length;
            const done = doneAttacks(NEW.season_id, NEW.player_id);
            if (held + done + 1 > 3) {
                throw check(NEW.status === 'pinned'
                    ? `運営の固定が残凸を超えます (約束・固定 ${held} 件 + 実凸 ${done} 件)`
                    : `約束が残凸を超えます (約束・固定 ${held} 件 + 実凸 ${done} 件) — 📌 の固定を外してから承認してください`);
            }
        }
        // 39 status_via_rpc
        if (op === 'update') {
            if (NEW.status !== OLD.status && !ctx.rpc) throw check('予約の状態は reservation_set_status() 経由で変更してください (履歴が残らないため)');
            if (['approved', 'cancel_requested', 'fulfilled', 'released', 'rejected'].includes(OLD.status)
                && !(ctx.rpc && ['requested', 'cancel_requested'].includes(OLD.status) && NEW.status === 'approved')) {
                const frozen = ['player_id', 'raid_level', 'boss_number', 'time_mode', 'time_slot', 'loadout_slot', 'characters_snapshot', 'expected_damage_b'];
                if (frozen.some(c => JSON.stringify(NEW[c] ?? null) !== JSON.stringify(OLD[c] ?? null))) {
                    throw check('承認済みの予約の内容 (誰が・レベル・ボス・時刻・編成) は変更できません');
                }
            }
        }
    }

    // ---- 行の書き込み (1 文ぶん)。失敗したら呼び出し側の tx が全体を巻き戻す ----
    function insertRow(table, values, ctx = {}) {
        if (!SCHEMA[table]) throw new PgError('PGRST205', `Could not find the table 'public.${table}' in the schema cache`);
        const row = withDefaults(table, values);
        for (const c of (SCHEMA[table].required || [])) {
            if (row[c] == null) throw new PgError('23502', `null value in column "${c}" of relation "${table}" violates not-null constraint`);
        }
        if (table === 'plan_reservations') resvBefore('insert', row, null, { rpc: !!ctx.rpc, setCols: Object.keys(row) });
        assertUnique(table, row, null);
        T[table].push(row);
        if (table === 'plan_reservations') {   // 39 log_insert
            insertRow('plan_reservation_events', { reservation_id: row.id, from_status: null, to_status: row.status, actor_name: row.requested_by, reason: 'created' });
        }
        return row;
    }
    function updateRow(table, row, patch, ctx = {}) {
        const sc = SCHEMA[table];
        if (sc.appendOnly) throw check('予約の履歴は書き換え・削除できません (append-only)');
        const NEW = { ...row };
        for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) NEW[k] = clone(v);
        if (sc.touch && !(patch && sc.touch in patch)) NEW[sc.touch] = nowIso();
        if (table === 'plan_reservations') resvBefore('update', NEW, row, { rpc: !!ctx.rpc, setCols: Object.keys(patch || {}) });
        assertUnique(table, NEW, row);
        Object.assign(row, NEW);
        return row;
    }
    function deleteRows(table, rows) {
        if (SCHEMA[table].appendOnly && !deleteRows.cascading) throw check('予約の履歴は書き換え・削除できません (append-only)');
        const gone = new Set(rows);
        T[table] = T[table].filter(r => !gone.has(r));
        for (const [child, col] of (CASCADE[table] || [])) {
            const key = SCHEMA[table].pk[0];
            const ids = rows.map(r => r[key]);
            const kids = T[child].filter(r => ids.some(id => eqv(r[col], id)));
            if (!kids.length) continue;
            const was = deleteRows.cascading; deleteRows.cascading = true;
            try { deleteRows(child, kids); } finally { deleteRows.cascading = was; }
        }
    }
    // 全体を控えておき、失敗したら戻す (RPC もふつうの 1 文も、途中まで書いた状態を残さない)
    function tx(fn) {
        const snap = JSON.stringify({ T, SEQ });
        try { const out = fn(); changed(); return out; }
        catch (e) {
            const back = JSON.parse(snap);
            for (const k of Object.keys(T)) T[k] = back.T[k] || [];
            Object.assign(SEQ, back.SEQ);
            throw e;
        }
    }
    let notifying = false;
    function changed() {
        if (typeof opts.onChange !== 'function' || notifying) return;
        notifying = true;
        try { opts.onChange(api.__db); } catch (_) { /* 保存や描き直しの失敗で書き込みを失敗にしない */ } finally { notifying = false; }
    }

    // ---- 問い合わせ ----
    function project(table, row, sel) {
        const out = {};
        for (const c of sel) {
            if (c.embed) {
                const fk = EMBED_FK[c.embed];
                if (!fk || !SCHEMA[c.embed]) throw new PgError('PGRST200', `Could not find a relationship between '${table}' and '${c.embed}' in the schema cache`);
                const parent = T[c.embed].find(p => eqv(p[SCHEMA[c.embed].pk[0]], row[fk]));
                out[c.embed] = parent ? project(c.embed, parent, c.cols) : null;
            } else if (c.name === '*') {
                for (const [k, v] of Object.entries(row)) out[k] = clone(v);
            } else {
                out[c.alias || c.name] = clone(row[c.name] === undefined ? null : row[c.name]);
            }
        }
        return out;
    }
    class Query {
        constructor(table) {
            this.table = table; this.op = 'select'; this.cols = '*'; this.filters = []; this.orders = [];
            this.max = null; this.span = null; this.one = null; this.returning = false; this.head = false; this.wantCount = false;
        }
        select(cols = '*', o = {}) {
            if (this.op !== 'select') this.returning = true;
            this.cols = cols; if (o && o.head) this.head = true; if (o && o.count) this.wantCount = true;
            return this;
        }
        insert(values) { this.op = 'insert'; this.values = values; return this; }
        update(values) { this.op = 'update'; this.values = values; return this; }
        upsert(values, o = {}) { this.op = 'upsert'; this.values = values; this.onConflict = o && o.onConflict; return this; }
        delete() { this.op = 'delete'; return this; }
        _f(fn) { this.filters.push(fn); return this; }
        eq(c, v) { return this._f(r => eqv(r[c], v)); }
        neq(c, v) { return this._f(r => r[c] != null && v != null && !eqv(r[c], v)); }
        gt(c, v) { return this._f(r => r[c] != null && cmp(r[c], v) > 0); }
        gte(c, v) { return this._f(r => r[c] != null && cmp(r[c], v) >= 0); }
        lt(c, v) { return this._f(r => r[c] != null && cmp(r[c], v) < 0); }
        lte(c, v) { return this._f(r => r[c] != null && cmp(r[c], v) <= 0); }
        in(c, list) { const arr = Array.isArray(list) ? list : []; return this._f(r => arr.some(v => eqv(r[c], v))); }
        is(c, v) { return this._f(r => v === null ? r[c] == null : r[c] === v); }
        contains(c, list) { const arr = Array.isArray(list) ? list : []; return this._f(r => Array.isArray(r[c]) && arr.every(v => r[c].some(x => eqv(x, v)))); }
        or(expr) {
            const parts = String(expr).split(',').map(s => s.trim()).filter(Boolean).map(s => {
                const i = s.indexOf('.'), j = s.indexOf('.', i + 1);
                return { c: s.slice(0, i), op: s.slice(i + 1, j), v: literal(s.slice(j + 1)) };
            });
            const test = (r, p) => p.op === 'is' ? (p.v === null ? r[p.c] == null : r[p.c] === p.v)
                : p.op === 'eq' ? eqv(r[p.c], p.v)
                : p.op === 'neq' ? (r[p.c] != null && !eqv(r[p.c], p.v))
                : p.op === 'gt' ? (r[p.c] != null && cmp(r[p.c], p.v) > 0)
                : p.op === 'gte' ? (r[p.c] != null && cmp(r[p.c], p.v) >= 0)
                : p.op === 'lt' ? (r[p.c] != null && cmp(r[p.c], p.v) < 0)
                : p.op === 'lte' ? (r[p.c] != null && cmp(r[p.c], p.v) <= 0)
                : (() => { throw new PgError('PGRST100', `練習モードの or() は ${p.op} を知りません`); })();
            return this._f(r => parts.some(p => test(r, p)));
        }
        order(c, o = {}) { this.orders.push({ c, asc: !(o && o.ascending === false) }); return this; }
        limit(n) { this.max = Number(n); return this; }
        range(a, b) { this.span = [Number(a), Number(b)]; return this; }
        single() { this.one = 'single'; return this; }
        maybeSingle() { this.one = 'maybe'; return this; }
        then(ok, ng) { return Promise.resolve().then(() => this._run()).then(ok, ng); }

        _match() { return T[this.table].filter(r => this.filters.every(f => f(r))); }
        _run() {
            try {
                if (!SCHEMA[this.table]) throw new PgError('PGRST205', `Could not find the table 'public.${this.table}' in the schema cache`);
                let rows;
                if (this.op === 'select') rows = this._match();
                else rows = tx(() => this._write());
                const count = rows.length;
                if (this.op === 'select' || this.returning) {
                    if (this.orders.length) {
                        rows = rows.slice().sort((a, b) => {
                            for (const o of this.orders) {
                                const x = a[o.c], y = b[o.c];
                                if (x == null && y == null) continue;
                                if (x == null) return o.asc ? 1 : -1;    // 昇順は NULL が最後・降順は最初 (PostgreSQL の既定)
                                if (y == null) return o.asc ? -1 : 1;
                                const d = cmp(x, y);
                                if (d) return o.asc ? d : -d;
                            }
                            return 0;
                        });
                    }
                    if (this.span) rows = rows.slice(this.span[0], this.span[1] + 1);
                    if (this.max != null) rows = rows.slice(0, this.max);
                }
                const res = { data: null, error: null, count: this.wantCount ? count : null, status: 200, statusText: 'OK' };
                if (this.head) return res;
                if (this.op !== 'select' && !this.returning) { res.status = this.op === 'insert' ? 201 : 204; return res; }
                const sel = parseSelect(this.cols);
                const data = rows.map(r => project(this.table, r, sel));
                if (this.one) {
                    if (data.length === 1) res.data = data[0];
                    else if (data.length === 0 && this.one === 'maybe') res.data = null;
                    else throw new PgError('PGRST116', 'JSON object requested, multiple (or no) rows returned');
                } else res.data = data;
                return res;
            } catch (e) {
                if (e instanceof PgError) return { data: null, error: e.toJSON(), count: null, status: 400, statusText: 'Bad Request' };
                throw e;
            }
        }
        _write() {
            const list = Array.isArray(this.values) ? this.values : [this.values];
            if (this.op === 'insert') return list.map(v => insertRow(this.table, v));
            if (this.op === 'upsert') {
                const keys = this.onConflict ? String(this.onConflict).split(',').map(s => s.trim()).filter(Boolean) : SCHEMA[this.table].pk;
                return list.map(v => {
                    const probe = withDefaultsPeek(this.table, v);
                    const hit = keys.every(k => probe[k] != null) ? T[this.table].find(r => keys.every(k => eqv(r[k], probe[k]))) : null;
                    return hit ? updateRow(this.table, hit, v) : insertRow(this.table, v);
                });
            }
            // update / delete は絞り込みが必須 (本番も WHERE の無い更新・削除は拒否する)
            if (!this.filters.length) throw new PgError('21000', `${this.op.toUpperCase()} requires a WHERE clause`);
            const hit = this._match();
            if (this.op === 'update') return hit.map(r => updateRow(this.table, r, this.values));
            deleteRows(this.table, hit);
            return hit;
        }
    }
    // upsert の突き合わせ用: 連番を消費せずに既定値だけ当てて鍵を見る
    function withDefaultsPeek(table, values) {
        const out = {};
        for (const [k, d] of Object.entries(SCHEMA[table].defaults || {})) if (d !== NOW && typeof d !== 'function') out[k] = d;
        return Object.assign(out, values || {});
    }

    // ---- RPC (supabase/40 と 47 の写し) ----
    const RPC = {
        reservation_set_status(a) {
            const row = T.plan_reservations.find(r => eqv(r.id, a.p_id));
            if (!row) throw new PgError('P0002', `予約が見つかりません (id=${a.p_id})`);
            const from = row.status, to = a.p_to;
            if (a.p_expect_from == null || a.p_expect_from === '') throw check('期待する現在の状態 (p_expect_from) は必須です');
            if (from !== a.p_expect_from) throw new PgError('40001', `予約の状態が変わっています (いま ${from} / 期待 ${a.p_expect_from})`);
            const ok = (from === 'requested' && ['approved', 'rejected', 'cancel_requested'].includes(to))
                || (from === 'approved' && ['cancel_requested', 'fulfilled', 'released'].includes(to))
                || (from === 'cancel_requested' && ['released', 'approved'].includes(to))
                || (from === 'pinned' && ['approved', 'released'].includes(to));
            if (!ok) throw check(`許可されていない状態遷移です (${from} → ${to})`);
            const patch = { status: to, updated_at: nowIso() };
            if (to === 'approved') {
                if (a.p_characters != null) patch.characters_snapshot = a.p_characters;
                if (a.p_expected_b != null) patch.expected_damage_b = a.p_expected_b;
                patch.approved_by = a.p_actor ?? row.approved_by;
                if (row.approved_at == null) patch.approved_at = nowIso();
            }
            if (a.p_plan_id != null) patch.approved_plan_id = a.p_plan_id;
            if (['released', 'rejected'].includes(to)) { patch.released_by = a.p_actor ?? null; patch.released_at = nowIso(); }
            if (['released', 'rejected', 'fulfilled'].includes(to)) patch.release_reason = a.p_reason ?? row.release_reason;
            updateRow('plan_reservations', row, patch, { rpc: true });
            insertRow('plan_reservation_events', { reservation_id: row.id, from_status: from, to_status: to, actor_name: a.p_actor ?? null, reason: a.p_reason ?? null });
            if (to === 'approved') {   // [47] 同じカードの 📌 は同じ処理の中で外す
                for (const pin of T.plan_reservations.filter(r => r !== row && r.status === 'pinned' && eqv(r.season_id, row.season_id)
                    && eqv(r.player_id, row.player_id) && eqv(r.boss_number, row.boss_number) && eqv(r.loadout_slot, row.loadout_slot))) {
                    updateRow('plan_reservations', pin, { status: 'released', released_by: a.p_actor ?? null, released_at: nowIso(), release_reason: 'superseded', updated_at: nowIso() }, { rpc: true });
                    insertRow('plan_reservation_events', { reservation_id: pin.id, from_status: 'pinned', to_status: 'released', actor_name: a.p_actor ?? null, reason: 'superseded' });
                }
            }
            return clone(row);
        },
        report_attack(a) {
            const seasonId = a.p_season_id, playerId = a.p_player_id, resId = a.p_reservation_id ?? null;
            const level = a.p_level ?? 1, chars = a.p_characters ?? [];
            let res = null, mismatch = null;
            if (resId != null) {
                res = T.plan_reservations.find(r => eqv(r.id, resId));
                if (!res) throw new PgError('P0002', `予約が見つかりません (id=${resId})`);
                if (!eqv(res.player_id, playerId) || !eqv(res.season_id, seasonId)) throw check('この予約は別のメンバー/シーズンのものです');
                if (!(res.status === 'approved' || (res.status === 'cancel_requested' && res.approved_at != null))) throw check(`固定されている予約ではありません (いま ${res.status})`);
                if (!eqv(res.boss_number, a.p_boss_number)) throw check(`予約のボス (B${res.boss_number}) と凸のボス (B${a.p_boss_number}) が違います`);
                if (!(res.raid_level == null && level == null) && !eqv(res.raid_level, level)) mismatch = `レベルが違う (予約 Lv${res.raid_level ?? ''} / 実際 Lv${level})`;
                const snap = Array.isArray(res.characters_snapshot) ? res.characters_snapshot : [];
                if (snap.length && Array.isArray(chars) && chars.length
                    && JSON.stringify(snap.map(String).sort()) !== JSON.stringify(chars.map(String).sort())) {
                    mismatch = (mismatch ? mismatch + ' / ' : '') + '編成が違う';
                }
            }
            const others = T.plan_reservations.filter(r => eqv(r.season_id, seasonId) && eqv(r.player_id, playerId) && ACTIVE.includes(r.status) && !(resId != null && eqv(r.id, resId)));
            const done = doneAttacks(seasonId, playerId);
            const over = Math.max(0, (others.length + done + 1) - 3);
            const atRisk = over > 0
                ? others.slice().sort((x, y) => cmp(y.requested_at, x.requested_at) || (Number(y.id) - Number(x.id))).slice(0, over).map(r => r.id) : [];
            const used = T.attacks.filter(x => eqv(x.season_id, seasonId) && eqv(x.player_id, playerId) && x.attack_date === a.p_attack_date).map(x => Number(x.attack_number));
            const num = [1, 2, 3].find(n => !used.includes(n)) || 0;
            if (!num) throw check('既に3凸済みです');
            const dmg = Math.max(0, Number(a.p_damage_raw) || 0);
            const attack = insertRow('attacks', { season_id: seasonId, player_id: playerId, attack_date: a.p_attack_date, boss_number: a.p_boss_number ?? null,
                boss_code: a.p_boss_code ?? null, damage_raw: dmg, attack_number: num, level, characters: chars, reservation_id: resId });
            let hpAfter = null;
            if (!a.p_skip_hp_decrement && (Number(a.p_damage_raw) || 0) > 0 && a.p_boss_number != null) {
                const boss = T.bosses.find(b => eqv(b.season_id, seasonId) && eqv(b.boss_number, a.p_boss_number));
                if (boss) { updateRow('bosses', boss, { remaining_hp_raw: Math.max(0, (Number(boss.remaining_hp_raw) || 0) - Number(a.p_damage_raw)), updated_at: nowIso() }); hpAfter = boss.remaining_hp_raw; }
            }
            if (resId != null) {
                const from = res.status;
                updateRow('plan_reservations', res, { status: 'fulfilled', release_reason: 'fulfilled', updated_at: nowIso() }, { rpc: true });
                insertRow('plan_reservation_events', { reservation_id: resId, from_status: from, to_status: 'fulfilled', actor_name: a.p_actor ?? null,
                    reason: mismatch ? `凸報告により実行済み (${mismatch})` : '凸報告により実行済み' });
            }
            return { id: attack.id, attack_number: attack.attack_number, hp_after: hpAfter, reservation_id: resId, mismatch, over_capacity: over, reservations_at_risk: atRisk };
        },
    };

    const api = {
        from: (table) => new Query(table),
        rpc(name, args = {}) {
            return Promise.resolve().then(() => {
                try {
                    if (!RPC[name]) throw new PgError('PGRST202', `Could not find the function public.${name} in the schema cache (練習モードでは使えません)`);
                    return { data: tx(() => RPC[name](args || {})), error: null, status: 200 };
                } catch (e) {
                    if (e instanceof PgError) return { data: null, error: e.toJSON(), status: 400 };
                    throw e;
                }
            });
        },
        functions: {
            // Edge Function。send-push は「送ったことにして」控える (本番の端末には何も届かない)
            invoke(name, o = {}) {
                return Promise.resolve().then(() => {
                    const body = (o && o.body) || {};
                    if (name === 'send-push') {
                        const ids = Array.isArray(body.playerIds) && body.playerIds.length ? body.playerIds.slice() : null;
                        const target = ids ? ids.length : T.players.filter(p => !p.archived).length;
                        const item = { at: nowIso(), title: body.title || '', body: body.body || '', url: body.url || null, tag: body.tag || null, playerIds: ids, target };
                        outbox.push(item);
                        try { if (typeof opts.onPush === 'function') opts.onPush(clone(item)); } catch (_) { /* 表示の失敗で送信を失敗にしない */ }
                        return { data: { ok: true, sent: target, target, practice: true }, error: null };
                    }
                    return { data: null, error: { message: '練習モードではこの機能 (画像の読み取りなど) は使えません' } };
                });
            },
        },
        storage: {
            from: () => ({
                upload: () => Promise.resolve({ data: null, error: { message: '練習モードでは画像を保存できません' } }),
                getPublicUrl: () => ({ data: { publicUrl: '' } }),
            }),
        },
        // 練習の層だけが使う口 (本番のクライアントには無い)
        __db: {
            isPractice: true,
            tables: T,
            outbox,
            /** 種データを入れる (既定値を当てる・トリガーは通さない = 承認済みの予約などをそのまま置ける) */
            load(tables) {
                for (const [name, rows] of Object.entries(tables || {})) {
                    if (!SCHEMA[name]) throw new Error(`練習の表に ${name} はありません`);
                    for (const r of rows || []) T[name].push(withDefaults(name, r));
                }
            },
            // ★ 送ったことにした通知 (outbox) も控えに入れる (Codex指摘 2026-10-03)。入れないと「〜したことにする」が途中で失敗して
            //   盤面を戻したあとも、送ったはずの通知だけ残り、押し直すと二重になる。古い控え (outbox 無し) は空に戻す
            dump() { return JSON.stringify({ v: 1, T, SEQ, outbox }); },
            restore(json) {
                const d = typeof json === 'string' ? JSON.parse(json) : json;
                if (!d || d.v !== 1 || !d.T) return false;
                for (const k of Object.keys(T)) T[k] = Array.isArray(d.T[k]) ? d.T[k] : [];
                Object.assign(SEQ, d.SEQ || {});
                outbox.splice(0, outbox.length, ...(Array.isArray(d.outbox) ? d.outbox : []));
                return true;
            },
            /** 練習の層 (相手役の動き) が直接書くとき用。失敗したら巻き戻す */
            tx,
            insert: (table, values) => tx(() => clone(insertRow(table, values))),
            rpc: (name, args) => tx(() => RPC[name](args || {})),
        },
    };
    if (opts.tables) api.__db.load(opts.tables);
    return api;
}
