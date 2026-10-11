'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,snapshot,loadState,writeNamedSnapshot,readablePath,recordingTime,hash}=require('../src/core.cjs');
const {scopedPath}=require('../src/scope.cjs');
const guard=async p=>scopedPath(p);
function vault(){const files=new Map();return {files,getAbstractFileByPath:p=>files.get(p),async read(f){return f.body;},async create(p,body){assert.ok(!files.has(p));const f={path:p,body};files.set(p,f);return f;},async rename(f,p){assert.ok(!files.has(p));files.delete(f.path);f.path=p;files.set(p,f);}};}
const raw=(id='a',title='日本語の会議')=>({id,title,summary:'S',transcript:'T',start_time:Date.UTC(2026,9,11,1,23),zonemins:540});
const note=(r=raw())=>snapshot(normalize(r,r.id),'Plaud');
test('Japanese and emoji names bounded by UTF8 bytes, control and traversal removed',()=>{
 assert.equal(note().path,'Plaud/日本語の会議 - 2026-10-11 1023.md');
 for(const title of ['../x/../../secret','a\\b:c\n\x00<>"|?*','CON','😀日本語'.repeat(200)]){
 const p=readablePath(title,'2026-10-11 1023');assert.equal(scopedPath(p),p);assert.ok(Buffer.byteLength(p.slice(6))<=220);assert.equal(p.split('/').length,2);assert.ok(!/[\\\x00-\x1f]/.test(p));}
 for(const p of ['Plaud/../x.md','Plaud/.hidden.md','Plaud/x/y.md','Plaud/a\\b.md','Plaud/a\x00.md','Plaud/a:.md','Plaud/a .md'])assert.throws(()=>scopedPath(p));
});
test('recording time uses API epoch in JST even for numeric timezone9 and zonemins0; absent date never uses import clock',()=>{
 assert.equal(recordingTime(raw()),'2026-10-11 1023');assert.equal(recordingTime({...raw(),timezone:9,zonemins:0}),'2026-10-11 1023');assert.equal(recordingTime({...raw(),zonemins:undefined,timezone:'America/New_York'}),'2026-10-11 1023');assert.equal(recordingTime({}),null);
});
test('same content hash survives adding timestamp; readable migration preserves exact bytes',async()=>{
 const r=raw();const old={...r};delete old.start_time;delete old.zonemins;
 const n=note(r);assert.equal(n.contentHash,note(old).contentHash);
 const v=vault(),state=loadState(null),f={path:n.legacyPath,body:n.body};v.files.set(f.path,f);
 assert.equal(await writeNamedSnapshot(v,n,state,async()=>{},undefined,guard),'unchanged');assert.equal(v.files.size,1);assert.equal(v.files.get(n.path).body,n.body);
 assert.equal(await writeNamedSnapshot(v,note(r),loadState(state),async()=>{},undefined,guard),'unchanged');assert.equal(v.files.size,1);
});
test('duplicate titles/times and unrelated collision get stable suffix without unrelated reads',async()=>{
 const v=vault(),state=loadState(null);let reads=[];const read=v.read;v.read=async f=>{reads.push(f.path);return read(f);};const n=note();v.files.set(n.path,{path:n.path,body:'unrelated'});
 assert.equal(await writeNamedSnapshot(v,n,state,async()=>{},undefined,guard),'created');assert.ok(n.path.includes('['));assert.ok(!reads.includes(note().path));
 const b=note(raw('b'));await writeNamedSnapshot(v,b,state,async()=>{},undefined,guard);assert.notEqual(n.path,b.path);assert.equal(v.files.size,3);
 await writeNamedSnapshot(v,note(),loadState(state),async()=>{},undefined,guard);assert.equal(v.files.size,3);
});
test('changed snapshots stay separate and edited notes are preserved without duplicate creation',async()=>{
 const v=vault(),state=loadState(null),n=note();await writeNamedSnapshot(v,n,state,async()=>{},undefined,guard);v.files.get(n.path).body+='\nuser edit';
 await assert.rejects(writeNamedSnapshot(v,note(),state,async()=>{},undefined,guard),/existing-note-conflict/);assert.equal(v.files.size,1);
 await writeNamedSnapshot(v,note({...raw(),summary:'Changed'}),state,async()=>{},undefined,guard);assert.equal(v.files.size,2);assert.match(v.files.get(n.path).body,/user edit/);
});
test('edited legacy migration retains bytes and reserves identity even when it reports conflict',async()=>{
 const v=vault(),state=loadState(null),n=note(),body=n.body+'\nedit';v.files.set(n.legacyPath,{path:n.legacyPath,body});
 await assert.rejects(writeNamedSnapshot(v,n,state,async()=>{},undefined,guard),/existing-note-conflict/);assert.equal(v.files.get(n.path).body,body);assert.equal(v.files.size,1);
 await assert.rejects(writeNamedSnapshot(v,note(),loadState(state),async()=>{},undefined,guard),/existing-note-conflict/);assert.equal(v.files.size,1);
});
test('journal-save interruption and interrupted rename recover reserved path on retry',async()=>{
 for(const legacy of [false,true]){
 const v=vault(),state=loadState(null),n=note();if(legacy)v.files.set(n.legacyPath,{path:n.legacyPath,body:n.body});let persisted;
 await assert.rejects(writeNamedSnapshot(v,n,state,async s=>{persisted=JSON.parse(JSON.stringify(s));throw Error('interrupt');},undefined,guard));
 await writeNamedSnapshot(v,note(),loadState(persisted),async()=>{},undefined,guard);assert.equal(v.files.size,1);assert.ok(v.files.has(n.path));
 }
 const v=vault(),state=loadState(null),n=note();v.files.set(n.legacyPath,{path:n.legacyPath,body:n.body});const rename=v.rename;v.rename=async()=>{throw Error('interrupted rename');};await assert.rejects(writeNamedSnapshot(v,n,state,async()=>{},undefined,guard));v.rename=rename;
 await writeNamedSnapshot(v,note(),loadState(state),async()=>{},undefined,guard);assert.equal(v.files.size,1);
});
