// Claude Design の .dc.html (x-dc + {{hole}} + sc-for/sc-if + renderVals) を、どのブラウザでも開ける素の HTML に展開する
//   canvas.json の order の順に全部の画面を並べる (画面の名前は boards[].title、メモは notes の付箋)
//   node dc2html.mjs <project/ を持つ root> <出力 html>
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2], outHtml = process.argv[3];
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
      (lookup(scope, list) || []).forEach((item, idx) => { out += expand(body, { ...scope, [as]: item, $index: idx }); });
    } else {
      const v = /value="\{\{\s*([\w.$]+)\s*\}\}"/.exec(attrs)[1];
      if (lookup(scope, v)) out += expand(body, scope);
    }
    i = bodyEnd + `</${tag}>`.length;
  }
  return out;
}
const holes = (s, scope) => s.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (m, p) => { const v = lookup(scope, p); return v == null ? '' : String(v); });
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function renderBoard(file) {
  const src = fs.readFileSync(path.join(root, 'project', file), 'utf8');
  const style = (/<helmet>\s*<style>([\s\S]*?)<\/style>\s*<\/helmet>/.exec(src) || [, ''])[1];
  const body = (/<\/helmet>([\s\S]*?)<\/x-dc>/.exec(src) || [, ''])[1];
  const logic = (/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(src) || [, ''])[1];
  const vals = new Function('DCLogic', `${logic}\nreturn new Component().renderVals();`)(class { constructor() { this.props = {}; } });
  let html = expand(body, vals)
    .replace(/href="([A-Za-z]+)\.dc\.html"/g, 'href="#$1"')
    .replace(/ checked="false"/g, '').replace(/ checked="true"/g, ' checked');
  const b = canvas.boards[file];
  return { id: file.replace(/\.dc\.html$/, ''), title: b.title || file, style, html, w: b.w, fill: b.expand === 'fill' };
}
const boards = canvas.order.map(renderBoard);
const notes = Object.values(canvas.notes || {}).filter(n => !n.kind);
const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(canvas.title)}</title>
<style>${boards[0].style}
.wrap{max-width:1500px;margin:0 auto;padding:24px 16px 60px}
h1.pg{font-size:26px;font-weight:900;color:#15171c;margin:0 0 6px}
.lead{font-size:14px;color:#3a3f46;margin:0 0 18px;line-height:1.7}
.cap{font-size:13.5px;line-height:1.75;color:#3a3f46;background:#fff;border:1px solid #e3e6eb;border-left:6px solid #6b3df5;border-radius:12px;padding:12px 14px;margin:0 0 12px}
h2.sec{font-size:18px;font-weight:900;color:#15171c;margin:34px 0 8px;padding-top:8px;border-top:1px solid #e3e6eb}
.frame{overflow-x:auto;border:1px solid #d7dbe3;border-radius:16px;background:#fff}
.frame > div{margin:0 auto}
.phones{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
.phones .frame{border-radius:28px}
</style></head><body><div class="wrap">
<h1 class="pg">${esc(canvas.title)}</h1>
<p class="lead">人名・ボス名・数字はすべて見本です。</p>
${notes.map(n => `<p class="cap">${esc(n.text)}</p>`).join('\n')}
${boards.filter(b => b.fill).map(b => `<h2 class="sec" id="${b.id}">${esc(b.title)}</h2>\n<div class="frame"><div style="width:${b.w}px">${b.html}</div></div>`).join('\n')}
<h2 class="sec">スマホ</h2>
<div class="phones">${boards.filter(b => !b.fill).map(b => `<div><div style="font-size:13px;font-weight:900;color:#15171c;margin:0 0 6px" id="${b.id}">${esc(b.title)}</div><div class="frame"><div style="width:${b.w}px">${b.html}</div></div></div>`).join('')}</div>
</div></body></html>`;
fs.writeFileSync(outHtml, page);
console.log('ok', boards.map(b => `${b.id} ${b.html.length}`).join(' / '));
