# Ben Plaud Sync

Manual PLAUD transcript and summary imports for Obsidian desktop. **Preview 0.1.4**, unofficial and not endorsed by PLAUD or Obsidian. [日本語](README.ja.md)

## Install

Back up your Vault and test in a separate Vault first. Disable other PLAUD import plugins to avoid their independent background behavior. Copy `main.js`, `manifest.json`, and the license files into `<Vault>/.obsidian/plugins/ben-plaud-sync/`, then enable Ben Plaud Sync in Community plugins. This repository is not an Obsidian marketplace listing.

Choose the exact API origin supported by your account: `https://api.plaud.ai` (default) or `https://api-apne1.plaud.ai`. Legacy v3 is the default; experimental v4 additionally requires a workspace ID. No origin discovery or credential forwarding occurs.

Enter a token you independently obtained through an authorized PLAUD workflow into the plugin's Session token field and leave that field. There is no built-in login or token acquisition. This project provides no browser credential scraping, bookmarklet, cookie export, or instructions to extract another session's credentials. Never post credentials, authorization headers, signed URLs, or HAR files in issues.

Click **Sync now**. Approve a content host only if you recognize it as your PLAUD storage provider. Approval is for that exact hostname and current session, with no API token sent to it. Check all result counts; pending or failed records mean the import is incomplete. **Forget** cancels active work and clears token/host references. Unload/restart/update also clears them; JavaScript cannot guarantee memory erasure.

## Behavior

- Manual only: no startup/background sync, telemetry, audio download, or PLAUD-side writes.
- Fixed note destination: `Plaud` immediately inside the Vault. Titles use `<Title> - YYYY-MM-DD HHmm.md`, with recording epoch converted consistently to **JST (Asia/Tokyo)**, never import time. Missing epoch is labeled `Recording date unknown`.
- Same content is deduplicated through stable identity/content hashes and a bounded path index. Changed content creates a new immutable snapshot. Collisions receive stable suffixes; existing files are never overwritten.
- Legacy plugin-created hash filenames can be renamed while retaining exact contents. Interrupted migration is journaled; edited content is preserved and reported as a conflict.
- Transcript/summary source text is fenced as untrusted text, including remote Markdown/HTML. Both transcript and summary must be available.
- Tokens live only in plugin session memory, not configuration, local storage, Secret Storage, or logs. Other plugins/process compromise remain a risk.
- `Inspect response structure` performs at most one list and one detail request on the regional v3 origin, only on user click. It shows allowlisted types/counts, not raw responses. **Copy diagnostic result** writes only that sanitized result when clicked.

## Limits and validation

Each request has a 20-second deadline and 4 MiB wire limit; gzip content also has a 4 MiB expanded limit. A manual run is limited to 10 minutes and 2,000 records. Exact-host consent, strict TLS, public IPv4 DNS pinning, no redirects, and narrow text/JSON MIME are enforced. Gzip Markdown/JSON is supported; arbitrary archives and compressed API JSON are refused. IPv6-only/proxy-dependent environments may not work.

The scope checks constrain this code's note operations; they are **not an OS sandbox** and do not revoke Obsidian or other plugins' Vault/process access. Concurrent filesystem replacement between metadata checks and Vault API calls cannot be made atomic. See [SECURITY.md](SECURITY.md).

70 synthetic offline tests pass. Desktop legacy-v3 imports and readable-name migration have been exercised in one local setup. This does not establish compatibility across accounts, regions, Obsidian/Electron versions, or v4. The manifest minimum version is a declared requirement, not a tested compatibility matrix. Unofficial APIs may change.

## Develop

Requires Node.js 18+; no downloaded npm build/runtime dependencies.

```sh
npm run check
python3 scripts/package.py
```

The deterministic build generates `main.js`; the package script creates a ZIP one directory above the project, with source, runtime files, licenses, and verified SHA256 checksums. Tests use synthetic records only. Do not commit Vault content, plugin data.json, credentials, logs, screenshots, or user API captures.

## Attribution

Derived field mapping and project lineage: [Leonard Sellem, plaud-sync-for-obsidian 1.0.1](https://github.com/leonardsellem/plaud-sync-for-obsidian), MIT. Protocol interpretation adapted from [ckelsoe, obsidian-plaud-importer 0.43.0](https://github.com/ckelsoe/obsidian-plaud-importer), MIT, reviewed at `cba42590c24fecfed5010576a3a98fe8974704db`. Original MIT notices are retained in [LICENSE](LICENSE) and [LICENSE-ckelsoe](LICENSE-ckelsoe).
