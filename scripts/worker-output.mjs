import { openSync, closeSync, readSync, fstatSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

// Independent timer remains responsive even when the model produces no output.
export async function runSupervised(executable,args,options,stdoutPath,stderrPath,control) {
  const out=openSync(stdoutPath,'wx'),err=openSync(stderrPath,'wx');
  const {input,timeout,...spawnOptions}=options;
  let child;
  try {child=spawn(executable,args,{...spawnOptions,stdio:['pipe',out,err]});}
  finally {closeSync(out);closeSync(err);}
  let reason=null,warning=false,busy=false,killPending=Promise.resolve(),started=Date.now();
  const ended=new Promise(resolve=>{
    child.once('error',error=>resolve({status:null,error}));
    child.once('exit',(status,signal)=>resolve({status,signal}));
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
  const stop=why=>{
    if(reason)return;
    reason=why;
    try {control.onStopping?.(why);} catch { /* stop still required if audit storage fails */ }
    if(process.platform==='win32') {
      killPending=new Promise(resolve=>{
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.once('error',()=>{child.kill();resolve();});killer.once('exit',()=>resolve());
      });
    } else child.kill('SIGKILL');
  };
  const timer=setInterval(()=>{
    if(reason||busy)return;
    const elapsed=Date.now()-started;
    try {
      if(control.cancelled()) {stop('user_cancelled');return;}
      if(elapsed>=control.timeoutMs) {stop('task_timeout');return;}
      if(!warning&&elapsed>=control.warningMs) {
        warning=true;busy=true;
        Promise.resolve().then(()=>control.onWarning()).catch(()=>{}).finally(()=>{busy=false;});
      }
    } catch {stop('supervisor_error');}
  },control.pollMs??500);
  const result=await ended;clearInterval(timer);await killPending;
  return {...result,stopReason:reason};
}

export function runWithOutputFiles(executable, args, options, stdoutPath, stderrPath) {
  const stdoutFd = openSync(stdoutPath, "wx");
  let stderrFd;
  try {
    stderrFd = openSync(stderrPath, "wx");
    return spawnSync(executable, args, {
      ...options, stdio: ["pipe", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
}

export function readOutputTail(path, limit = 4000) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - limit));
    return buffer.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}

// Scan NDJSON without retaining large tool-output events in memory.
export function readStartedThreadId(path) {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let line = "", oversized = false;
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (const char of buffer.subarray(0, count).toString("utf8")) {
        if (char === "\n") {
          if (!oversized) {
            try {
              const event = JSON.parse(line);
              if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
            } catch { /* Non-JSON diagnostics are not thread metadata. */ }
          }
          line = ""; oversized = false;
        } else if (!oversized) {
          line += char;
          if (line.length > 16384) { line = ""; oversized = true; }
        }
      }
    }
    if (!oversized && line.trim()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
      } catch { /* Incomplete final record. */ }
    }
    return null;
  } finally { closeSync(fd); }
}
