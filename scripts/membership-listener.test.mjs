import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(check) { const end=Date.now()+10000;while(Date.now()<end){if(check())return;await wait(30);}throw Error('mock listener timeout'); }

test('listener consumes membership separately, wakes the live lane and never logs raw V2 token',async t=>{
  const root=mkdtempSync(join(tmpdir(),'botcow-listener-'));
  for(const p of ['scripts','runtime','config'])mkdirSync(join(root,p));
  const scripts=dirname(fileURLToPath(import.meta.url));
  for(const p of ['lark-event-listener.mjs','bridge-eligibility.mjs','group-membership.mjs','task-control.mjs'])copyFileSync(join(scripts,p),join(root,'scripts',p));
  const at=Date.now();
  writeFileSync(join(root,'config/bridge.json'),JSON.stringify({profile:'fixture',event_key:'im.message.receive_v1',
    allowed_sender_ids:['ou_owner'],allowed_group_chat_ids:[],allowed_chat_types:['group'],allowed_message_types:['text'],
    bot_open_id:'ou_bot',chat_model:'fixture',event_wakeup:{enabled:true},
    auto_group_admission:{enabled:true,app_id:'cli_test',enabled_at:new Date(at-1000).toISOString()}}));
  // The node binary serves as a deterministic fake lark-cli: `node event consume KEY`.
  writeFileSync(join(root,'event'),`const fs=require('node:fs');const key=process.argv[3];
    process.stderr.write('[event] ready event_key='+key+'\\n');let sent=false;
    const timer=setInterval(()=>{const p='runtime/emit-'+key+'.json';if(!sent&&fs.existsSync(p)){sent=true;process.stdout.write(fs.readFileSync(p,'utf8')+'\\n');}},20);
    process.stdin.resume();process.stdin.on('end',()=>{clearInterval(timer);process.exit(0)});`);
  writeFileSync(join(root,'scripts/codex-event-wakeup.mjs'),`import {appendFileSync} from 'node:fs';
    appendFileSync('runtime/wakes.txt',process.argv.includes('--greetings')?'chat\\n':'task\\n');`);
  const proc=spawn(process.execPath,[join(root,'scripts/lark-event-listener.mjs')],{cwd:root,
    env:{...process.env,LARK_CLI_EXE:process.execPath},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{
    writeFileSync(join(root,'runtime/stop.requested'),'stop');
    try{await until(()=>proc.exitCode!==null);}finally{
      if(proc.exitCode===null)proc.kill();
      assert.equal(dirname(resolve(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});
    }
  });
  const added='im.chat.member.bot.added_v1',removed='im.chat.member.bot.deleted_v1';
  await until(()=>[added,removed].every(k=>existsSync(join(root,'runtime',k+'.status.json'))&&JSON.parse(readFileSync(join(root,'runtime',k+'.status.json'))).status==='ready'));
  await until(()=>existsSync(join(root,'runtime/wakes.txt'))&&readFileSync(join(root,'runtime/wakes.txt'),'utf8').includes('chat'));
  const event={schema:'2.0',header:{app_id:'cli_test',event_type:added,event_id:'e1',create_time:String(at),token:'NEVER_LOG_TOKEN'},event:{chat_id:'oc_new',operator_id:{open_id:'ou_owner'}}};
  writeFileSync(join(root,'runtime/emit-'+added+'.json'),JSON.stringify(event));
  await until(()=>existsSync(join(root,'runtime/group-admissions.json')));
  await until(()=>readFileSync(join(root,'runtime/wakes.txt'),'utf8').split('chat').length>=3);
  assert.equal(existsSync(join(root,'runtime/inbox.ndjson')),false);
  assert.equal(readFileSync(join(root,'runtime/listener.log'),'utf8').includes('NEVER_LOG_TOKEN'),false);
  event.header={...event.header,event_type:removed,event_id:'e2',create_time:String(at+1)};
  writeFileSync(join(root,'runtime/emit-'+removed+'.json'),JSON.stringify(event));
  await until(()=>JSON.parse(readFileSync(join(root,'runtime/group-admissions.json'))).groups.oc_new.status==='removed');
});
