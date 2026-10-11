# Validation

70 offline tests use synthetic records and bytes only. Coverage includes exact origins/hosts, credential confinement, TLS/DNS boundaries, redirects, MIME, pagination, pending content, matching IDs, cancellation, response caps, gzip input/output caps, corrupt gzip, UTF-8, decompression deadline disposal, fixed-folder containment, symlink/hardlink rejection, inert fences, schema diagnostics, readable Japanese/emoji names, JST semantics, collisions, repeated imports, changed snapshots, edited notes and interrupted migration retry.

`npm run check` runs deterministic build and tests. Building twice must produce identical main.js bytes. `scripts/package.py` verifies ZIP integrity and all included checksums. No external npm build dependencies.

One local Obsidian desktop legacy-v3 setup successfully imported text and migrated readable filenames with unchanged content hashes. This is limited integration evidence, not a cross-account/version/region compatibility guarantee; v4 remains experimental. No actual recordings, session data, local configuration, migration mapping, screenshots or user API fixtures are distributed.
