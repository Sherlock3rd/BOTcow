import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assertGroupSchedulePrivacy} from "./scoped-reply.mjs";

test("group output blocks configured private scheduling identifiers in text and cards",()=>{
  const dir=mkdtempSync(join(tmpdir(),"botcow-privacy-")),path=join(dir,"workflows.json");
  try {
    writeFileSync(path,JSON.stringify({scheduling:{base_token:"private_base_fixture",table_id:"tbl_private_fixture",view_id:"vew_private_fixture"}}));
    for(const spec of [{type:"text",content:"https://example.feishu.cn/base/private_base_fixture"},
      {type:"interactive",content:{elements:[{url:"https://example.feishu.cn/base/other?table=tbl_private_fixture"}]}},
      {type:"post",content:{text:"%76%65%77%5Fprivate_fixture"}}]) {
      assert.throws(()=>assertGroupSchedulePrivacy({chat_type:"group"},spec,path),/private_schedule_not_allowed/);
      assert.doesNotThrow(()=>assertGroupSchedulePrivacy({chat_type:"p2p"},spec,path));
    }
    assert.doesNotThrow(()=>assertGroupSchedulePrivacy({chat_type:"group"},{type:"text",content:"项目任务配置表为 Quest_Chapter。"},path));
    assert.throws(()=>assertGroupSchedulePrivacy({chat_type:"group"},{content:"reply"},join(dir,"missing")),/config_unavailable/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
