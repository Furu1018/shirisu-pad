// 撤去の編集の道具 (CRLF を保つ)。must = 1 か所だけの置き換え / cut = 行の範囲を消す (頭と尻の行を文字で確かめる) / cutLine = 1 行消す
import fs from 'node:fs';
export const load = (root, file) => { const p = root + '/' + file; const raw = fs.readFileSync(p, 'utf8'); return { p, crlf: raw.includes('\r\n'), s: raw.replace(/\r\n/g, '\n') }; };
export const save = (f) => fs.writeFileSync(f.p, f.crlf ? f.s.replace(/\n/g, '\r\n') : f.s);
export const must = (f, a, b) => {
    const i = f.s.indexOf(a);
    if (i < 0) throw new Error('当たらない: ' + a.slice(0, 90));
    if (f.s.indexOf(a, i + 1) >= 0) throw new Error('2 か所以上: ' + a.slice(0, 90));
    f.s = f.s.slice(0, i) + b + f.s.slice(i + a.length);
};
// 行の頭 (字下げを除いた先頭の文字) で 1 行を決め、そこから尻の行 (同じく先頭の文字・頭より後ろで最初に当たる行) までを消す。repl があれば差し替える
export const cut = (f, head, tail, repl = null) => {
    const lines = f.s.split('\n');
    const hs = lines.map((l, i) => l.trimStart().startsWith(head) ? i : -1).filter(i => i >= 0);
    if (hs.length !== 1) throw new Error(`頭が ${hs.length} か所: ` + head.slice(0, 90));
    let t = -1;
    for (let i = hs[0]; i < lines.length; i++) if (lines[i].trimStart().startsWith(tail) && (i > hs[0] || head === tail)) { t = i; break; }
    if (t < 0) throw new Error('尻が無い: ' + tail.slice(0, 90));
    lines.splice(hs[0], t - hs[0] + 1, ...(repl == null ? [] : repl.split('\n')));
    f.s = lines.join('\n');
    return t - hs[0] + 1;
};
export const cutLine = (f, head) => cut(f, head, head);
// HTML の要素 1 つ (開始タグの行 = head から、同じ字下げの閉じタグの行まで) を消す
export const cutEl = (f, head, closeTag = '</div>') => {
    const lines = f.s.split('\n');
    const hs = lines.map((l, i) => l.trimStart().startsWith(head) ? i : -1).filter(i => i >= 0);
    if (hs.length !== 1) throw new Error(`要素の頭が ${hs.length} か所: ` + head.slice(0, 90));
    const ind = lines[hs[0]].match(/^\s*/)[0];
    let t = -1;
    for (let i = hs[0] + 1; i < lines.length; i++) if (lines[i] === ind + closeTag) { t = i; break; }
    if (t < 0) throw new Error('閉じタグが無い: ' + head.slice(0, 90));
    lines.splice(hs[0], t - hs[0] + 1);
    f.s = lines.join('\n');
    return t - hs[0] + 1;
};
// 1 文を消す: 頭 (字下げを除いた先頭の文字) で 1 行を決め、それより字下げの深い続きの行もいっしょに消す
export const cutStmt = (f, head) => {
    const lines = f.s.split('\n');
    const hs = lines.map((l, i) => l.trimStart().startsWith(head) ? i : -1).filter(i => i >= 0);
    if (hs.length !== 1) throw new Error(`文の頭が ${hs.length} か所: ` + head.slice(0, 90));
    const L = hs[0]; const ind = lines[L].match(/^\s*/)[0].length; let M = L;
    while (M + 1 < lines.length && lines[M + 1].trim() !== '' && (lines[M + 1].match(/^\s*/)[0].length > ind)) M++;
    lines.splice(L, M - L + 1);
    f.s = lines.join('\n');
};
