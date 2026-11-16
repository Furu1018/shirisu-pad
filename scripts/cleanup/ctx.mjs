// 目印の正規表現に当たる行の前後を、関数名つきで書き出す。 node ctx.mjs <root> <regex> [before] [after] [clip]
import fs from 'node:fs';
const [root, reSrc, b = '4', a = '6', clip = '460'] = process.argv.slice(2);
const lines = fs.readFileSync(root + '/index.html', 'utf8').replace(/\r\n/g, '\n').split('\n');
const re = new RegExp(reSrc);
const fnAt = (i) => { for (let k = i; k >= 0; k--) { const m = /^        (?:async )?function ([\w$]+)\(/.exec(lines[k]); if (m) return m[1] + ' @' + (k + 1); if (lines[k] === '        }' && k < i) return '(関数の外)'; } return '(頭)'; };
let last = -100; const out = [];
for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const s = Math.max(i - Number(b), last + 1), e = Math.min(lines.length - 1, i + Number(a));
    if (s > last + 1) out.push('\n===== ' + fnAt(i));
    for (let k = s; k <= e; k++) out.push(String(k + 1).padStart(6) + (re.test(lines[k]) ? ' >' : '  ') + [...lines[k]].slice(0, Number(clip)).join(''));
    last = e;
}
console.log(out.join('\n'));
