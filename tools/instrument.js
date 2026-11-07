'use strict';
/**
 * bundle 插桩工具（仅调试用）。
 *   node tools/instrument.js trace   # 给失败路径加日志
 *   node tools/instrument.js restore # 从 .bak 还原
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'player', 'build');
const FILE = path.join(DIR, 'player_v2.2d180c468559fbd29528.js');
const BAK = FILE + '.bak';

const mode = process.argv[2] || 'trace';

if (mode === 'restore') {
  if (!fs.existsSync(BAK)) {
    console.error('没有备份文件');
    process.exit(1);
  }
  fs.copyFileSync(BAK, FILE);
  console.log('已还原');
  process.exit(0);
}

let s = fs.readFileSync(FILE, 'utf8');
let n = 0;
function rep(from, to) {
  const c = s.split(from).length - 1;
  n += c;
  s = s.split(from).join(to);
  return c;
}

// mt(t)：积木运行时错误处理器，把收到的异常序列化打出来
const mtFrom = 'function mt(t){ct(),';
const mtTo =
  'function mt(t){console.error("[k4p:trace] MT",(function(x){try{return JSON.stringify(x,function(k,v){return typeof v==="function"?"[fn]":v}).slice(0,3000)}catch(e){return "stringify-fail:"+String(x)}})(t)),ct(),';
rep(mtFrom, mtTo);

// 领域函数调用出错时，打印块类型与块 id —— 定位到具体是哪个积木的哪个参数出问题
const dfFrom = 'extend_domain_function_call_error=function(t,e,n,i,r){var s={block_id:e,';
const dfTo =
  'extend_domain_function_call_error=function(t,e,n,i,r){console.error("[k4p:trace] DFERR",String(t&&(t.message||t)),"type="+this.domain_function_types[n],"block="+e,"root="+i,"entity="+r);console.error("[k4p:trace] DFPARAMS",(function(x){try{return JSON.stringify(x&&x.params)}catch(e){return "x"}})(this.current_frame&&this.current_frame.script));var s={block_id:e,';
rep(dfFrom, dfTo);

// mirror（克隆）域函数：打印解析前的 sprite 参数、当前实体、以及 o.actors 里有什么
const mirFrom = 'mirror:function(t,i,r){var a=O(t.sprite)?r:t.sprite,';
const mirTo =
  'mirror:function(t,i,r){try{console.error("[k4p:trace] MIRROR",JSON.stringify({sprite:t&&t.sprite,isSelf:O(t&&t.sprite),cur:r,hasActors:!!(o&&o.actors),nActors:o&&o.actors?Object.keys(o.actors).length:null,oKeys:Object.keys(o||{}).slice(0,24),tKeys:t?Object.keys(t).slice(0,24):null}))}catch(e){console.error("[k4p:trace] MIRROR-fail",String(e&&e.message))}var a=O(t.sprite)?r:t.sprite,';
rep(mirFrom, mirTo);

// 域函数调用抛错时，把「出错的那个积木」连参数一起打出来（这才是能定位问题的现场）
const callFrom =
  'catch(t){throw this.extend_domain_function_call_error(t,n,e,this.current_frame.source_map_rbid,this.current_frame.source_map_entity)}';
const callTo =
  'catch(t){try{console.error("[k4p:trace] CALL",String(i&&i.type),"blk="+String(i&&i.id),"keys="+String(i&&Object.keys(i)),"params="+String(JSON.stringify(i&&i.params,(function(){var seen=new WeakSet();return function(k,v){if(v&&typeof v==="object"){if(seen.has(v))return "[cyc]";seen.add(v)}return typeof v==="function"?"[fn]":v}})(),1)||"(undef)").slice(0,1800))}catch(ee){console.error("[k4p:trace] CALL-fail",String(ee&&ee.message))}throw this.extend_domain_function_call_error(t,n,e,this.current_frame.source_map_rbid,this.current_frame.source_map_entity)}';
rep(callFrom, callTo);

console.log('插桩替换处数:', n);
fs.writeFileSync(FILE, s);
