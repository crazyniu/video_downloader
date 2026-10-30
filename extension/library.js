import {platformName, normalizeMediaURL, mediaType, fileName, probeMediaFile} from './media.js';
import {canCaptureSource, mediaIdentity, mediaSize, uniqueMedia} from './media-records.js';
import {isMediaURL} from './platforms.js';

let writes = Promise.resolve();
let creating;
let jobWrites = Promise.resolve();
const keyFor = id => `media:${id}`;
function patchJob(id, patch) {
  const write = jobWrites.then(async () => {
    const key = `job:${id}`;
    const job = (await chrome.storage.session.get(key))[key];
    await chrome.storage.session.set({[key]: {...job, ...patch}});
  });
  jobWrites = write.catch(console.error);
  return write;
}

export function addMedia(item) {
  const write = writes.then(async () => {
    const url = normalizeMediaURL(item.url);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mediaIdentity(url)));
    const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const key = keyFor(id);
    const previous = (await chrome.storage.session.get(key))[key];
    const sourceUrl = item.sourceUrl || previous?.sourceUrl;
    const record = {id, ...previous, ...item, url, sourceUrl,
      platform: platformName(sourceUrl), createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now()};
    if (previous && item.quality === '网页视频') {
      if (previous.quality && previous.quality !== '网页视频') {
        for (const field of ['quality', 'title', 'author', 'videoOnly', 'height', 'bitrate', 'awemeId', 'videoId', 'sourceUrl']) if (previous[field] !== undefined) record[field] = previous[field];
      }
      if (!item.contentType && previous.contentType) { record.contentType = previous.contentType; record.kind = previous.kind; }
      if (previous.sizeVerified && !item.sizeVerified) { record.size = previous.size; record.sizeVerified = true; record.sizeCheckedAt = previous.sizeCheckedAt; }
    }
    if (previous && !record.sizeVerified && (previous.url !== url || (item.quality && item.quality !== '网页视频'))) delete record.sizeCheckedAt;
    if (record.kind === 'hls') { record.size = 0; record.sizeVerified = false; }
    record.platform = platformName(record.sourceUrl);
    await chrome.storage.session.set({[key]: record});
    return record;
  });
  writes = write.catch(error => console.error('保存视频记录失败', error));
  return write;
}

export async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'],
      justification: '并行下载视频分段，在本地合并音视频并生成下载文件。'}).finally(() => { creating = null; });
  }
  await creating;
}

export async function queueDownloads(items, threads, mode = 'auto') {
  await writes;
  const stored = await chrome.storage.session.get(null);
  const audio = Object.entries(stored).filter(([key, item]) => key.startsWith('media:') && item.kind === 'audio').map(([, item]) => item);
  const jobs = items.map(item => {
    const track = item.videoOnly ? audio.filter(track => track.sourceUrl === item.sourceUrl).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0) || b.updatedAt - a.updatedAt)[0] : null;
    if (item.videoOnly && !track) throw new Error('此视频的音轨尚未识别，请先在作品页播放视频，再重试下载。');
    return {...item, id: crypto.randomUUID(), mediaId: item.id, threads,
      engine: mode === 'auto' && !track && item.kind === 'video' && /^https?:/.test(item.url) ? 'browser' : 'parallel',
      audioUrl: track?.url, createdAt: Date.now(), received: 0, status: 'queued',
      filename: fileName(item.title, item.quality || '视频', item.kind === 'hls' || track ? 'video/mp4' : item.contentType)};
  });
  await ensureOffscreen();
  await chrome.storage.session.set(Object.fromEntries(jobs.map(job => [`job:${job.id}`, job])));
  await chrome.runtime.sendMessage({target: 'offscreen', type: 'ENQUEUE', jobs});
  return jobs.map(job => job.id);
}

chrome.webRequest.onResponseStarted.addListener(details => {
  if (details.tabId < 0 || details.statusCode >= 400 || details.initiator?.startsWith('chrome-extension:')) return;
  const header = name => details.responseHeaders.find(item => item.name.toLowerCase() === name)?.value || '';
  const contentType = header('content-type');
  const kind = mediaType(details.url, contentType);
  if (!kind) return;
  const size = mediaSize(details.statusCode, header, kind);
  chrome.tabs.get(details.tabId).then(tab => {
    if (!canCaptureSource(tab.url)) return;
    return addMedia({url: details.url, title: tab.title || '网页视频',
      sourceUrl: tab.url, sourceTabId: details.tabId, frameId: details.frameId, contentType, kind,
      size, sizeVerified: size > 0, sizeCheckedAt: size > 0 ? Date.now() : undefined,
      quality: '网页视频'});
  }).catch(error => console.error('记录视频请求失败', error));
}, {urls: ['http://*/*', 'https://*/*']}, ['responseHeaders']);

const inspectionQueue = [];
const inspecting = new Set();
let inspectionCount = 0;
function patchMedia(id, patch) {
  const write = writes.then(async () => {
    const key = keyFor(id);
    const record = (await chrome.storage.session.get(key))[key];
    // 清空列表后不让未完成的大小探测重新生成记录。
    if (record) await chrome.storage.session.set({[key]: {...record, ...patch}});
  });
  writes = write.catch(console.error);
  return write;
}
function inspectUnknownSizes(items) {
  for (const item of items) if (item.kind === 'video' && !item.url.startsWith('blob:') && !item.sizeVerified && !item.sizeCheckedAt && !inspecting.has(item.id)) {
    inspecting.add(item.id); inspectionQueue.push(item);
  }
  const pump = () => {
    while (inspectionCount < 3 && inspectionQueue.length) {
      const item = inspectionQueue.shift(); inspectionCount++;
      probeMediaFile(item.url).then(patch => patchMedia(item.id, patch),
        () => patchMedia(item.id, {size: 0, sizeVerified: false, sizeCheckedAt: Date.now()}))
        .finally(() => {inspectionCount--; inspecting.delete(item.id); pump();});
    }
  };
  pump();
}
async function readLibrary() {
  await writes;
  const stored = await chrome.storage.session.get(null);
  const records = [], removed = [], updates = {};
  for (const [key, record] of Object.entries(stored)) {
    if (!key.startsWith('media:')) continue;
    let sourceUrl = record.sourceUrl;
    if (!canCaptureSource(sourceUrl)) {
      if (/^\d+$/.test(record.awemeId || '') && isMediaURL(record.url, 'douyin')) sourceUrl = `https://www.douyin.com/video/${record.awemeId}`;
      else if (record.videoId && isMediaURL(record.url, 'kuaishou')) sourceUrl = `https://www.kuaishou.com/short-video/${record.videoId}`;
      else { removed.push(key); continue; }
    }
    const item = {...record, sourceUrl, platform: platformName(sourceUrl)};
    if (item.kind === 'hls' || !item.sizeVerified) {item.size = 0; item.sizeVerified = false;}
    records.push(item);
  }
  const unique = uniqueMedia(records);
  for (const item of unique) if (JSON.stringify(item) !== JSON.stringify(stored[keyFor(item.id)])) updates[keyFor(item.id)] = item;
  if (removed.length) await chrome.storage.session.remove(removed);
  if (Object.keys(updates).length) await chrome.storage.session.set(updates);
  const items = unique.filter(item => item.kind !== 'audio');
  inspectUnknownSizes(items);
  return {items, jobs: Object.entries(stored).filter(([key]) => key.startsWith('job:')).map(([, job]) => job)};
}

async function readPageRange(message) {
  const [execution] = await chrome.scripting.executeScript({target: {tabId: message.tabId, frameIds: [message.frameId || 0]}, world: 'MAIN',
    args: [message.url, message.start, message.end],
    func: async (url, start, end) => {
      try {
        const response = await fetch(url, {headers: start === null ? {} : {Range: `bytes=${start}-${end}`}});
        if (start !== null && response.status !== 206) {
          await response.body?.cancel();
          return {error: '此播放器不支持读取完整视频分段，请使用网页自身的下载入口。'};
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < buffer.length; offset += 32768) binary += String.fromCharCode(...buffer.subarray(offset, offset + 32768));
        return {status: response.status, headers: Object.fromEntries(response.headers), data: btoa(binary)};
      } catch { return {error: '此播放器使用流式缓冲，无法读取完整文件。请使用网页自身的下载入口。'}; }
    }});
  return execution.result;
}

async function handle(message, sender) {
  if (message.type === 'CAPTURE_MEDIA') {
    const item = message.item;
    if (!/^(https?:|blob:)/.test(item.url) || !sender.tab || !canCaptureSource(sender.tab.url)) return;
    return addMedia({...item, sourceUrl: sender.tab.url, sourceTabId: sender.tab.id, frameId: sender.frameId,
      kind: item.kind || mediaType(item.url, item.contentType || 'video/mp4'), quality: item.quality || '网页视频'});
  }
  if (message.type === 'LIST_LIBRARY') return readLibrary();
  if (message.type === 'QUEUE_DOWNLOADS') {
    const keys = message.ids.map(keyFor);
    const stored = await chrome.storage.session.get(keys);
    const items = keys.map(key => stored[key]);
    if (items.some(item => !item)) throw new Error('部分视频记录已清除，请刷新列表后重新选择。');
    return {jobIds: await queueDownloads(items, message.threads, message.mode)};
  }
  if (message.type === 'CLEAR_LIBRARY') {
    await writes;
    const stored = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(stored).filter(key => key.startsWith('media:')));
    return {ok: true};
  }
  if (message.type === 'JOB_UPDATE') {
    await patchJob(message.id, message.patch);
    return {ok: true};
  }
  if (message.type === 'START_NATIVE') {
    const job = (await chrome.storage.session.get(`job:${message.id}`))[`job:${message.id}`];
    const downloadId = await chrome.downloads.download({url: job.url, filename: job.filename, saveAs: false, conflictAction: 'uniquify'});
    await patchJob(job.id, {downloadId, status: 'fetching'});
    await finishDownload(downloadId);
    return {downloadId};
  }
  if (message.type === 'SYNC_NATIVE') {
    const job = (await chrome.storage.session.get(`job:${message.id}`))[`job:${message.id}`];
    const [download] = await chrome.downloads.search({id: job.downloadId});
    if (!download) throw new Error('Chrome 下载记录已移除。');
    const now = Date.now();
    const speed = job.progressAt ? Math.max(0, download.bytesReceived - job.received) * 1000 / (now - job.progressAt) : 0;
    await patchJob(job.id, {received: download.bytesReceived, size: download.totalBytes > 0 ? download.totalBytes : job.size, speed, progressAt: now});
    await finishDownload(job.downloadId);
    return {ok: true};
  }
  if (message.type === 'SAVE_BLOB') {
    const key = `job:${message.id}`;
    const job = (await chrome.storage.session.get(key))[key];
    const downloadId = await chrome.downloads.download({url: message.url, filename: job.filename, saveAs: false, conflictAction: 'uniquify'});
    await patchJob(message.id, {status: 'saving', downloadId});
    await finishDownload(downloadId);
    return {downloadId};
  }
  if (message.type === 'PAGE_RANGE') return readPageRange(message);
  if (message.type === 'CANCEL_JOB') {
    const job = (await chrome.storage.session.get(`job:${message.id}`))[`job:${message.id}`];
    if (job.downloadId) await chrome.downloads.cancel(job.downloadId);
    else await chrome.runtime.sendMessage({target: 'offscreen', type: 'CANCEL', id: job.id});
    return {ok: true};
  }
}

const types = new Set(['CAPTURE_MEDIA', 'LIST_LIBRARY', 'QUEUE_DOWNLOADS', 'CLEAR_LIBRARY', 'JOB_UPDATE', 'SAVE_BLOB', 'PAGE_RANGE', 'CANCEL_JOB', 'START_NATIVE', 'SYNC_NATIVE']);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target === 'offscreen' || !types.has(message.type)) return;
  handle(message, sender).then(respond, error => respond({error: error.message}));
  return true;
});
async function finishDownload(downloadId) {
  const [download] = await chrome.downloads.search({id: downloadId});
  if (!download || !['complete', 'interrupted'].includes(download.state)) return;
  const stored = await chrome.storage.session.get(null);
  const entry = Object.entries(stored).find(([key, job]) => key.startsWith('job:') && job.downloadId === downloadId);
  if (!entry) return;
  const [key, job] = entry;
  const status = download.state === 'complete' ? 'complete' : download.error === 'USER_CANCELED' ? 'canceled' : 'error';
  await patchJob(job.id, {status, error: download.error});
  await chrome.runtime.sendMessage({target: 'offscreen', type: 'RELEASE', id: job.id});
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state && ['complete', 'interrupted'].includes(delta.state.current)) void finishDownload(delta.id).catch(console.error);
});
