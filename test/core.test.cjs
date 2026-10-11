'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { folderPath, recordingId, normalize, snapshot, loadState, SyncEngine, fileList } = require('../src/core.cjs');
function vault() {
  const files = new Map();
  return { files, getAbstractFileByPath:p => files.get(p),
    async createFolder(p) { if(files.has(p)) throw Error(); files.set(p,{path:p,children:[]}); },
    async create(p,body) { if(files.has(p)) throw Error(); const f={path:p,body,stat:{size:Buffer.byteLength(body)}}; files.set(p,f); return f; },
    async read(f) {return f.body;} };
}
const detail = { id:'rec-1', title:'Meeting', summary:'Summary', transcript_text:'Transcript' };
test('folder and ID traversal, config paths and Windows devices rejected', () => {
  for(const path of ['../escape','/abs','.obsidian','a/../b','a\\b','a//b','a/','CON','NUL','a:','a\n','a.']) assert.throws(()=>folderPath(path));
  for(const id of ['../x','a/b','a?b','a\n','__proto__.x','']) assert.throws(()=>recordingId(id));
  assert.equal(folderPath('Plaud'),'Plaud');
});
test('token migration never reads legacy token properties; only whitelist persists', () => {
  const data={schema:1,folder:'Plaud',completed:{}};
  Object.defineProperty(data,'token',{get(){throw Error('legacy secret read');}});
  assert.deepEqual(Object.keys(loadState(data)),['schema','folder','completed','snapshots']);
});
test('untrusted YAML, Markdown, HTML and fences are inert within unbroken text fence', () => {
  const record=normalize({...detail,title:'---\n![[secret]]',summary:'```\n<img src="https://evil.test">\n```\n![](https://evil.test)',transcript_text:'```dataviewjs\napp.vault.delete(x)\n```'},'rec-1');
  const note=snapshot(record,'Plaud');
  assert.match(note.body,/````text/); assert.ok(!note.path.includes('evil'));
  assert.ok(!note.body.split('\n---\n')[0].includes('secret'));
});
test('incomplete and content-linked records remain incomplete; mismatched IDs rejected', () => {
  assert.throws(()=>normalize({id:'rec-1'},'rec-1'),/content-not-ready/);
  assert.throws(()=>normalize({id:'rec-1',content_list:[{url:'https://evil.test'}]},'rec-1'),/external-content-blocked/);
  assert.throws(()=>normalize(detail,'different'),/mismatched/);
});
test('full reconciliation retries late text, skips duplicates and creates changed snapshots', async () => {
  const v=vault(), state=loadState(null); let ready=false, changed=false, saves=0;
  const engine=new SyncEngine({guard:async p=>require('../src/scope.cjs').scopedPath(p),vault:v,state,save:async()=>{saves++;},api:async p=> p.endsWith('/web')?[{id:'rec-1',start_time:1},{id:'rec-1'}]:ready?{...detail,summary:changed?'New':'Summary'}:{id:'rec-1'}});
  assert.equal((await engine.run('token')).pending,1); assert.equal(saves,0);
  ready=true; assert.equal((await engine.run('token')).created,1);
  assert.equal((await engine.run('token')).unchanged,1);
  changed=true; assert.equal((await engine.run('token')).created,1);
  assert.equal([...v.files.values()].filter(x=>!x.children).length,2);
});
test('edited and unrelated colliding notes never overwritten', async () => {
  const v=vault(), state=loadState(null), note=snapshot(normalize(detail,'rec-1'),state.folder);
  const engine=new SyncEngine({guard:async p=>require('../src/scope.cjs').scopedPath(p),vault:v,state,save:async()=>{},api:async p=>p.endsWith('/web')?[detail]:detail});
  await engine.run('token'); v.files.get(note.path).body+='\nMy personal edit';
  assert.equal((await engine.run('token')).conflicts,1);
  assert.match(v.files.get(note.path).body,/My personal edit/);
});
test('folder collisions fail without creating files', async () => {
  const v=vault(); v.files.set('Plaud',{body:'unrelated',path:'Plaud'});
  const engine=new SyncEngine({guard:async p=>require('../src/scope.cjs').scopedPath(p),vault:v,state:loadState(null),save:async()=>{},api:async()=>[detail]});
  await assert.rejects(engine.run('token'),/folder-collision/); assert.equal(v.files.size,1);
});
test('concurrent sync rejected; abort prevents further writes', async () => {
  const v=vault(); let resolve; const pending=new Promise(r=>{resolve=r;});
  const engine=new SyncEngine({guard:async p=>require('../src/scope.cjs').scopedPath(p),vault:v,state:loadState(null),save:async()=>{},api:async()=>pending});
  const c=new AbortController(), run=engine.run('token',c.signal);
  await assert.rejects(engine.run('token'),/sync-already-running/);
  c.abort(); resolve([detail]); await assert.rejects(run,/cancelled/); assert.equal(v.files.size,0);
});
test('malformed list/pagination/limits cannot look successful',()=>{
  assert.throws(()=>fileList({data:[],has_more:true}),/pagination/);
  assert.throws(()=>fileList({data:[],status:500,msg:'secret-token'}),/api-rejected/);
  assert.throws(()=>fileList([{id:'a',file_id:'b'}]),/conflicting/);
});
test('malformed transcript segments never silently disappear',()=>{
  assert.throws(()=>normalize({id:'rec-1',summary:'S',transcript:[{content:'valid'},null]},'rec-1'),/unsupported-transcript/);
  assert.throws(()=>normalize({id:'rec-1',summary:'S',transcript:[{content:'valid'},{unknown:'missing'}]},'rec-1'),/unsupported-transcript/);
});
