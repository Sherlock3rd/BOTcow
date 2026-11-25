import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {eligibleMessage,isOwnerSender} from './bridge-eligibility.mjs';

export function stopCommand(event,config) {
  if(!eligibleMessage(event,config)||!isOwnerSender(event,config)||event.message_type!=='text') return false;
  let text=String(event.content??'').trim();
  for(const m of event.mentions??[]) if(m.id===config.bot_open_id) {
    for(const prefix of [m.key,m.name&&`@${m.name}`].filter(Boolean)) if(text.startsWith(prefix)) text=text.slice(prefix.length).trim();
  }
  return /^(停止当前任务|取消当前任务)[。！!\s]*$/.test(text);
}
export function readActive(runtime) {
  try {return JSON.parse(readFileSync(join(runtime,'active-task.json'),'utf8'));} catch {return null;}
}
export function writeActive(runtime,state) {
  const path=join(runtime,'active-task.json'),tmp=path+`.${process.pid}.tmp`;
  writeFileSync(tmp,JSON.stringify(state));renameSync(tmp,path);
}
export function requestStop(runtime,event,config,alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}) {
  if(!stopCommand(event,config)) return {accepted:false,reason:'not_control'};
  const decisionPath=join(runtime,'task-control-'+createHash('sha256').update(event.message_id).digest('hex')+'.json');
  if(existsSync(decisionPath)) {
    const prior=JSON.parse(readFileSync(decisionPath,'utf8'));
    if(prior.accepted) {
      const path=join(runtime,'task-stop-'+prior.run_id+'.json');
      if(!existsSync(path))writeFileSync(path,JSON.stringify({...prior,requested_by:event.message_id}));
    }
    return prior;
  }
  const active=readActive(runtime);
  if(!active||active.state!=='running'||active.chat_id!==event.chat_id||active.sender_id!==event.sender_id||
    !Number.isInteger(active.worker_pid)||!alive(active.worker_pid)) {
    const result={accepted:false,reason:'no_active_task'};
    try {writeFileSync(decisionPath,JSON.stringify(result),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
    return JSON.parse(readFileSync(decisionPath,'utf8'));
  }
  // Bind to this generation; a late stop must never cancel the next task.
  const path=join(runtime,'task-stop-'+active.run_id+'.json');
  const result={accepted:true,run_id:active.run_id,message_id:active.message_id};
  try {writeFileSync(decisionPath,JSON.stringify(result),{flag:'wx'});}
  catch(error){if(error.code==='EEXIST')return JSON.parse(readFileSync(decisionPath,'utf8'));throw error;}
  if(!existsSync(path)) writeFileSync(path,JSON.stringify({run_id:active.run_id,message_id:active.message_id,requested_by:event.message_id}));
  return result;
}
export function readStop(runtime,runId) {
  try {const value=JSON.parse(readFileSync(join(runtime,'task-stop-'+runId+'.json'),'utf8'));return value.run_id===runId?value:null;}catch{return null;}
}
export function blockTask(runtime,event,reason) {
  appendFileSync(join(runtime,'blocked.ndjson'),JSON.stringify({message_id:event.message_id,status:'blocked',
    error_type:reason,error_fingerprint:reason,reason:'任务已停止自动执行',recovery_condition:'核对已有操作结果后重新发起请求',blocked_at:new Date().toISOString()})+'\n');
}
export function taskWasStopped(runtime,messageId) {
  const path=join(runtime,'blocked.ndjson');if(!existsSync(path))return false;
  const rows=readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const last=rows.findLast(r=>r.message_id===messageId);
  return last?.status==='blocked'&&['user_cancelled','task_timeout','worker_failed','supervisor_error'].includes(last.error_type);
}
export function notice(runtime,event,config,kind,text,im) {
  const dir=join(runtime,'task-notices');mkdirSync(dir,{recursive:true});
  const key=createHash('sha256').update(event.message_id+':'+kind).digest('hex');
  const path=join(dir,key+'.json');
  let receipt=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
  if(receipt?.verified) return receipt.reply_id;
  if(receipt?.uncertain) throw Error('notice_send_uncertain');
  if(!receipt?.reply_id) {
    writeFileSync(path,JSON.stringify({uncertain:true}));
    const sent=im('+messages-reply',['--message-id',event.message_id,'--text',text,'--idempotency-key','ctl-'+key.slice(0,40)]);
    if(!sent.message_id||sent.chat_id!==event.chat_id) throw Error('notice_receipt_mismatch');
    receipt={reply_id:sent.message_id,text};writeFileSync(path,JSON.stringify(receipt));
  }
  const reply=im('+messages-mget',['--message-ids',receipt.reply_id,'--no-reactions']).messages?.find(m=>m.message_id===receipt.reply_id);
  if(!reply||reply.deleted||reply.chat_id!==event.chat_id||reply.reply_to!==event.message_id||
    reply.sender?.open_bot_id!==config.bot_open_id||reply.content!==receipt.text) throw Error('notice_readback_mismatch');
  writeFileSync(path,JSON.stringify({...receipt,verified:true}));return receipt.reply_id;
}
