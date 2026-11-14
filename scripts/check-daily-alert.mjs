// Read-only end-to-end probe, including card generation. Never sends a message.
import {spawnSync} from "node:child_process";
import {writeFileSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
if (process.argv.includes("--diagnose-identity")) {
  const config=JSON.parse(readFileSync(join(root,"config/assistant-workflows.json"),"utf8")).dobe_bugs;
  const r=spawnSync(config.cli_executable,["user","me","--envelope"],{cwd:root,encoding:"utf8",windowsHide:true,timeout:25000,env:{...process.env,MEEGLE_HOST:"project.feishu.cn"}});
  let payload;try {payload=JSON.parse(r.stdout||r.stderr);}catch{}
  const scrub=text=>String(text||"").replace(/https?:\/\/[^\s"<>]+/g,"[URL]").replace(/Bearer\s+[^\s"<]+/gi,"Bearer [hidden]").replace(/((?:access_token|refresh_token|device_code|client_secret|authorization|session_token)["\s:=]+)[^\s,"}]+/gi,"$1[hidden]").replace(/eyJ[A-Za-z0-9_.-]+/g,"[JWT]");
  const detail={at:new Date().toISOString(),exit:r.status,error_code:typeof payload?.error?.code==="number"?payload.error.code:null,
    error_type:scrub(payload?.error?.type),message:scrub(payload?.error?.message),
    profile_root:process.env.USERPROFILE,appdata:process.env.APPDATA,home:process.env.HOME,
    env_key_names:Object.keys(process.env).filter(k=>/MEEGLE|PROXY|HOME|XDG|PATH/i.test(k))};
  writeFileSync(join(root,"runtime/daily-alert-identity-probe.json"),JSON.stringify(detail,null,2));
  process.exit(r.status??1);
}
const result=spawnSync(process.execPath,[join(root,"scripts/send-overdue-alert-card.mjs"),"--dry-run"],{
  cwd:root,encoding:"utf8",windowsHide:true,timeout:110000,maxBuffer:8*1024*1024,
});
let data; try {data=JSON.parse(result.stdout);} catch {}
const status={at:new Date().toISOString(),ok:result.status===0&&data?.bugs_complete===true&&data?.tasks_complete===true,
  writes_attempted:0,bug_count:data?.bug_count??null,bug_error:data?.bug_error??null,
  task_count:data?.task_count??null,tasks_complete:data?.tasks_complete??false,task_error:data?.task_error??null,
  card_count:data?.cards?.length??0,exit_code:result.status};
writeFileSync(join(root,"runtime/daily-alert-probe.json"),JSON.stringify(status,null,2));
console.log(JSON.stringify(status));
process.exitCode=status.ok?0:1;
