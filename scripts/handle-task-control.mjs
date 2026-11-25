import {readFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requestStop,notice} from './task-control.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),runtime=join(root,'runtime');
try {
  const config=JSON.parse(readFileSync(join(root,'config/bridge.json'),'utf8'));
  const event=readFileSync(join(runtime,'inbox.ndjson'),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).find(e=>e.message_id===process.argv[2]);
  const result=requestStop(runtime,event,config);
  if(result.reason==='not_control') process.exit(0);
  const cli=process.env.LARK_CLI_EXE??join(process.env.APPDATA,'npm/node_modules/@larksuite/cli/bin/lark-cli.exe');
  const im=(cmd,args)=>{const r=JSON.parse(execFileSync(cli,['im',cmd,...args,'--profile',config.profile,'--as','bot','--format','json'],{cwd:root,windowsHide:true,timeout:15000,encoding:'utf8'}));if(!r.ok)throw Error('im_failed');return r.data;};
  notice(runtime,event,config,'stop_requested',result.accepted?'已收到停止请求，正在停止当前任务。已完成的外部操作不会自动撤销。':'当前会话没有正在执行的任务。',im);
  appendFileSync(join(runtime,'task-controls.ndjson'),JSON.stringify({message_id:event.message_id,...result,at:new Date().toISOString()})+'\n');
} catch {console.error('task_control_failed');process.exitCode=1;}
