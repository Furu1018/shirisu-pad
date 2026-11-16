// run-tests.mjs の写し (tests/_rt-debug.mjs) を作る: 落ちたテストの「どの行の assert か」を出す (行番号は本物と同じ)。 node mk-rtdebug.mjs <root>
import fs from 'node:fs';
const root = process.argv[2];
let s = fs.readFileSync(root + '/tests/run-tests.mjs', 'utf8');
const a = "console.error(`     ${e.message}`);";
const n = s.split(a).length - 1;
if (n < 1) throw new Error('目印が無い');
s = s.split(a).join("console.error(`     ${String(e.message).split('\\n')[0]}`); console.error('     @L' + ((String(e.stack).match(/_rt-debug\\.mjs:(\\d+)/g) || []).map(x => x.split(':')[1]).join(',')));");
fs.writeFileSync(root + '/tests/_rt-debug.mjs', s);
console.log('ok ' + n);
