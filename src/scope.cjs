'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const FOLDER = 'Plaud';
function scopeError() { const error = new Error('vault-scope-blocked'); error.code = 'vault-scope-blocked'; return error; }
function scopedPath(value) {
  if (typeof value !== 'string' || (value !== FOLDER && !/^Plaud\/[^/\\\x00-\x1f\x7f:<>"|?*]+\.md$/u.test(value) || value !== FOLDER && (Buffer.byteLength(value.slice(6)) > 240 || /(?:^Plaud\/\.|[ .]\.md$)/.test(value)))) throw scopeError();
  return value;
}
// Metadata checks only: never enumerate or read unrelated note bodies.
// This is a code policy, not an OS sandbox; concurrent filesystem replacement
// between checks and Obsidian IO cannot be made atomic through Vault APIs.
function createScopeGuard(vault) {
  return async value => {
    scopedPath(value);
    try {
      const base = vault.adapter?.getBasePath?.();
      if (typeof base !== 'string' || !path.isAbsolute(base)) throw scopeError();
      const root = await fs.realpath(base);
      if (!(await fs.lstat(root)).isDirectory()) throw scopeError();
      let current = root;
      const parts = value.split('/');
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let metadata;
        try { metadata = await fs.lstat(current); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink !== 1)) throw scopeError();
        if (i === 0 ? !metadata.isDirectory() : !metadata.isFile()) throw scopeError();
        const resolved = await fs.realpath(current);
        if (resolved !== current || !resolved.startsWith(root + path.sep)) throw scopeError();
      }
    } catch (_) { throw scopeError(); }
  };
}
module.exports = { FOLDER, scopedPath, createScopeGuard };
