-- ============================================================================
-- 🗣 2026-10-24 ふるりの決定: 模擬の編成を 1 属性 3 つまで (player_damages.slot 1〜3)
-- 32 で 2 に戻した CHECK を 1〜3 に広げるだけ。行は消さない (32 は slot>=3 を削除したが、ここは制約だけ)。
-- クライアント (js/supabase-client.js の MOCK_SLOT_MAX = 3) と同時に出す。未適用のまま編成③を保存すると
-- CHECK で弾かれ、画面が「55 を実行してください」と案内する (読み出し・算出は従来どおり動く)。
-- ソルバーは「同じキャラは 1 日 1 回」で 3 凸を選ぶので、同じ属性の 3 編成でもキャラが被らない形で組める。
-- ボス 5 の弱点の編成②③は Lv4 でだけ使う (段階 5 の決まりの延長)
-- ============================================================================
-- 適用: Supabase Dashboard → SQL Editor で実行 (再実行しても壊れない)
-- ============================================================================

ALTER TABLE player_damages DROP CONSTRAINT IF EXISTS chk_player_damages_slot;
ALTER TABLE player_damages
    ADD CONSTRAINT chk_player_damages_slot CHECK (slot IN (1, 2, 3));

NOTIFY pgrst, 'reload schema';
