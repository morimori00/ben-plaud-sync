'use strict';
const { apiJson } = require('./transport.cjs');
const { recordingId, safeCode } = require('./core.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const FIELDS = Object.freeze(['status','data_file_total','total_count','is_trans','is_summary','data_file_list','payload','data','has_more','next_cursor','total','id','file_id','is_trash','summary','ai_content','transcript_text','transcript','full_text','trans_result','content_list','pre_download_content_list','data_type','task_status','data_link','data_id','data_content']);
function type(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : ['string','number','boolean'].includes(typeof value) ? typeof value : 'other'; }
function shape(value) {
  const result = { type: type(value) };
  if (Array.isArray(value)) result.count = Math.min(value.length, 2001);
  if (object(value)) {
    result.fields = {};
    for (const key of FIELDS) if (Object.hasOwn(value, key)) result.fields[key] = type(value[key]);
    result.unlistedFieldCount = Math.min(Object.keys(value).filter(key => !FIELDS.includes(key)).length, 1000);
  }
  return result;
}
function apiStatus(raw) {
  if (!object(raw) || !Object.hasOwn(raw, 'status')) return 'absent';
  if ([0,200,'0','200','ok','success'].includes(raw.status)) return 'accepted';
  if ([-302,-419,-3900,-12].includes(raw.status)) return raw.status;
  return 'rejected';
}
function detailShape(raw) {
  const data = object(raw?.payload) ? raw.payload : object(raw?.data) ? raw.data : raw;
  const result = { envelope: shape(raw), apiStatus: apiStatus(raw), data: shape(data) };
  if (!object(data)) return result;
  for (const field of ['content_list','pre_download_content_list']) {
    const entries = data[field];
    if (!Array.isArray(entries)) continue;
    const counts = { transaction: 0, transaction_polish: 0, auto_sum_note: 0, other: 0, ready: 0, autoSumPrefix: 0 };
    for (const entry of entries.slice(0,2000)) {
      if (!object(entry)) { counts.other++; continue; }
      const kind = entry.data_type;
      if (['transaction','transaction_polish','auto_sum_note'].includes(kind)) counts[kind]++; else counts.other++;
      if (entry.task_status === 1) counts.ready++;
      if (typeof entry.data_id === 'string' && entry.data_id.startsWith('auto_sum:')) counts.autoSumPrefix++;
    }
    result[field] = { count: Math.min(entries.length,2001), firstEntry: shape(entries[0]), counts };
  }
  return result;
}
// User-triggered only. No content-host downloads, Vault IO, logging, or raw result retention.
async function diagnose({token, origin, signal, request = apiJson}) {
  const result = { diagnostic: 'recording-schema-v1', list: null, detail: null };
  if (origin !== 'https://api-apne1.plaud.ai') { result.list = {error:'diagnostic-origin-required'}; return result; }
  let stage = 'list';
  try {
    const raw = await request('/file/simple/web?skip=0&limit=1', token, signal, undefined, origin);
    const list = Array.isArray(raw) ? raw : raw?.payload ?? raw?.data_file_list ?? raw?.data;
    result.list = { http: '2xx-json', envelope: shape(raw), apiStatus: apiStatus(raw), items: shape(list) };
    if (!['absent','accepted'].includes(result.list.apiStatus) || !Array.isArray(list) || list.length === 0 || list.length > 100) return result;
    result.list.flags = {trash:0,transcriptReady:0,summaryReady:0,eligible:0};
    const candidates = list.filter(entry=>{
      if (!object(entry)) return false;
      const trash = entry.is_trash === true || entry.is_trash === 1 || entry.is_trash === '1';
      if (trash) result.list.flags.trash++;
      if (entry.is_trans === true) result.list.flags.transcriptReady++;
      if (entry.is_summary === true) result.list.flags.summaryReady++;
      const eligible = !trash && entry.is_trans !== false && entry.is_summary !== false;
      if (eligible) result.list.flags.eligible++;
      return eligible;
    });
    const entry = candidates.find(entry=>{try{recordingId(entry.id || entry.file_id);return true;}catch(_){return false;}});
    result.list.firstEntry = shape(entry);
    if (!object(entry)) return result;
    let id;
    try { id = recordingId(entry.id || entry.file_id); }
    catch (_) { result.detail = { skipped: 'invalid-recording-id' }; return result; }
    stage = 'detail';
    const detail = await request('/file/detail/' + id, token, signal, undefined, origin);
    result.detail = { http: '2xx-json', ...detailShape(detail) };
  } catch (error) { result[stage] = { error: safeCode(error) }; }
  return result;
}
module.exports = { shape, detailShape, diagnose };
