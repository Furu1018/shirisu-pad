// A4 1 枚の説明 (メンバー向け / 運営向け) を HTML に組む。画像は ./実機画面/ (練習モードで撮った本物の画面)。
//   node src/build_a4.mjs  → メンバー向け_A4.html / 運営向け_A4.html (このフォルダに)。PNG / PDF は src/render_a4.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIM = { m03: [748, 613], m06: [748, 423], m08: [748, 433], m09: [748, 1399], m11: [780, 247], m12: [748, 1489], o01: [780, 1688], o03: [780, 1688], o06: [780, 1688], o07: [748, 671], o10: [748, 322], o11: [780, 1688], o14: [672, 914], o15: [672, 214], o16: [672, 708], o17: [672, 630], o19: [672, 730] };
const FILE = { m03: 'm03_mocks', m06: 'm06_avail_strip_after', m08: 'm08_next_action_day', m09: 'm09_today_published', m11: 'm11_ack_btn', m12: 'm12_today_done', o01: 'o01_ops_top', o03: 'o03_ops_avail_sheet', o06: 'o06_resv_create_block', o07: 'o07_resv_card', o10: 'o10_day_hero', o11: 'o11_hp_sheet_diff', o14: 'o14_board_rows', o15: 'o15_plan_next', o16: 'o16_block_steps', o17: 'o17_missing', o19: 'o19_result_form_box' };
// 切り抜き: box = [x0, y0, x1, y1] (画像の px)・w = 置く幅 (mm)。高さは比率で決まる
const crop = (key, box, w) => {
    const [W] = DIM[key]; const [x0, y0, x1, y1] = box || [0, 0, DIM[key][0], DIM[key][1]];
    const cw = x1 - x0, ch = y1 - y0, scale = W / cw * 100;
    return `<div class="shot" style="width:${w}mm;aspect-ratio:${cw}/${ch}"><img src="実機画面/${FILE[key]}.png" alt="" style="width:${scale.toFixed(3)}%;margin-left:${(-x0 / cw * 100).toFixed(3)}%;margin-top:${(-y0 / cw * 100).toFixed(3)}%"></div>`;
};
const CSS = `
@page { size: A4; margin: 0; }
html, body { margin: 0; }
body { font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; color: #14161A; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-weight: 600; }
.page { width: 210mm; height: 297mm; padding: 8mm 9mm; box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; gap: 3mm; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 4mm; }
.tag { display: inline-block; background: #6C42F0; color: #fff; border-radius: 999px; padding: 0.8mm 3mm; font-size: 7pt; font-weight: 900; margin-bottom: 1.2mm; }
h1 { font-size: 14.5pt; margin: 0; font-weight: 900; line-height: 1.25; letter-spacing: 0.1pt; }
h1 .em { color: #4b17ed; }
.lead { font-size: 8.6pt; color: #3D4249; margin: 1mm 0 0; line-height: 1.5; }
.cols { display: grid; gap: 3mm; flex: 1; min-height: 0; }
.cols.three { grid-template-columns: repeat(3, 1fr); }
.cols.two { grid-template-columns: 1fr 1fr; }
.col { border: 0.35mm solid #E3E5E8; border-radius: 3mm; padding: 2.8mm 3mm; display: flex; flex-direction: column; gap: 2mm; background: #F7F8F9; min-height: 0; }
.col > .when { font-size: 7pt; font-weight: 900; color: #4b17ed; background: #F0ECFE; border-radius: 999px; padding: 0.6mm 2.5mm; align-self: flex-start; }
.col h2 { font-size: 11pt; margin: 0; font-weight: 900; line-height: 1.3; display: flex; align-items: center; gap: 2mm; }
.n { width: 6mm; height: 6mm; border-radius: 50%; background: #14161A; color: #fff; font-weight: 900; font-size: 9pt; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.col p, .col li { margin: 0; font-size: 8pt; line-height: 1.5; color: #3D4249; }
.col ol { margin: 0; padding-left: 4mm; display: flex; flex-direction: column; gap: 0.8mm; }
.col b, .box b { color: #14161A; }
.step { display: grid; grid-template-columns: 1fr auto; gap: 2.5mm; align-items: start; }
.step.single { grid-template-columns: 1fr; }
.step h3 { font-size: 9.2pt; margin: 0 0 0.8mm; font-weight: 900; display: flex; gap: 1.6mm; align-items: center; line-height: 1.3; }
.step h3 .n { width: 5mm; height: 5mm; font-size: 7.5pt; }
.step p { font-size: 7.6pt; }
.shots { display: flex; flex-direction: column; gap: 1.5mm; align-items: center; }
.shot { border-radius: 1.8mm; overflow: hidden; box-shadow: 0 0.4mm 1.6mm rgba(0,0,0,.16); border: 0.25mm solid rgba(0,0,0,.08); background: #fff; flex: none; }
.shot img { display: block; }
.cap { font-size: 6.5pt; color: #62666e; text-align: center; font-weight: 800; }
.foot { display: grid; grid-template-columns: 1.15fr 1fr; gap: 3mm; }
.box { border-radius: 3mm; padding: 2.5mm 3.5mm; font-size: 7.8pt; line-height: 1.5; }
.box.dark { background: #14161A; color: #fff; } .box.dark b { color: #fff; }
.box.light { background: #F0ECFE; color: #14161A; }
.box h4 { margin: 0 0 1mm; font-size: 9pt; font-weight: 900; }
.box ul { margin: 0; padding-left: 3.5mm; }
.blocks { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1mm; margin-top: 1.5mm; }
.blk { background: #fff; border-radius: 1.5mm; text-align: center; padding: 0.8mm 0; font-size: 7.4pt; font-weight: 900; line-height: 1.25; }
.blk small { display: block; font-size: 6.2pt; color: #62666e; font-weight: 800; }
.tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; }
.tb { background: #F7F8F9; border: 0.35mm solid #E3E5E8; border-radius: 2.5mm; padding: 1.8mm 2.5mm; font-size: 7.2pt; line-height: 1.4; color: #3D4249; }
.tb b { display: block; font-size: 8.6pt; color: #14161A; }
.tb.m { border-style: dashed; }
.foot-note { font-size: 6.8pt; color: #62666e; text-align: right; }
`;
const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body><div class="page">${body}</div></body></html>`;
const blocks = `<div class="blocks">${[['朝', '5〜8時'], ['午前', '9〜11時'], ['昼', '12〜14時'], ['午後', '15〜17時'], ['夕方', '18〜20時'], ['夜', '21〜23時'], ['深夜', '翌0〜4時']].map(([a, b]) => `<div class="blk">${a}<small>${b}</small></div>`).join('')}</div>`;

// ===== メンバー向け =====
const member = page('しりすこPAD メンバーがやること', `
<div class="head"><div><span class="tag">しりすこPAD · 🧱 ブロック制 (2026-10 から)</span>
<h1>メンバーがやること — <span class="em">前日は Discord に書くだけ</span>、当日は配信を見て ✅ → 凸</h1>
<p class="lead">PAD の中で入力するものはありません。運営が PAD に登録し、ブロックの前に「あなたの凸」を配信します。</p></div></div>
<div class="cols three">
 <div class="col"><span class="when">前日まで</span><h2><span class="n">1</span>Discord に 3 つ書く</h2>
  <ol><li><b>出られるブロックと、何凸するか</b> — 例「朝 1・夜 2」「夕方だけ 3」。凸数が無ければブロックだけで OK (運営におまかせ)。出られない回は「今回は難しい」</li>
  <li><b>模擬のスクショ</b> — 属性ごとに 1 つ (編成 5 キャラとダメージが写るもの)。<b>18 時以降に出られる人は、ボス 5 の属性だけ編成を 2 つ</b></li>
  <li><b>凸先の希望があれば</b> — 「夕方に 風圧PT の編成① で」のように (= 予約。組み直しても動かない)</li></ol>
  <p>運営が登録すると、ホームの <b>⏰ 参加可能時間</b> / <b>📘 登録された模擬</b> / <b>🔒 予約</b> に出て通知が届きます。違っていたら Discord で運営へ。</p>
  <div class="shots">${crop('m06', null, 57)}<span class="cap">運営が登録すると ⏰ に時間と「凸数: 夜 2」が出る</span>${crop('m03', [0, 0, 748, 480], 57)}<span class="cap">📘 登録された模擬 (直すときは Discord に出し直す)</span></div></div>
 <div class="col"><span class="when">当日 · 自分のブロックの前</span><h2><span class="n">2</span>配信を見て ✅</h2>
  <ol><li>ブロックの前に <b>「🧱 夜 21〜23時 のあなたの凸が決まりました」</b> の通知が来る</li>
  <li>ホームの <b>📅 きょうの凸</b> で「何時に・どのボスへ・どの PT の どの編成で」を見る</li>
  <li>読んだら <b>✅ 確認しました</b> を押す</li>
  <li><b>「プランが変わりました」の通知が来たら、もう一度 📅 を見て ✅</b> (前のブロックの結果で予定が変わることがある)</li></ol>
  <p>配信されるのは<b>次のブロックのぶんだけ</b>。後ろのブロックは、そのブロックの前に配信されます。</p>
  <div class="shots">${crop('m09', [0, 700, 748, 1170], 57)}<span class="cap">📅 きょうの凸 — 夜 21時 B1 ドリアン / 水冷PT 編成①</span>${crop('m11', [30, 50, 750, 172], 57)}<span class="cap">読んだら ✅ (運営が「見た人 / まだの人」を知るため)</span></div></div>
 <div class="col"><span class="when">凸したら</span><h2><span class="n">3</span>スクショを Discord へ</h2>
  <ol><li>その時刻になったらゲームで凸</li>
  <li><b>結果の画面のスクショを Discord へ</b>。PAD に入れるものはありません</li>
  <li>運営が取り込むと きょうの凸 に <b>✓</b> が付く</li>
  <li>その時刻に行けなくなったら Discord で一言。締め凸 (とどめ) は運営が Discord で声をかけます</li></ol>
  <div class="shots">${crop('m08', null, 57)}<span class="cap">当日のホーム — 残り凸と「📅 きょうの凸を見る」</span>${crop('m12', [0, 860, 748, 1215], 57)}<span class="cap">運営が取り込むと ✓ (1 / 3 凸 済み)</span></div></div>
</div>
<div class="foot">
 <div class="box dark"><h4>PAD で触るのは、この 4 つだけ</h4><ul><li>最初の 1 回: 名乗る・🔔 通知を ON (iPhone は先に「ホーム画面に追加」。Safari のタブのままだと通知が来ません)</li><li>📅 きょうの凸 を見る</li><li>✅ 確認しました を押す</li><li>困ったら ヘルプ、または 設定 › 🎮 練習する (メンバー編) — 本番と同じ画面を 3 分で試せます</li></ul></div>
 <div class="box light"><h4>🧱 ブロックは 7 つ</h4>${blocks}<p style="margin:1.5mm 0 0;font-size:7.4pt;line-height:1.5;">運営はブロックごとに、そのブロックに出られる人で凸を組み、ブロックの前に配信します。凸数を書いたブロックには、その数より多くは割り当てません。</p></div>
</div>`);

// ===== 運営向け =====
const ops = page('しりすこPAD 運営がやること', `
<div class="head"><div><span class="tag">しりすこPAD · 🧱 ブロック制 · 運営担当向け (2026-10 から)</span>
<h1>運営がやること — 前日に「朝」を配信、<span class="em">当日はブロックの頭ごとに 4 手順</span></h1>
<p class="lead">メンバーは Discord に書くだけ。PAD への登録はぜんぶ運営が行う。運営タブを開くと、いちばん上の「いちばん先に」が次にやることを 1 つ出す (交代したらそこから)。</p></div></div>
<div class="tabs">
 <div class="tb"><b>👥 メンバー</b>メンバー状況 (⏰ 時間と凸数の登録)・📸 模擬の取り込み・📣 催促・一斉通知</div>
 <div class="tb"><b>🧱 組む</b>このブロックの手順の帯・🔒 凸の予約 (＋ 予約を登録)・算出 (盤 / 時間割)・📤 配信</div>
 <div class="tb"><b>⚔️ 戦況</b>🎯 ボス HP の更新・📥 結果の取り込み・🏁 締め凸検索</div>
 <div class="tb m"><b>👑 マスター</b>シーズン・任命・バックアップ (ふるりだけ)</div>
</div>
<div class="cols two">
 <div class="col"><span class="when">前日 — Discord の報告が来たら、人ごとに PAD へ</span>
  <div class="step"><div><h3><span class="n">1</span>⏰ 時間と凸数を登録</h3><p>👥 メンバー状況の行の <b>⏰</b> (📸 の「時間を登録」でも)。本人のシートと同じ部品に「👑 運営の登録: ○○ さん」と出る。出られるブロックを ON・凸数を ＋/−・<b>「この時間で参加します」</b>。前回の登録が既定で入っている。報告の無い人は <b>📣 催促</b> (文面は「Discord で教えてください」)。時間が無い人は算出の候補に入らない。</p></div>${crop('o03', [0, 200, 780, 1160], 40)}</div>
  <div class="step"><div><h3><span class="n">2</span>📸 模擬を登録 → 希望は 🔒 予約</h3><p>👥 › 📸 模擬の取り込み: 「誰の模擬か」→ スクショ (PC は落とす / 貼り付け)。保存先 (編成① / ②) は自動。希望が書かれた人は、保存直後の <b>「🔒 この編成で予約する」</b> か 🧱 組む › 🔒 凸の予約 › <b>「＋ 予約を登録」</b> (誰が → どの編成 → どのブロック)。登録した時点で予約・本人に通知。承認待ちは無い。</p></div>${crop('o07', [0, 0, 748, 671], 40)}</div>
  <div class="step"><div><h3><span class="n">3</span>🧱 朝を組む → 📤 配信</h3><p>🧱 組む › 対象「🧱 ブロックの人」(前日は 朝) → <b>🧮 この条件で算出</b> → 🧱 盤で確かめる。足りないボスには候補が出る。手で置くなら 🧩 ピース → 光ったマス (📌 仮置き・本人には見えない)。置けない駒は理由が出る。→ <b>📤 朝のぶんを配信</b> → 運営スレに「朝 配信した」。模擬が早くそろえば「残りのブロックを一気に組む」(🔭 予想)。</p></div><div class="shots">${crop('o14', [0, 0, 672, 470], 40)}${crop('o15', [0, 0, 672, 214], 40)}</div></div>
 </div>
 <div class="col"><span class="when">当日 — ブロックの頭ごとに (🧱 組む の手順の帯のとおり)</span>
  <div class="step"><div><h3><span class="n">1</span>⚔️ ボスの HP をゲームと合わせる</h3><p>「いちばん先に」の <b>🎯 ボス HP を更新する</b> → BlaBlaLINK のボス一覧のスクショを 選ぶ / 落とす / 貼り付け (PC) → 行に<b>いまの値との差分</b> (読めなかった行は「読めず」) → <b>⏬ 読み取った値を保存</b>。残 HP が 0 になる保存は撃破として通知が飛ぶ。古い HP のまま組むと無駄凸・取りこぼしが出るので、必ずここから。</p></div>${crop('o11', [0, 215, 780, 960], 40)}</div>
  <div class="step"><div><h3><span class="n">2</span>📥 前のブロックの結果を取り込む</h3><p>⚔️ 戦況 › 📥 結果の取り込み › <b>⏰ 結果がまだの凸</b> の「📥 取り込む」→ スクショ (ボス・ダメージ・キャラを読み取る) か ダメージを手で → <b>登録する</b> (✓ 確認済み・残 HP もダメージぶん減る)。凸していなかった人は「凸していない」(次のブロックで組み直す)。聞くなら「📋 聞く」の文面を Discord へ。</p></div><div class="shots">${crop('o17', [0, 0, 672, 335], 40)}${crop('o19', [0, 330, 672, 730], 40)}</div></div>
  <div class="step"><div><h3><span class="n">3</span>🧱 組む → <span class="n">4</span>📤 配信</h3><p>前日と同じ (対象「ブロックの人」= いまのブロック → 算出 → 盤 → 配信 → 運営スレに 1 行)。前に配信した割当は尊重される。配信し直したときは<b>割当が変わった人にだけ</b>通知 (✅ の有無に関わらず・割当が消えた人にも)。</p><p style="margin-top:1mm"><b>🏁 必要なときだけ</b>: 残りが少ないボスは 締め凸検索 →「いま打つか、待つか」→ 📋 名前と文面をコピー → Discord で声をかける → 盤に置いて 🔒 確定 → 配信。</p></div>${crop('o16', [0, 0, 672, 708], 40)}</div>
 </div>
</div>
<div class="foot">
 <div class="box dark"><h4>知っておくこと</h4><ul><li><b>1 ブロックは 1 人が組む</b> (📌 は誰が置いてもよい)。共有されるのは DB にあるもの (📌・🔒・HP・結果・模擬・時間・配信)。算出の結果と条件パネルは端末の中だけ。配信の直前に別の運営の配信と照合するので、相手の約束を知らずに上書きしない</li><li><b>置けなかった予約 (未達) は必ず画面に出る</b> — 運営が解除しないと枠を押さえたまま</li><li>「配信中止」は削除ではなく凍結 (前の割当と「組み直し中」の帯)。新しい配信で解除</li><li>誤って登録した凸は 📥 › 登録された凸 の ✏️ 編集・削除</li></ul></div>
 <div class="box light"><h4>練習・文章</h4><ul><li>設定 › <b>🎮 練習する (運営編・前日 / 当日)</b> — 本番と同じ画面を練習用のデータで各 5 分。前日は 催促 → ⏰ 登録 → 🔒 予約 → 🧱 朝 → 📌 → 配信、当日は ⚔️ HP → 📥 → 🧱 夕方 → 配信 → 締め凸検索</li><li>メンバー向けの文章は 👥 › <b>📣 Discord 用の文面</b> からコピーして Discord にピン留め (レイドの 2 日前からは 🔔 通知の疎通確認も)</li><li>メンバーに PAD の入力は無い。「違っていたら Discord で運営へ」と伝えてある</li></ul></div>
</div>`);
fs.writeFileSync(path.join(ROOT, 'メンバー向け_A4.html'), member);
fs.writeFileSync(path.join(ROOT, '運営向け_A4.html'), ops);
console.log('ok');
