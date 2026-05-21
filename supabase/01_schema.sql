-- ============================================================================
-- しりすこPAD Supabase Schema (Phase 0)
-- ============================================================================
-- 適用方法: Supabase Dashboard → SQL Editor で全文ペーストして Run
-- 順序: 01_schema.sql → 02_rls.sql → 03_seed_data.sql
-- ============================================================================

-- ===== Players (プレイヤー) =====
CREATE TABLE IF NOT EXISTS players (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,                 -- 表示名（ユニーク）
    finish_alert BOOLEAN NOT NULL DEFAULT TRUE,-- 締め凸通知ON/OFF
    is_temp BOOLEAN NOT NULL DEFAULT FALSE,    -- 仮メンバー（未参加など）
    notes TEXT,
    auth_user_id UUID,                         -- 将来Supabase Auth導入時に紐付け用
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===== Player Damages (属性別登録ダメージ) =====
CREATE TABLE IF NOT EXISTS player_damages (
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    attribute TEXT NOT NULL CHECK (attribute IN ('fire','water','iron','electric','wind')),
    damage_b NUMERIC(8,3) NOT NULL DEFAULT 0,  -- B単位
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (player_id, attribute)
);

-- ===== Seasons (ユニオンレイドシーズン) =====
CREATE TABLE IF NOT EXISTS seasons (
    id BIGSERIAL PRIMARY KEY,
    month_key TEXT UNIQUE NOT NULL,            -- 'YYYY-MM' 既存JSONとの紐付け
    hard_date DATE NOT NULL,                   -- Day2(ハード日)
    current_level INT NOT NULL DEFAULT 1,
    union_rank NUMERIC(5,2),                   -- ユニオン順位 %
    is_active BOOLEAN NOT NULL DEFAULT FALSE,  -- 現在進行中シーズンは TRUE
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===== Bosses (5体/シーズン) =====
CREATE TABLE IF NOT EXISTS bosses (
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    boss_number INT NOT NULL CHECK (boss_number BETWEEN 1 AND 5),
    boss_code TEXT NOT NULL,                   -- 'H.S.T.A.'/'P.S.I.D.'/'Z.E.U.S.'/'D.M.T.R.'/'A.N.M.I.'
    name TEXT,                                 -- ボス名（例: クリスタルアーマー）
    attribute TEXT NOT NULL CHECK (attribute IN ('fire','water','iron','electric','wind')),
    weakness TEXT NOT NULL CHECK (weakness IN ('fire','water','iron','electric','wind')),
    tier TEXT NOT NULL CHECK (tier IN ('tyrant','lord')),
    total_hp_raw BIGINT NOT NULL DEFAULT 0,
    remaining_hp_raw BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (season_id, boss_number),
    UNIQUE (season_id, boss_code)
);

-- ===== Player Sync Levels (シーズン別SLv履歴) =====
CREATE TABLE IF NOT EXISTS player_sync_levels (
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    sync_level INT NOT NULL DEFAULT 0,
    PRIMARY KEY (season_id, player_id)
);

-- ===== Attacks (凸記録) =====
CREATE TABLE IF NOT EXISTS attacks (
    id BIGSERIAL PRIMARY KEY,
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    attack_date DATE NOT NULL,
    boss_number INT,                           -- NULL = 代理凸（ボス未指定）
    boss_code TEXT,                            -- 利便性のため複製保持
    damage_raw BIGINT NOT NULL DEFAULT 0,
    attack_number INT NOT NULL CHECK (attack_number BETWEEN 1 AND 3),
    level INT NOT NULL DEFAULT 1,              -- 凸時点のレイドレベル
    characters JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 凸PT (キャラ画像URL配列)
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attacks_season_player ON attacks(season_id, player_id);
CREATE INDEX IF NOT EXISTS idx_attacks_date ON attacks(attack_date);
CREATE INDEX IF NOT EXISTS idx_attacks_boss ON attacks(season_id, boss_number);

-- ===== Day Off (お休み宣言) =====
CREATE TABLE IF NOT EXISTS day_offs (
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    PRIMARY KEY (player_id, date)
);

-- ===== Availability (凸可能時間帯) =====
CREATE TABLE IF NOT EXISTS availability (
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    time_slot TEXT NOT NULL CHECK (time_slot IN ('morning','noon','evening','night','latenight')),
    PRIMARY KEY (player_id, time_slot)
);

-- ===== Finish Claims (締め凸担当者) =====
CREATE TABLE IF NOT EXISTS finish_claims (
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    level INT NOT NULL,
    boss_number INT NOT NULL,
    date DATE NOT NULL,
    claimed_by BIGINT REFERENCES players(id) ON DELETE SET NULL,
    claimed_at TIMESTAMPTZ,
    PRIMARY KEY (season_id, level, boss_number, date)
);

-- ===== Fururi Simulation Scores (基準者凸無し属性用) =====
CREATE TABLE IF NOT EXISTS fururi_simulation_scores (
    season_id BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    boss_code TEXT NOT NULL,
    damage_raw BIGINT NOT NULL,
    PRIMARY KEY (season_id, boss_code)
);

-- ===== Push Subscriptions (Phase 6 用) =====
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===== updated_at 自動更新トリガ =====
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_players_updated_at ON players;
CREATE TRIGGER trg_players_updated_at
BEFORE UPDATE ON players
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_player_damages_updated_at ON player_damages;
CREATE TRIGGER trg_player_damages_updated_at
BEFORE UPDATE ON player_damages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
