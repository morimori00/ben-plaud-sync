'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createApi}=require('../src/api.cjs');
const {fileList,SyncEngine,loadState}=require('../src/core.cjs');
const {scopedPath}=require('../src/scope.cjs');
const rows=Array.from({length:8},(_,i)=>({id:(i+1).toString(16).padStart(32,'0'),filename:'Synthetic recording',keywords:[],filesize:100,filetype:'opus',fullname:'synthetic',file_md5:'0'.repeat(32),ori_ready:false,version:1,version_ms:1,edit_time:1,edit_from:'web',start_time:1000,end_time:2000,duration:1000,timezone:'UTC',zonemins:0,scene:1,filetag_id_list:[],serial_number:'SYNTHETIC',is_trans:i!==2,is_summary:i!==2,is_markmemo:false,wait_pull:0,contributor:null,contributed_at:null,is_trash:i<2}));
const fixture={status:0,msg:'success',request_id:'',data_file_total:8,data_file_list:rows,next_cursor:null,has_more:null,total_count:null};
test('supplied list schema is accepted by parser; trash removed and pending retained',async()=>{
 assert.equal(fileList(fixture).length,6);
 const calls=[];const api=createApi({version:'v3',origin:'https://api-apne1.plaud.ai',approvedHosts:new Set(),approveHost:async()=>false,request:async(...args)=>{calls.push(args);return fixture;}});
 const list=await api('/file/simple/web','synthetic-token');assert.equal(list.length,8);assert.equal(fileList(list).length,6);assert.equal(calls.length,1);assert.equal(calls[0][0],'/file/simple/web?skip=0&limit=100');assert.equal(calls[0][4],'https://api-apne1.plaud.ai');
});
test('same list with supported synthetic detail responses yields five notes and one pending',async()=>{
 const calls=[],files=new Map();const vault={getAbstractFileByPath:p=>files.get(p),async createFolder(p){files.set(p,{path:p,children:[]});},async create(p,body){const f={path:p,body};files.set(p,f);return f;},async read(f){return f.body;}};
 const api=createApi({version:'v3',origin:'https://api-apne1.plaud.ai',approvedHosts:new Set(),approveHost:async()=>false,request:async(p)=>{calls.push(p);if(p.startsWith('/file/simple/web'))return fixture;const id=p.slice('/file/detail/'.length);return {status:0,data:{file_id:id,...(id===rows[2].id?{}:{summary:'Synthetic summary',transcript_text:'Synthetic transcript'})}};}});
 const engine=new SyncEngine({vault,state:loadState(null),save:async()=>{},api,guard:async p=>scopedPath(p)});
 const result=await engine.run('synthetic-token');assert.equal(result.created,5);assert.equal(result.pending,1);assert.equal(result.failed,0);assert.equal(calls.filter(p=>p.startsWith('/file/detail/')).length,6);assert.equal([...files.values()].filter(f=>!f.children).length,5);
});
