# Security model

This preview constrains its own operations; it is not an OS sandbox and offers no blanket security guarantee. Obsidian, Electron/Node, the OS and TLS trust store are trusted. Other plugins can access Vault files or process memory.

API credentials are session-only and sent only to internally constructed allowed routes on the exact selected API origin (`https://api.plaud.ai` or `https://api-apne1.plaud.ai`). Content requests never carry bearer credentials, cookies or workspace headers, and require explicit exact-host session approval. Signed URLs are capability secrets and are not logged or persisted. DNS pins validated public IPv4, strict TLS and redirect rejection remain active.

Wire and expanded gzip output limits are independently 4 MiB, with a 20-second deadline including decompression and cancellation disposal. Narrow text/JSON MIME and gzip magic validation reject mismatches and arbitrary archives. API response compression remains refused. These bounds do not eliminate all resource exhaustion risk.

Note IO is limited to safe single-level Markdown names in Plaud, with filesystem containment, symlink, hardlink and TFile.path checks before operations. Own plugin code/configuration in .obsidian is an explicit exception. Path replacement between checks and Vault calls, other plugins and external sync services remain concurrency risks.

Snapshot identity/content hashes remain independent of readable filenames. A bounded whitelisted index journals destination paths before create/rename. Existing imported note contents are never overwritten or deleted; identity-checked legacy renames preserve bytes. Collisions and edits are reported, not merged. Hashes are not signatures against local malicious tampering. Notes remain plaintext.

Imported source text is untrusted, fenced data; it must not be treated as instructions for tools or AI. Rendering assumptions concern standard Markdown, not arbitrary third-party postprocessors. Diagnostic output is allowlisted field types/counts and safe statuses, held in session memory; clipboard output occurs only on explicit user click. No raw response logs are retained.

No startup/background sync, telemetry or remote writes. Unofficial API schemas, all-account compatibility, v4, proxy and IPv6 support are not established. Report issues using safe error codes or sanitized diagnostic output only; never include credentials, signed URLs, recordings or HAR files.
