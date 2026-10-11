'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {diagnose,detailShape}=require('../src/diagnostic.cjs');
const {createApi}=require('../src/api.cjs');const {normalize}=require('../src/core.cjs');
const secret='SECRET_TOKEN_TITLE_CONTENT_URL';
test('diagnostic emits only allowlisted structural fields and counts, never values or arbitrary key names',async()=>{
 const calls=[];const result=await diagnose({token:secret,origin:'https://api-apne1.plaud.ai',request:async(...args)=>{calls.push(args);return calls.length===1?{status:0,data_file_list:[{id:'recording-1',filename:secret,[secret]:secret}]}:{status:0,data:{id:'recording-1',title:secret,summary:secret,content_list:[{data_type:'transaction_polish',task_status:1,data_link:'https://evil.test/'+secret},{data_type:secret,data_id:secret}],pre_download_content_list:[{data_id:'auto_sum:synthetic',data_content:secret}]}};}});
 const serialized=JSON.stringify(result);for(const value of [secret,'evil.test','recording-1','synthetic'])assert.ok(!serialized.includes(value));
 assert.equal(result.detail.content_list.counts.transaction_polish,1);assert.equal(result.detail.content_list.counts.ready,1);assert.equal(result.detail.pre_download_content_list.counts.autoSumPrefix,1);
 assert.equal(calls.length,2);assert.equal(calls[0][0],'/file/simple/web?skip=0&limit=1');assert.equal(calls[1][0],'/file/detail/recording-1');assert.ok(calls.every(c=>c[4]==='https://api-apne1.plaud.ai'));
});
test('diagnostic does not follow routing errors, invalid IDs, multiple entries or content URLs',async()=>{
 for(const raw of [{status:-302,domain:'https://evil.test/'+secret,data_file_list:[{id:'a'}]},{status:secret,data_file_list:[{id:'a'}]},{data_file_list:[{id:'../escape'}]},{data_file_list:[]}]){
  let calls=0;const result=await diagnose({token:secret,origin:'https://api-apne1.plaud.ai',request:async()=>{calls++;return raw;}});assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(result).includes('evil.test'));
 }
});
test('diagnostic errors discard arbitrary error messages and payload bodies',async()=>{
 const result=await diagnose({token:secret,origin:'https://api-apne1.plaud.ai',request:async()=>{const e=new Error(secret);e.code=secret;throw e;}});assert.deepEqual(result.list,{error:'operation-failed'});assert.ok(!JSON.stringify(result).includes(secret));
 assert.ok(!JSON.stringify(detailShape({status:secret,data:{[secret]:secret}})).includes(secret));
});
test('public-source fixture imports public-source polished-only transcript fixture after compatibility fix',async()=>{
 let downloads=0;const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>true,request:async()=>({status:0,data:{file_id:'a',pre_download_content_list:[{data_id:'auto_sum:test',data_content:JSON.stringify({ai_content:'Synthetic summary'})}],content_list:[{data_type:'transaction_polish',task_status:1,data_link:'https://cdn.example.com/test'}]}}),fetchContent:async()=>{downloads++;return [{content:'Synthetic transcript'}];}});
 const detail=await api('/file/detail/a','synthetic-token');assert.equal(normalize(detail,'a').transcript,'Speaker: Synthetic transcript');assert.equal(normalize(detail,'a').summary,'Synthetic summary');assert.equal(downloads,1);
});
test('public-source fixture expands public-source auto_sum JSON into summary text',()=>{
 const detail={id:'a',transcript_text:'Synthetic transcript',pre_download_content_list:[{data_id:'auto_sum:test',data_content:JSON.stringify({ai_content:'Synthetic summary'})}]};
 assert.equal(normalize(detail,'a').summary,'Synthetic summary');
});
test('diagnostic itself requires exact user-identified origin before any request',async()=>{
 for(const origin of ['https://api.plaud.ai','https://api-apne1.plaud.ai:443','https://api-apne1.plaud.ai.evil.test',undefined]){let calls=0;const result=await diagnose({token:secret,origin,request:async()=>calls++});assert.equal(calls,0);assert.deepEqual(result.list,{error:'diagnostic-origin-required'});}
});
test('diagnostic handles eight returned records with null pagination flags and picks one eligible detail',async()=>{
 const rows=Array.from({length:8},(_,i)=>({id:(i+1).toString(16).padStart(32,'0'),is_trash:i<2,is_trans:i!==2,is_summary:i!==2}));let calls=[];
 const result=await diagnose({token:secret,origin:'https://api-apne1.plaud.ai',request:async(p)=>{calls.push(p);return calls.length===1?{status:0,data_file_total:8,data_file_list:rows,next_cursor:null,has_more:null,total_count:null}:{status:0,data:{file_id:rows[3].id}};}});
 assert.equal(calls.length,2);assert.equal(calls[1],'/file/detail/'+rows[3].id);assert.equal(result.list.items.count,8);assert.equal(result.list.flags.trash,2);assert.equal(result.list.flags.eligible,5);assert.equal(result.list.envelope.fields.data_file_total,'number');assert.equal(result.list.envelope.fields.total_count,'null');
 for(const row of rows)assert.ok(!JSON.stringify(result).includes(row.id));
});
