import {addMedia} from './library.js';
import {mediaType} from './media.js';
import {mediaSize} from './media-records.js';
import {videoPage} from './platforms.js';

export function extractVideoURL(value) {
  const match = value.match(/https?:\/\/[^\s<>"'，。！？；、]+/i);
  if (!match) throw new Error('请输入完整的 http 或 https 视频网址，也可以直接粘贴分享文案。');
  const url = new URL(match[0].replace(/[)）\]】.,;!?]+$/, ''));
  return url.href;
}

function samePage(first, second) {
  const a = videoPage(first), b = videoPage(second);
  return a && b ? a.platform === b.platform && a.id === b.id : first === second;
}

function waitForPage(tabId) {
  return new Promise((resolve, reject) => {
    const finish = (error, tab) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve(tab);
    };
    const updated = (id, change, tab) => {
      if (id === tabId && change.status === 'complete') finish(null, tab);
    };
    const removed = id => { if (id === tabId) finish(new Error('解析网页已关闭，请重新解析链接。')); };
    const timer = setTimeout(() => finish(new Error('网页加载超时，请打开来源网页完成登录或验证后重试。')), 30000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(null, tab); }, error => finish(error));
  });
}

async function capturedMedia(tabId, startedAt) {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored).filter(([key, item]) => key.startsWith('media:') && item.sourceTabId === tabId && item.updatedAt >= startedAt && item.kind !== 'audio').map(([, item]) => item);
}

function watchMedia(tabId, startedAt) {
  let changed, timer, settle;
  const promise = new Promise((resolve, reject) => {
    changed = (changes, area) => {
      if (area !== 'session') return;
      if (Object.entries(changes).some(([key, change]) => key.startsWith('media:') && change.newValue?.sourceTabId === tabId && change.newValue.kind !== 'audio')) {
        clearTimeout(settle);
        settle = setTimeout(async () => {
          const items = await capturedMedia(tabId, startedAt);
          if (items.length) { cleanup(); resolve(items); }
        }, 700);
      }
    };
    timer = setTimeout(() => { cleanup(); reject(new Error('还未识别到可下载视频。请打开来源网页，完成登录或验证并播放视频，再重试。')); }, 25000);
    chrome.storage.onChanged.addListener(changed);
  });
  function cleanup() {
    clearTimeout(timer); clearTimeout(settle);
    chrome.storage.onChanged.removeListener(changed);
  }
  return {promise, cleanup};
}

export async function resolveVideoURL(value, {quality, onProgress, analyze}) {
  const url = extractVideoURL(value);
  await onProgress({message: '正在识别链接…'});
  const kind = mediaType(url);
  if (kind && kind !== 'audio') {
    const response = await fetch(url, {headers: {Range: 'bytes=0-0'}, signal: AbortSignal.timeout(15000)});
    const contentType = response.headers.get('content-type') || '';
    const size = mediaSize(response.status, name => response.headers.get(name) || '', kind);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`视频地址返回 HTTP ${response.status}，请检查链接是否已过期。`);
    if (/text\/html|application\/json/i.test(contentType)) throw new Error('该地址返回了网页或验证信息，请使用视频作品页链接。');
    const item = await addMedia({url: response.url, sourceUrl: url, title: decodeURIComponent(new URL(url).pathname.split('/').pop()) || '链接视频',
      sizeVerified: size > 0, sizeCheckedAt: Date.now(), quality: kind === 'hls' ? 'HLS' : '媒体直链', kind, contentType, size});
    return {items: [item], url};
  }
  const startedAt = Date.now();
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find(tab => /^https?:/.test(tab.url || '') && samePage(tab.url, url));
  if (!tab) tab = await chrome.tabs.create({url, active: false});
  await onProgress({message: '正在加载视频网页，复用浏览器登录态…', sourceTabId: tab.id});
  tab = await waitForPage(tab.id);
  await onProgress({message: '正在提取视频下载地址…', sourceTabId: tab.id});
  if (videoPage(tab.url)) {
    const result = await analyze(tab.id, quality);
    const records = await capturedMedia(tab.id, startedAt);
    return {items: records.length ? records : [result], sourceTabId: tab.id, preferredId: result.mediaId, url: tab.url};
  }
  const capture = watchMedia(tab.id, startedAt);
  // 页面脚本注入可能先失败，提前绑定拒绝处理，最终仍由调用方显示错误。
  capture.promise.catch(() => {});
  try {
    await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files: ['bridge.js']});
    await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, world: 'MAIN', files: ['capture.js']});
    const items = await capturedMedia(tab.id, startedAt);
    return {items: items.length ? items : await capture.promise, sourceTabId: tab.id, url: tab.url};
  } finally { capture.cleanup(); }
}
