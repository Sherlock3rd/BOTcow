import { openSync,closeSync,writeFileSync,readFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { memoryScope } from "./memory-policy.mjs";
import { openMemory } from "./context-builder.mjs";

// Serialize memory mutations with the final send check, across both processes.
// Never hold this lock while waiting for a model or doing business work.
export function withScopeLock(runtimeDir,event,config,fn) {
  const scope=memoryScope(event,config),path=join(runtimeDir,`memory-scope-${scope.id}.lock`);
  let fd;
  try {fd=openSync(path,"wx");} catch(error) {
    if(error.code!=="EEXIST") throw error;
    const pid=Number(readFileSync(path,"utf8"));
    let alive=true; try {process.kill(pid,0);} catch(e) {if(e.code==="ESRCH") alive=false;}
    if(alive||!Number.isInteger(pid)||pid<=0) throw new Error("memory_scope_busy");
    rmSync(path);fd=openSync(path,"wx");
  }
  try {writeFileSync(fd,String(process.pid));return fn();}
  finally {closeSync(fd);rmSync(path,{force:true});}
}
export function manageMemory(runtimeDir,event,config,command) {
  if(config.memory?.write_enabled===false&&command.operation!=="list")
    return {text:"当前已暂停记忆写入，这条内容尚未保存。",disabled:true};
  return withScopeLock(runtimeDir,event,config,()=>{
    const store=openMemory(runtimeDir);
    try {
      const result=store.manage(event,config,command);
      // Keep monotonic invalidation fences outside database backups. An older
      // restored DB is rejected, never allowed to resurrect forgotten input.
      store.scope(event,config);
      return result;
    } finally {store.close();}
  });
}
