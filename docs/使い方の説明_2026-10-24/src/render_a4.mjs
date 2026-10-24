// A4 の HTML → PNG (2 倍) と PDF。Chrome のヘッドレス (CDP) が要る: CDP_PORT=9336 node src/render_a4.mjs <cdp.mjs の場所>
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { openPage } = await import(process.argv[2]);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
for (const name of ['メンバー向け_A4', '運営向け_A4']) {
    const html = path.join(ROOT, `${name}.html`);
    const p = await openPage({ width: 794, height: 1123, mobile: false });
    await p.goto('file://' + html, 2500);
    const m = await p.eval(`(()=>{const pg=document.querySelector('.page');return {h:pg.scrollHeight, over:[...pg.querySelectorAll('.col, .cols, .foot')].map(e=>[e.className, e.scrollHeight - e.clientHeight]).filter(x=>x[1]>1), imgs:[...document.images].filter(i=>!i.naturalWidth).length}})()`);
    console.log(name, JSON.stringify(m));
    await p.shot(path.join(ROOT, `${name}.png`));
    await p.close();
    const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${process.env.TMPDIR || '/tmp'}/a4pdf-profile`, '--no-pdf-header-footer', `--print-to-pdf=${path.join(ROOT, `${name}.pdf`)}`, 'file://' + html], { encoding: 'utf8' });
    console.log(name, 'pdf', r.status, (r.stderr || '').split('\n').filter(l => /written|error/i.test(l)).join(' | '));
}
