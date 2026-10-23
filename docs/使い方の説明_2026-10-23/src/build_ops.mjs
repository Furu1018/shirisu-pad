import fs from 'node:fs';
const src = fs.readFileSync(new URL('./build_member.mjs', import.meta.url), 'utf8');
const CSS0 = src.match(/const CSS = `([\s\S]*?)`;/)[1];
const CSS = CSS0 + `
.st2{display:grid;grid-template-columns:44px 1fr;gap:14px;align-items:start}
.st2 .k{width:44px;height:44px;border-radius:50%;background:var(--ink);color:#fff;font-size:22px;font-weight:900;display:flex;align-items:center;justify-content:center}
.st2 b{display:block;font-size:24px;font-weight:900;line-height:1.4}
.st2 span{display:block;font-size:19px;color:var(--body);line-height:1.6;margin-top:4px}
.st2 span span{display:inline;margin:0}
.col{display:flex;flex-direction:column;gap:18px}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:18px;padding:20px 24px;font-size:20px;line-height:1.7}
.warn ul{margin:0;padding-left:24px}
.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.tb{background:var(--card);border-radius:20px;padding:20px 18px;box-shadow:0 2px 10px rgba(20,22,26,.05)}
.tb b{display:block;font-size:24px;font-weight:900} .tb small{display:block;font-size:16.5px;color:var(--body);line-height:1.55;margin-top:8px;font-weight:700}
.tb.m{background:var(--s1);box-shadow:none;border:1.5px dashed var(--line)}
.tl{display:grid;grid-template-columns:130px 1fr;gap:16px;align-items:center}
.tl .d{font-size:21px;font-weight:900;color:var(--ops-deep);background:var(--ops-bg);border-radius:14px;padding:14px 10px;text-align:center;line-height:1.3}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{background:var(--card);border:1.5px solid var(--line);border-radius:999px;padding:7px 14px;font-size:18px;font-weight:900}
.chip.hot{background:var(--ink);color:#fff;border-color:var(--ink)}
.chips i{font-style:normal;color:var(--muted);font-weight:900;font-size:20px}
.cycle{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.cy{background:var(--card);border-radius:18px;padding:18px 14px;text-align:center;box-shadow:0 2px 10px rgba(20,22,26,.05)}
.cy .ic{font-size:40px;line-height:1} .cy b{display:block;font-size:20px;font-weight:900;margin-top:8px;line-height:1.35} .cy small{display:block;font-size:15px;color:var(--muted);margin-top:4px}
.cy .no{display:inline-block;font-size:14px;font-weight:900;color:#fff;background:var(--ops);border-radius:999px;padding:2px 10px;margin-bottom:8px}
.quote{background:var(--s1);border-left:5px solid var(--ops);border-radius:12px;padding:14px 18px;font-size:17px;line-height:1.65;color:var(--strong);white-space:pre-line}
`;
const D = decodeURIComponent(new URL('../実機画面_運営/', import.meta.url).pathname);
const crop = (f, w, top, h, scale = 100, ml = 0) => `<div class="shot" style="width:${w};aspect-ratio:1/${h};overflow:hidden;flex:none"><img src="file://${D}${f}" style="display:block;width:${scale}%;margin-left:${ml}%;margin-top:-${top}%"></div>`;
const full = (f, w) => `<img class="shot" src="file://${D}${f}" style="width:${w};flex:none">`;
const TAG = (i) => `<span class="tag">しりすこPAD · 運営向け操作 (${i}/6)</span>`;
const step = (n, b, d) => `<div class="st2"><div class="k">${n}</div><div><b>${b}</b>${d ? `<span>${d}</span>` : ''}</div></div>`;
const pages = [];
// 1
pages.push(`<div>${TAG(1)}<h1>ブロック制レイドの回し方<br><span class="em">運営</span></h1>
<div class="sub">前日に「朝」を配信。当日はブロックごとに同じ手順を繰り返します。</div></div>
<div class="tabs">
<div class="tb"><b>👥 メンバー</b><small>模擬の取り込み・メンバー状況・催促・一斉通知</small></div>
<div class="tb"><b>🧱 組む</b><small>このブロックの手順・🔒 凸の予約・算出 (盤 / 時間割)・配信</small></div>
<div class="tb"><b>⚔️ 戦況</b><small>ボス HP・📥 結果の取り込み・締め凸検索</small></div>
<div class="tb m"><b>👑 マスター</b><small>シーズン・バックアップ・任命 (ふるりだけ)</small></div></div>
<div class="card col">
<div class="tl"><div class="d">前日</div><div class="chips"><span class="chip">📸 模擬・催促</span><i>→</i><span class="chip">🧱 朝を組む</span><i>→</i><span class="chip">🔒 予約の承認</span><i>→</i><span class="chip hot">📤 朝を配信</span></div></div>
<div class="tl"><div class="d">当日<br><small style="font-size:15px">各ブロックの頭</small></div><div class="chips"><span class="chip">⚔️ HP</span><i>→</i><span class="chip">📥 結果の取り込み</span><i>→</i><span class="chip">🧱 組む</span><i>→</i><span class="chip hot">📤 配信</span><i>→</i><span class="chip">🏁 締め凸検索</span></div></div></div>
<div class="card row">${step('📌','いちばん上の「いちばん先に」から','運営タブを開くと、いま最初にやることが 1 つ出ます。タブの横の数字は手を打つべき件数。交代したら、ここから続けます。')}${crop('ops01_運営タブ_上部.png','400px',33,0.72)}</div>`);
// 2
pages.push(`<div>${TAG(2)}<h1><span class="n">1</span>前日: メンバーの準備をそろえる</h1><div class="sub">👥 メンバー タブ。模擬と参加可能時間がプランの材料です。</div></div>
<div class="card row">${step(1,'📸 模擬の取り込み','Discord に貼られた模擬のスクショを、本人の代わりに登録します。「誰の模擬か」→「スクショを選ぶ」。<br>届いていない人と、その人の締め切り (✗ 朝の前 など) が並びます。')}${crop('ops02b_模擬の取り込み.png','400px',0,0.86)}</div>
<div class="card row">${step(2,'📣 未提出の人に催促する','いちばん上の「いちばん先に」から押せます。宛先と文面を確かめて「送信する」。')}<div class="col">${full('ops02_催促ボタン.png','400px')}${crop('ops03_催促の送信確認.png','400px',34.5,0.95,112,-6)}</div></div>
<div class="warn"><ul><li>催促は通知を購読している人にだけ届きます。届かない人は Discord で声をかけます。</li><li>時間を登録していない人は、算出の候補に入りません。</li><li>全員に伝えたいことは「一斉通知」(運営も使えます)。</li></ul></div>`);
// 3
pages.push(`<div>${TAG(3)}<h1><span class="n">2</span>前日: 🧱 朝のブロックを組む</h1><div class="sub">🧱 組む タブ。頭に「このブロックの手順」が並び、いまの手順が光ります。</div></div>
<div class="card row">${step(1,'対象を「🧱 ブロックの人」にして「🧮 この条件で算出」','前日は「朝 5〜8時」が選ばれています。本人の凸数・🔒 予約・除外・難しい は自動で効きます。')}<div class="col">${crop('ops04-05_このブロックの手順と算出の条件.png','400px',2.7,0.79)}${crop('ops04-05_このブロックの手順と算出の条件.png','400px',100,0.41)}</div></div>
<div class="card row">${step(2,'🧱 盤 で見る','枠の長さ = ボスの残り HP、ピースの幅 = ダメージ。足りないボスは「あと ◯B」と、置ける候補が出ます。')}${crop('ops06-10-15_盤と配信ボタン_一気に組む.png','400px',512,1.43)}</div>
<div class="card row">${step(3,'置きたい人がいれば 📌 仮置き','🗓 時間割で、ピース (🧩 模擬ピース) を押す → 光ったマスを押す。自動で算出し直します。<br>📌 は運営の下書き。本人には見えません。')}${crop('ops07_時間割_仮置き.png','400px',437,0.82)}</div>`);
// 4
pages.push(`<div>${TAG(4)}<h1><span class="n">3</span>前日: 予約を承認 → 📤 配信</h1><div class="sub">メンバーから予約が届くと、運営あてに通知が鳴ります。</div></div>
<div class="card row">${step(1,'🔒 凸の予約 で「承認する」','確認が出たら OK。承認した予約を入れて組み直します。<br>運営の誰か 1 人が承認すれば成立します。')}${full('ops08_予約の承認.png','400px')}</div>
<div class="card row"><div class="col">${step(2,'「📤 朝のぶんを配信」','確認が出たら OK。押すまでメンバーには見えません。配信すると、朝に割当のある人のホームに出て「あなたの凸」の通知が届きます。')}${step(3,'Discord の運営スレに「朝 配信した」と 1 行','')}</div>${crop('ops06-10-15_盤と配信ボタン_一気に組む.png','400px',1017,0.3)}</div>
<div class="warn"><ul><li>置けなかった予約 (未達) は必ず画面に出ます。解除しないと、その人の枠を押さえたままになります。</li><li>同じブロックの配信し直しは、割当が変わった人にだけ届きます。</li><li>「配信中止」は削除ではなく凍結 (メンバーには前の割当と「組み直し中」の帯)。</li></ul></div>`);
// 5
pages.push(`<div>${TAG(5)}<h1><span class="n">4</span>当日: ブロックの頭に 4 手順</h1><div class="sub">朝・午前・昼・午後・夕方・夜・深夜、ブロックごとに繰り返します。</div></div>
<div class="cycle"><div class="cy"><span class="no">1</span><div class="ic">⚔️</div><b>HP を<br>ゲームと合わせる</b><small>⚔️ 戦況</small></div><div class="cy"><span class="no">2</span><div class="ic">📥</div><b>前のブロックの<br>結果を取り込む</b><small>⚔️ 戦況</small></div><div class="cy"><span class="no">3</span><div class="ic">🧱</div><b>そのブロックを<br>組む</b><small>🧱 組む (前日と同じ)</small></div><div class="cy"><span class="no">4</span><div class="ic">📤</div><b>配信して<br>運営スレに 1 行</b><small>🧱 組む</small></div></div>
<div class="card row">${step(1,'「🎯 ボス HP を更新する」→ 残HP を入れて「保存」','古い HP のまま組むと、無駄凸や取りこぼしが出ます。残HP が 0 になる保存は撃破として通知が飛ぶので、数字を確かめてから。')}<div class="col">${crop('ops11a_当日_いちばん先に_HP.png','400px',64,0.41)}${crop('ops11_ボスHP更新.png','400px',2.9,0.96,112,-6)}</div></div>
<div class="card row">${step(2,'「⏰ 結果がまだの凸」の「📥 取り込む」','ダメージを入れて「登録する」(スクショを選べば読み取れます)。凸していなかった人は「凸していない」→ 次のブロックで組み直し。')}<div class="col">${crop('ops12_結果がまだの凸.png','400px',44,0.75)}${crop('ops13_結果の取り込み.png','400px',82,0.92)}</div></div>`);
// 6
pages.push(`<div>${TAG(6)}<h1>知っておくと便利</h1></div>
<div class="card row">${step('🏁','締め凸検索 (⚔️ 戦況)','残りが少ないボスのカードで「締め凸検索」。「いま打つか、待つか」を読んで「📋 名前と文面をコピー」→ Discord で声をかけます (PAD からは頼まない)。やってもらえることになったら、盤に置いて 🔒 確定 → 配信。')}${crop('ops14_締め凸検索.png','400px',0,0.86)}</div>
<div class="card">${step('🧱','残りのブロックを一気に組む (🧱 組む の下)','模擬が早くそろったとき。いまのブロックから最後まで、前のブロックが模擬どおり削れたと仮定して組み、ブロックごとに配信します (🔭 予想の印・通知は人ごとに 1 通)。実際の結果でずれたら、次のブロックの頭で組み直します。')}</div>
<div class="practice"><div><b>🎮 練習してみる</b><span>設定 ›「🎮 練習する (運営編・前日 / 当日)」。本番と同じ画面を練習用のデータで、各 約 5 分。本番には反映されません。</span></div>${crop('ops16_設定_練習する.png','400px',35,0.53)}</div>`);
pages.forEach((b, i) => fs.writeFileSync(`${process.argv[2] || '.'}/slide${i+1}.html`, `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="page">${b}</div></body></html>`));
