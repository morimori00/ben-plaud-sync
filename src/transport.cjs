'use strict';

const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { createGunzip } = require('node:zlib');
const { TextDecoder } = require('node:util');

const ORIGIN = 'https://api.plaud.ai';
const API_ORIGINS = Object.freeze([ORIGIN, 'https://api-apne1.plaud.ai']);
function validateApiOrigin(origin) {
  if (!API_ORIGINS.includes(origin)) throw failure('INVALID_ORIGIN');
  return origin;
}
const MESSAGES = Object.freeze({
  INVALID_GZIP: 'The compressed content format is invalid.',
  INVALID_UTF8: 'The content is not valid UTF-8.',
  INVALID_ORIGIN: 'The API origin is not permitted.',
  INVALID_PATH: 'The API route is not permitted.',
  INVALID_TOKEN: 'The access token is invalid.',
  CONTENT_UNAPPROVED: 'The content hostname needs explicit session approval.',
  INVALID_CONTENT_URL: 'The content URL is not permitted.',
  INVALID_WORKSPACE: 'The workspace identifier is invalid.',
  CONTENT_DISABLED: 'Content-link downloads are disabled pending a verified host policy.',
  NETWORK: 'The API request failed.',
  DNS_BLOCKED: 'The API address failed the public-address policy.',
  REDIRECT: 'API redirects are not permitted.',
  HTTP_STATUS: 'The API returned an unsuccessful status.',
  CONTENT_TYPE: 'The API response format is not permitted.',
  CONTENT_ENCODING: 'Compressed API responses are not permitted.',
  TOO_LARGE: 'The API response exceeded the size limit.',
  TIMEOUT: 'The API request timed out.',
  ABORTED: 'The API request was canceled.',
  INVALID_JSON: 'The API returned invalid JSON.'
});
class TransportError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.NETWORK);
    this.name = 'TransportError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'NETWORK';
  }
}
function failure(code) { return new TransportError(code); }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function buildApiURL(path, origin = ORIGIN) {
  validateApiOrigin(origin);
  if (typeof path !== 'string' || path !== path.trim() || /[\\#\r\n]/.test(path)) throw failure('INVALID_PATH');
  if (/^\/file\/(?:simple\/web|detail\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.test(path) ||
      /^\/file-app\/v4\/files\/detail\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(path)) return new URL(path, origin);
  if (/^\/file\/simple\/web\?[^#\r\n]*$/.test(path)) {
    const url = new URL(path, origin);
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
      if (seen.has(key)) throw failure('INVALID_PATH');
      seen.add(key);
      if (key === 'skip' && /^(?:0|[1-9][0-9]{0,3})$/.test(value) && Number(value) <= 2000) continue;
      if (key === 'limit' && /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 100) continue;
      throw failure('INVALID_PATH');
    }
    return url;
  }
  if (!/^\/file-app\/v4\/recordings\/all(?:\?[^#\r\n]*)?$/.test(path)) throw failure('INVALID_PATH');
  const url = new URL(path, origin);
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) throw failure('INVALID_PATH');
    seen.add(key);
    if ((key === 'sort_by' && value === 'created') || (key === 'sort_order' && value === 'desc') ||
        (key === 'page_size' && /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 100) ||
        (key === 'cursor' && /^[A-Za-z0-9._~+\/=-]{1,2048}$/.test(value))) continue;
    throw failure('INVALID_PATH');
  }
  return url;
}
function parseContentURL(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || raw !== raw.trim() || /[\\\s]/.test(raw)) throw failure('INVALID_CONTENT_URL');
  const authority = raw.match(/^https:\/\/([^/?#]*)/i);
  if (!authority || authority[1].includes('%')) throw failure('INVALID_CONTENT_URL');
  let url;
  try { url = new URL(raw); } catch (_) { throw failure('INVALID_CONTENT_URL'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash ||
      net.isIP(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
      url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) throw failure('INVALID_CONTENT_URL');
  return url;
}
function contentHostname(raw) { return parseContentURL(raw).hostname; }

// Conservative IPv4 policy. IPv6, mapped IPv6, ambiguous numeric forms and
// special-purpose/documentation/benchmark/multicast space are never accepted.
function publicAddress(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

// Dependencies and limits are injectable solely for deterministic offline tests.
function createTransport(dependencies = {}) {
  const request = dependencies.request || https.request;
  const lookup = dependencies.lookup || dns.lookup;
  const timeoutMs = dependencies.timeoutMs || 20000;
  const gunzip = dependencies.createGunzip || createGunzip;
  const maxBytes = dependencies.maxBytes || 4 * 1024 * 1024;

  function apiJson(path, token, signal, workspaceId, origin = ORIGIN) {
    let url;
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity' };
    try {
      url = buildApiURL(path, origin);
      if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || /[^\x21-\x7e]/.test(token)) throw failure('INVALID_TOKEN');
      headers.Authorization = `Bearer ${token}`;
      headers['app-platform'] = 'web';
      headers['edit-from'] = 'web';
      if (workspaceId !== undefined && workspaceId !== null && workspaceId !== '') {
        if (typeof workspaceId !== 'string' || workspaceId !== workspaceId.trim() || !SAFE_ID.test(workspaceId)) throw failure('INVALID_WORKSPACE');
        headers['x-scope-type'] = 'workspace';
        headers['x-scope-id'] = workspaceId;
      }
    } catch (error) { return Promise.reject(failure(error.code)); }
    return jsonRequest(url, headers, signal);
  }
  function contentJson(raw, approvedHosts, signal) {
    let url;
    try {
      url = parseContentURL(raw);
      if (!(approvedHosts instanceof Set) || !approvedHosts.has(url.hostname)) throw failure('CONTENT_UNAPPROVED');
    } catch (error) { return Promise.reject(failure(error.code)); }
    return jsonRequest(url, { Accept: 'application/json, text/plain, text/markdown, text/vnd.plaud.summary+markdown, text/vnd.plaud.transcript+json', 'Accept-Encoding': 'identity' }, signal, true);
  }
  function jsonRequest(url, headers, signal, contentMode = false) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(failure('ABORTED')); return; }
      let req;
      let response;
      let decoder;
      let ended = false;
      let settled = false;
      let timer;
      const abort = () => finish('ABORTED');
      const finish = (code, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
        if (code) {
          // Do not pass original errors or token-bearing request options onward.
          if (decoder) { try { decoder.destroy(); } catch (_) {} }
          if (response) { try { response.destroy(); } catch (_) {} }
          if (req) { try { req.destroy(); } catch (_) {} }
          reject(failure(code));
        } else resolve(value);
      };
      timer = setTimeout(() => finish('TIMEOUT'), timeoutMs);
      if (signal) signal.addEventListener('abort', abort, { once: true });
      const pinnedLookup = (hostname, options, callback) => {
        if (hostname !== url.hostname || settled) { callback(failure('DNS_BLOCKED')); return; }
        try {
          lookup(hostname, { all: true, family: 4, verbatim: true }, (error, addresses) => {
            if (settled) { callback(failure('ABORTED')); return; }
            if (error || !Array.isArray(addresses) || !addresses.length ||
                addresses.some(entry => entry.family !== 4 || !publicAddress(entry.address))) {
              finish('DNS_BLOCKED');
              callback(failure('DNS_BLOCKED'));
              return;
            }
            // Pin the validated address directly into this socket's lookup result.
            if (options && options.all) callback(null, [{ address: addresses[0].address, family: 4 }]);
            else callback(null, addresses[0].address, 4);
          });
        } catch (_) { finish('DNS_BLOCKED'); callback(failure('DNS_BLOCKED')); }
      };
      try {
        req = request({
          protocol: 'https:', hostname: url.hostname, port: 443,
          servername: url.hostname, path: url.pathname + url.search, method: 'GET',
          family: 4, lookup: pinnedLookup, agent: false,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16384,
          headers
        }, incoming => {
          response = incoming;
          // Always attach an error handler, even when aborting a rejected response.
          incoming.on('error', () => finish('NETWORK'));
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode || 0;
          if (status >= 300 && status <= 399) { finish('REDIRECT'); return; }
          if (status < 200 || status > 299) { finish('HTTP_STATUS'); return; }
          const encoding = String(incoming.headers['content-encoding'] || 'identity').toLowerCase().trim();
          if (encoding !== 'identity' && !(contentMode && encoding === 'gzip')) { finish('CONTENT_ENCODING'); return; }
          const type = String(incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const jsonType = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(type) || (contentMode && type === 'text/vnd.plaud.transcript+json');
          const textType = type === 'text/plain' || (contentMode && ['text/markdown', 'text/vnd.plaud.summary+markdown'].includes(type));
          const fileKind = contentMode ? url.pathname.match(/\.(md|json)\.gz$/i)?.[1]?.toLowerCase() : undefined;
          if (contentMode && /\.(?:zip|tar|tgz|gz)$/i.test(url.pathname) && !fileKind) { finish('CONTENT_TYPE'); return; }
          const gzipMime = contentMode && ['application/gzip','application/x-gzip'].includes(type);
          const binaryGzip = contentMode && type === 'application/octet-stream' && !!fileKind;
          if ((!jsonType && !textType && !(fileKind && gzipMime) && !binaryGzip) ||
              (fileKind === 'md' && jsonType) || (fileKind === 'json' && textType && type !== 'text/plain')) { finish('CONTENT_TYPE'); return; }
          const expectsGzip = contentMode && (encoding === 'gzip' || !!fileKind || gzipMime);
          const outputText = contentMode && (fileKind ? fileKind === 'md' : textType);
          const length = incoming.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) { finish('TOO_LARGE'); return; }
          let bytes = 0;
          const chunks = [];
          incoming.on('data', chunk => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBytes) { finish('TOO_LARGE'); return; }
            chunks.push(buffer);
          });
          incoming.on('aborted', () => finish('NETWORK'));
          const parseBody = buffer => {
            if (settled) return;
            let body;
            try { body = contentMode ? new TextDecoder('utf-8', {fatal:true}).decode(buffer) : buffer.toString('utf8'); }
            catch (_) { finish('INVALID_UTF8'); return; }
            try { finish(null, outputText ? body : JSON.parse(body)); }
            catch (_) { finish('INVALID_JSON'); }
          };
          incoming.on('end', () => {
            ended = true;
            if (settled) return;
            const input = Buffer.concat(chunks);
            const magic = input.length >= 3 && input[0] === 0x1f && input[1] === 0x8b && input[2] === 8;
            if (!expectsGzip) {
              if (contentMode && magic) { finish('INVALID_GZIP'); return; }
              parseBody(input); return;
            }
            if (!magic) { finish('INVALID_GZIP'); return; }
            try {
              decoder = gunzip();
              let outputBytes = 0;
              const output = [];
              decoder.on('error', () => finish('INVALID_GZIP'));
              decoder.on('data', chunk => {
                if (settled) return;
                outputBytes += chunk.length;
                if (outputBytes > maxBytes) { finish('TOO_LARGE'); return; }
                output.push(chunk);
              });
              decoder.on('end', () => { if (!settled) parseBody(Buffer.concat(output)); });
              decoder.end(input);
            } catch (_) { finish('INVALID_GZIP'); }
          });
          incoming.on('close', () => { if (!settled && !ended) finish('NETWORK'); });
        });
        req.on('error', () => finish('NETWORK'));
        if (settled) req.destroy();
        else req.end();
      } catch (_) { finish('NETWORK'); }
    });
  }
  return { apiJson, contentJson };
}
const { apiJson, contentJson } = createTransport();
module.exports = { API_ORIGINS, validateApiOrigin, apiJson, contentJson, contentHostname, buildApiURL, publicAddress, createTransport, TransportError };
