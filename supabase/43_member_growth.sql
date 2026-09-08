-- ============================================================================
-- Phase: ユニオンメンバーの育成データ (2026-09-08 決定 A1 / C1)
-- ----------------------------------------------------------------------------
-- 「A さんのこの編成、ふるり値高いな」→ その人の育成と自分の同じキャラを並べたい。
-- BlaBlaLINK から、今回のレイドで**実際に使われたキャラ**の育成状況だけを取り込む。
--
--   A1: メンバーの BlaBlaLINK 識別子は players に持つ (初回だけ手で名寄せする)
--   C1: 育成は**シーズンごとのスナップショット**として残す
--       (育成は日々変わる。レイド当時の育成が後から見られないと「あの凸のとき」が分からない)
--
-- ★ 取れるのは BlaBlaLINK でゲームカードを公開している人だけ (2026-09-08 実機確認)。
--   非公開の人は API が code=1301002 で一律拒否する。**同じユニオンでも突破できない。**
--   だから「取れなかった」を欠測ではなく**状態として残す** (member_growth_status)。
--   これが無いと「未取り込み」と「非公開」が区別できず、催促の相手を間違える。
--
-- 適用: Supabase Dashboard → SQL Editor で実行
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A1: メンバーの BlaBlaLINK 識別子
-- ---------------------------------------------------------------------------
ALTER TABLE players ADD COLUMN IF NOT EXISTS blabla_openid TEXT;

-- 1つの識別子を2人に付けない (名寄せの取り違えは、他人の育成が別人に付く事故になる)。
-- 未設定 (NULL) は何人いてもよいので部分索引にする
CREATE UNIQUE INDEX IF NOT EXISTS uq_players_blabla_openid
    ON players(blabla_openid) WHERE blabla_openid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- C1: 育成のスナップショット (シーズン × メンバー × キャラ)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_growth (
    season_id         BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id         BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    -- PAD のキャラ名 (nikke_characters.canonical_name)。FK は張らない —
    -- attacks.characters と同じく非正規化で持つ (内輪ツールなので読み出しの単純さを優先)
    character_name    TEXT NOT NULL,
    -- 由来を残す。BlaBlaLINK 側の番号 (data/blabla-name-codes.json で PAD 名に対応づけた)
    name_code         INT,

    -- 突破とコア。grade 0〜3、core は grade=3 のときだけ 1〜7 (2026-09-08 CDN で確認)。
    -- 段階の通し番号は grade + core + 1 (1〜11)
    grade             SMALLINT,
    core              SMALLINT,
    lv                SMALLINT,

    skill1_lv         SMALLINT,
    skill2_lv         SMALLINT,
    ulti_skill_lv     SMALLINT,

    combat            INT,          -- 戦闘力。実測との突き合わせに使える
    attractive_lv     SMALLINT,     -- 好感度

    harmony_cube_tid  INT,
    harmony_cube_lv   SMALLINT,
    favorite_item_tid INT,
    favorite_item_lv  SMALLINT,

    -- 装備4部位: [{part, tier, lv, options:[id,id,id]}]。部位ごとに列を作ると 24 列になり、
    -- 増減のたびにマイグレーションが要る。まとめて読む用途しかないので JSONB で持つ
    equip             JSONB,
    -- オーバーロードの合計 {"攻撃力": 12.34, "クリティカル確率": 5.6}。
    -- option_id は state_effects が無いと意味が分からないので、**取り込み時に解決して**保存する
    -- (あとから state_effects を持っていないと復元できなくなる)
    overload          JSONB,

    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (season_id, player_id, character_name)
);

-- 「このキャラ、みんなどれくらい育ててる?」を引くため (D3 は後回しだが索引は今作る)
CREATE INDEX IF NOT EXISTS idx_member_growth_season_char
    ON member_growth(season_id, character_name);

-- ---------------------------------------------------------------------------
-- 取り込みの結果 (B3 の「未公開 N 人」と「取れなかった人」の一覧)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_growth_status (
    season_id       BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id       BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    -- ok        取れた
    -- private   本人が BlaBlaLINK で非公開にしている (API code=1301002 / 1303002)
    -- no_openid PAD にまだ識別子を紐づけていない (運営の作業待ち。本人のせいではない)
    -- error     それ以外の失敗 (通信・想定外の応答)。次回また試す
    status          TEXT NOT NULL,
    detail          TEXT,
    character_count INT,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (season_id, player_id)
);

-- 状態の綴りを固定する。再実行できるよう作り直す
ALTER TABLE member_growth_status DROP CONSTRAINT IF EXISTS member_growth_status_status_check;
ALTER TABLE member_growth_status ADD CONSTRAINT member_growth_status_status_check
    CHECK (status IN ('ok', 'private', 'no_openid', 'error'));

CREATE INDEX IF NOT EXISTS idx_member_growth_status_season
    ON member_growth_status(season_id, status);

-- ---------------------------------------------------------------------------
-- RLS (anon 全許可 — 認証なしの内輪運用という設計判断。変えない)
-- ---------------------------------------------------------------------------
ALTER TABLE member_growth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON member_growth;
CREATE POLICY "anon_all" ON member_growth FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON member_growth;
CREATE POLICY "authenticated_all" ON member_growth FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE member_growth_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON member_growth_status;
CREATE POLICY "anon_all" ON member_growth_status FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON member_growth_status;
CREATE POLICY "authenticated_all" ON member_growth_status FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
