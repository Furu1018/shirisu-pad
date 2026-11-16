// 呼んでいるのに定義が無い window.supabaseXxx を出す (通信の関数を消したあとの検算)。
//   node scripts/cleanup/undefined-api.mjs <root>
// index.html・js/ 以下 (supabase-client.js 自身の中の呼び出しも) を見る。1 つでもあれば終了コード 1。
// ★ 2026-11-16: 状態の読み取り (supabaseGetActiveFinishCoordinations) を消したとき、撃破の通知の宛先を決める関数の中に呼び出しが残っていた
//   (実行すると TypeError → その撃破は誰にも通知されない)。index.html 側の参照だけを見る dangling.mjs では出ない。
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const read = (f) => fs.readFileSync(f, 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const client = read(root + '/js/supabase-client.js');
const defined = new Set([...client.matchAll(/^window\.(supabase[A-Za-z0-9_]+)\s*=/gm)].map(m => m[1]));
const files = [root + '/index.html', ...walk(root + '/js').filter(f => f.endsWith('.js'))];
let bad = 0;
for (const f of files) {
    read(f).replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
        if (/^\s*(\/\/|\*|<!--)/.test(l)) return;
        for (const m of l.replace(/\s{2,}\/\/.*$/, '').matchAll(/(?:window|W)\.(supabase[A-Za-z0-9_]+)/g)) {
            if (defined.has(m[1])) continue;
            // 「あれば呼ぶ」(typeof で守っている・?.() で呼ぶ) は数えない
            if (new RegExp('typeof window\\.' + m[1] + ' [!=]==? \'function\'').test(l) || new RegExp('window\\.' + m[1] + '\\?\\.\\(').test(l)) continue;
            bad++; console.log(`${path.relative(root, f)}:${i + 1}: 定義が無い ${m[1]}`);
        }
    });
}
console.log(bad ? `定義の無い呼び出し ${bad} か所` : `定義の無い window.supabaseXxx の呼び出しは無い (定義 ${defined.size} 個)`);
process.exit(bad ? 1 : 0);
