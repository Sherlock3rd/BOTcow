import { readFileSync,existsSync,writeFileSync,mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname,join,resolve,relative,isAbsolute } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { memoryScope,digest } from "./memory-policy.mjs";
import { withScopeLock } from "./memory-management.mjs";
import { verifyContextEpoch,recordVerifiedReply,projectRecord } from "./context-builder.mjs";

export function scopedReply(runtime,event,config,spec,im) {
  memoryScope(event,config);
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(spec.part??"")||!Number.isInteger(spec.epoch)||
    !["text","interactive","file","image","post"].includes(spec.type)) throw new Error("invalid_reply_spec");
  if(spec.type==="text" ? typeof spec.content!=="string" : !spec.content||typeof spec.content!=="object") throw new Error("invalid_reply_content");
  if(spec.type!=="text"&&!spec.expected_text?.length&&!spec.expected_key) throw new Error("reply_evidence_required");
  const key=digest(event.message_id+":"+spec.part),dir=join(runtime,"scoped-replies"),path=join(dir,key+".json");
  mkdirSync(dir,{recursive:true});
  return withScopeLock(runtime,event,config,()=>{
    let receipt=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):null;
    if(receipt?.payload_hash!==undefined&&receipt.payload_hash!==digest(JSON.stringify(spec))) throw new Error("reply_part_payload_changed");
    if(!receipt?.reply_id) {
      verifyContextEpoch(runtime,event,config,spec.epoch);
      if(receipt?.state==="sending") throw new Error("reply_send_uncertain_reconcile_required");
      receipt={message_id:event.message_id,payload_hash:digest(JSON.stringify(spec)),state:"sending",epoch:spec.epoch};
      writeFileSync(path,JSON.stringify(receipt));
      const args=spec.type==="text"?["--text",spec.content]:["--msg-type",spec.type,"--content",JSON.stringify(spec.content)];
      const sent=im("+messages-reply",["--message-id",event.message_id,...args,"--idempotency-key","bc-"+key.slice(0,40)]);
      if(!sent.message_id||sent.chat_id!==event.chat_id) throw new Error("reply_receipt_mismatch");
      receipt={...receipt,reply_id:sent.message_id,state:"sent"};
      writeFileSync(path,JSON.stringify(receipt));
      try {projectRecord(runtime,config,event,{id:sent.message_id,message_id:event.message_id,reply_id:sent.message_id,
        role:"assistant",content_type:spec.type,body:JSON.stringify(spec.content),verification:"sent",
        source_time:new Date().toISOString(),epoch:spec.epoch});} catch { /* original receipt survives */ }
    }
    const read=im("+messages-mget",["--message-ids",receipt.reply_id,"--no-reactions"]);
    const reply=read.messages?.find(m=>m.message_id===receipt.reply_id);
    if(!reply||reply.msg_type!==spec.type||reply.deleted||reply.chat_id!==event.chat_id||reply.reply_to!==event.message_id||
      reply.sender?.open_bot_id!==config.bot_open_id) throw new Error("reply_readback_identity_mismatch");
    const body=typeof reply.content==="string"?reply.content:JSON.stringify(reply.content);
    if(spec.type==="text"?body!==spec.content:
      (spec.expected_text??[]).some(text=>!body.includes(text))||(spec.expected_key&&!body.includes(spec.expected_key)))
      throw new Error("reply_readback_content_mismatch");
    receipt={...receipt,state:"reply_verified",reply};writeFileSync(path,JSON.stringify(receipt));
    try {recordVerifiedReply(runtime,config,event,reply,spec.epoch);} catch { /* replay from receipt, not resend */ }
    return {ok:true,reply_id:receipt.reply_id,verification:"reply_verified"};
  });
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  const root=join(dirname(fileURLToPath(import.meta.url)),".."),runtime=join(root,"runtime");
  try {
    const [id,file]=process.argv.slice(2),path=resolve(root,file??""),rel=relative(root,path);
    if(!file||isAbsolute(file)||rel.startsWith("..")||isAbsolute(rel)) throw new Error("invalid_reply_path");
    const config=JSON.parse(readFileSync(join(root,"config/bridge.json"),"utf8"));
    const event=readFileSync(join(runtime,"inbox.ndjson"),"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).find(e=>e.message_id===id);
    const cli=process.env.LARK_CLI_EXE??join(process.env.APPDATA,"npm/node_modules/@larksuite/cli/bin/lark-cli.exe");
    const im=(cmd,args)=>{
      const result=JSON.parse(execFileSync(cli,["im",cmd,...args,"--profile",config.profile,"--as","bot","--format","json"],
        {cwd:root,windowsHide:true,timeout:30000,encoding:"utf8",env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:"1",LARKSUITE_CLI_NO_SKILLS_NOTIFIER:"1"}}));
      if(result.ok!==true) throw new Error("im_failed");return result.data;
    };
    console.log(JSON.stringify(scopedReply(runtime,event,config,JSON.parse(readFileSync(path,"utf8")),im)));
  } catch(error) {console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
