import {addMedia, queueDownloads} from './library.js';
import {videoPage} from './platforms.js';
import {resolveVideoURL} from './resolve.js';

const pendingProbes = new Map();
const activeJobs = new Set();
const keyFor = tabId => `video:${tabId}`;

function awemeId(url) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://www.douyin.com") throw new Error("请在抖音视频页打开插件。 ");
  const id = parsed.searchParams.get("modal_id") || parsed.searchParams.get("vid") || parsed.pathname.match(/^\/video\/(\d+)/)?.[1];
  if (!/^\d+$/.test(id || "")) throw new Error("请先打开一个独立视频页，例如 douyin.com/video/…");
  return id;
}

function isMediaURL(url) {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && ["douyinvod.com", "idouyinvod.com", "ixigua.com", "365yg.com", "bytecdn.cn", "amemv.com", "snssdk.com", "toutiaovod.com"]
    .some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
}

// 在浏览器网络层拿 302 地址，避开页面脚本无法读取跨域 CDN 响应的问题。
chrome.webRequest.onBeforeRedirect.addListener(details => {
  const pending = pendingProbes.get(details.tabId);
  if (!pending) return;
  const params = new URL(details.url).searchParams;
  if (params.get("video_id") !== pending.videoId || params.get("ratio") !== "default") return;
  if (!isMediaURL(details.redirectUrl)) {
    pending.reject(new Error("原片接口未跳转到已支持的视频 CDN，可能需要先完成抖音验证。"));
    return;
  }
  pending.resolve({url: details.redirectUrl, playUrl: details.url});
}, {urls: ["https://www.douyin.com/aweme/v1/play/*"]});

async function inPage(tabId, func, args = []) {
  const [execution] = await chrome.scripting.executeScript({target: {tabId}, world: "MAIN", func, args});
  if (execution.result?.error) throw new Error(execution.result.error);
  return execution.result;
}

async function probeOriginal(tabId, detail) {
  let timer;
  const redirect = new Promise((resolve, reject) => {
    pendingProbes.set(tabId, {videoId: detail.videoId, resolve, reject});
    timer = setTimeout(() => reject(new Error("原片探测超时：未收到视频地址。请确认视频能正常播放，再重试。")), 12000);
  });
  // 提前接住拒绝，避免页面注入失败时留下未处理的 promise。
  redirect.catch(() => {});
  try {
    await inPage(tabId, (videoId, needCookie) => {
      window.__douyinOriginal.startProbe(videoId, needCookie);
    }, [detail.videoId, detail.needCookie]);
    return await redirect;
  } finally {
    clearTimeout(timer);
    pendingProbes.delete(tabId);
    await inPage(tabId, () => window.__douyinOriginal.stopProbe()).catch(() => {});
  }
}

async function inspectMedia(url) {
  const response = await fetch(url, {
    headers: {Range: "bytes=0-31"}, credentials: "omit", signal: AbortSignal.timeout(15000)
  });
  try {
    if (!response.ok) throw new Error(`CDN 返回 HTTP ${response.status}，请重新获取地址。`);
    if (!isMediaURL(response.url)) throw new Error("CDN 跳转到了未支持的域名。 ");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("video/")) {
      throw new Error(`CDN 没有返回视频文件（${contentType || "未知类型"}），未生成下载结果。`);
    }
    const total = response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
    const size = Number(total || (response.status === 200 ? response.headers.get("content-length") : 0));
    return {url: response.url, size, sizeVerified: size > 0, sizeCheckedAt: Date.now(), contentType};
  } finally {
    await response.body?.cancel();
  }
}

async function update(tabId, data) {
  await chrome.storage.session.set({[keyFor(tabId)]: data});
}

async function analyze(tabId, quality = 'original') {
  const tab = await chrome.tabs.get(tabId);
  const page = videoPage(tab.url);
  if (page && page.platform !== 'douyin') return analyzePlatform(tab, page);
  const id = awemeId(tab.url);
  await update(tabId, {status: "loading", awemeId: id, message: "正在读取当前作品…"});
  await chrome.scripting.executeScript({target: {tabId}, world: "MAIN", files: ["page.js"]});
  const detail = await inPage(tabId, async id => {
    try { return await window.__douyinOriginal.getDetail(id); }
    catch (error) { return {error: error.message}; }
  }, [id]);
  let address;
  if (quality === 'original') {
    await update(tabId, {status: "loading", awemeId: id, message: "正在探测原片地址…"});
    address = await probeOriginal(tabId, detail);
  } else {
    if (!detail.hd) throw new Error('详情中没有可下载的高清 MP4。');
    address = {url: detail.hd.url};
  }
  const media = await inspectMedia(address.url);
  const current = await chrome.tabs.get(tabId);
  if (awemeId(current.url) !== id) throw new Error("页面已切换到另一个作品，请重新获取。 ");
  const result = {status: "ready", ...detail, ...media, playUrl: address.playUrl, fetchedAt: Date.now(),
    quality: quality === 'original' ? '原片候选' : '高清 MP4', kind: 'video', sourceUrl: tab.url, sourceTabId: tabId,
    height: quality === 'original' ? Math.min(detail.width, detail.height) || detail.width || detail.height || 0 : detail.hd.resolution || 0};
  const record = await addMedia(result);
  result.mediaId = record.id;
  await update(tabId, result);
  return result;
}

async function analyzePlatform(tab, page) {
  await update(tab.id, {status: 'loading', awemeId: page.id, message: '正在读取当前作品详情…'});
  await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', files: [`${page.platform}.js`]});
  const detail = await inPage(tab.id, async (platform, id) => {
    try { return await window.__kuaishouDownloader.getDetail(id); }
    catch (error) { return {error: error.message}; }
  }, [page.platform, page.id]);
  const preferred = await addMedia({...detail, sourceUrl: tab.url, sourceTabId: tab.id});
  const current = await chrome.tabs.get(tab.id);
  if (videoPage(current.url)?.id !== page.id) throw new Error('页面已切换，请重新解析当前作品。');
  const result = {...preferred, status: 'ready', awemeId: page.id, fetchedAt: Date.now(), mediaId: preferred.id,
    message: detail.message || '已取得作品详情中的视频地址。'};
  await update(tab.id, result);
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'REFRESH_JOB') {
    chrome.storage.session.get(`job:${message.id}`).then(stored => refreshFailedJob(stored[`job:${message.id}`]));
    respond({ok: true});
    return;
  }
  if (message.type === 'PARSE_URL') {
    const key = `parse:${message.requestId}`;
    let state = {status: 'loading', requestId: message.requestId};
    const progress = async patch => {
      state = {...state, ...patch};
      await chrome.storage.session.set({[key]: state});
    };
    resolveVideoURL(message.value, {quality: message.quality || 'hd', onProgress: progress, analyze})
      .then(result => progress({status: 'ready', ...result, message: `解析完成，发现 ${result.items.length} 个可下载视频。`}),
        error => progress({status: 'error', message: error.message}));
    respond({ok: true});
    return;
  }
  if (message.type === "ANALYZE") {
    if (activeJobs.has(message.tabId)) { respond({ok: true}); return; }
    activeJobs.add(message.tabId);
    analyze(message.tabId, message.quality)
      .catch(error => update(message.tabId, {status: "error", message: error.message}))
      .finally(() => activeJobs.delete(message.tabId));
    respond({ok: true});
  }
  if (message.type === "DOWNLOAD") {
    (async () => {
      const stored = await chrome.storage.session.get(keyFor(message.tabId));
      const result = stored[keyFor(message.tabId)];
      const tab = await chrome.tabs.get(message.tabId);
      if (result?.status !== "ready" || videoPage(tab.url)?.id !== result.awemeId) {
        throw new Error("当前作品尚未获取地址，请先重新获取。 ");
      }
      const [jobId] = await queueDownloads([{...result, id: result.mediaId}], message.threads, message.mode);
      await update(message.tabId, {...result, jobId});
      return {ok: true, jobId};
    })().then(respond, error => respond({error: error.message}));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(keyFor(tabId)));

// Platform addresses expire. When a download fails, resolve the source page again once and queue the same quality.
async function refreshFailedJob(job) {
  const key = `job:${job.id}`;
  const mark = async patch => {
    const current = (await chrome.storage.session.get(key))[key];
    if (current) await chrome.storage.session.set({[key]: {...current, ...patch}});
  };
  await mark({refresh: 'running'});
  try {
    const result = await resolveVideoURL(job.sourceUrl, {quality: job.quality === '原片候选' ? 'original' : 'hd', onProgress: async () => {}, analyze});
    const same = result.items.filter(item => item.quality === job.quality);
    const fresh = same.find(item => item.height === job.height) || same[0] || result.items.find(item => item.id === result.preferredId) || result.items[0];
    const {downloadThreads = '8', downloadMode = 'auto'} = await chrome.storage.local.get(['downloadThreads', 'downloadMode']);
    const [jobId] = await queueDownloads([{...fresh, refreshedFrom: job.id}], Number(downloadThreads), downloadMode);
    await mark({refresh: 'done', refreshJobId: jobId});
  } catch (error) {
    await mark({refresh: 'failed', refreshError: error.message});
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const [key, {newValue: job}] of Object.entries(changes)) {
    if (key.startsWith('job:') && job?.status === 'error' && !job.refresh && !job.refreshedFrom && /^https?:/.test(job.sourceUrl || '')) void refreshFailedJob(job);
  }
});
