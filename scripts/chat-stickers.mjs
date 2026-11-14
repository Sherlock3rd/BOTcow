import { existsSync, readdirSync, readFileSync, realpathSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";
import { createHash } from "node:crypto";

const hash=value=>createHash("sha256").update(value).digest("hex");
const extensions=new Set([".png",".jpg",".jpeg",".gif",".webp"]);
export function stickerCatalog(root) {
  const dir=join(root,"assets/stickers");
  if(!existsSync(dir)||lstatSync(dir).isSymbolicLink()) return [];
  const resolved=realpathSync(dir),items=[];
  for(const name of readdirSync(dir).sort()) {
    if(!extensions.has(extname(name).toLowerCase())) continue;
    const path=join(dir,name),stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>10*1024*1024||relative(resolved,realpathSync(path))!==name) continue;
    const bytes=readFileSync(path),digest=hash(bytes);
    // Reject renamed non-images before considering them for upload.
    const magic=bytes.subarray(0,16);
    const valid=magic.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      (magic[0]===255&&magic[1]===216&&magic[2]===255) || /^GIF8[79]a/.test(magic.toString("ascii")) ||
      (magic.toString("ascii",0,4)==="RIFF"&&magic.toString("ascii",8,12)==="WEBP");
    if(!valid) continue;
    items.push({id:hash(name+":"+digest).slice(0,24),description:basename(name,extname(name)).slice(0,80),digest,path:relative(root,path)});
    if(items.length===100)break;
  }
  return items;
}
export function stickerOptions(root) {
  try {return stickerCatalog(root).map(({id,description})=>({id,description}));} catch {return [];}
}
export function resolveSticker(root,config,choice,upload) {
  const fallback=choice.fallback;
  try {
    const item=stickerCatalog(root).find(x=>x.id===choice.id);
    if(!item)return fallback;
    const dir=join(root,"runtime/sticker-cache");mkdirSync(dir,{recursive:true});
    const cache=join(dir,hash(JSON.stringify([config.profile,config.bot_open_id,item.digest]))+".json");
    let key=existsSync(cache)?JSON.parse(readFileSync(cache,"utf8")).image_key:null;
    if(!/^img_[A-Za-z0-9_-]+$/.test(key??"")) {
      key=upload(item.path)?.image_key;
      if(!/^img_[A-Za-z0-9_-]+$/.test(key??""))throw Error("invalid_image_key");
      writeFileSync(cache,JSON.stringify({image_key:key,digest:item.digest}));
    }
    return {type:"image",content:{image_key:key},text:`[表情包：${item.description}]`};
  } catch {return fallback;}
}
