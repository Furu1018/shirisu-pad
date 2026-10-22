// Claude Design の .dc.html (x-dc + {{hole}} + sc-for/sc-if + renderVals) を、どのブラウザでも開ける素の HTML に展開する (2026-10-22 の 5 枚用)
//   node docs/ブロック制モック_src_2026-10-22/dc2html.mjs <project/ を持つ root> <出力 html> <1 画面 1 ファイルの出力 dir>
//   この dir のファイルを root/project/ に置いて使うなら: root = このフォルダの親に project/ を作って写す (下の「写し」参照)
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2], outHtml = process.argv[3], outDir = process.argv[4];
const canvas = JSON.parse(fs.readFileSync(path.join(root, 'project/canvas.json'), 'utf8'));
const lookup = (scope, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
function findClose(tpl, from, tag) {
  let depth = 1, i = from;
  const open = new RegExp(`<${tag}\\b`, 'g'), close = new RegExp(`</${tag}>`, 'g');
  while (depth > 0) {
    open.lastIndex = i; close.lastIndex = i;
    const o = open.exec(tpl), c = close.exec(tpl);
    if (!c) throw new Error('unclosed ' + tag);
    if (o && o.index < c.index) { depth++; i = o.index + 1; } else { depth--; i = c.index + (depth === 0 ? 0 : c[0].length); if (depth === 0) return c.index; }
  }
  return -1;
}
function expand(tpl, scope) {
  let out = '', i = 0;
  const re = /<(sc-for|sc-if)\b([^>]*)>/g;
  while (true) {
    re.lastIndex = i; const m = re.exec(tpl); if (!m) { out += holes(tpl.slice(i), scope); break; }
    out += holes(tpl.slice(i, m.index), scope);
    const tag = m[1], attrs = m[2], bodyStart = m.index + m[0].length;
    const bodyEnd = findClose(tpl, bodyStart, tag); const body = tpl.slice(bodyStart, bodyEnd);
    if (tag === 'sc-for') {
      const list = /list="\{\{\s*([\w.$]+)\s*\}\}"/.exec(attrs)[1], as = /as="(\w+)"/.exec(attrs)[1];
      const arr = lookup(scope, list) || [];
      arr.forEach((item, idx) => { out += expand(body, { ...scope, [as]: item, $index: idx }); });
    } else {
      const v = /value="\{\{\s*([\w.$]+)\s*\}\}"/.exec(attrs)[1];
      if (lookup(scope, v)) out += expand(body, scope);
    }
    i = bodyEnd + `</${tag}>`.length;
  }
  return out;
}
const holes = (s, scope) => s.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (m, p) => { const v = lookup(scope, p); return v == null ? '' : String(v); });
function renderBoard(file) {
  const src = fs.readFileSync(path.join(root, 'project', file), 'utf8');
  const style = (/<helmet>\s*<style>([\s\S]*?)<\/style>\s*<\/helmet>/.exec(src) || [, ''])[1];
  const body = (/<\/helmet>([\s\S]*?)<\/x-dc>/.exec(src) || [, ''])[1];
  const logic = (/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(src) || [, ''])[1];
  const title = (/<title>([^<]*)<\/title>/.exec(src) || [, file])[1];
  const vals = new Function('DCLogic', `${logic}\nreturn new Component().renderVals();`)(class { constructor() { this.props = {}; } });
  let html = expand(body, vals);
  html = html.replace(/href="([A-Za-z]+)\.dc\.html"/g, 'href="#$1"');
  // checked="true|false" は素の HTML では属性の有無で表す
  html = html.replace(/ checked="false"/g, '').replace(/ checked="true"/g, ' checked');
  return { title, style, html, w: canvas.boards[file].w, h: canvas.boards[file].h };
}
const notes = canvas.notes || {};
const S = Object.fromEntries(['Main', 'OpsResults', 'MemberHome', 'MemberTime', 'MemberReserve'].map(id => [id, { id, ...renderBoard(`${id}.dc.html`) }]));
fs.mkdirSync(outDir, { recursive: true });
for (const s of Object.values(S)) {
  const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${s.title}</title><style>${s.style}\nhtml,body{background:#f3f4f6}</style></head><body><div style="width:${s.w}px">${s.html}</div></body></html>`;
  fs.writeFileSync(path.join(outDir, `${s.id}.html`), page);
}
const css = S.Main.style;
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cap = (t) => t ? `<p class="cap">${esc(t)}</p>` : '';
const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>しりすこPAD ブロック制モック: メンバー / 運営 (2026-10-22)</title>
<style>${css}
.wrap{max-width:1500px;margin:0 auto;padding:24px 16px 60px}
h1.pg{font-size:26px;font-weight:900;color:#15171c;margin:0 0 6px}
.lead{font-size:14px;color:#3a3f46;margin:0 0 22px;line-height:1.7}
h2.sec{font-size:18px;font-weight:900;color:#15171c;margin:36px 0 8px;padding-top:8px;border-top:1px solid #e3e6eb}
.cap{font-size:13.5px;line-height:1.75;color:#3a3f46;background:#fff;border:1px solid #e3e6eb;border-left:6px solid #6b3df5;border-radius:12px;padding:12px 14px;margin:0 0 14px}
.cap.ask{border-left-color:#d97706}
.frame{overflow-x:auto;border:1px solid #d7dbe3;border-radius:16px;background:#fff}
.frame > div{margin:0 auto}
.phones{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
.phones .frame{border-radius:28px}
</style></head><body><div class="wrap">
<h1 class="pg">しりすこPAD ブロック制モック — メンバー / 運営</h1>
<p class="lead">2026-10-22 の案。メンバーは「いつ・どの PT で凸するか」だけを見る (ボスの状況・状態ボタン・凸報告は無し)。ボスの HP を持ち、結果を Discord から取り込んで次のブロックを組むのは運営。ボス名・人名・数字はすべて見本です。</p>
<h2 class="sec" id="Main">1. 運営: 当日の司令席 (ボス HP · 結果の取り込み · 次のブロック · メンバー状況)</h2>${cap(notes['n-ops']?.text)}
<div class="frame"><div style="width:${S.Main.w}px">${S.Main.html}</div></div>
<h2 class="sec" id="OpsResults">2. 運営: 結果の取り込み (Discord のリザルト → 凸の記録)</h2>
<div class="frame"><div style="width:${S.OpsResults.w}px">${S.OpsResults.html}</div></div>
<h2 class="sec" id="MemberHome">3. メンバー: ホーム / 出られる時間と凸数 / 予約 (スマホ)</h2>${cap(notes['n-member']?.text)}<p class="cap ask">${esc(notes['n-ask']?.text || '')}</p>
<div class="phones"><div class="frame"><div style="width:390px">${S.MemberHome.html}</div></div><div class="frame" id="MemberTime"><div style="width:390px">${S.MemberTime.html}</div></div><div class="frame" id="MemberReserve"><div style="width:390px">${S.MemberReserve.html}</div></div></div>
</div></body></html>`;
fs.writeFileSync(outHtml, page);
console.log('ok', Object.values(S).map(s => `${s.id} ${s.html.length}`).join(' / '));
