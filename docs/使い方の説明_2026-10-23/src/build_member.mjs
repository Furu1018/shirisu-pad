import fs from 'node:fs';
const D = decodeURIComponent(new URL('../実機画面_メンバー/', import.meta.url).pathname);
const crop = (f, w, top, h, scale = 100, ml = 0) => `<div class="shot" style="width:${w};aspect-ratio:1/${h};overflow:hidden"><img src="file://${D}${f}" style="display:block;width:${scale}%;margin-left:${ml}%;margin-top:-${top}%"></div>`;
const img = (f, w, cls = '') => `<img class="shot ${cls}" src="file://${D}${f}" style="width:${w}px">`;
const CSS = `
:root{--ink:#14161A;--strong:#3D4249;--body:#52575E;--muted:#62666e;--bg:#F1F3F6;--card:#fff;--s1:#F7F8F9;--line:#E3E5E8;--ops:#6C42F0;--ops-deep:#4b17ed;--ops-bg:#f0ecfe;--ok:#107e45;--ok-bg:#e8f9f0;--warn:#724905;--warn-bg:#fef5e7;}
*{box-sizing:border-box}
body{margin:0;width:1080px;background:var(--bg);color:var(--ink);font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;font-weight:700;-webkit-font-smoothing:antialiased}
.page{width:1080px;padding:48px 52px 44px;display:flex;flex-direction:column;gap:26px}
.tag{display:inline-block;font-size:17px;font-weight:900;padding:5px 14px;border-radius:999px;background:var(--ops);color:#fff;margin-bottom:14px}
h1{margin:0;font-size:50px;font-weight:900;line-height:1.25;letter-spacing:.3px}
h1 .n{display:inline-flex;width:58px;height:58px;border-radius:50%;background:var(--ops);color:#fff;align-items:center;justify-content:center;font-size:32px;vertical-align:6px;margin-right:12px}
.sub{font-size:23px;color:var(--body);line-height:1.6;margin-top:12px}
.card{background:var(--card);border-radius:24px;padding:30px 32px;box-shadow:0 2px 10px rgba(20,22,26,.05)}
.row{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:center}
.st{display:grid;grid-template-columns:52px 1fr;gap:16px;align-items:start}
.st .k{width:52px;height:52px;border-radius:50%;background:var(--ink);color:#fff;font-size:26px;font-weight:900;display:flex;align-items:center;justify-content:center}
.st b{display:block;font-size:27px;font-weight:900;line-height:1.4}
.st span span{display:inline!important;margin:0!important} .st span{display:block;font-size:20px;color:var(--body);line-height:1.65;margin-top:6px;font-weight:700}
.shot{display:block;border-radius:18px;box-shadow:0 6px 22px rgba(20,22,26,.13);border:1px solid rgba(20,22,26,.06);background:#fff}
.em{color:var(--ops-deep)} .ok{color:var(--ok)}
.pill{display:inline-block;padding:3px 12px;border-radius:999px;font-size:18px;font-weight:900}
.pill.warn{background:var(--warn-bg);color:var(--warn)} .pill.ok{background:var(--ok-bg);color:var(--ok)}
.point{background:var(--ink);color:#fff;border-radius:18px;padding:22px 26px;font-size:21px;line-height:1.7}
.point li{margin:2px 0} .point ul{margin:0;padding-left:24px}
.flow{display:grid;grid-template-columns:1fr 40px 1fr 40px 1fr;align-items:stretch;gap:8px}
.fb{background:var(--card);border-radius:22px;padding:30px 20px;text-align:center;box-shadow:0 2px 10px rgba(20,22,26,.05);display:flex;flex-direction:column;gap:12px;align-items:center}
.fb .ic{font-size:60px;line-height:1}
.fb .when{font-size:17px;font-weight:900;color:var(--ops-deep);background:var(--ops-bg);border-radius:999px;padding:4px 14px}
.fb b{font-size:26px;font-weight:900;line-height:1.4}
.fb small{font-size:18px;color:var(--body);line-height:1.6;font-weight:700}
.arr{display:flex;align-items:center;justify-content:center;font-size:34px;color:var(--muted);font-weight:900}
.blocks{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
.blk{border-radius:14px;padding:14px 6px;text-align:center;background:var(--s1);border:1.5px solid var(--line)}
.blk b{display:block;font-size:24px;font-weight:900} .blk small{display:block;font-size:15px;color:var(--muted);margin-top:4px;font-weight:800}
.foot{font-size:18px;color:var(--muted);text-align:center;line-height:1.6}
.pair{display:grid;grid-template-columns:1fr 60px 1fr;align-items:center;gap:6px}
.cap{font-size:20px;font-weight:900;text-align:center;margin-bottom:12px}
.sum li{font-size:27px;font-weight:900;line-height:1.5;margin:10px 0}
.sum ol{margin:0;padding-left:40px}
.mini{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.mini h3{margin:0 0 8px;font-size:25px;font-weight:900}
.mini p{margin:0 0 16px;font-size:19px;color:var(--body);line-height:1.65}
.practice{display:grid;grid-template-columns:1fr auto;gap:26px;align-items:center;background:var(--ops-bg);border:2px solid var(--ops);border-radius:24px;padding:26px 30px}
.practice b{font-size:28px;font-weight:900;display:block} .practice span{font-size:20px;color:var(--strong);line-height:1.65;display:block;margin-top:8px}
`;
const TAG = (i) => `<span class="tag">しりすこPAD · メンバー向け使い方 (${i}/5)</span>`;
const pages = [];
// 1 表紙
pages.push(`<div>${TAG(1)}<h1>今期からレイドは<br><span class="em">「ブロック」</span>で動きます</h1>
<div class="sub">メンバーがやることは、この 3 つだけです。</div></div>
<div class="flow">
 <div class="fb"><span class="when">前日まで</span><div class="ic">⏰</div><b>参加可能時間と<br>凸数を入れる</b><small>出られるブロックを ON →<br>「この時間で参加します」</small></div>
 <div class="arr">→</div>
 <div class="fb"><span class="when">当日・ブロックの前</span><div class="ic">📅</div><b>配信を見て<br>「✅ 確認しました」</b><small>いつ・どのボスへ・<br>どの PT で行くかを確かめる</small></div>
 <div class="arr">→</div>
 <div class="fb"><span class="when">凸したら</span><div class="ic">📸</div><b>結果のスクショを<br>Discord へ</b><small>PAD には入れなくて OK<br>運営が取り込むと ✓</small></div>
</div>
<div class="card"><div style="font-size:24px;font-weight:900;margin-bottom:16px">🧱 ブロックは 7 つ</div>
<div class="blocks">${[['朝','5〜8時'],['午前','9〜11時'],['昼','12〜14時'],['午後','15〜17時'],['夕方','18〜20時'],['夜','21〜23時'],['深夜','翌0〜4時']].map(([a,b])=>`<div class="blk"><b>${a}</b><small>${b}</small></div>`).join('')}</div>
<p style="margin:18px 0 0;font-size:20px;color:var(--body);line-height:1.7">運営はブロックごとに、そのブロックに出られる人で凸を組み、<b style="color:var(--ink)">ブロックの前に配信</b>します。<br>模擬は今までどおり Discord にスクショを貼るだけ (運営が PAD に登録します)。</p></div>`);
// 2 参加可能時間
pages.push(`<div>${TAG(2)}<h1><span class="n">1</span>参加可能時間と凸数を入れる</h1><div class="sub">前日までに。毎期 1 回「この時間で参加します」を押します。</div></div>
<div class="card row"><div class="st"><div class="k">1</div><div><b>ホームの「⏰ ユニオンレイド参加可能時間」で「変更する ›」</b><span>まだのときは <span class="pill warn">今期 未確認</span> と出ています。</span></div></div>${img('02_参加可能時間カード.png',400)}</div>
<div class="card row"><div class="st"><div class="k">2</div><div><b>出られるブロックをタップして ON に</b><span>1 時間でも出られるブロックは ON。<br><span class="ok">✓ 出られる</span> になれば OK。</span></div></div>${crop('03_参加可能時間シート.png','400px',75,0.9)}</div>
<div class="card row"><div class="st"><div class="k">3</div><div><b>「何凸するか」を ＋ / − で</b><span>入れたブロックには、その数より多く割り当てられません。<br>入れなければ「おまかせ」(運営がそのブロックのどこかに)。合計 3 凸まで。</span></div></div>${crop('04_参加可能時間シート_夜2.png','400px',70.5,0.48)}</div>
<div class="card row"><div class="st"><div class="k">4</div><div><b>いちばん下の「この時間で参加します」</b><span>出られない回は「今回は難しい」。<br>ホームが <span class="pill ok">今期 確認済み</span> になれば完了です。</span></div></div>${crop('04b_参加可能時間シート_確定ボタン.png','400px',180.7,0.42)}</div>`);
// 3 配信
pages.push(`<div>${TAG(3)}<h1><span class="n">2</span>配信を見て「✅ 確認しました」</h1><div class="sub">当日、出られるブロックの前にホームを開きます。</div></div>
<div class="card row" style="align-items:start"><div class="st"><div class="k">1</div><div><b>📅 きょうの凸 を見る</b><span>何時に・どのボスへ・どの PT (編成) で行くかが出ています。<br><br>「まだ決まっていません」は、そのブロックがまだ配信前ということ。運営がブロックの前に配信します。<br><br>配信されるのは<b style="display:inline;font-size:20px;color:var(--ink)">次のブロックのぶんだけ</b>です。</span></div></div>${crop('08_きょうの凸_配信後.png','400px',96,0.78)}</div>
<div class="card row"><div class="st"><div class="k">2</div><div><b>「配信された凸プラン」の下の<br>「✅ 確認しました」を押す</b><span>押しておくと、レイド中にプランが組み直されたとき通知でお知らせが来ます。</span></div></div><div style="display:flex;flex-direction:column;gap:14px">${img('07c_確認しましたボタン.png',400)}<div style="text-align:center;font-size:26px;color:var(--muted)">↓</div>${img('07b_確認済み.png',400)}</div></div>`);
// 4 Discord
pages.push(`<div>${TAG(4)}<h1><span class="n">3</span>凸したら、スクショを Discord へ</h1><div class="sub">割り当ての時刻になったらゲームで凸。結果の画面のスクショを Discord に貼ります。<br><b style="color:var(--ink)">PAD には何も入れなくて OK</b> です。</div></div>
<div class="card"><div class="pair">
<div><div class="cap">凸する前</div>${crop('08_きょうの凸_配信後.png','100%',96,0.86)}</div>
<div class="arr">→</div>
<div><div class="cap">運営が取り込んだ後</div>${crop('12_きょうの凸_取り込み後.png','100%',99,0.86)}</div>
</div><p style="margin:22px 0 0;font-size:21px;line-height:1.7;color:var(--strong);text-align:center">運営がスクショを見て結果を取り込むと、📅 きょうの凸 に <b class="ok">✓</b> が付きます。</p></div>
<div class="point"><ul><li>ボスの残り HP は運営が見ています。</li><li>時刻に行けなくなったら、Discord で運営にひとこと。</li></ul></div>`);
// 5 まとめ
pages.push(`<div>${TAG(5)}<h1>まとめ</h1></div>
<div class="card sum"><ol>
<li>前日までに <span class="em">⏰ 参加可能時間と凸数</span> →「この時間で参加します」</li>
<li>当日、ブロックの前に <span class="em">📅 きょうの凸</span> を見て「✅ 確認しました」</li>
<li>凸したら <span class="em">スクショを Discord へ</span> (✓ が付けば OK)</li></ol></div>
<div style="font-size:24px;font-weight:900;margin-top:4px">知っておくと便利</div>
<div class="mini">
<div class="card"><h3>📘 登録された模擬</h3><p>運営が Discord の模擬のスクショから登録したもの。直したいときは Discord に模擬を出し直します。</p>${img('09_登録された模擬.png',400)}</div>
<div class="card"><h3>🔒 枠を予約する</h3><p>希望がある人だけ。「このブロックにこの PT で」を先に出せます。運営が承認すると、組み直しても動きません。</p>${crop('11_枠を予約するシート.png','400px',68,1.18,112,-6)}</div>
</div>
<div class="practice"><div><b>🎮 練習してみる</b><span>設定 ›「🎮 練習する (メンバー編)」で、本番と同じ画面を練習用のデータで触れます。約 3 分・本番には反映されません。</span></div>${img('13_設定_練習する.png',380)}</div>`);
pages.forEach((b, i) => fs.writeFileSync(`${process.argv[2] || '.'}/slide${i+1}.html`, `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="page">${b}</div></body></html>`));
