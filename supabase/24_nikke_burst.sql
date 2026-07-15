-- 本家 nikke_characters バースト逆輸入 (GB burst-map 由来・出典 game8)
-- 63件を投入。未照合キャラは null (=どのバースト枠でも選べる扱い)。
-- 冪等 (再実行可)。バースト列が無ければ追加してから。

alter table public.nikke_characters add column if not exists burst text
    check (burst is null or burst in ('B1','B2','B3','BΛ'));

update public.nikke_characters set burst='B3' where canonical_name='E.H.';
update public.nikke_characters set burst='B1' where canonical_name='アニス:スター';
update public.nikke_characters set burst='B3' where canonical_name='アニス：スパークリングサマー';
update public.nikke_characters set burst='B3' where canonical_name='アリス';
update public.nikke_characters set burst='B1' where canonical_name='アリス：ワンダーランドバニー';
update public.nikke_characters set burst='B2' where canonical_name='アルカナ：フォーチュンメイト';
update public.nikke_characters set burst='B2' where canonical_name='アンカー：イノセントメイド';
update public.nikke_characters set burst='B3' where canonical_name='イヴ';
update public.nikke_characters set burst='B2' where canonical_name='エード：エージェントバニー';
update public.nikke_characters set burst='B3' where canonical_name='エレグ：ブーム・アンド・ショック';
update public.nikke_characters set burst='B1' where canonical_name='キラーワイン';
update public.nikke_characters set burst='B2' where canonical_name='クラウン';
update public.nikke_characters set burst='B2' where canonical_name='グレイブ';
update public.nikke_characters set burst='B3' where canonical_name='ジュリア';
update public.nikke_characters set burst='B3' where canonical_name='シンデレラ';
update public.nikke_characters set burst='B3' where canonical_name='シンデレラ:クリスタルウェーブ';
update public.nikke_characters set burst='B3' where canonical_name='スノーホワイト';
update public.nikke_characters set burst='B3' where canonical_name='スノーホワイト：ヘビーアームズ';
update public.nikke_characters set burst='B1' where canonical_name='セイレーン';
update public.nikke_characters set burst='B2' where canonical_name='センチ';
update public.nikke_characters set burst='B1' where canonical_name='ソリン：フロストチケット';
update public.nikke_characters set burst='B1' where canonical_name='ツバイ';
update public.nikke_characters set burst='B3' where canonical_name='ディーゼル：ウィンタースイーツ';
update public.nikke_characters set burst='B1' where canonical_name='ティア';
update public.nikke_characters set burst='B1' where canonical_name='トーブ';
update public.nikke_characters set burst='B2' where canonical_name='トリナ';
update public.nikke_characters set burst='B3' where canonical_name='ドレイク';
update public.nikke_characters set burst='B3' where canonical_name='ドロシー：セレンディピティ';
update public.nikke_characters set burst='B2' where canonical_name='ナガ';
update public.nikke_characters set burst='B2' where canonical_name='ナユタ';
update public.nikke_characters set burst='B3' where canonical_name='ネオン：ビジョン・アイ';
update public.nikke_characters set burst='B1' where canonical_name='ノイズ';
update public.nikke_characters set burst='B3' where canonical_name='ノワール';
update public.nikke_characters set burst='B3' where canonical_name='バニーミルク';
update public.nikke_characters set burst='B2' where canonical_name='ブラン';
update public.nikke_characters set burst='B2' where canonical_name='プリカ';
update public.nikke_characters set burst='B2' where canonical_name='ブリッド：サイレントトラック';
update public.nikke_characters set burst='B3' where canonical_name='プリバティ';
update public.nikke_characters set burst='B2' where canonical_name='ベルベット';
update public.nikke_characters set burst='B3' where canonical_name='ヘルム';
update public.nikke_characters set burst='B2' where canonical_name='ヘルム：アクアマリン';
update public.nikke_characters set burst='B3' where canonical_name='マクスウェル';
update public.nikke_characters set burst='B2' where canonical_name='マスト：ロマンチックメイド';
update public.nikke_characters set burst='B2' where canonical_name='マリ';
update public.nikke_characters set burst='B3' where canonical_name='マルチャーナ：マリンスタディ';
update public.nikke_characters set burst='B3' where canonical_name='ミハラ：ボンディングチェーン';
update public.nikke_characters set burst='B1' where canonical_name='ミランダ';
update public.nikke_characters set burst='B2' where canonical_name='ミント';
update public.nikke_characters set burst='B3' where canonical_name='メイデン：アイスローズ';
update public.nikke_characters set burst='B1' where canonical_name='モラン';
update public.nikke_characters set burst='B3' where canonical_name='ラピ:レッドフード';
update public.nikke_characters set burst='B3' where canonical_name='ラプラス';
update public.nikke_characters set burst='B1' where canonical_name='リター';
update public.nikke_characters set burst='B1' where canonical_name='リトルマーメイド';
update public.nikke_characters set burst='B3' where canonical_name='リバーレリオ';
update public.nikke_characters set burst='B1' where canonical_name='ルージュ';
update public.nikke_characters set burst='B3' where canonical_name='ルドミラ:ウィンターオーナー';
update public.nikke_characters set burst='B3' where canonical_name='レイヴン';
update public.nikke_characters set burst='BΛ' where canonical_name='レッドフード';
update public.nikke_characters set burst='B2' where canonical_name='レム';
update public.nikke_characters set burst='B3' where canonical_name='水着マルチャーナ';
update public.nikke_characters set burst='B3' where canonical_name='紅蓮';
update public.nikke_characters set burst='B3' where canonical_name='紅蓮：ブラックシャドウ';

notify pgrst, 'reload schema';   -- API にカラムを即認識させる
