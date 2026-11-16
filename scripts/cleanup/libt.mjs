// テストファイルの編集の道具: テスト 1 つを名前で探して、消す / 差し替える / 元の版から戻す
//   名前は test('…' の中の文字列の「頭」で指す (1 つに決まらなければ止まる)
const findTest = (s, nameHead) => {
    const ls = s.split('\n');
    const hits = [];
    ls.forEach((l, i) => { const m = /^(\s*)(?:await )?test(?:Async)?\(\s*(['"`])/.exec(l); if (m && l.slice(m[0].length).startsWith(nameHead)) hits.push([i, m[1]]); });
    if (hits.length !== 1) throw new Error(`テストが ${hits.length} 個: ` + nameHead.slice(0, 70));
    const [a, ind] = hits[0];
    let b = a + 1; while (b < ls.length && !ls[b].startsWith(ind + '})')) b++;
    if (b >= ls.length) throw new Error('テストの終わりが無い: ' + nameHead.slice(0, 70));
    return { ls, a, b };
};
export const dropTest = (f, nameHead) => {
    const { ls, a, b } = findTest(f.s, nameHead);
    // 直前に貼り付いた注釈の行も (同じ字下げの // の行・空行で切れるまで)
    let a2 = a; const ind = ls[a].match(/^\s*/)[0];
    while (a2 > 0 && ls[a2 - 1].startsWith(ind + '//')) a2--;
    ls.splice(a2, b - a2 + 1);
    f.s = ls.join('\n');
    return b - a2 + 1;
};
export const replaceTest = (f, nameHead, text) => {
    const { ls, a, b } = findTest(f.s, nameHead);
    ls.splice(a, b - a + 1, ...text.replace(/\n$/, '').split('\n'));
    f.s = ls.join('\n');
};
export const getTest = (s, nameHead) => { const { ls, a, b } = findTest(s, nameHead); return ls.slice(a, b + 1).join('\n'); };
// 元の版のテストの本文に戻す (機械の仕分けで外しすぎたとき)
export const restoreTest = (f, oldS, nameHead) => replaceTest(f, nameHead, getTest(oldS, nameHead));
