import assert from 'node:assert/strict';
import {test} from 'node:test';
import {contextForModel,chatInput,assistantProfile,publicAssistantProfile} from './assistant-profile.mjs';

test('standalone chat never receives old assistant prose or technical identity as an alternate persona',()=>{
  const source={question:'你是谁呀',history:[{message_id:'m1',reply_id:'r1',user:'介绍自己',reply:'OLD_STYLE_SENTINEL'}]};
  const view=chatInput(source);
  assert.ok(!JSON.stringify(view).includes('OLD_STYLE_SENTINEL'));
  assert.equal(view.assistant_evidence[0].source_omitted,true);
  assert.equal(view.assistant_evidence[0].message_id,'m1');assert.equal(view.technical_reference,undefined);
  assert.ok(!assistantProfile({includeKnowledge:false}).includes('牛马小助手基础知识'));
  assert.equal(contextForModel(source,{allEvidence:true}).assistant_evidence[0].source_text,'OLD_STYLE_SENTINEL');
  assert.ok(chatInput({...source,question:'底层项目叫什么？'}).technical_reference.includes('botCow'));
  assert.equal(source.history[0].reply,'OLD_STYLE_SENTINEL');
});

test('historical answers become lossless evidence without mutating stored context',()=>{
  const original={question:'第二个呢？',scope_epoch:3,memory_status:'available',
    history:[{message_id:'m1',user:'列两个名字',reply:'主人，1. 星港；2. 潮汐。不确定是否可注册。',reply_id:'r1',verification:'reply_verified'}],
    quoted:{message_id:'m1',reply_id:'r1',user:'列两个名字',reply:'主人，1. 星港；2. 潮汐。不确定是否可注册。'},
    confirmed_memories:[{id:'pref',value:'方案需要附成本',revision:2}],
    previousReply:{text:'SENT_RECEIPT_NOT_A_DEMO'}};
  const snapshot=JSON.stringify(original),view=contextForModel(original);
  assert.equal(JSON.stringify(original),snapshot);
  assert.equal(view.history[0].reply,undefined);assert.equal(view.quoted.reply,undefined);
  assert.equal(view.assistant_evidence.find(x=>x.record_ref===view.history[0].assistant_record_ref).source_text,original.history[0].reply);
  assert.equal(view.assistant_evidence.find(x=>x.record_ref===view.quoted.assistant_record_ref).source_text,original.quoted.reply);
  assert.deepEqual(view.confirmed_memories,original.confirmed_memories);
  assert.equal(view.scope_epoch,3);assert.ok(!JSON.stringify(view).includes('SENT_RECEIPT_NOT_A_DEMO'));
});

test('task evidence keeps actual conclusions and source identifiers outside assistant role sequences',()=>{
  const record={id:'r1',role:'assistant',body:'尚未提交；Review ID=A-7，需确认。',verification:'reply_verified',content_type:'text'};
  const input={bound_task:{task:{id:'t1'},records:[{id:'u1',role:'user',body:'检查配置'},record],requires_source_read:false},history:[{user:'继续',reply:null}],missingReference:true};
  const view=contextForModel(input),mapped=view.bound_task.records[1];
  assert.equal(mapped.role,undefined);assert.equal(mapped.body,undefined);
  assert.deepEqual(view.bound_task.records[0],input.bound_task.records[0]);
  assert.equal(view.assistant_evidence[0].source_text,record.body);
  assert.equal(view.assistant_evidence[0].record_id,'r1');assert.equal(view.assistant_evidence[0].verification,'reply_verified');
  assert.equal(view.missingReference,true);assert.equal(view.history[0].assistant_record_ref,undefined);
});

test('both lanes have exactly one shared character with no retired style appendix',()=>{
  for(const profile of [assistantProfile(),publicAssistantProfile()]){
    assert.equal(profile.split('## 二、身份').length-1,1);
    assert.ok(profile.includes('不使用“主人”'));
    assert.doesNotMatch(profile,/## 当前对话的落点|## 自我介绍与称呼|普通疲惫、吐槽不自动|回复前在本轮内简短检查/);
  }
  assert.doesNotMatch(publicAssistantProfile(),/牛马小助手基础知识|管理员通道运行边界|assistant_evidence/);
});
