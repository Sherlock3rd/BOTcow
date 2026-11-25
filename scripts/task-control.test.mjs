import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stopCommand,requestStop,readStop,writeActive,notice} from './task-control.mjs';
import {runSupervised} from './worker-output.mjs';
const config={allowed_sender_ids:['owner'],allowed_chat_types:['p2p','group'],allowed_message_types:['text'],allowed_group_chat_ids:['group'],bot_open_id:'bot'};
const event={message_id:'stop',sender_type:'user',sender_id:'owner',chat_type:'p2p',chat_id:'dm',message_type:'text',content:'停止当前任务'};
test('stop is exact, owner-only, same chat, live run, and generation bound',()=>{
  const dir=mkdtempSync(join(tmpdir(),'botcow-control-'));
  writeActive(dir,{run_id:'run1',message_id:'target',chat_id:'dm',sender_id:'owner',worker_pid:123,state:'running'});
  assert.equal(stopCommand({...event,content:'帮我解释停止当前任务'},config),false);
  assert.equal(stopCommand({...event,sender_id:'guest'},config),false);
  assert.equal(requestStop(dir,{...event,message_id:'cross',chat_id:'elsewhere'},config,()=>true).accepted,false);
  assert.equal(requestStop(dir,{...event,message_id:'dead'},config,()=>false).accepted,false);
  assert.equal(requestStop(dir,event,config,()=>true).accepted,true);
  assert.equal(readStop(dir,'run1').message_id,'target');
  assert.equal(readStop(dir,'run2'),null);
  writeActive(dir,{run_id:'run2',message_id:'next',chat_id:'dm',sender_id:'owner',worker_pid:123,state:'running'});
  assert.equal(requestStop(dir,event,config,()=>true).run_id,'run1');
  assert.equal(readStop(dir,'run2'),null);
  assert.equal(stopCommand({...event,chat_type:'group',chat_id:'group',content:'@Bot 停止当前任务',mentions:[{id:'bot',name:'Bot'}]},config),true);
  assert.equal(stopCommand({...event,chat_type:'group',chat_id:'group'},config),false);
});
test('silent child gets one warning, times out, and next child can run',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'botcow-supervisor-'));let warnings=0,stopping;
  const result=await runSupervised(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true},join(dir,'out'),join(dir,'err'),{
    warningMs:60,timeoutMs:150,pollMs:10,cancelled:()=>false,onWarning:()=>warnings++,onStopping:r=>{stopping=r;}
  });
  assert.equal(warnings,1);assert.equal(result.stopReason,'task_timeout');assert.equal(stopping,'task_timeout');
  const next=await runSupervised(process.execPath,['-e','console.log("ok")'],{windowsHide:true},join(dir,'next'),join(dir,'nextErr'),{
    warningMs:5000,timeoutMs:10000,cancelled:()=>false,onWarning:()=>{}
  });
  assert.equal(next.status,0);assert.match(readFileSync(join(dir,'next'),'utf8'),/ok/);
});
test('cancel does not depend on model output and no warning is needed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'botcow-cancel-'));let warnings=0;
  const result=await runSupervised(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true},join(dir,'out'),join(dir,'err'),{
    warningMs:5000,timeoutMs:10000,pollMs:10,cancelled:()=>true,onWarning:()=>warnings++
  });
  assert.equal(result.stopReason,'user_cancelled');assert.equal(warnings,0);
});
test('notice readback retries never resend, and wrong chat is rejected',()=>{
  const dir=mkdtempSync(join(tmpdir(),'botcow-notice-'));let sends=0,valid=false;
  const im=cmd=>cmd==='+messages-reply'?(sends++,{message_id:'reply',chat_id:'dm'}):{messages:[{
    message_id:'reply',chat_id:valid?'dm':'wrong',reply_to:'stop',content:'stopped',sender:{open_bot_id:'bot'}
  }]};
  assert.throws(()=>notice(dir,event,config,'end','stopped',im),/readback/);
  valid=true;notice(dir,event,config,'end','stopped',im);notice(dir,event,config,'end','stopped',im);
  assert.equal(sends,1);
});
