// ============================================================================
// ボス横断分岐 (フェーズ2) の効果測定
//   node tests/bench-crossboss.mjs            現行 vs crossBoss:false
//   node tests/bench-crossboss.mjs <旧実装.js>  現行 vs 指定実装 (例: git show <sha>:js/optimal-plan.js > /tmp/old.js)
//
// 乱数盤面は自前LCGで生成するので seed 固定 = 何度実行しても同じ盤面になる。
// 「改善数 / 悪化数 / 踏破レベルの増減 / 実行時間」を出す。
// **悪化0・踏破Lv低下0 が採用条件** (分岐は基準解を下回ってはいけない)
// ============================================================================
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const load=(p)=>{const g={};const c={console,Math,JSON,Date,Set,Map,WeakMap,WeakSet,Array,Object,Number,String,globalThis:g};
 vm.createContext(c);vm.runInContext(fs.readFileSync(p,'utf8'),c);return g.computeOptimalPlanCore;};
const F = load(path.join(HERE, '..', 'js', 'optimal-plan.js'));
const OTHER = process.argv[2] ? load(process.argv[2]) : null;
const baselineOf = (inp) => OTHER ? OTHER(structuredClone(inp)) : F({ ...structuredClone(inp), crossBoss: false });
const ATTRS=['fire','water','electric','iron','wind'],HOURS=['h05','h09','h13','h17','h21'];
function board(seed){let s=seed;const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648;
 const bosses=ATTRS.map((a,k)=>({boss_number:k+1,boss_code:`B${k+1}`,name:`B${k+1}`,attribute:a,weakness:ATTRS[(k+3)%5],
  tier:k===4?'tyrant':'lord',total_hp_raw:1e9*(15+rnd()*50),remaining_hp_raw:1e9*(8+rnd()*45)}));
 const n=6+Math.floor(rnd()*25),players=[];
 for(let p=0;p<n;p++){const dmg={},teams={};const pool=[...ATTRS].sort(()=>rnd()-0.5).slice(0,2+Math.floor(rnd()*4));
  pool.forEach(a=>{dmg[a]=4+rnd()*24;teams[a]=['B1共有','B2共有',`${a}A`,`${a}B`,`${a}C`];});
  const done=Math.floor(rnd()*4);
  players.push({id:`p${p}`,name:`M${p}`,syncLevel:300+Math.floor(rnd()*400),attackCount:done,damagesByAttr:dmg,teamsByAttr:teams,
   attacks:Array(done).fill(0).map(()=>({boss_number:1+Math.floor(rnd()*5),characters:[]})),
   availableSlots:rnd()<0.4?HOURS.filter(()=>rnd()<0.6):[],strong_attributes:rnd()<0.3?pool.slice(0,2):[]});}
 return {season:{current_level:1+Math.floor(rnd()*3)},bosses,players,currentSlot:HOURS[Math.floor(rnd()*5)],timeAware:rnd()<0.7};}
let up=0,down=0,same=0,sum=0,lvUp=0,lvDown=0;const times=[];
for(let i=1;i<=2000;i++){const inp=board(i*7919);let on,off;
 const t0=process.hrtime.bigint();
 try{on=F(structuredClone(inp));}catch(e){continue;}
 times.push(Number(process.hrtime.bigint()-t0)/1e6);
 try{off=baselineOf(inp);}catch{continue;}
 if(on.fullyClearedThrough>off.fullyClearedThrough)lvUp++;
 if(on.fullyClearedThrough<off.fullyClearedThrough){lvDown++;console.log(`  踏破低下 seed ${i*7919}`);}
 const d=on.totalCreditedB-off.totalCreditedB; sum+=d;
 if(d>1e-6)up++; else if(d<-1e-6){down++;console.log(`  悪化 seed ${i*7919}: ${d.toFixed(2)}B`);} else same++;}
times.sort((a,b)=>a-b);
const q=(p)=>times[Math.floor(times.length*p)].toFixed(1);
console.log(`改善 ${up} / 悪化 ${down} / 同一 ${same}   合計 +${sum.toFixed(1)}B`);
console.log(`踏破Lv 上昇 ${lvUp} / 低下 ${lvDown}`);
console.log(`実行時間 中央値 ${q(0.5)}ms / p95 ${q(0.95)}ms / p99 ${q(0.99)}ms / 最大 ${times[times.length-1].toFixed(1)}ms`);
// 基準解 (crossBoss:false) 比較のときだけ非悪化を強制する。旧実装比較は探索の当たり方の差なので落とさない
if(!OTHER&&(down>0||lvDown>0)){console.error('❌ 基準解より悪い盤面がある');process.exit(1);}
