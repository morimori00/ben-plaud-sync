'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {scopedPath,createScopeGuard}=require('../src/scope.cjs');
const {loadState,snapshot,normalize,writeSnapshot,SyncEngine}=require('../src/core.cjs');
const note='Plaud/'+ 'a'.repeat(64)+'-'+ 'b'.repeat(64)+'.md';
test('only exact Plaud folder and generated snapshot filenames are accepted',()=>{
 assert.equal(scopedPath('Plaud'),'Plaud');assert.equal(scopedPath(note),note);
 for(const p of ['../Plaud','/Plaud','Plaud/../secret','PlaudSibling/x','Plaud2','Plaud/','Plaud/nested/x','Plaud\\x','Plaud/.obsidian','plaud','Plaud//x','Plaud/'+ 'a'.repeat(64)+'-'+ 'b'.repeat(64)+'.md/../x'])assert.throws(()=>scopedPath(p));
 const d={schema:1,completed:{}};Object.defineProperty(d,'folder',{get(){throw Error('legacy destination accessed');}});assert.equal(loadState(d).folder,'Plaud');
 assert.throws(()=>snapshot(normalize({id:'a',summary:'s',transcript_text:'t'},'a'),'Other'));
});
test('filesystem guard allows missing destinations, rejects symlink and hardlink escapes and unavailable base',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ben-scope-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'ben-outside-'));
 try{
  const guard=createScopeGuard({adapter:{getBasePath:()=>root}});await guard('Plaud');await guard(note);
  await fs.symlink(outside,path.join(root,'Plaud'));await assert.rejects(guard(note),/vault-scope-blocked/);await fs.unlink(path.join(root,'Plaud'));
  await fs.mkdir(path.join(root,'Plaud'));await guard(note);
  await fs.writeFile(path.join(outside,'secret'),'test only');await fs.symlink(path.join(outside,'secret'),path.join(root,note));await assert.rejects(guard(note));await fs.unlink(path.join(root,note));
  await fs.link(path.join(outside,'secret'),path.join(root,note));await assert.rejects(guard(note));await fs.unlink(path.join(root,note));
  await fs.writeFile(path.join(root,note),'note');await guard(note);
  await assert.rejects(createScopeGuard({})('Plaud'));await assert.rejects(createScopeGuard({adapter:{getBasePath:()=>'.'}})('Plaud'));
 }finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
test('note IO rejects mismatched TFile paths and failed guard before reading or creating',async()=>{
 let reads=0,creates=0,lookups=0;
 const vault={getAbstractFileByPath(){lookups++;return {path:'Other/secret.md'};},read(){reads++;},create(){creates++;}};
 const body={path:note,body:'test'};
 await assert.rejects(writeSnapshot(vault,body,undefined,async()=>{}),/vault-scope-blocked/);assert.equal(reads,0);assert.equal(creates,0);
 lookups=0;await assert.rejects(writeSnapshot(vault,body,undefined,async()=>{throw Error('guard unavailable');}));assert.equal(lookups,0);
 for(const target of ['Other/note.md','PlaudSibling/note.md','Plaud/../secret'])await assert.rejects(writeSnapshot(vault,{path:target,body:'test'},undefined,async()=>{}));assert.equal(reads,0);
});
test('guard is rechecked immediately before every note read/create and failures never overwrite',async()=>{
 const calls=[];let file;const vault={getAbstractFileByPath(p){calls.push('lookup');return file;},async create(p,body){calls.push('create');file={path:p,body};},async read(f){calls.push('read');return f.body;}};
 const guard=async p=>{assert.equal(p,note);calls.push('guard');};
 assert.equal(await writeSnapshot(vault,{path:note,body:'test'},undefined,guard),'created');
 for(let i=0;i<calls.length;i++)if(['lookup','read','create'].includes(calls[i]))assert.equal(calls[i-1],'guard');
 file.body='personal edit';await assert.rejects(writeSnapshot(vault,{path:note,body:'test'},undefined,guard),/existing-note-conflict/);assert.equal(file.body,'personal edit');
});
test('runtime state pointing outside Plaud stops before API or Vault IO',async()=>{
 let api=0,io=0;const engine=new SyncEngine({vault:{getAbstractFileByPath(){io++;}},state:{folder:'Other'},api:async()=>{api++;},save:async()=>{}});
 await assert.rejects(engine.run('test-token'),/invalid-folder/);assert.equal(api,0);assert.equal(io,0);
});
test('mutated TFile path during asynchronous guard is rejected immediately before read',async()=>{
 let reads=0,checks=0;const file={path:note};const vault={getAbstractFileByPath:()=>file,read(){reads++;}};
 await assert.rejects(writeSnapshot(vault,{path:note,body:'test'},undefined,async()=>{if(++checks===3)file.path='Other/secret';}),/vault-scope-blocked/);assert.equal(reads,0);
});
test('folder lookup/create boundaries each check scope and guard failure blocks create',async()=>{
 const calls=[];let folder;const vault={getAbstractFileByPath(p){assert.equal(p,'Plaud');calls.push('lookup');return folder;},async createFolder(p){assert.equal(p,'Plaud');calls.push('createFolder');folder={path:p,children:[]};}};
 const engine=new SyncEngine({vault,state:loadState(null),api:async()=>[],save:async()=>{},guard:async p=>{assert.equal(p,'Plaud');calls.push('guard');}});
 await engine.run('test-token');for(let i=0;i<calls.length;i++)if(['lookup','createFolder'].includes(calls[i]))assert.equal(calls[i-1],'guard');
 let created=0;const blocked=new SyncEngine({vault:{getAbstractFileByPath:()=>null,createFolder:async()=>created++},state:loadState(null),api:async()=>[],save:async()=>{},guard:async()=>{throw Error('containment unavailable');}});await assert.rejects(blocked.run('test-token'));assert.equal(created,0);
});
