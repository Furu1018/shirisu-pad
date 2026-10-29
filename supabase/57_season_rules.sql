-- ============================================================================
-- Phase: シーズンの決まり (2026-10-30 ふるり「本番のうえにテストを作成するのが良くない」)
--   ① アクティブなシーズンは 1 つだけ (DB の一意索引で守る)
--   ② テストシーズンは履歴に残さない = 終えるときは行ごと消す
--
-- ★ ② の前提の直し: 予約の履歴 (plan_reservation_events・39) の append-only トリガーが、
--   シーズンを消したときの CASCADE の削除まで止めていた (10/27 の検証で見つかった 39 からの既存の不具合)。
--   予約が 1 件でもあるテストシーズンは 🧪 ✕ 終了 でも消せず、「シーズン終了」で止めるしかなかった
--   (10/27 のテストで本番 2026-10b が止まったままになった件)。
--   → シーズンを消す口 (RPC delete_season) の中の削除だけ通す。履歴の書き換え・ふだんの削除は今までどおり拒む
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等・再実行安全)
-- 前提: supabase/39_plan_reservations.sql (plan_reservation_events)
--
--   uq_seasons_one_active          is_active = true の行は 1 つまで
--   delete_season(p_season_id)     シーズンを消す口。テストシーズンはいつでも / 本番は「止めてあって凸の記録が 0 件」のときだけ
--                                  (同じ月キーで作り直すときの空のシーズン)。消した月キーを返す (無ければ NULL)
--   plan_reservation_events_append_only  delete_season の中 (app.season_delete = 'on') の DELETE だけ通す
--   trg_seasons_delete_via_rpc     seasons の DELETE も delete_season の中からだけ (REST の素の DELETE で条件を迂回させない: Codex 監査)。
--                                  ★ 設定タブの「復元」は seasons も消すが、予約の履歴の表がある DB では消す前に止める安全策が既にある (使えないのは前から)
-- ============================================================================

SET lock_timeout = '3s';

-- ① アクティブは 1 つだけ。シーズン作成は「止めてから入れる」順なので、この索引とぶつからない
--   (2 つ以上アクティブな DB では作成に失敗する = そのときは先にどれかを止める)
CREATE UNIQUE INDEX IF NOT EXISTS uq_seasons_one_active
    ON seasons (is_active) WHERE is_active;

-- ② 予約の履歴の append-only: シーズンを消す RPC の中だけ削除を通す。
--   app.season_delete は set_config(..., true) = このトランザクションの中だけ。REST からは set_config を呼べない
CREATE OR REPLACE FUNCTION plan_reservation_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.season_delete', true), '') = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '予約の履歴は書き換え・削除できません (append-only)'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_season(p_season_id BIGINT)
RETURNS TEXT AS $$
DECLARE
    v_key TEXT;
    v_test BOOLEAN;
    v_active BOOLEAN;
    v_atk INT;
BEGIN
    SELECT month_key, is_test, is_active INTO v_key, v_test, v_active
      FROM seasons WHERE id = p_season_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    -- 本番 (is_test が false / NULL の古い行も本番) は「止めてあって凸 0 件」のときだけ (シーズン作成の同じ月キーの作り直しと同じ条件)
    IF v_test IS NOT TRUE THEN
        IF v_active THEN
            RAISE EXCEPTION 'いま動いている本番シーズン (%) は消せません', v_key USING ERRCODE = 'check_violation';
        END IF;
        SELECT COUNT(*) INTO v_atk FROM attacks WHERE season_id = p_season_id;
        IF v_atk > 0 THEN
            RAISE EXCEPTION '本番シーズン (%) には凸の記録が % 件あるので消せません', v_key, v_atk USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    PERFORM set_config('app.season_delete', 'on', true);
    DELETE FROM seasons WHERE id = p_season_id;   -- ボス・凸・配信・予約 (と履歴)・確認などは CASCADE
    PERFORM set_config('app.season_delete', '', true);
    RETURN v_key;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION delete_season(BIGINT) TO anon, authenticated;

-- seasons の DELETE は delete_season の中からだけ。古い版のアプリ・手作業の素の DELETE は断る (アプリは 57 があれば RPC を使う)
CREATE OR REPLACE FUNCTION seasons_delete_via_rpc()
RETURNS TRIGGER AS $$
BEGIN
    IF COALESCE(current_setting('app.season_delete', true), '') = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'シーズンは delete_season() で消してください (テストはいつでも・本番は止めてあって凸 0 件のときだけ)'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seasons_delete_via_rpc ON seasons;
CREATE TRIGGER trg_seasons_delete_via_rpc
    BEFORE DELETE ON seasons
    FOR EACH ROW EXECUTE FUNCTION seasons_delete_via_rpc();

NOTIFY pgrst, 'reload schema';
