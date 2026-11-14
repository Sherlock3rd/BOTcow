import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,dirname,resolve } from "node:path";
import { stickerOptions,resolveSticker } from "./chat-stickers.mjs";
import { parseChatResponse } from "./chat-model.mjs";
import { deliverGreeting } from "./greeting-reply.mjs";
const png=Buffer.from([137,80,78,71,13,10,26,10,1]);
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),"botcow-stickers-"));
  t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,"assets/stickers"),{recursive:true});mkdirSync(join(root,"runtime"));return root;
}
test("local drop-in catalog rescans, excludes other files and keeps paths out of model input",t=>{
  const root=fixture(t),dir=join(root,"assets/stickers");
  assert.deepEqual(stickerOptions(root),[]);
  writeFileSync(join(dir,"笑死了.png"),png);writeFileSync(join(dir,"假图片.png"),"not image");
  writeFileSync(join(dir,"notes.txt"),"private");mkdirSync(join(dir,"sub"));writeFileSync(join(dir,"sub/隐藏.png"),png);
  let items=stickerOptions(root);assert.equal(items.length,1);assert.equal(items[0].description,"笑死了");
  assert.deepEqual(Object.keys(items[0]),["id","description"]);
  writeFileSync(join(dir,"笑死了.png"),Buffer.concat([png,Buffer.from([2])]));assert.notEqual(stickerOptions(root)[0].id,items[0].id);
  rmSync(join(dir,"笑死了.png"));assert.deepEqual(stickerOptions(root),[]);
});
test("upload cache is content/profile bound; stale IDs and upload failures fall back to text",t=>{
  const root=fixture(t),file=join(root,"assets/stickers/疑惑.png");writeFileSync(file,png);
  const config={profile:"bot",bot_open_id:"app"},choice={...stickerOptions(root)[0],fallback:"这个我得想想"};let uploads=0;
  const upload=path=>{uploads++;assert.equal(path,join("assets","stickers","疑惑.png"));return{image_key:"img_fixture"};};
  assert.equal(resolveSticker(root,config,choice,upload).type,"image");resolveSticker(root,config,choice,upload);assert.equal(uploads,1);
  resolveSticker(root,{...config,profile:"other"},choice,upload);assert.equal(uploads,2);
  writeFileSync(file,Buffer.concat([png,Buffer.from([3])]));assert.equal(resolveSticker(root,config,choice,upload),choice.fallback);
  const newer={...stickerOptions(root)[0],fallback:choice.fallback};assert.equal(resolveSticker(root,config,newer,()=>{throw Error("upload failed")}),choice.fallback);
});
test("sticker route rejects paths, missing fallback and mixed control output",()=>{
  const id="a".repeat(24);assert.equal(parseChatResponse('#STICKER '+JSON.stringify({id,fallback:"笑死了"})).kind,"sticker");
  for(const value of [{id:"../private.png",fallback:"好"},{id,fallback:"😂"},{id,fallback:"#TASK"},{id}])
    assert.throws(()=>parseChatResponse('#STICKER '+JSON.stringify(value)));
  assert.throws(()=>parseChatResponse('笑死 #STICKER '+JSON.stringify({id,fallback:"好"})),/ambiguous/);
});
test("image reply freezes selection and readback retry never resends or marks a wrong image",t=>{
  const root=fixture(t),runtime=join(root,"runtime"),event={message_id:"om_sticker",chat_id:"dm"},config={bot_open_id:"bot"};
  const chosen={type:"image",content:{image_key:"img_selected"},text:"[表情包：笑死了]"};
  let sends=0,marks=0,correct=false;
  const im=(command,args)=>{
    if(command==="+messages-reply") {sends++;assert.equal(args[args.indexOf("--msg-type")+1],"image");assert.deepEqual(JSON.parse(args[args.indexOf("--content")+1]),chosen.content);return{message_id:"reply",chat_id:"dm"};}
    return{messages:[{message_id:"reply",msg_type:"image",chat_id:"dm",reply_to:"om_sticker",sender:{open_bot_id:"bot"},content:correct?"[Image: img_selected]":"[Image: img_wrong]"}]};
  };
  assert.throws(()=>deliverGreeting(event,config,runtime,im,()=>marks++,chosen),/readback/);assert.equal(marks,0);
  correct=true;deliverGreeting(event,config,runtime,im,()=>marks++,{...chosen,content:{image_key:"img_new_selection"}});
  assert.equal(sends,1);assert.equal(marks,1);
  const rows=readFileSync(join(runtime,"greeting-replies.ndjson"),"utf8").trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].reply_id,undefined);assert.equal(rows.at(-1).reply_id,"reply");
});
test("uncertain image send retains payload and original idempotency key",t=>{
  const runtime=join(fixture(t),"runtime"),event={message_id:"om_uncertain",chat_id:"dm"},config={bot_open_id:"bot"};
  const payload={type:"image",content:{image_key:"img_original"},text:"[表情包：疑惑]"};let tries=0;
  const im=(cmd,args)=>{if(cmd==="+messages-reply") {tries++;assert.ok(args.includes("greet-om_uncertain"));assert.deepEqual(JSON.parse(args[args.indexOf("--content")+1]),payload.content);if(tries===1)throw Error("timeout");return{message_id:"reply",chat_id:"dm"};}
    return{messages:[{message_id:"reply",msg_type:"image",chat_id:"dm",reply_to:event.message_id,sender:{open_bot_id:"bot"},content:payload.content}]};};
  assert.throws(()=>deliverGreeting(event,config,runtime,im,()=>{},payload),/timeout/);
  deliverGreeting(event,config,runtime,im,()=>{},"a different model answer");assert.equal(tries,2);
});
