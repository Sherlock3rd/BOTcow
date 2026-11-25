import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {notice,readActive} from './task-control.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),runtime=join(root,'runtime');
try {
  const config=JSON.parse(readFileSync(join(root,'config/bridge.json'),'utf8'));
  const [id,kind]=process.argv.slice(2);
  const event=readFileSync(join(runtime,'inbox.ndjson'),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).find(e=>e.message_id===id);
  const texts={slow:'这项任务仍未完成。需要停止时，请在当前会话发送“停止当前任务”（群内请 @ 我）。',
    user_cancelled:'当前任务已停止，不会自动重试。已完成的外部操作不会自动撤销。',
    task_timeout:'任务处理超时，已停止自动执行并释放队列。历史记录已保留；如需继续，请重新发起请求，先核对已有操作结果。',
    worker_failed:'任务执行失败，已停止自动重试并释放队列。如需继续，请重新发起请求，先核对已有操作结果。',
    supervisor_error:'任务监控异常，已停止自动执行。请核对已有操作结果后再继续。'};
  if(!texts[kind])throw Error('invalid_notice');
  if(kind==='slow') {const a=readActive(runtime);if(a?.message_id!==id||a.state!=='running')process.exit(0);}
  const cli=process.env.LARK_CLI_EXE??join(process.env.APPDATA,'npm/node_modules/@larksuite/cli/bin/lark-cli.exe');
  const im=(cmd,args)=>{const r=JSON.parse(execFileSync(cli,['im',cmd,...args,'--profile',config.profile,'--as','bot','--format','json'],{cwd:root,windowsHide:true,timeout:15000,encoding:'utf8'}));if(!r.ok)throw Error('im_failed');return r.data;};
  console.log(JSON.stringify({ok:true,reply_id:notice(runtime,event,config,kind,texts[kind],im)}));
} catch {console.error('task_notice_failed');process.exitCode=1;}
