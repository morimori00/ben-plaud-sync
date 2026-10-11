'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createApi}=require('../src/api.cjs');
const {normalize}=require('../src/core.cjs');
test('v4 cursor pages, workspace, preferred transcript and raw summary with exact host consent',async()=>{
  let calls=[],prompts=[],fetches=[];
  const api=createApi({version:'v4',workspace:'workspace-1',approvedHosts:new Set(),approveHost:async h=>{prompts.push(h);return true;},request:async(p,t,s,w)=>{
    calls.push({p,t,w});
    if(p.includes('/recordings/'))return {status:0,data:{items:[{file_id:p.includes('cursor=')?'rec-2':'rec-1'}],next_cursor:p.includes('cursor=')?null:'cursor2'}};
    return {status:0,data:{meta:{file_id:'rec-1'},node:{name:'Title'},objects:[{object_type:'AUDIO',content_url:'https://evil.test/audio'},{object_type:'TRANSCRIPT',content_url:'https://evil.test/raw'},{object_type:'POLISHED_TRANSCRIPT',content_url:'https://cdn.example.com/t'},{object_type:'SUMMARY',content_url:'https://cdn.example.com/s'}]}};
  },fetchContent:async(u,hosts)=>{fetches.push(u);assert.ok(hosts.has('cdn.example.com'));return u.endsWith('/t')?[{content:'Hello',speaker:'A'}]:'# Summary\n- Hi';}});
  assert.equal((await api('/file/simple/web','secret')).length,2);
  const d=normalize(await api('/file/detail/rec-1','secret'),'rec-1');
  assert.equal(d.transcript,'A: Hello');assert.equal(d.summary,'# Summary\n- Hi');
  assert.deepEqual(prompts,['cdn.example.com']);assert.ok(fetches.every(x=>!x.includes('evil')));assert.ok(calls.every(c=>c.w==='workspace-1'));
});
test('host refusal blocks download and approved hosts never persisted by adapter',async()=>{
  let fetched=false;
  const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>false,request:async()=>({id:'rec-1',content_list:[{data_type:'transaction',data_link:'https://cdn.example.com/t'}]}),fetchContent:async()=>{fetched=true;}});
  await assert.rejects(api('/file/detail/rec-1','secret'),/external-content-blocked/);assert.equal(fetched,false);
});
test('v4 missing summary remains pending; repeated cursor aborts without success',async()=>{
  let api=createApi({version:'v4',workspace:'w1',approvedHosts:new Set(),approveHost:async()=>true,request:async()=>({status:0,data:{meta:{file_id:'rec-1'},objects:[]}})});
  await assert.rejects(api('/file/detail/rec-1','secret'),/content-not-ready/);
  api=createApi({version:'v4',workspace:'w1',approvedHosts:new Set(),approveHost:async()=>true,request:async()=>({status:0,data:{items:[],next_cursor:'same'}})});
  await assert.rejects(api('/file/simple/web','secret'),/invalid-pagination/);
});
test('malicious content host rejected before approval; token never passed to content fetch',async()=>{
  let prompts=0;
  const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>{prompts++;return true;},request:async()=>({id:'rec-1',content_list:[{data_type:'transaction',data_link:'http://127.0.0.1/internal'}]})});
  await assert.rejects(api('/file/detail/rec-1','secret'));assert.equal(prompts,0);
});
test('inline v3 complete content makes no content requests',async()=>{
  const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>{throw Error('no');},request:async()=>({status:0,payload:{id:'rec-1',summary:'S',transcript_text:'T'}})});
  assert.equal(normalize(await api('/file/detail/rec-1','secret'),'rec-1').summary,'S');
});
test('v3 parses JSON stored as text/plain; v4 raw transcript fallback when polished lacks URL',async()=>{
  let api=createApi({version:'v3',approvedHosts:new Set(['cdn.example.com']),approveHost:async()=>false,request:async()=>({id:'rec-1',summary:'S',content_list:[{data_type:'transaction',data_link:'https://cdn.example.com/t'}]}),fetchContent:async()=>JSON.stringify([{content:'Hello'}])});
  assert.equal(normalize(await api('/file/detail/rec-1','token'),'rec-1').transcript,'Speaker: Hello');
  api=createApi({version:'v4',workspace:'w1',approvedHosts:new Set(['cdn.example.com']),approveHost:async()=>false,request:async()=>({status:0,data:{meta:{file_id:'rec-1'},objects:[{object_type:'POLISHED_TRANSCRIPT'},{object_type:'TRANSCRIPT',content_url:'https://cdn.example.com/t'},{object_type:'SUMMARY',content_url:'https://cdn.example.com/s'}]}}),fetchContent:async u=>u.endsWith('/t')?[{content:'Raw'}]:'Summary'});
  assert.equal(normalize(await api('/file/detail/rec-1','token'),'rec-1').transcript,'Speaker: Raw');
});
test('v3 offset pages all records and rejects repeated pages',async()=>{
  let calls=0;
  const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>false,request:async p=>{calls++;return p.includes('skip=0&')?Array.from({length:100},(_,i)=>({id:'r'+i})):[{id:'last'}];}});
  assert.equal((await api('/file/simple/web','token')).length,101);assert.equal(calls,2);
  const looping=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>false,request:async()=>Array.from({length:100},(_,i)=>({id:'r'+i}))});
  await assert.rejects(looping('/file/simple/web','token'),/invalid-pagination/);
});
test('cancel during approval cannot restore cleared host consent; denial not asked repeatedly',async()=>{
  const hosts=new Set(),c=new AbortController();
  const base={version:'v3',approvedHosts:hosts,request:async()=>({id:'rec-1',content_list:[{data_type:'transaction',data_link:'https://cdn.example.com/t'}]})};
  const api=createApi({...base,approveHost:async()=>{c.abort();hosts.clear();return true;}});
  await assert.rejects(api('/file/detail/rec-1','token',c.signal),/cancelled/);assert.equal(hosts.size,0);
  let prompts=0;const denied=createApi({...base,approveHost:async()=>{prompts++;return false;}});
  await assert.rejects(denied('/file/detail/rec-1','token'));
  await assert.rejects(denied('/file/detail/rec-1','token'));assert.equal(prompts,1);
});

test('regional origin is forwarded for every v3 list and detail request', async () => {
 const calls=[];const api=createApi({version:'v3',origin:'https://api-apne1.plaud.ai',approvedHosts:new Set(),approveHost:async()=>false,request:async(...args)=>{calls.push(args);return args[0].startsWith('/file/simple/web')?[]:{id:'rec-1',summary:'summary',transcript_text:'transcript'};}});
 await api('/file/simple/web','test-token');await api('/file/detail/rec-1','test-token');assert.equal(calls.length,2);for(const call of calls)assert.equal(call[4],'https://api-apne1.plaud.ai');
 assert.throws(()=>createApi({version:'v3',origin:'https://evil.test'}),e=>e.code==='INVALID_ORIGIN');
});

test('JSON routing status -302 never forwards credentials or follows suggested origin',async()=>{
 for(const version of ['v3','v4']){let requests=0;const api=createApi({version,workspace:'workspace-1',origin:'https://api-apne1.plaud.ai',approvedHosts:new Set(),approveHost:async()=>false,request:async()=>{requests++;return {status:-302,domain:'https://evil.test',data:{domain:'https://api.plaud.ai'}};}});await assert.rejects(api('/file/simple/web','test-token'),e=>['api-rejected-response','unsupported-api-response'].includes(e.code));assert.equal(requests,1);}
});
test('polish preference and unfinished-polish fallback retain exact host approval',async()=>{
 for(const ready of [true,false]){
  const fetched=[],prompts=[];const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async h=>{prompts.push(h);return true;},request:async()=>({data:{id:'a',summary:'Synthetic summary',content_list:[{data_type:'transaction',task_status:1,data_link:'https://cdn.example.com/raw'},{data_type:'transaction_polish',task_status:ready?1:0,data_link:'https://cdn.example.com/polish'}]}}),fetchContent:async url=>{fetched.push(url);return [{content:'Synthetic transcript'}];}});
  normalize(await api('/file/detail/a','synthetic-token'),'a');assert.deepEqual(fetched,['https://cdn.example.com/'+(ready?'polish':'raw')]);assert.deepEqual(prompts,['cdn.example.com']);
 }
});
test('malformed structured summaries reject safely rather than import JSON envelopes',async()=>{
 for(const data_content of ['{bad json',JSON.stringify({unexpected:'Synthetic content'})]){
  const api=createApi({version:'v3',approvedHosts:new Set(),approveHost:async()=>true,request:async()=>({data:{id:'a',transcript_text:'Synthetic transcript',pre_download_content_list:[{data_id:'auto_sum:test',data_content}]}})});
  await assert.rejects(api('/file/detail/a','synthetic-token'),e=>e.code==='unsupported-summary-response');
 }
});
