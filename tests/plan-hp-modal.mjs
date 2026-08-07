// ============================================================================
// 🎯どれくらい削れる? モーダル (openPlanHpModal) の実行テスト
//   node tests/plan-hp-modal.mjs
// ----------------------------------------------------------------------------
// index.html から関数本体を切り出し、依存をスタブして**実際に実行**する。
// UIテストが無いこのリポジトリで、この関数だけは実行経路のバグが出やすいため:
//   - 2026-08-08: const の TDZ で「想定ダメージ>0 のカードをタップすると
//     ReferenceError」という致命バグが入り、単体テスト129件では検出できなかった
//   - 残HP未記録・total=0 の不整合・Lv4 の分岐は実データで踏みやすい
// index.html 側の関数シグネチャや依存を変えたら、ここのスタブも直すこと。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const i = html.indexOf('        async function openPlanHpModal(');
const j = html.indexOf('        // ヒーローの主CTA:');
if (i < 0 || j < 0 || j <= i) {
    console.error('NG: openPlanHpModal を index.html から切り出せませんでした (目印が変わった?)');
    process.exit(2);
}
const src = html.slice(i, j);
// 依存スタブ
let bodyHtml='';
const el={ classList:{add(){},remove(){}}, set innerHTML(v){bodyHtml=v}, get innerHTML(){return bodyHtml} };
globalThis.document={ getElementById:(id)=> id==='planHpModal'||id==='planHpBody' ? el : null };
globalThis._planHpSeq=0;
globalThis.escapeHtml=(x)=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
globalThis.ATTR_VISUAL={fire:{color:'#FF3D44',dark:'#D02830',name:'灼熱',icon:'a.png'},water:{color:'#2E8BFF',dark:'#1E78F0',name:'水冷',icon:'b.png'},electric:{color:'#9B4DFF',dark:'#7C3AED',name:'電撃',icon:'c.png'},iron:{color:'#FF8A2B',dark:'#E0701F',name:'鉄甲',icon:'d.png'},wind:{color:'#18C26B',dark:'#0EA055',name:'風圧',icon:'e.png'}};
globalThis.weaknessPtOf=(b)=>b.weakness;
globalThis.opsStore={patchBosses(){}}; globalThis.seasonStore={patchBosses(){}};
globalThis.isLv4LiveBoard=(se,bs)=>Number(se?.current_level)>=3 && (bs||[]).every(x=>{const t=Number(x.total_hp_raw)||0,r=Number(x.remaining_hp_raw)||0;return t>0?(r/t)*100<=0.01:r<=0;});
globalThis.getNikkeCharsCache=async()=>[];
globalThis._renderMatchupCharAvatar=(n,s)=>`<img alt="${n}">`;
globalThis._myPlanRows=()=>MOCK_ROWS;
let MOCK_ROWS=[];
let BOSSES=[];
globalThis.window={ supabaseLoadActiveSeasonWithBosses: async()=>({season:SEASON,bosses:BOSSES}) };
let SEASON={id:26,current_level:2};
globalThis._myPubState={plan:{},viewerId:'me',doneCounts:new Map(),seasonId:26};
const openPlanHpModal=eval(`(${src.trim().replace(/^async function openPlanHpModal/, 'async function openPlanHpModal')})`);

const B=(n,attr,weak,tot,rem)=>({boss_number:n,attribute:attr,weakness:weak,name:`B${n}`,boss_code:`T${n}`,total_hp_raw:tot*1e9,remaining_hp_raw:rem*1e9});
const cases=[
 ['通常 (残34.2/150.8, 18.4B)', [B(1,'fire','water',150.8,34.2)], {cl:2}, 1,2,18.4,0],
 ['撃破見込み (残10, 18.4B)', [B(1,'fire','water',150.8,10)], {cl:2}, 1,2,18.4,0],
 ['残HP未記録 (total=0,rem=0)', [B(1,'fire','water',0,0)], {cl:2}, 1,2,18.4,0],
 ['total=0 だが rem>0 の不整合', [B(1,'fire','water',0,5)], {cl:2}, 1,2,18.4,0],
 ['Lv4 (B1-4撃破・B5無限)', [B(1,'fire','water',100,0),B(2,'water','electric',100,0),B(3,'electric','iron',100,0),B(4,'iron','wind',100,0),B(5,'wind','fire',0,0)], {cl:3}, 5,4,25.0,0],
 ['B5だけHP未記録・他は未撃破', [B(1,'fire','water',100,50),B(2,'water','electric',100,50),B(3,'electric','iron',100,50),B(4,'iron','wind',100,50),B(5,'wind','fire',0,0)], {cl:3}, 5,3,25.0,0],
 ['想定ダメージ0', [B(1,'fire','water',150.8,34.2)], {cl:2}, 1,2,0,0],
];
let ok=0;
for (const [name,bs,se,bn,lv,dmg,idx] of cases){
  BOSSES=bs; SEASON={id:26,current_level:se.cl};
  MOCK_ROWS=[{bossNumber:bn,dmgB:dmg,level:lv,team:['A','B','C','D','E'],loadoutSlot:1,hourLabel:'07時',flex:false}];
  bodyHtml='';
  try{
    await openPlanHpModal(bn,lv,dmg,idx);
    const hasErr=/ReferenceError|undefined/.test(bodyHtml);
    const verdict=(bodyHtml.match(/(💥[^<]*|残HPの \d+% を削る見込み|♾️[^<]*|残HPが記録されていないため試算できません)/)||['?'])[0].slice(0,34);
    const pct=(bodyHtml.match(/(全額が加算|\d+% 削減)/)||['—'])[0];
    console.log(`✅ ${name.padEnd(28)} → ${verdict} / バー:${pct}`);
    ok++;
  }catch(e){ console.log(`❌ ${name.padEnd(28)} → ${e.constructor.name}: ${e.message}`); }
}
console.log(`\n${ok}/${cases.length} 例外なし`);
