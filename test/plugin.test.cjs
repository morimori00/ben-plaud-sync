'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('built plugin onload performs no network or credential persistence; unload cancels and clears',async()=>{
  let network=0,saves=0;
  class Plugin {constructor(){this.app={vault:{}};}async loadData(){return {token:'legacy-not-read',schema:1,completed:{}};}async saveData(data){saves++;assert.ok(!JSON.stringify(data).includes('token'));}addCommand(){}addSettingTab(){}}
  const context={module:{exports:{}},require:n=> n==='obsidian'?{Plugin,PluginSettingTab:class{},Setting:class{},Notice:class{},Modal:class{}}:n==='node:https'?{request(){network++;throw Error('network forbidden');}}:require(n),Buffer,URL,URLSearchParams,AbortController,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),context);
  const p=new context.module.exports();await p.onload();assert.equal(network,0);assert.equal(saves,0);assert.equal(p.sessionToken,'');
  p.sessionToken='private-token';p.approvedHosts.add('cdn.example.com');p.controller=new AbortController();p.onunload();
  assert.equal(p.sessionToken,'');assert.equal(p.approvedHosts.size,0);assert.equal(p.controller.signal.aborted,true);assert.equal(network,0);
});

test('origin selection is session only, clears credentials and approvals, and cannot change during sync',async()=>{
 let tab,saves=0,network=0;const dropdowns=[];let displayedOrigin;
 class Plugin{constructor(){this.app={vault:{}};}async loadData(){return {apiOrigin:'https://evil.test'};}async saveData(){saves++;}addCommand(){}addSettingTab(t){tab=t;}}
 class PluginSettingTab{constructor(){this.containerEl={empty(){},createEl(){}};}}
 class Setting{setName(n){this.name=n;return this;}setDesc(){return this;}addDropdown(cb){const d={addOption(){return this;},setValue(value){if(this.name==='API origin (session only)')displayedOrigin=value;return this;},onChange(fn){dropdowns.push({name:this.name,fn});return this;},name:this.name};cb(d);return this;}addText(){return this;}addButton(){return this;}}
 const context={module:{exports:{}},require:n=>n==='obsidian'?{Plugin,PluginSettingTab,Setting,Notice:class{},Modal:class{}}:n==='node:https'?{request(){network++;throw Error('network forbidden');}}:require(n),Buffer,URL,URLSearchParams,AbortController,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),context);
 const p=new context.module.exports();await p.onload();assert.equal(p.apiOrigin,'https://api.plaud.ai');tab.display();
 const change=dropdowns.find(d=>d.name==='API origin (session only)').fn;
 p.sessionToken='private-token';p.approvedHosts.add('cdn.example.com');p.engine.running=true;
 change('https://api-apne1.plaud.ai');assert.equal(p.apiOrigin,'https://api.plaud.ai');assert.equal(p.sessionToken,'private-token');assert.equal(displayedOrigin,p.apiOrigin);
 p.engine.running=false;change('https://evil.test');assert.equal(p.apiOrigin,'https://api.plaud.ai');assert.equal(p.sessionToken,'private-token');
 change('https://api-apne1.plaud.ai');assert.equal(p.apiOrigin,'https://api-apne1.plaud.ai');assert.equal(p.sessionToken,'');assert.equal(p.approvedHosts.size,0);assert.equal(saves,0);assert.equal(network,0);
});
test('diagnostic user action guards block network when token absent, sync active, wrong version or origin',async()=>{
 let network=0;
 class Plugin{constructor(){this.app={vault:{}};}async loadData(){return null;}addCommand(){}addSettingTab(){}}
 const context={module:{exports:{}},require:n=>n==='obsidian'?{Plugin,PluginSettingTab:class{},Setting:class{},Notice:class{},Modal:class{}}:n==='node:https'?{request(){network++;throw Error('network forbidden');}}:require(n),Buffer,URL,URLSearchParams,AbortController,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),context);const p=new context.module.exports();await p.onload();await p.diagnose();p.sessionToken='synthetic-token';await p.diagnose();p.apiOrigin='https://api-apne1.plaud.ai';p.version='v4';await p.diagnose();p.version='v3';p.engine.running=true;await p.diagnose();p.engine.running=false;p.diagnosticRunning=true;await p.diagnose();assert.equal(network,0);assert.equal(p.lastDiagnostic,null);
});
