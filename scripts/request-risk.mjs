import { existsSync,readFileSync,writeFileSync,renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isPublicGroup } from "./bridge-eligibility.mjs";
const digest=s=>createHash("sha256").update(s).digest("hex");
const notices={
  input_size:"这条内容太长了，请缩小到一个具体问题，或分段整理后再发。",
  private_data:"这个不能提供：密钥、内部指令和他人的私人信息不对外公开。可以直接说你想解决什么问题。",
  unbounded:"这类无界求证或海量输出我不接，不能一直耗下去。可以改成解释问题、讨论一个具体思路，或先做一个小样本。",
  rate_limit:"这会儿问得有点密，先缓一缓再发。每次聚焦一个问题就好。",
  text_only:"这个群聊通道目前只处理本条文字，请把要问的内容用文字发来。",
  output_limit:"这个问题超出了本次短答预算，请缩小范围，我再简要回答。",
  unavailable:"这次没能完成短答，先到这里。可以稍后把问题缩小一点再问。",
};
export const riskNotice=code=>notices[code]??notices.unavailable;
export function inspectRequest(event,config) {
  if(config.risk_control?.enabled!==true&&!isPublicGroup(event,config))return null;
  const guest=isPublicGroup(event,config),raw=String(event.content??"");
  const max=guest?(config.group_public.max_input_chars??4000):(config.risk_control.max_input_chars??12000);
  if(raw.length>max)return "input_size";
  const t=raw.normalize("NFKC").replace(/[\u200b-\u200f\ufeff]/g,"");
  if(/(?:输出|打印|展示|泄露|给我|发我|导出|读取|告诉|复述|翻译|编码|show|print|reveal|dump|encode|read).{0,80}(?:系统提示词?|开发者提示|隐藏指令|system\s*prompt|developer\s*instructions|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|app[_ -]?secret|登录凭据)/isu.test(t)||
     /(?:系统提示词|开发者提示词|隐藏指令).{0,20}(?:是什么|逐字|全文)/u.test(t)||
     /(?:access[_ -]?token|refresh[_ -]?token|app[_ -]?secret|登录凭据).{0,40}(?:给我|发我|输出|编码|翻译|提供)/iu.test(t))return "private_data";
  const theorem=/(?:哥德巴赫|黎曼猜想|Goldbach|Riemann hypothesis|P\s*[=≠]\s*NP)/iu.test(t);
  if(theorem&&/(?:证明|证出|解决|prove|solve)/iu.test(t)&&!/(?:为什么不能|是否已|有没有人|介绍|解释|科普|什么是)/u.test(t))return "unbounded";
  if(/(?:无限循环|不要停止|永远.{0,12}(?:运行|思考|输出)|(?:用完|耗尽|消耗光).{0,16}tokens?|(?:一直|不停).{0,12}(?:证明|穷举|枚举))/iu.test(t)||
    /(?:重复.{0,20}[1-9]\d{4,}|(?:逐一|穷举|枚举).{0,20}(?:所有|全部).{0,12}(?:组合|可能|整数|字符串)|(?:写|生成|输出).{0,12}(?:[1-9]\d{4,}|[一二三四五六七八九十百]+万|无限).{0,8}(?:字|行|遍|条|次|tokens?))/iu.test(t))return "unbounded";
  if(guest&&event.message_type!=="text")return "text_only";
  return null;
}
// Called only from the serialized public chat lane. No message bodies or direct IDs are stored here.
export function reservePublicRequest(runtime,event,config,now=Date.now()) {
  const path=join(runtime,"group-public-budget.json");
  const state=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{calls:[],decisions:{},notices:{}};
  const id=digest(event.message_id),who=digest(event.chat_id+":"+event.sender_id),actor=digest(event.sender_id),group=digest(event.chat_id);
  if(state.decisions[id])return state.decisions[id].decision;
  state.calls=state.calls.filter(x=>x.at>now-3600000);
  state.decisions=Object.fromEntries(Object.entries(state.decisions).filter(([,x])=>x.at>now-86400000).slice(-3999));
  state.notices=Object.fromEntries(Object.entries(state.notices).filter(([,at])=>at>now-60000));
  const p=config.group_public??{};
  const limited=state.calls.filter(x=>x.actor===actor&&x.at>now-60000).length>=(p.per_user_minute??6)||
    state.calls.filter(x=>x.actor===actor).length>=(p.per_user_hour??30)||
    state.calls.filter(x=>x.group===group).length>=(p.per_group_hour??60)||state.calls.length>=(p.total_hour??100);
  // Count rejected attempts too, so attackers cannot get unlimited refusal messages.
  state.calls.push({at:now,actor,group});state.calls=state.calls.slice(-10000);
  let reason=limited?"rate_limit":inspectRequest(event,config);
  const silent=limited&&state.notices[who]>now-60000;
  if(limited&&!silent)state.notices[who]=now;
  const decision={allow:!reason,reason,silent};state.decisions[id]={at:now,decision};
  const temp=path+".tmp";writeFileSync(temp,JSON.stringify(state));renameSync(temp,path);
  return decision;
}
