import test from "node:test";
import assert from "node:assert/strict";
import { collectOpenBugs } from "./dobe-bugs.mjs";
import { buildDailyCards, shanghaiDate } from "./daily-alert-card.mjs";
import { deliverDailyCards } from "./daily-alert-delivery.mjs";

const config = {simple_name:"dobe",type_key:"issue",excluded_status_key:"CLOSED",excluded_status_name:"已关闭",url:"https://project.feishu.cn/dobe/issue/homepage",scope:"related_to_current_user",expected_user_email:"me@example.com"};
const me = {email:"me@example.com"};
const keys = ["work_item_id","name","work_item_status","priority","current_status_operator","updated_at"];
const meta = {list:keys.map(key=>({field_key:key,field_name:key,option:key === "work_item_status" ? [{option_id:"CLOSED",option_name:"已关闭"}] : []})),pagination:{has_more:false}};
const item = id => ({id:String(id), title:`缺陷 ${id} ` + "测试标题".repeat(6),status:"新建",status_key:"OPEN",priority:"P1",owners:["验证人员"],url:`https://project.feishu.cn/dobe/issue/detail/${id}`});
function row(id, status="OPEN") {
  const values = [["long_value",id],["string_value",`缺陷 ${id}`],["key_label_value_list",[{key:status,label:status === "CLOSED" ? "已关闭":"新建"}]],["key_label_value_list",[{label:"P1"}]],["user_value_list",[{name_cn:"小王",email:"private@example.com",user_key:"private"}]],["string_value","2026-11-12"]];
  return {moql_field_list:keys.map((key,i)=>({key,value_type:values[i][0],value:{[values[i][0]]:values[i][1]}}))};
}
const page = (ids,count) => ({list:[{count,group_infos:[{group_id:"1"}]}],data:{"1":ids.map(id=>row(id))}});
const overdue = {ok:true,count:0,items:[],source_url:"https://example.com/schedule"};
const bugs = count => ({ok:true,complete:true,scope:"related_to_current_user",count,items:Array.from({length:count},(_,i)=>item(i+1)),status_counts:{新建:count},source_url:config.url});

test("fetches beyond 50 rows, checks remaining totals and strips user identifiers", () => {
  const calls=[];
  const pages=[me,meta,page(Array.from({length:50},(_,i)=>i+1),148),page(Array.from({length:50},(_,i)=>i+51),98),page(Array.from({length:48},(_,i)=>i+101),48)];
  const result=collectOpenBugs(config,args=>{calls.push(args);return pages.shift();});
  assert.equal(result.count,148); assert.equal(result.complete,true);
  assert.match(calls[3].at(-1),/> 50/); assert.match(calls[4].at(-1),/> 100/);
  assert.doesNotMatch(JSON.stringify(result),/private@example|user_key/);
});
test("fails closed on schema drift, repeated pages, count changes and closed rows", () => {
  for (const pages of [
    [{...meta,pagination:{has_more:true}}],
    [meta,page([1],2),page([1],1)],
    [meta,page([1],2),page([2],2)],
    [meta,{list:[{count:1,group_infos:[{group_id:"1"}]}],data:{"1":[row(1,"CLOSED")]}}],
  ]) assert.throws(()=>collectOpenBugs(config,args=>args[0] === "user" ? me : pages.shift()));
});
test("complete zero results are distinct from a failed read", () => {
  const pages=[me,meta,page([],0)];
  assert.equal(collectOpenBugs(config,()=>pages.shift()).count,0);
  const liveEmptyShape=[me,meta,{list:null,data:{}}];
  assert.equal(collectOpenBugs(config,()=>liveEmptyShape.shift()).count,0);
  const empty=buildDailyCards(overdue,bugs(0));
  const failed=buildDailyCards(overdue,{ok:false,error:"query_failed"});
  assert.equal(empty.bug_count,0); assert.equal(failed.bug_count,null);
  assert.match(JSON.stringify(failed.cards),/未能读取/);
  assert.doesNotMatch(JSON.stringify(failed.cards),/当前没有未关闭 Bug/);
});
test("all 148 bugs appear once across bounded cards with native pagination", () => {
  const built=buildDailyCards(overdue,bugs(148));
  assert.ok(built.cards.length>1);
  const rows=built.cards.flatMap(c=>c.body.elements.filter(e=>e.tag==="table").flatMap(t=>t.rows));
  assert.equal(rows.length,148); assert.equal(new Set(rows.map(r=>r.bug)).size,148);
  for (const c of built.cards) { assert.ok(Buffer.byteLength(JSON.stringify(c))<=28000); assert.equal(c.schema,"2.0"); assert.ok(c.body.elements.length<=5); }
});
test("untrusted bug titles cannot inject card mentions or Markdown links", () => {
  const data=bugs(1); data.items[0].title="<at id=all></at> [click](https://evil.test) **text**";
  const content=JSON.stringify(buildDailyCards(overdue,data).cards);
  assert.doesNotMatch(content,/<at id=all/); assert.match(content,/&#60;at/);
});
test("uses Shanghai date at UTC midnight boundary", () => {
  assert.equal(shanghaiDate(new Date("2026-11-12T16:30:00Z")),"2026-11-13");
});
test("partial send resumes readback without resending the first card", () => {
  const plan={key:"day",chat_id:"chat",cards:[{},{}],receipts:[],bug_count:148,bugs_complete:true};
  const sends=[]; let fail=true;
  const im=(command,args)=>{
    if(command==="+messages-send") { const id=`m${sends.length+1}`; sends.push(args);return{message_id:id,chat_id:"chat"}; }
    if(fail) {fail=false;throw new Error("readback unavailable");}
    return {messages:[{message_id:args[1],chat_id:"chat",msg_type:"interactive",content:"Dobe 未关闭 Bug"}]};
  };
  assert.throws(()=>deliverDailyCards(plan,im,()=>{}));
  assert.equal(sends.length,1); assert.equal(plan.receipts[0].verified,false);
  const done=deliverDailyCards(plan,im,()=>{});
  assert.equal(sends.length,2); assert.equal(done.data.message_ids.length,2);
  deliverDailyCards(plan,im,()=>{}); assert.equal(sends.length,2);
});
test("wrong chat or deleted card cannot pass readback", () => {
  const plan={key:"day",chat_id:"chat",cards:[{}],receipts:[{message_id:"m1",verified:false}]};
  assert.throws(()=>deliverDailyCards(plan,()=>({messages:[{message_id:"m1",chat_id:"wrong",msg_type:"interactive",content:"Dobe 未关闭 Bug"}]}),()=>{}));
});


test("every page is restricted to me, wrong login and old broad snapshots are rejected", () => {
  const seen=[];
  const pages=[me,meta,page([1],2),page([2],1)];
  collectOpenBugs(config,args=>{seen.push(args);return pages.shift();});
  for(const args of seen.filter(a=>a[1]==="query")) assert.match(args.at(-1),/AND array_contains\(all_participate_persons\(\), current_login_user\(\)\)/);
  assert.throws(()=>collectOpenBugs(config,()=>({email:"someone-else@example.com"})),/identity_mismatch/);
  const broad=bugs(2);delete broad.scope;
  const rendered=buildDailyCards(overdue,broad);
  assert.equal(rendered.bugs_complete,false);
  assert.equal(rendered.cards.flatMap(c=>c.body.elements.filter(e=>e.tag==="table")).length,0);
});

test("Meegle transient errors retry, stderr auth errors stop, diagnostics never contain secrets", async () => {
  const {makeMeegleQuery}=await import('./dobe-bugs.mjs');
  const diagnostics=[];let attempts=0;
  const query=makeMeegleQuery(config,'.',{sleep:()=>{},onDiagnostic:d=>diagnostics.push(d),run:()=>{
    attempts++;
    return attempts===1?{status:1,stdout:'',stderr:'HTTP 503 service unavailable https://example.com/?access_token=secret Bearer secret'}:{status:0,stdout:JSON.stringify({data:me,error:null}),stderr:''};
  }});
  assert.deepEqual(query(['user','me']),me);assert.equal(attempts,2);assert.equal(diagnostics[0].code,'service_unavailable');
  assert.doesNotMatch(JSON.stringify(diagnostics),/secret|Bearer|example.com/);
  attempts=0;
  const auth=makeMeegleQuery(config,'.',{sleep:()=>{},run:()=>{attempts++;return{status:1,stdout:'',stderr:JSON.stringify({error:{code:401,message:'Not logged in; token expired. access_token=secret'}})};}});
  assert.throws(()=>auth(['user','me']),e=>e.code==='authorization_required'&&e.diagnostic.stage==='user me'&&e.diagnostic.json_stream==='stderr');
  assert.equal(attempts,1);
});
test("Meegle retries are bounded and business errors are not retried", async () => {
  const {makeMeegleQuery}=await import('./dobe-bugs.mjs');
  for(const [stderr,expected,attemptLimit] of [['ECONNRESET','service_unavailable',3],['permission denied','permission_denied',1],['authentication required','authorization_required',1],['invalid MQL field','query_failed',1]]) {
    let attempts=0;
    const query=makeMeegleQuery(config,'.',{sleep:()=>{},run:()=>{attempts++;return{status:1,stdout:'',stderr};}});
    assert.throws(()=>query(['workitem','query']),e=>e.code===expected);
    assert.equal(attempts,attemptLimit);
  }
});
