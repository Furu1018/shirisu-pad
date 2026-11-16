// 元の版にあって、いまの index.html・js/ のどこにも出てこない id・クラス・data 属性の名前を出す (prune.mjs の EXTRAS 用)
//   node gone-ids.mjs <root> <元の版の index.html>
import fs from 'node:fs';
import path from 'node:path';
const [root, oldFile] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const now = read(root + '/index.html') + walk(root + '/js').filter(f => f.endsWith('.js')).map(read).join('\n');
const old = read(oldFile);
const names = new Set();
for (const m of old.matchAll(/\bid="([A-Za-z][\w-]{3,})"/g)) names.add(m[1]);
for (const m of old.matchAll(/getElementById\('([A-Za-z][\w-]{3,})'\)/g)) names.add(m[1]);
for (const m of old.matchAll(/\bclass="([^"$]+)"/g)) for (const c of m[1].split(/\s+/)) if (/^[a-z][\w-]{4,}$/.test(c) && c.includes('-')) names.add(c);
for (const m of old.matchAll(/\b(data-[a-z][a-z0-9-]{3,})\b/g)) names.add(m[1]);
const has = (n) => new RegExp('(?<![\\w-])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(now);
console.log([...names].filter(n => !has(n)).join(' '));
