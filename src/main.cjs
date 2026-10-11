'use strict';
const { Plugin, PluginSettingTab, Setting, Notice, Modal } = require('obsidian');
const { SyncEngine, loadState, safeCode } = require('./core.cjs');
const { API_ORIGINS } = require('./transport.cjs');
const { diagnose } = require('./diagnostic.cjs');
const { createApi } = require('./api.cjs');
class BenPlaudSync extends Plugin {
  async onload() {
    this.sessionToken = '';
    this.diagnosticRunning = false; this.lastDiagnostic = null;
    this.approvedHosts = new Set();
    this.apiOrigin = API_ORIGINS[0];
    this.version = 'v3'; this.workspace = '';
    this.controller = null;
    this.unloaded = false;
    this.state = loadState(await this.loadData());
    this.engine = new SyncEngine({ vault: this.app.vault, api: null, state: this.state, save: data => this.saveData(data) });
    this.addCommand({ id: 'manual-sync', name: 'Sync PLAUD text now', callback: () => this.sync() });
    this.addCommand({ id: 'cancel-sync', name: 'Cancel sync and forget token', callback: () => this.forget() });
    this.addSettingTab(new BenSettings(this.app, this));
    // Deliberately no startup request, timer, deep-link, token storage, or automatic sync.
  }
  forget() { this.controller?.abort(); this.sessionToken = ''; this.approvedHosts?.clear(); }
  onunload() { this.unloaded = true; this.forget(); }
  async diagnose() {
    if (this.unloaded || this.engine.running || this.diagnosticRunning) return;
    if (!this.sessionToken) { new Notice('Enter your session token yourself before diagnostics'); return; }
    if (this.apiOrigin !== 'https://api-apne1.plaud.ai' || this.version !== 'v3') { new Notice('Schema diagnostic requires api-apne1.plaud.ai and Legacy v3'); return; }
    const controller = new AbortController(); this.controller = controller;
    this.diagnosticRunning = true;
    try { this.lastDiagnostic = await diagnose({token:this.sessionToken,origin:this.apiOrigin,signal:controller.signal}); }
    finally { this.diagnosticRunning = false; if (this.controller === controller) this.controller = null; }
  }

  async sync() {
    if (this.unloaded) return;
    if (this.engine.running || this.diagnosticRunning) { new Notice('Ben Plaud Sync: a sync is already running'); return; }
    if (!this.sessionToken) { new Notice('Ben Plaud Sync: enter your session token in plugin settings first'); return; }
    const controller = new AbortController(); this.controller = controller;
    const deadline = setTimeout(()=>controller.abort(), 10 * 60 * 1000);
    new Notice('Ben Plaud Sync: manual sync started. Cancel from the command palette.');
    try {
      this.engine.api = createApi({origin:this.apiOrigin, version:this.version, workspace:this.workspace, approvedHosts:this.approvedHosts, approveHost:(host, signal)=>approveHost(this.app, host, signal)});
      const r = await this.engine.run(this.sessionToken, controller.signal);
      if (!this.unloaded) new Notice(`Ben Plaud Sync: ${r.created} new snapshots; ${r.unchanged} unchanged; ${r.pending} not ready; ${r.blocked} blocked external content; ${r.conflicts} local conflicts; ${r.failed} failed. Reasons: ${Object.keys(r.reasons).join(', ') || 'none'}. Original PLAUD recordings are unchanged.`, 15000);
    } catch (error) {
      // Never display or log arbitrary network/API error messages, response bodies, IDs, URLs, or credentials.
      if (!this.unloaded) new Notice(`Ben Plaud Sync: ${safeCode(error)}. Check connection and legacy API compatibility; no completion claimed.`, 10000);
    } finally { clearTimeout(deadline); if (this.controller === controller) this.controller = null; }
  }
}
class BenSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el, plugin: p } = this; el.empty();
    el.createEl('h2', { text: 'Ben Plaud Sync · private preview' });
    el.createEl('p', { text: 'Desktop only. Manual text imports with legacy-v3 or experimental v4 adapters. Live compatibility is unverified. API credentials go only to the exact API origin selected below: api.plaud.ai or api-apne1.plaud.ai. Content downloads require your approval of each exact hostname, for this session only, without the API token.' });
    el.createEl('p', { text: 'The token stays in this plugin session’s memory. It is not saved to data.json, local storage, or Secret Storage. Other plugins or a compromised computer can still access process memory. Restart, unload, or “Forget” clears this reference; JavaScript cannot guarantee memory erasure.' });
    new Setting(el).setName('API origin (session only)').setDesc('Choose the exact origin of your successful PLAUD recording-list request. Changing origin clears the token and content approvals; enter the token again yourself.').addDropdown(d=>{ for (const origin of API_ORIGINS) d.addOption(origin, origin); d.setValue(p.apiOrigin).onChange(value=>{ if((p.engine.running || p.diagnosticRunning) || !API_ORIGINS.includes(value) || value === p.apiOrigin) { d.setValue(p.apiOrigin); return; } p.forget(); p.apiOrigin=value; new Notice('API origin changed; token reference and content approvals cleared'); }); });
    new Setting(el).setName('API version (session only)').setDesc('v4 is experimental. It also needs your workspace ID. Choose the version used by your account.').addDropdown(d=>d.addOption('v3','Legacy v3').addOption('v4','Experimental v4').setValue(p.version).onChange(value=>{ if((p.engine.running || p.diagnosticRunning)) return; p.version=value; p.approvedHosts.clear(); }));
    new Setting(el).setName('v4 workspace ID (session only)').addText(t=>t.setValue(p.workspace).onChange(value=>{ if(!(p.engine.running || p.diagnosticRunning)) { p.workspace=value.trim(); p.approvedHosts.clear(); } }));
    new Setting(el).setName('Session token').setDesc('Use a token you obtained yourself. No deep-link or bookmarklet support. Never share it in chat.').addText(input => {
      input.inputEl.type = 'password'; input.inputEl.autocomplete = 'off'; input.inputEl.spellcheck = false;
      input.setPlaceholder('Paste for this session only');
      // Consume on blur, immediately clear the DOM input. Never pre-fill stored token.
      input.inputEl.addEventListener('change', () => {
        const value = input.getValue().trim().replace(/^Bearer\s+/i, ''); input.setValue('');
        if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(value) || value.length < 8 || value.length > 8192) { new Notice('Token format rejected'); return; }
        if (p.unloaded || (p.engine.running || p.diagnosticRunning)) { new Notice('Wait for sync to finish before changing token'); return; }
        p.approvedHosts.clear(); p.sessionToken = value; new Notice('Token held in memory for this session');
      });
    });
    new Setting(el).setName('Forget token and cancel').addButton(b => b.setButtonText('Forget').onClick(() => { p.forget(); new Notice('Token reference cleared; active sync cancelled'); }));
    new Setting(el).setName('Import folder: Plaud (fixed)').setDesc('All note content reads and creates are limited by code to Plaud. Plugin code/config remain in .obsidian. This does not revoke Obsidian or other plugins’ Vault permissions. Symlinks or unavailable filesystem containment checks block imports.');
    new Setting(el).setName('Schema diagnostic (user click only)').setDesc('Reads at most one list entry and its detail on api-apne1.plaud.ai. Shows allowlisted field types/counts and safe status only. No note writes, content URL downloads, or raw payload storage.').addButton(b=>b.setButtonText('Inspect response structure').onClick(async()=>{ await p.diagnose(); if(!p.unloaded) this.display(); }));
    if (p.lastDiagnostic) {
      el.createEl('pre', {text:JSON.stringify(p.lastDiagnostic,null,2)});
      new Setting(el).setName('Copy safe diagnostic').setDesc('Copies only the displayed sanitized diagnostic. No credential or raw response access.').addButton(b=>b.setButtonText('Copy diagnostic result').onClick(async()=>{
        try { await navigator.clipboard.writeText(JSON.stringify(p.lastDiagnostic,null,2)); new Notice('Safe diagnostic copied'); }
        catch (_) { new Notice('Clipboard unavailable; read the displayed diagnostic'); }
      }));
    }
    new Setting(el).setName('Manual sync').setDesc('Fetches the full recording list and revisits every record, including older updates. Requires both summary and transcript. No audio or binary downloads.').addButton(b => b.setButtonText('Sync now').onClick(() => p.sync()));
    el.createEl('p', { text: 'Before use: back up your vault and test in a separate vault. Disable the original Plaud Sync to avoid its independent background sync. This plugin never reads or deletes legacy saved credentials; revoke old PLAUD sessions separately if needed. Imported code-block text remains untrusted when used as AI context.' });
  }
}
function approveHost(app, host, signal) {
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return; settled=true; signal?.removeEventListener('abort',abort); resolve(value);};
    class HostModal extends Modal {
      onOpen() {
        this.contentEl.createEl('h2',{text:'Approve a content download host?'});
        this.contentEl.createEl('p',{text:host});
        this.contentEl.createEl('p',{text:'PLAUD supplied a transcript or summary URL on this exact host. Ownership has not been independently verified. Approve only if you recognize it as your PLAUD storage provider. The host will see your IP address and its signed download request, but not your API bearer token. Approval lasts until Forget, unload, or restart.'});
        new Setting(this.contentEl).addButton(b=>b.setButtonText('Skip').onClick(()=>{finish(false);this.close();})).addButton(b=>b.setButtonText('Allow this exact host').onClick(()=>{finish(true);this.close();}));
      }
      onClose(){finish(false);this.contentEl.empty();}
    }
    const modal=new HostModal(app); const abort=()=>{finish(false);modal.close();};
    if(signal?.aborted) {finish(false);return;}
    signal?.addEventListener('abort',abort,{once:true}); modal.open();
  });
}
module.exports = BenPlaudSync;
