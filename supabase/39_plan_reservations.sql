-- ============================================================================
-- Phase: 凸の予約 (L2 / 課題E — 2026-09-07)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
--
-- 何のためのものか:
--   第44回 (2026-09-05) の反省は「当日のプラン再生成でメンバーを振り回した」こと。
--   L1 (ソルバーの安定化) は「理由なく割当を動かさない」までは実現したが、
--   **本人が引き受けた凸を絶対に動かさない**保証はしていない (L1 の割当は
--   踏破が上がる・時間リスクが増える・与ダメが閾値以上増える、のいずれかで動く)。
--   予約は「運営が承認した約束」なので、原則として動かしてはいけない層。
--
-- ユーザー決定 (2026-09-07):
--   ・固定する範囲は **誰が・レベル・ボス・時刻・編成** の全部
--     - 時刻を固定する理由: その人が締め凸になる場合に**撃破時刻が確定し、次のレベルの予定が組める**
--     - 編成を固定する理由: (1) 誰がどの編成で行くか全員に見える (2) 1凸だけ予約した人の
--       **残り2凸で使えないキャラが確定**する (3) 予約のキャラを別の凸で使う事故を防ぐ
--   ・承認は **運営の誰か1人でよい**。誰が承認したかは運営全員に同じように見える
--   ・**承認しても自動では配信しない** (承認のたびに再配信すると、承認自体が振り回しの原因になる)
--   ・締め凸依頼の了承は **即予約** になる
--   ・無断欠席は **猶予なし・運営判断で取り下げ** (時刻到来だけの自動解除はしない)
--   ・本人の取り消しは **いつでも希望を出せるが、解除には運営の承認が要る**
--   ・予約後に本人が編成を変えたら **予約は守り、残り2凸は本人が模擬を再提出して調整する**
--     (だから characters_snapshot / expected_damage_b は承認時点で固定し、あとから動かさない)
--
-- ★ 設計上の要点 (Codex 設計レビュー 2026-09-07):
--   1. **実行済みの判定を推測でやらない**。同じ人が同じレベル・同じボスに2凸できるので、
--      ボス・ダメージ・時刻・編成からの自動推定は曖昧。`attacks.reservation_id` で明示的に結ぶ
--   2. **リンクは片方向だけ**。`plan_reservations.attack_id` は作らない —
--      attacks ⇄ plan_reservations の相互 FK は循環参照になり、バックアップ復元の順序が決まらない。
--      予約に対応する凸は `attacks.reservation_id` の一意索引から引く
--   3. **状態遷移は必ず履歴に残す**。`plan_reservation_events` に append-only で積む。
--      status 列は「いまの状態」のキャッシュにすぎない
--   4. **時刻の持ち方を兼用しない**。`time_mode` で fixed / flex を明示する。
--      `time_slot IS NULL` を「未入力」「⏳隙間」「旧データ」で兼用すると必ず読み違える
-- ============================================================================

SET lock_timeout = '3s';

-- ---- 1) 予約本体 ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_reservations (
    id BIGSERIAL PRIMARY KEY,
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,

    -- 何を約束したか (この5つが「固定する範囲」)
    raid_level SMALLINT NOT NULL CHECK (raid_level BETWEEN 1 AND 4),
    boss_number INT NOT NULL CHECK (boss_number BETWEEN 1 AND 5),
    -- fixed = 時刻を約束する / flex = ⏳隙間型で時刻を約束しない
    time_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (time_mode IN ('fixed', 'flex')),
    time_slot TEXT,                          -- 'h21' 形式。fixed のときだけ入る
    loadout_slot SMALLINT NOT NULL CHECK (loadout_slot IN (1, 2)),

    -- 承認時点の写し。**あとから模擬を編集しても動かさない** (約束は約束のまま)
    characters_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_damage_b NUMERIC(8,3),

    -- どこから生まれたか
    source_type TEXT NOT NULL DEFAULT 'self'
        CHECK (source_type IN ('plan', 'finish_request', 'self')),
    source_plan_id BIGINT,                   -- published_plans.id (FK は張らない: 配信は消せる)
    source_finish_request_id BIGINT,         -- finish_requests.id (同上)

    status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'approved', 'cancel_requested', 'fulfilled', 'released', 'rejected')),

    requested_by TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    approved_plan_id BIGINT,                 -- 承認後、最初にこの予約を反映して配信したプラン
    released_by TEXT,
    released_at TIMESTAMPTZ,
    -- fulfilled / boss_defeated / level_passed / no_show / member_request / ops / infeasible
    release_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- time_mode と time_slot の対応を DB で閉じる (兼用させない)。
-- ★ 形式まで縛る (Codex指摘 2026-09-07) — 'あ' のような値でも保存できてしまうと、
--   ソルバーは未知の時刻を「指定なし」として最速枠に寄せる = 固定時刻が静かに変わる
ALTER TABLE plan_reservations DROP CONSTRAINT IF EXISTS chk_plan_reservations_time;
ALTER TABLE plan_reservations ADD CONSTRAINT chk_plan_reservations_time
    CHECK ((time_mode = 'fixed' AND time_slot ~ '^h(0[0-9]|1[0-9]|2[0-3])$')
        OR (time_mode = 'flex'  AND time_slot IS NULL));

CREATE INDEX IF NOT EXISTS idx_plan_reservations_season_status
    ON plan_reservations(season_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_reservations_player
    ON plan_reservations(season_id, player_id);

-- 「生きている予約」の重複よけ。同じ人が同じレベル・同じボスを**同じ編成で**
-- 二重に予約することはない (編成が違えば同属性2凸として正当なので loadout_slot を含める)
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_reservations_active
    ON plan_reservations(season_id, player_id, raid_level, boss_number, loadout_slot)
    WHERE status IN ('requested', 'approved', 'cancel_requested');

-- ---- 2) 状態遷移の履歴 (append-only) --------------------------------------
-- status 列だけだと「誰がなぜ解除したか」が残らない。監査はこちらが正。
CREATE TABLE IF NOT EXISTS plan_reservation_events (
    id BIGSERIAL PRIMARY KEY,
    reservation_id BIGINT NOT NULL REFERENCES plan_reservations(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_name TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plan_reservation_events_res
    ON plan_reservation_events(reservation_id, id);

-- ---- 3) 凸との紐づけ (片方向) ----------------------------------------------
-- ★ 予約に対応する凸はここから引く。推測 (ボス・ダメージ・時刻の一致) では特定できない —
--   同じ人が同じレベル・同じボスに2凸できるため
ALTER TABLE attacks ADD COLUMN IF NOT EXISTS reservation_id BIGINT
    REFERENCES plan_reservations(id) ON DELETE SET NULL;
-- 1つの予約に紐づく凸は1件だけ
CREATE UNIQUE INDEX IF NOT EXISTS uq_attacks_reservation
    ON attacks(reservation_id) WHERE reservation_id IS NOT NULL;

-- ---- 4) 残凸を超える予約を作らせない --------------------------------------
-- 「生きている予約 + その日の実凸 <= 3」を DB 側で閉じる。
-- クライアントだけの検査だと、複数端末・運営の承認と本人の申請が同時に走ったときに破れる。
-- fulfilled になった予約は実凸として数えられるので二重計上にはならない
CREATE OR REPLACE FUNCTION plan_reservations_capacity_check()
RETURNS TRIGGER AS $$
DECLARE
    v_hard_date DATE;
    v_active INT;
    v_done INT;
BEGIN
    -- 生きている予約だけを見る (fulfilled / released / rejected は枠を持たない)
    IF NEW.status NOT IN ('requested', 'approved', 'cancel_requested') THEN
        RETURN NEW;
    END IF;
    -- ★ 同じメンバーへの操作を直列化する (Codex指摘 2026-09-07)。
    --   これが無いと、2端末が同時に予約を作ったとき双方が同じ v_active を読み、
    --   どちらも「+1 で3件」と判断して両方通る = 予約が4件になる。
    --   キーは report_attack (40) と**同一の式**にすること — 予約と実凸が別の鍵だと
    --   「予約を作りながら凸を報告」で同じ穴が開く
    PERFORM pg_advisory_xact_lock(hashtextextended('attack:' || NEW.season_id || ':' || NEW.player_id, 0));
    SELECT hard_date INTO v_hard_date FROM seasons WHERE id = NEW.season_id;
    SELECT COUNT(*) INTO v_active FROM plan_reservations
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND status IN ('requested', 'approved', 'cancel_requested')
       AND id <> COALESCE(NEW.id, -1);
    SELECT COUNT(*) INTO v_done FROM attacks
     WHERE season_id = NEW.season_id AND player_id = NEW.player_id
       AND (v_hard_date IS NULL OR attack_date = v_hard_date);
    IF v_active + v_done + 1 > 3 THEN
        RAISE EXCEPTION '残凸を超える予約はできません (生きている予約 % 件 + 実凸 % 件)', v_active, v_done
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_reservations_capacity ON plan_reservations;
CREATE TRIGGER trg_plan_reservations_capacity
    BEFORE INSERT OR UPDATE OF status, player_id, season_id ON plan_reservations
    FOR EACH ROW EXECUTE FUNCTION plan_reservations_capacity_check();

-- ---- 5) 状態遷移 (更新 + 履歴を1つの操作で) --------------------------------
-- ★ クライアントから2回に分けて書くと「状態は変わったのに履歴が無い」が起きる。
--   期待する現在の状態 (p_expect_from) を渡させて、取り違えた更新も弾く
-- ⚠ 引数を増やしたので、**旧シグネチャを先に落とす** — CREATE OR REPLACE は引数が違うと
--   別関数として増え、PostgREST から呼ぶと「どちらか決まらない」で失敗する
DROP FUNCTION IF EXISTS reservation_set_status(BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT);

-- ★ p_characters / p_expected_b は **承認の瞬間に固定するスナップショット** (Codex指摘 2026-09-07)。
--   ユーザー決定は「characters_snapshot / expected_damage_b は**承認時点で**固定」。
--   申請時の写しのまま承認すると、申請から承認までの間に本人が模擬を直したとき、
--   固定されるのは古い内容になる。承認する運営が見ている内容と一致させる。
--   NULL を渡せば従来どおり既存の写しを維持する (締め凸の了承など、作成即承認の経路)
CREATE OR REPLACE FUNCTION reservation_set_status(
    p_id BIGINT,
    p_to TEXT,
    p_expect_from TEXT DEFAULT NULL,   -- ★ 実際には必須 (NULL は下で弾く。既存呼び出しの互換のため既定値は残す)
    p_actor TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_plan_id BIGINT DEFAULT NULL,
    p_characters JSONB DEFAULT NULL,
    p_expected_b NUMERIC DEFAULT NULL
) RETURNS plan_reservations AS $$
DECLARE
    v_row plan_reservations;
    v_from TEXT;
BEGIN
    SELECT * INTO v_row FROM plan_reservations WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '予約が見つかりません (id=%)', p_id USING ERRCODE = 'no_data_found';
    END IF;
    v_from := v_row.status;
    -- ★ 期待する現在の状態は必須 (Codex指摘 2026-09-07)。任意にすると、
    --   古い画面からの操作が「先に別の運営が動かした後の状態」に対して
    --   別の合法な遷移として通ってしまう
    IF p_expect_from IS NULL OR p_expect_from = '' THEN
        RAISE EXCEPTION '期待する現在の状態 (p_expect_from) は必須です' USING ERRCODE = 'check_violation';
    END IF;
    IF v_from <> p_expect_from THEN
        RAISE EXCEPTION '予約の状態が変わっています (いま % / 期待 %)', v_from, p_expect_from
            USING ERRCODE = 'serialization_failure';
    END IF;
    -- 許可する遷移だけを通す。終端 (fulfilled/released/rejected) からは動かさない
    IF NOT (
        (v_from = 'requested'        AND p_to IN ('approved', 'rejected', 'cancel_requested'))
     OR (v_from = 'approved'         AND p_to IN ('cancel_requested', 'fulfilled', 'released'))
     OR (v_from = 'cancel_requested' AND p_to IN ('released', 'approved'))
    ) THEN
        RAISE EXCEPTION '許可されていない状態遷移です (% → %)', v_from, p_to USING ERRCODE = 'check_violation';
    END IF;

    -- このトランザクションの更新は RPC 経由であると名乗る (上のトリガーが見る)
    PERFORM set_config('app.reservation_rpc', 'on', true);
    UPDATE plan_reservations SET
        status = p_to,
        -- 承認の瞬間だけ、承認時点の内容で固定し直す
        characters_snapshot = CASE WHEN p_to = 'approved' AND p_characters IS NOT NULL
                                   THEN p_characters ELSE characters_snapshot END,
        expected_damage_b   = CASE WHEN p_to = 'approved' AND p_expected_b IS NOT NULL
                                   THEN p_expected_b ELSE expected_damage_b END,
        approved_by   = CASE WHEN p_to = 'approved' THEN COALESCE(p_actor, approved_by) ELSE approved_by END,
        approved_at   = CASE WHEN p_to = 'approved' AND approved_at IS NULL THEN NOW() ELSE approved_at END,
        approved_plan_id = COALESCE(p_plan_id, approved_plan_id),
        released_by   = CASE WHEN p_to IN ('released', 'rejected') THEN p_actor ELSE released_by END,
        released_at   = CASE WHEN p_to IN ('released', 'rejected') THEN NOW() ELSE released_at END,
        release_reason = CASE WHEN p_to IN ('released', 'rejected', 'fulfilled') THEN COALESCE(p_reason, release_reason) ELSE release_reason END,
        updated_at = NOW()
    WHERE id = p_id
    RETURNING * INTO v_row;

    INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
    VALUES (p_id, v_from, p_to, p_actor, p_reason);

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- 作成時の履歴も同じ形で残す (作成は INSERT なので RPC ではなくトリガーで積む)
CREATE OR REPLACE FUNCTION plan_reservations_log_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO plan_reservation_events (reservation_id, from_status, to_status, actor_name, reason)
    VALUES (NEW.id, NULL, NEW.status, NEW.requested_by, 'created');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_reservations_log_insert ON plan_reservations;
CREATE TRIGGER trg_plan_reservations_log_insert
    AFTER INSERT ON plan_reservations
    FOR EACH ROW EXECUTE FUNCTION plan_reservations_log_insert();

-- ---- 5-2) 履歴は append-only / 状態は RPC 経由だけ ------------------------
-- ★ RLS は anon 全許可 (内輪運用の割り切り) なので、REST から直接
--   status を書き換えたり履歴を消したりできてしまう。**認可の話ではなく**、
--   「状態遷移は必ず履歴に残る」という設計上の不変条件が破れるのが問題
--   (旧クライアントや手作業が直接書くと、監査ログだけ欠ける — Codex指摘 2026-09-07)。
--   遷移の正しさは reservation_set_status に集約してあるので、それ以外の経路を塞ぐ。
CREATE OR REPLACE FUNCTION plan_reservation_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '予約の履歴は書き換え・削除できません (append-only)'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_reservation_events_append_only ON plan_reservation_events;
CREATE TRIGGER trg_plan_reservation_events_append_only
    BEFORE UPDATE OR DELETE ON plan_reservation_events
    FOR EACH ROW EXECUTE FUNCTION plan_reservation_events_append_only();

-- status の直接更新を弾く。RPC 側はセッション変数で自分を名乗ってから更新する。
-- ★ あわせて「固定する範囲」(誰が・レベル・ボス・時刻・編成) の後出し変更も弾く
--   (Codex指摘 2026-09-07)。status だけ守っても、承認済みの予約の中身を書き換えられては
--   「約束を固定する」という不変条件が成立しない
CREATE OR REPLACE FUNCTION plan_reservations_status_via_rpc()
RETURNS TRIGGER AS $$
DECLARE
    v_rpc BOOLEAN := COALESCE(current_setting('app.reservation_rpc', true), '') = 'on';
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_rpc THEN
        RAISE EXCEPTION '予約の状態は reservation_set_status() 経由で変更してください (履歴が残らないため)'
            USING ERRCODE = 'check_violation';
    END IF;
    -- 承認済み以降は約束の中身を動かさない。
    -- ★ 承認の瞬間 (approved への遷移) だけは、RPC が承認時のスナップショットを載せ直せるようにする
    IF OLD.status IN ('approved', 'cancel_requested', 'fulfilled', 'released', 'rejected')
       AND NOT (v_rpc AND OLD.status IN ('requested', 'cancel_requested') AND NEW.status = 'approved') THEN
        IF NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.raid_level IS DISTINCT FROM OLD.raid_level
           OR NEW.boss_number IS DISTINCT FROM OLD.boss_number
           OR NEW.time_mode IS DISTINCT FROM OLD.time_mode
           OR NEW.time_slot IS DISTINCT FROM OLD.time_slot
           OR NEW.loadout_slot IS DISTINCT FROM OLD.loadout_slot
           OR NEW.characters_snapshot IS DISTINCT FROM OLD.characters_snapshot
           OR NEW.expected_damage_b IS DISTINCT FROM OLD.expected_damage_b THEN
            RAISE EXCEPTION '承認済みの予約の内容 (誰が・レベル・ボス・時刻・編成) は変更できません'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_reservations_status_via_rpc ON plan_reservations;
CREATE TRIGGER trg_plan_reservations_status_via_rpc
    BEFORE UPDATE ON plan_reservations
    FOR EACH ROW EXECUTE FUNCTION plan_reservations_status_via_rpc();

-- ---- 6) RLS (anon 全許可 — 認証なしの内輪運用という設計判断) ----------------
ALTER TABLE plan_reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON plan_reservations;
CREATE POLICY "anon_all" ON plan_reservations FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON plan_reservations;
CREATE POLICY "authenticated_all" ON plan_reservations FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE plan_reservation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON plan_reservation_events;
CREATE POLICY "anon_all" ON plan_reservation_events FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON plan_reservation_events;
CREATE POLICY "authenticated_all" ON plan_reservation_events FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';   -- API に即認識させる (忘れると 404 になる)
