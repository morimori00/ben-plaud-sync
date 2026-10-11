'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTransport, buildApiURL, contentHostname, publicAddress } = require('../src/transport.cjs');
const TOKEN = 'DO_NOT_LEAK_SECRET';
function mock(config = {}) {
  const seen = [];
  let destroyed = false;
  const transport = createTransport({
    createGunzip: config.createGunzip,
    timeoutMs: config.timeoutMs || 1000,
    maxBytes: config.maxBytes || 1024,
    lookup(host, options, done) {
      assert.equal(host, config.host || 'api.plaud.ai');
      assert.equal(options.all, true);
      if (config.dnsHang) return;
      done(config.dnsError || null, config.addresses || [{ address: '8.8.8.8', family: 4 }]);
    },
    request(options, onResponse) {
      seen.push(options);
      const req = new EventEmitter();
      req.destroy = () => { destroyed = true; };
      req.end = () => queueMicrotask(() => options.lookup(options.hostname, { all: !!config.lookupAll }, (error, address, family) => {
        if (error) { req.emit('error', error); return; }
        if (config.lookupAll) assert.deepEqual(address, [{ address: '8.8.8.8', family: 4 }]);
        else { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); }
        if (config.networkError) { req.emit('error', new Error(`secret ${TOKEN} https://evil.test`)); return; }
        if (config.hang) return;
        const res = new EventEmitter();
        res.destroy = () => { destroyed = true; };
        res.statusCode = config.status || 200;
        res.headers = config.headers || { 'content-type': 'application/json' };
        onResponse(res);
        if (config.responseHang) return;
        for (const chunk of config.chunks || ['{"ok":true}']) res.emit('data', Buffer.from(chunk));
        if (config.truncated) res.emit('aborted');
        else res.emit('end');
        res.emit('close');
      }));
      return req;
    }
  });
  return { ...transport, seen, destroyed: () => destroyed };
}
async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.name, 'TransportError');
    assert.equal(error.cause, undefined);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(TOKEN));
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('evil.test'));
    return true;
  });
}
test('only canonical API routes can carry bearer credentials', async () => {
  const m = mock();
  assert.deepEqual(await m.apiJson('/file/simple/web', TOKEN), { ok: true });
  assert.equal(m.seen[0].hostname, 'api.plaud.ai');
  assert.equal(m.seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(m.seen[0].agent, false);
  assert.equal(m.seen[0].rejectUnauthorized, true);
  assert.equal(buildApiURL('/file/detail/abc_123-xyz').href, 'https://api.plaud.ai/file/detail/abc_123-xyz');
  for (const path of ['https://api.plaud.ai/file/simple/web', '//evil.test', '/file/simple/web\n', '/file/detail/a\r', '/file/simple/web?token=x', '/file/detail/..', '/file/detail/a/b', '/file/detail/%2f', '/file/detail/a#x', '/file/simple/web/', '/file/detail/' + 'a'.repeat(129), '/file/detail/a\\b']) {
    await expectCode(m.apiJson(path, TOKEN), 'INVALID_PATH');
  }
  assert.equal(m.seen.length, 1);
});
test('public address policy rejects private and special-use addresses', () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '127.1', '2130706433', '01.2.3.4']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1']) assert.equal(publicAddress(ip), true, ip);
});
test('DNS rejects private results and mixed result sets', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }]]) {
    const m = mock({ addresses });
    await expectCode(m.apiJson('/file/simple/web', TOKEN), 'DNS_BLOCKED');
    assert.equal(m.destroyed(), true);
  }
  await expectCode(mock({ dnsError: new Error(TOKEN) }).apiJson('/file/simple/web', TOKEN), 'DNS_BLOCKED');
});
test('pinned lookup supports Node all-address result interface', async () => {
  assert.deepEqual(await mock({ lookupAll: true }).apiJson('/file/simple/web', TOKEN), { ok: true });
});
test('redirects are rejected without following location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const m = mock({ status, headers: { location: `https://evil.test/${TOKEN}` } });
    await expectCode(m.apiJson('/file/simple/web', TOKEN), 'REDIRECT');
    assert.equal(m.seen.length, 1);
  }
});
test('byte limits apply to declared and streaming response sizes', async () => {
  await expectCode(mock({ maxBytes: 8 }).apiJson('/file/simple/web', TOKEN), 'TOO_LARGE');
  await expectCode(mock({ headers: { 'content-type': 'application/json', 'content-length': '1025' } }).apiJson('/file/simple/web', TOKEN), 'TOO_LARGE');
  await expectCode(mock({ maxBytes: 8, chunks: ['12345', '67890'] }).apiJson('/file/simple/web', TOKEN), 'TOO_LARGE');
});
test('response format and compression restrictions fail closed', async () => {
  for (const type of ['text/html', 'application/octet-stream', 'image/png', '']) {
    await expectCode(mock({ headers: { 'content-type': type } }).apiJson('/file/simple/web', TOKEN), 'CONTENT_TYPE');
  }
  await expectCode(mock({ headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }).apiJson('/file/simple/web', TOKEN), 'CONTENT_ENCODING');
  assert.deepEqual(await mock({ headers: { 'content-type': 'text/plain; charset=utf-8' } }).apiJson('/file/simple/web', TOKEN), { ok: true });
  await expectCode(mock({ chunks: [`<html>${TOKEN}</html>`] }).apiJson('/file/simple/web', TOKEN), 'INVALID_JSON');
});
test('overall deadline includes DNS and stalled response body', async () => {
  for (const scenario of [{ dnsHang: true }, { hang: true }, { responseHang: true }]) {
    const m = mock({ ...scenario, timeoutMs: 10 });
    await expectCode(m.apiJson('/file/simple/web', TOKEN), 'TIMEOUT');
    assert.equal(m.destroyed(), true);
  }
});
test('abort before and during request is supported', async () => {
  const pre = new AbortController(); pre.abort(TOKEN);
  const m = mock();
  await expectCode(m.apiJson('/file/simple/web', TOKEN, pre.signal), 'ABORTED');
  assert.equal(m.seen.length, 0);
  const live = new AbortController();
  const m2 = mock({ hang: true });
  const result = m2.apiJson('/file/simple/web', TOKEN, live.signal);
  live.abort(TOKEN);
  await expectCode(result, 'ABORTED');
  assert.equal(m2.destroyed(), true);
});
test('upstream errors, truncation, status and invalid tokens are sanitized', async () => {
  await expectCode(mock({ networkError: true }).apiJson('/file/simple/web', TOKEN), 'NETWORK');
  await expectCode(mock({ truncated: true }).apiJson('/file/simple/web', TOKEN), 'NETWORK');
  await expectCode(mock({ status: 401 }).apiJson('/file/simple/web', TOKEN), 'HTTP_STATUS');
  const m = mock();
  await expectCode(m.apiJson('/file/simple/web', `${TOKEN}\r\nInjected: yes`), 'INVALID_TOKEN');
  await expectCode(m.apiJson('/file/simple/web', `${TOKEN}\n`), 'INVALID_TOKEN');
  assert.equal(m.seen.length, 0);
});

test('v4 API routes, safe query and workspace headers', async () => {
  const m = mock();
  const path = '/file-app/v4/recordings/all?sort_by=created&sort_order=desc&page_size=100&cursor=abc%3D';
  await m.apiJson(path, TOKEN, undefined, 'workspace-123');
  assert.equal(m.seen[0].path, path);
  assert.equal(m.seen[0].headers['x-scope-id'], 'workspace-123');
  assert.equal(m.seen[0].headers['x-scope-type'], 'workspace');
  assert.equal(m.seen[0].headers['app-platform'], 'web');
  assert.equal(m.seen[0].headers['edit-from'], 'web');
  await m.apiJson('/file-app/v4/files/detail/file-id', TOKEN);
  for (const query of ['page_size=101', 'page_size=0', 'sort_by=token', 'sort_order=asc', 'cursor=a%0A', 'cursor=a&cursor=b', 'other=x']) {
    await expectCode(m.apiJson('/file-app/v4/recordings/all?' + query, TOKEN), 'INVALID_PATH');
  }
  await expectCode(m.apiJson(path, TOKEN, undefined, 'workspace\n'), 'INVALID_WORKSPACE');
});
test('content URL validation and exact hostname approval', async () => {
  const m = mock({ host: 'cdn.example.com' });
  assert.equal(contentHostname('https://cdn.example.com/file?signature=secret'), 'cdn.example.com');
  for (const url of ['http://cdn.example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://user:pass@cdn.example.com/a', 'https://cdn.example.com:8443/a', 'https://cdn.example.com/a#frag', 'https://localhost/a', 'https://cdn.example.com/a\n']) {
    await expectCode(m.contentJson(url, new Set(['cdn.example.com'])), 'INVALID_CONTENT_URL');
  }
  for (const hosts of [undefined, new Set(), new Set(['example.com']), new Set(['*.example.com'])]) {
    await expectCode(m.contentJson('https://cdn.example.com/a', hosts), 'CONTENT_UNAPPROVED');
  }
  assert.equal(m.seen.length, 0);
  assert.deepEqual(await m.contentJson('https://cdn.example.com/a?sig=secret', new Set(['cdn.example.com'])), { ok: true });
  const options = m.seen[0];
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.headers['x-scope-id'], undefined);
  assert.equal(options.headers['app-platform'], undefined);
  assert.equal(options.servername, 'cdn.example.com');
});
test('approved content still rejects redirects and private DNS', async () => {
  const approved = new Set(['cdn.example.com']);
  const url = 'https://cdn.example.com/a?signature=' + TOKEN;
  const redirected = mock({ host: 'cdn.example.com', status: 302, headers: { location: 'https://evil.test' } });
  await expectCode(redirected.contentJson(url, approved), 'REDIRECT');
  assert.equal(redirected.seen.length, 1);
  await expectCode(mock({ host: 'cdn.example.com', addresses: [{ address: '10.0.0.1', family: 4 }] }).contentJson(url, approved), 'DNS_BLOCKED');
});
test('content supports raw summaries and JSON transcript arrays with explicit MIME types', async () => {
  const approved = new Set(['cdn.example.com']);
  for (const type of ['text/plain', 'text/markdown', 'text/vnd.plaud.summary+markdown']) {
    const m = mock({ host: 'cdn.example.com', headers: { 'content-type': type }, chunks: ['# Summary\n\n- Key point'] });
    assert.equal(await m.contentJson('https://cdn.example.com/a', approved), '# Summary\n\n- Key point');
  }
  const m = mock({ host: 'cdn.example.com', headers: { 'content-type': 'text/vnd.plaud.transcript+json' }, chunks: ['[{"content":"Hello","speaker":"Charles"}]'] });
  assert.deepEqual(await m.contentJson('https://cdn.example.com/a', approved), [{ content: 'Hello', speaker: 'Charles' }]);
});

test('v3 offset pagination accepts only bounded skip and limit', async () => {
  const m = mock();
  await m.apiJson('/file/simple/web?skip=0&limit=100', TOKEN);
  await m.apiJson('/file/simple/web?skip=2000&limit=1', TOKEN);
  assert.equal(m.seen[0].path, '/file/simple/web?skip=0&limit=100');
  for (const query of ['skip=-1', 'skip=2001', 'skip=01', 'skip=1.5', 'limit=0', 'limit=101', 'skip=0&skip=1', 'other=a', 'limit=10%0A']) {
    await expectCode(m.apiJson('/file/simple/web?' + query, TOKEN), 'INVALID_PATH');
  }
  await expectCode(m.contentJson('https://%61pi.plaud.ai/a', new Set(['api.plaud.ai'])), 'INVALID_CONTENT_URL');
});

test('exact API origin allowlist rejects host, userinfo, port and normalization tricks before requests', async () => {
 const {API_ORIGINS}=require('../src/transport.cjs');
 for(const origin of API_ORIGINS){const host=new URL(origin).hostname,m=mock({host});await m.apiJson('/file/simple/web',TOKEN,undefined,undefined,origin);assert.equal(m.seen[0].hostname,host);assert.equal(m.seen[0].servername,host);assert.equal(m.seen[0].headers.Authorization,`Bearer ${TOKEN}`);assert.equal(m.seen[0].headers.Cookie,undefined);assert.equal(m.seen[0].port,443);assert.equal(m.seen[0].rejectUnauthorized,true);}
 const m=mock();
 for(const origin of [null,{},'http://api-apne1.plaud.ai','https://api-apne1.plaud.ai/','https://API-APNE1.plaud.ai','https://api-apne1.plaud.ai.','https://api-apne1.plaud.ai:443','https://api-apne1.plaud.ai:8443','https://user@api-apne1.plaud.ai','https://api-apne1.plaud.ai@evil.test','https://api-apne1.plaud.ai.evil.test','https://api-eu.plaud.ai','https://%61pi-apne1.plaud.ai','https://api-apne1.plaud.ai?x=1',' https://api-apne1.plaud.ai','https://api-apne1.plaud.ai\n'])await expectCode(m.apiJson('/file/simple/web',TOKEN,undefined,undefined,origin),'INVALID_ORIGIN');
 assert.equal(m.seen.length,0);
});
test('regional API retains route, redirect, DNS and content auth boundaries', async () => {
 const origin='https://api-apne1.plaud.ai',m=mock({host:'api-apne1.plaud.ai'});
 await expectCode(m.apiJson('https://api.plaud.ai/file/simple/web',TOKEN,undefined,undefined,origin),'INVALID_PATH');assert.equal(m.seen.length,0);
 for(const status of [301,302,303,307,308]){const redirect=mock({host:'api-apne1.plaud.ai',status,headers:{location:'https://api.plaud.ai/file/simple/web'}});await expectCode(redirect.apiJson('/file/simple/web',TOKEN,undefined,undefined,origin),'REDIRECT');assert.equal(redirect.seen.length,1);}
 await expectCode(mock({host:'api-apne1.plaud.ai',addresses:[{address:'127.0.0.1',family:4}]}).apiJson('/file/simple/web',TOKEN,undefined,undefined,origin),'DNS_BLOCKED');
 await expectCode(m.contentJson(origin+'/content',new Set()),'CONTENT_UNAPPROVED');await m.contentJson(origin+'/content',new Set(['api-apne1.plaud.ai']));
 for(const header of ['Authorization','Cookie','x-scope-id','x-scope-type','app-platform','edit-from'])assert.equal(m.seen[0].headers[header],undefined);
});
const {gzipSync}=require('node:zlib');
test('bounded gzip Markdown and JSON accept consistent bytes and MIME without API credentials',async()=>{
 const host='apne1-prod-plaud-content-storage.s3.amazonaws.com',approved=new Set([host]);
 for(const type of ['application/gzip','application/x-gzip','application/octet-stream','text/plain','text/markdown']){
  const m=mock({host,headers:{'content-type':type},chunks:[gzipSync('# Synthetic summary\n- Point')]});
  assert.equal(await m.contentJson('https://'+host+'/synthetic.md.gz',approved),'# Synthetic summary\n- Point');
  for(const key of ['Authorization','Cookie','x-scope-id','app-platform','edit-from'])assert.equal(m.seen[0].headers[key],undefined);
 }
 const m=mock({host,headers:{'content-type':'application/json'},chunks:[gzipSync('[{"content":"Synthetic transcript"}]')]});
 assert.deepEqual(await m.contentJson('https://'+host+'/synthetic.json.gz',approved),[{content:'Synthetic transcript'}]);
 const encoded=mock({host,headers:{'content-type':'text/markdown','content-encoding':'gzip'},chunks:[gzipSync('Synthetic')]});assert.equal(await encoded.contentJson('https://'+host+'/synthetic.md',approved),'Synthetic');
});
test('gzip requires approved exact host, valid magic, consistent MIME and permitted nonarchive suffix',async()=>{
 const host='cdn.example.com',approved=new Set([host]);
 const noApproval=mock({host,headers:{'content-type':'application/gzip'},chunks:[gzipSync('Synthetic')]});await expectCode(noApproval.contentJson('https://'+host+'/synthetic.md.gz',new Set()),'CONTENT_UNAPPROVED');assert.equal(noApproval.seen.length,0);
 for(const config of [
  {url:'/synthetic.md.gz',type:'text/markdown',chunks:['Plain despite gzip suffix'],code:'INVALID_GZIP'},
  {url:'/synthetic.md.gz',type:'application/json',chunks:[gzipSync('Synthetic')],code:'CONTENT_TYPE'},
  {url:'/synthetic.json.gz',type:'text/markdown',chunks:[gzipSync('{}')],code:'CONTENT_TYPE'},
  {url:'/synthetic.tar.gz',type:'application/gzip',chunks:[gzipSync('Synthetic')],code:'CONTENT_TYPE'},
  {url:'/synthetic.zip',type:'text/plain',chunks:['Synthetic'],code:'CONTENT_TYPE'},
  {url:'/synthetic.md',type:'text/markdown',chunks:[gzipSync('Synthetic')],code:'INVALID_GZIP'},
  {url:'/synthetic.md.gz',type:'application/gzip',chunks:[Buffer.from([0x1f,0x8b,8,0])],code:'INVALID_GZIP'}]){
  await expectCode(mock({host,headers:{'content-type':config.type},chunks:config.chunks}).contentJson('https://'+host+config.url,approved),config.code);
 }
});
test('compressed and decompressed limits reject gzip bombs and oversized wire content',async()=>{
 const host='cdn.example.com',approved=new Set([host]),url='https://'+host+'/synthetic.md.gz';
 await expectCode(mock({host,maxBytes:100,headers:{'content-type':'application/gzip'},chunks:[gzipSync('x'.repeat(10000))]}).contentJson(url,approved),'TOO_LARGE');
 await expectCode(mock({host,maxBytes:8,headers:{'content-type':'application/gzip'},chunks:[gzipSync('Synthetic')]}).contentJson(url,approved),'TOO_LARGE');
 await expectCode(mock({host,headers:{'content-type':'application/gzip','content-length':'1025'},chunks:[]}).contentJson(url,approved),'TOO_LARGE');
});
test('gzip validates UTF8 and rejects unsupported HTTP encoding without broadening API policy',async()=>{
 const host='cdn.example.com',approved=new Set([host]);
 await expectCode(mock({host,headers:{'content-type':'text/markdown'},chunks:[Buffer.from([0xff])]}).contentJson('https://'+host+'/synthetic.md',approved),'INVALID_UTF8');
 await expectCode(mock({host,headers:{'content-type':'application/gzip'},chunks:[gzipSync(Buffer.from([0xff]))]}).contentJson('https://'+host+'/synthetic.md.gz',approved),'INVALID_UTF8');
 await expectCode(mock({host,headers:{'content-type':'text/markdown','content-encoding':'br'}}).contentJson('https://'+host+'/synthetic.md',approved),'CONTENT_ENCODING');
 await expectCode(mock({headers:{'content-type':'application/json','content-encoding':'gzip'},chunks:[gzipSync('{}')]}).apiJson('/file/simple/web',TOKEN),'CONTENT_ENCODING');
});
test('deadline and abort cover stalled decompression and destroy decoder',async()=>{
 const host='cdn.example.com',approved=new Set([host]);let destroyed=false;
 const createGunzip=()=>{const decoder=new EventEmitter();decoder.end=()=>{};decoder.destroy=()=>{destroyed=true;};return decoder;};
 const config={host,timeoutMs:10,createGunzip,headers:{'content-type':'application/gzip'},chunks:[gzipSync('Synthetic')]};
 await expectCode(mock(config).contentJson('https://'+host+'/synthetic.md.gz',approved),'TIMEOUT');assert.equal(destroyed,true);
 destroyed=false;const c=new AbortController(),result=mock({...config,timeoutMs:1000}).contentJson('https://'+host+'/synthetic.md.gz',approved,c.signal);await new Promise(resolve=>setImmediate(resolve));c.abort();await expectCode(result,'ABORTED');assert.equal(destroyed,true);
});
