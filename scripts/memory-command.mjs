import { readFileSync } from "node:fs";
import { dirname,join,resolve,relative,isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMemoryCommand } from "./memory-policy.mjs";
import { manageMemory } from "./memory-management.mjs";

const root=join(dirname(fileURLToPath(import.meta.url)),".."),runtime=join(root,"runtime");
try {
  const [id,file]=process.argv.slice(2),config=JSON.parse(readFileSync(join(root,"config/bridge.json"),"utf8"));
  if(config.memory?.enabled!==true) throw new Error("memory_disabled");
  const event=readFileSync(join(runtime,"inbox.ndjson"),"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).find(e=>e.message_id===id);
  let command=parseMemoryCommand(event??{});
  if(file) {
    const path=resolve(root,file),rel=relative(root,path);
    if(isAbsolute(file)||rel.startsWith("..")||isAbsolute(rel)) throw new Error("invalid_command_path");
    command=JSON.parse(readFileSync(path,"utf8"));
  }
  const result=manageMemory(runtime,event,config,command);
  console.log(JSON.stringify({ok:true,...result}));
} catch(error) {console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
