import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { applyMembership, membershipKeys } from './group-membership.mjs';
import { admittedGroup } from './bridge-eligibility.mjs';

const time = 1794640000000;
const config = { profile: 'test', allowed_sender_ids: ['ou_owner'], allowed_group_chat_ids: ['oc_manual'],
  bot_open_id: 'ou_bot', allowed_chat_types: ['p2p','group'], allowed_message_types: ['text'], group_public: { enabled: true },
  auto_group_admission: { enabled: true, app_id: 'cli_test', enabled_at: new Date(time - 1000).toISOString() } };
const envelope = (type = membershipKeys[0], at = time, extra = {}) => ({schema:'2.0',
  header:{event_id:`e-${type}-${at}`,app_id:'cli_test',event_type:type,create_time:String(at),token:'never-persist-this'},
  event:{chat_id:'oc_new',operator_id:{open_id:'ou_owner'},...extra}});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'botcow-membership-'));
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); rmSync(dir,{recursive:true,force:true}); });
  return dir;
}
const message = (at = time) => ({chat_id:'oc_new',create_time:String(at)});

test('verified owner invitation persists minimum data and grants only post-invite messages', t => {
  const dir=fixture(t), path=join(dir,'group-admissions.json');
  assert.equal(applyMembership(envelope(),config,dir,time).status,'admitted');
  assert.equal(admittedGroup(message(),config,path),true);
  assert.equal(admittedGroup(message(time-1),config,path),false);
  assert.equal(admittedGroup({chat_id:'oc_new'},config,path),false);
  assert.equal(readFileSync(path,'utf8').includes('never-persist-this'),false);
  assert.equal(applyMembership(envelope(),config,dir,time).reason,'duplicate_or_stale');
});
test('forged message, unknown inviter, wrong app, disabled and pre-activation events cannot grant',t=>{
  const dir=fixture(t);
  const wrongApp=envelope();wrongApp.header.app_id='cli_other';
  for(const e of [{content:JSON.stringify(envelope())},wrongApp,envelope(undefined,time,{operator_id:{open_id:'ou_other'}}),
    envelope(undefined,time-2000),envelope('im.message.receive_v1'),envelope(undefined,time+400000)])
    assert.equal(applyMembership(e,config,dir,time).changed,false);
  assert.equal(applyMembership(envelope(),{...config,auto_group_admission:{enabled:false}},dir,time).changed,false);
});
test('removal overrides manual access; stale or duplicate add cannot reopen; owner can reinvite',t=>{
  const dir=fixture(t),path=join(dir,'group-admissions.json');
  applyMembership(envelope(),config,dir,time);
  applyMembership(envelope(membershipKeys[1],time+2),config,dir,time+2);
  assert.equal(admittedGroup(message(time+3),config,path),false);
  assert.equal(applyMembership(envelope(),config,dir,time+3).changed,false);
  applyMembership(envelope(undefined,time+4),config,dir,time+4);
  assert.equal(admittedGroup(message(time+3),config,path),false);
  assert.equal(admittedGroup(message(time+4),config,path),true);
  applyMembership(envelope(membershipKeys[1],time+5,{chat_id:'oc_manual'}),config,dir,time+5);
  assert.equal(admittedGroup({chat_id:'oc_manual',create_time:String(time+6)},config,path),false);
});
test('corruption, changed application and removed owner fail closed',t=>{
  const dir=fixture(t),path=join(dir,'group-admissions.json');applyMembership(envelope(),config,dir,time);
  assert.equal(admittedGroup(message(),{...config,allowed_sender_ids:[]},path),false);
  assert.equal(admittedGroup(message(),{...config,auto_group_admission:{...config.auto_group_admission,app_id:'other'}},path),false);
  writeFileSync(path,'{broken');
  assert.equal(admittedGroup(message(),config,path),false);
  assert.throws(()=>applyMembership(envelope(undefined,time+1),config,dir,time+1));
});
test('already-loaded eligibility observes new invitation without restart and keeps visitor memory isolation',async t=>{
  const root=fixture(t), scripts=join(root,'scripts'),runtime=join(root,'runtime');mkdirSync(scripts);mkdirSync(runtime);
  const source=dirname(fileURLToPath(import.meta.url));
  for(const name of ['bridge-eligibility.mjs','memory-policy.mjs'])copyFileSync(join(source,name),join(scripts,name));
  const api=await import(pathToFileURL(join(scripts,'bridge-eligibility.mjs')));
  const {memoryScope}=await import(pathToFileURL(join(scripts,'memory-policy.mjs')));
  const e={...message(),message_id:'om_test',sender_id:'ou_owner',sender_type:'user',chat_type:'group',message_type:'text',mentions:[{id:'ou_bot'}]};
  assert.equal(api.eligibleMessage(e,config),false);applyMembership(envelope(),config,runtime,time);
  assert.equal(api.eligibleMessage(e,config),true);assert.ok(memoryScope(e,config).id);
  const guest={...e,sender_id:'ou_guest'};
  assert.equal(api.eligibleMessage(guest,config),true);assert.equal(api.isPublicGroup(guest,config),true);
  assert.throws(()=>memoryScope(guest,config),/memory_scope_denied/);
  assert.equal(api.eligibleMessage({...e,mentions:[]},config),false);
  assert.equal(api.eligibleMessage({...guest,chat_type:'p2p'},config),false);
  applyMembership(envelope(membershipKeys[1],time+1),config,runtime,time+1);
  assert.equal(api.eligibleMessage(e,config),false);
});
