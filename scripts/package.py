"""Build a deterministic, user-facing archive without any credentials/audit workfiles."""
from pathlib import Path
import hashlib, zipfile
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'ben-plaud-sync-0.1.4-private.zip'
files = {}
for name in ('README.ja.md','SECURITY.md','VALIDATION.md','LICENSE','LICENSE-ckelsoe'):
    files[name] = (ROOT/name).read_bytes()
for name in ('main.js','manifest.json','LICENSE','LICENSE-ckelsoe'):
    files['plugin/ben-plaud-sync/'+name] = (ROOT/name).read_bytes()
for name in ('main.js','manifest.json','package.json','README.ja.md','SECURITY.md','VALIDATION.md','LICENSE','LICENSE-ckelsoe'):
    files['source/'+name] = (ROOT/name).read_bytes()
for folder in ('src','test','scripts'):
    for path in sorted((ROOT/folder).glob('*')):
        if path.is_file(): files['source/'+str(path.relative_to(ROOT))] = path.read_bytes()
files['SHA256SUMS.txt'] = ''.join(hashlib.sha256(data).hexdigest()+'  '+name+'\n' for name,data in sorted(files.items())).encode()
with zipfile.ZipFile(OUT,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for name,data in sorted(files.items()):
        info=zipfile.ZipInfo(name,date_time=(2026,10,11,0,0,0));info.external_attr=0o100644<<16
        info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,data)
with zipfile.ZipFile(OUT) as z:
    assert z.testzip() is None
    assert z.read('plugin/ben-plaud-sync/main.js') == z.read('source/main.js')
    for line in z.read('SHA256SUMS.txt').decode().splitlines():
        digest,name=line.split('  ',1);assert hashlib.sha256(z.read(name)).hexdigest()==digest
print(OUT)
print('SHA256',hashlib.sha256(OUT.read_bytes()).hexdigest())
print('Bytes',OUT.stat().st_size,'Entries',len(files))
