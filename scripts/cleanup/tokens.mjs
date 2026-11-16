// 使われていない CSS のトークン (--x の定義があるのに var(--x) が index.html・js/ に無い) を、元の版と比べて出す
import fs from 'node:fs';
import path from 'node:path';
const [root, oldFile] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const js = walk(root + '/js').filter(f => f.endsWith('.js')).map(read).join('\n');
const unused = (t) => { const defs = new Set([...t.matchAll(/(?<![\w-])(--[a-z][\w-]*)\s*:/g)].map(m => m[1])); return [...defs].filter(d => !new RegExp('var\\(\\s*' + d + '(?![\\w-])').test(t + js) && !new RegExp("['\"`]" + d + "['\"`]").test(t + js)); };
const a = new Set(unused(read(oldFile))), b = unused(read(root + '/index.html'));
console.log('今回の撤去で使われなくなったトークン: ' + (b.filter(x => !a.has(x)).join(' ') || '(なし)'));
console.log('前から使われていないトークン: ' + b.filter(x => a.has(x)).length + ' 個');
