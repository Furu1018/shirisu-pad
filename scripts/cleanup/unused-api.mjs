// index.html から呼ばれなくなった window.supabaseXxx と、使われなくなったドメインのモジュールを数える (元の版と比べて、今回の撤去で使われなくなったものだけ)
//   node unused-api.mjs <root> <元の版の index.html>
import fs from 'node:fs';
import path from 'node:path';
const [root, oldFile] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const jsFiles = walk(root + '/js').filter(f => f.endsWith('.js'));
const client = read(root + '/js/supabase-client.js');
const others = jsFiles.filter(f => !f.endsWith('supabase-client.js')).map(read).join('\n');
const now = read(root + '/index.html'), old = read(oldFile);
const api = [...new Set([...client.matchAll(/window\.(supabase[A-Za-z0-9_]+)\s*=/g)].map(m => m[1]))];
const cnt = (t, n) => (t.match(new RegExp('(?<![\\w$])' + n + '(?![\\w$])', 'g')) || []).length;
const tests = walk(root + '/tests').filter(f => f.endsWith('.mjs')).map(f => [path.basename(f), read(f)]);
console.log(`window.supabaseXxx ${api.length} 個`);
for (const n of api) {
    const inNow = cnt(now, n) + cnt(others, n), inOld = cnt(old, n) + cnt(others, n), inClient = cnt(client, n);
    if (inNow === 0) console.log(`  ${inOld ? '★ 今回' : '  前から'} 呼ばれていない: ${n}  (client の中 ${inClient} 回${tests.filter(([, s]) => cnt(s, n)).length ? '・テスト: ' + tests.filter(([, s]) => cnt(s, n)).map(([f]) => f).join(',') : ''})`);
}
console.log('\nドメインのモジュール (script で読むもの) の、index.html での使われ方');
for (const m of now.matchAll(/<script[^>]*src="\.\/(js\/[^"?]+)[^"]*"/g)) {
    const f = m[1]; if (!fs.existsSync(root + '/' + f)) continue;
    const src = read(root + '/' + f);
    const globals = [...new Set([...src.matchAll(/(?:window|globalThis|root|global)\.([A-Za-z_$][\w$]*)\s*=/g)].map(x => x[1]))];
    const used = globals.filter(g => cnt(now, g) > 0 || jsFiles.filter(j => !j.replace(/\\/g, '/').endsWith(f)).some(j => cnt(read(j), g) > 0));
    const usedOld = globals.filter(g => cnt(old, g) > 0);
    if (globals.length && used.length === 0) console.log(`  ${usedOld.length ? '★ 今回' : '  前から'} どの公開名も使われていない: ${f} (${globals.join(', ').slice(0, 120)})`);
}
