'use strict';
// v3 field mappings: Leonard Sellem Plaud Sync 1.0.1 (MIT).
// v4 protocol shapes cross-checked against Charles Kelsoe Obsidian Plaud 0.43.0 (MIT).
const { SafeError, recordingId, fileList, summaryFromDetail, normalize } = require('./core.cjs');
const { apiJson, contentJson, contentHostname, validateApiOrigin } = require('./transport.cjs');
const fail = code => { throw new SafeError(code); };
function parseTextJSON(value) {
  if (typeof value !== 'string') return value;
  try { const parsed=JSON.parse(value); return parsed !== null && typeof parsed === 'object' ? parsed : value; } catch { return value; }
}
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function unwrap(raw) {
  if (!object(raw) || ('status' in raw && ![0,200,'0','200','ok','success'].includes(raw.status))) fail('unsupported-api-response');
  return raw.data;
}
function createApi({ origin = 'https://api.plaud.ai', version, workspace, approvedHosts, approveHost, request = apiJson, fetchContent = contentJson, hostname = contentHostname }) {
  validateApiOrigin(origin);
  const apiRequest = (path, token, signal, workspaceId) => request(path, token, signal, workspaceId, origin);
  if (!['v3','v4'].includes(version)) fail('invalid-api-version');
  if (version === 'v4') recordingId(workspace);
  const deniedHosts = new Set(); let hostPrompts = 0;
  async function content(url, signal) {
    const host = hostname(url);
    if (!approvedHosts.has(host)) {
      if (deniedHosts.has(host) || hostPrompts >= 10) fail('external-content-blocked');
      hostPrompts++;
      if (!await approveHost(host, signal)) { deniedHosts.add(host); fail('external-content-blocked'); }
      if (signal?.aborted) fail('cancelled');
      approvedHosts.add(host);
    }
    if (signal?.aborted) fail('cancelled');
    return fetchContent(url, approvedHosts, signal);
  }
  async function hydrate(d, signal) {
    try { normalize(d, d.id); return d; } catch (e) { if (!['content-not-ready','external-content-blocked'].includes(e.code)) throw e; }
    if (!Array.isArray(d.content_list)) return d;
    const localSummary = summaryFromDetail(d);
    if (localSummary) d.summary = localSummary;
    for (const [type, field] of [['auto_sum_note','summary'],['transaction','transcript']]) {
      if (field === 'summary' && (d.summary || d.ai_content?.summary)) continue;
      if (field === 'transcript' && (d.transcript_text || d.full_text || d.trans_result?.full_text || d.transcript)) continue;
      const readyLink = kind => d.content_list.find(x => object(x) && (x.data_type || x.type || '').toLowerCase() === kind && (x.task_status === 1 || (kind !== 'transaction_polish' && x.task_status === undefined)));
      const link = field === 'transcript' ? readyLink('transaction_polish') || readyLink(type) : readyLink(type);
      if (!link) continue;
      const fetched = parseTextJSON(await content(link.data_link || link.link || link.url, signal));
      if (field === 'summary') d.summary = typeof fetched === 'string' ? fetched : fetched?.summary || fetched?.abstract || fetched?.ai_content || fetched?.content || fetched?.text;
      else if (typeof fetched === 'string') d.transcript_text = fetched;
      else if (Array.isArray(fetched)) d.transcript = fetched;
      else if (object(fetched)) d.trans_result = fetched;
    }
    return d;
  }
  const timeById=new Map();
  return async (path, token, signal) => {
    if (path === '/file/simple/web') {
      if (version === 'v3') {
        const all = [], pages = new Set();
        for (let skip = 0; skip <= 2000; skip += 100) {
          const raw = await apiRequest('/file/simple/web?skip=' + skip + '&limit=100', token, signal);
          if (object(raw) && 'status' in raw && ![0,200,'0','200','ok','success'].includes(raw.status)) fail('api-rejected-response');
          const page = Array.isArray(raw) ? raw : raw?.payload ?? raw?.data_file_list ?? raw?.data;
          if (!Array.isArray(page) || page.length > 100) fail('unsupported-v3-pagination');
          const signature = JSON.stringify(page.map(item=>item?.id || item?.file_id));
          if (page.length && pages.has(signature)) fail('invalid-pagination');
          pages.add(signature); all.push(...page);
          if (all.length > 2000) fail('recording-limit');
          if (page.length < 100) {
            if (object(raw) && (raw.has_more === true || raw.next_cursor || (Number.isFinite(raw.total) && raw.total > all.length))) fail('unsupported-v3-pagination');
            fileList(all); for(const item of all)timeById.set(item.id || item.file_id,{start_time:item.start_time,timezone:item.timezone,zonemins:item.zonemins}); return all;
          }
        }
        fail('pagination-limit');
      }
      const all = [], cursors = new Set(); let cursor = '';
      for (let page = 0; page < 50; page++) {
        const query = new URLSearchParams({sort_by:'created', sort_order:'desc', page_size:'100'});
        if (cursor) query.set('cursor', cursor);
        const data = unwrap(await apiRequest('/file-app/v4/recordings/all?' + query, token, signal, workspace));
        if (!object(data) || !Array.isArray(data.items)) fail('unsupported-v4-list');
        for (const item of data.items) { if (!object(item)) fail('unsupported-v4-list'); all.push({id:recordingId(item.file_id), is_trash:item.is_trash}); }
        if (all.length > 2000) fail('recording-limit');
        if (data.next_cursor === null || data.next_cursor === undefined || data.next_cursor === '') { fileList(all); return all; }
        if (typeof data.next_cursor !== 'string' || data.next_cursor.length > 2048 || cursors.has(data.next_cursor)) fail('invalid-pagination');
        cursor = data.next_cursor; cursors.add(cursor);
      }
      fail('pagination-limit');
    }
    const id = recordingId(path.slice('/file/detail/'.length));
    if (path !== '/file/detail/' + id) fail('invalid-api-route');
    if (version === 'v3') {
      const raw = await apiRequest(path, token, signal);
      if (!object(raw)) fail('unsupported-detail-response');
      if ('status' in raw && ![0,200,'0','200','ok','success'].includes(raw.status)) fail('api-rejected-response');
      const data = object(raw.payload) ? raw.payload : object(raw.data) ? raw.data : raw;
      if ((data.file_id || data.id) !== id || (data.id && data.id !== id)) fail('mismatched-recording-id');
      return hydrate({...timeById.get(id),...data,id}, signal);
    }
    const data = unwrap(await apiRequest('/file-app/v4/files/detail/' + id, token, signal, workspace));
    if (!object(data) || !object(data.meta) || data.meta.file_id !== id || !Array.isArray(data.objects)) fail('unsupported-v4-detail');
    const transcript = data.objects.find(x=>x?.object_type==='POLISHED_TRANSCRIPT' && typeof x.content_url==='string' && x.content_url) || data.objects.find(x=>x?.object_type==='TRANSCRIPT');
    const summary = data.objects.find(x=>x?.object_type==='SUMMARY');
    if (!transcript?.content_url || !summary?.content_url) fail('content-not-ready');
    const t = parseTextJSON(await content(transcript.content_url, signal)), s = parseTextJSON(await content(summary.content_url, signal));
    const result = {id, title:data.node?.name || 'Untitled recording'};
    if (typeof t === 'string') result.transcript_text=t;
    else if (Array.isArray(t)) result.transcript=t;
    else if (object(t)) result.trans_result=t;
    result.summary=typeof s==='string'?s:s?.summary || s?.content || s?.text;
    return result;
  };
}
module.exports={createApi};
