(() => {
  if (window.__professionalVideoCapture) {
    window.__professionalVideoCapture.scan(true);
    return;
  }
  const known = new Map();
  let pageURL = location.href;
  let scanTimer;
  const mediaPath = /\.(mp4|webm|mov|m4v|ogv|m3u8)(?:$|[?#])/i;
  const publish = (url, title = document.title, extra = {}) => {
    if (!url || !/^(https?:|blob:)/.test(url)) return;
    if (location.href !== pageURL) {
      pageURL = location.href;
      known.clear();
    }
    const kind = extra.kind || (/mpegurl/i.test(extra.contentType || '') || /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'video');
    const item = {url, title, sourceUrl: location.href, ...extra, kind};
    const previous = known.get(url);
    // 播放器扫描不能把接口识别出的画质和分轨信息覆盖成普通网页视频。
    if (previous && extra.quality === '网页视频') return;
    const signature = JSON.stringify(item);
    if (previous === signature) return;
    known.set(url, signature);
    window.postMessage({source: 'professional-video-capture', item}, '*');
  };
  function publishResource(entry) {
    if (mediaPath.test(entry.name)) publish(entry.name, document.title, {quality: '网页视频'});
  }
  function publishSource(url, contentType = '') {
    // MediaSource 的 blob 是播放器缓冲，下载目标应取网络中的媒体文件或 HLS 清单。
    if (url.startsWith('blob:') && !/(^|\.)telegram\.org$/.test(location.hostname)) return;
    if (/\.(ts|m4s|vtt)(?:$|[?#])/i.test(url) || /mp2t|dash\+xml/i.test(contentType)) return;
    publish(url, document.title, {...(contentType ? {contentType} : {}), quality: '网页视频'});
  }
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    // TikTok 的公开视频详情，以及 X 返回的 MP4 / HLS 视频变体。
    if (value.video?.playAddr && value.id) {
      const address = value.video.playAddr;
      publish(typeof address === 'string' ? address : address.UrlList?.[0], value.desc || document.title, {quality: '高清 MP4', contentType: 'video/mp4'});
    }
    if (value.video_info?.variants) {
      const variants = value.video_info.variants;
      const best = variants.filter(item => item.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (best) publish(best.url, document.title, {quality: '高清 MP4', contentType: 'video/mp4'});
      else {
        const hls = variants.find(item => item.content_type?.includes('mpegURL'));
        if (hls) publish(hls.url, document.title, {kind: 'hls'});
      }
    }
    Object.values(value).forEach(collect);
  }
  function scan(force = false) {
    if (force) known.clear();
    for (const entry of performance.getEntriesByType('resource')) publishResource(entry);
    for (const video of document.querySelectorAll('video')) {
      publishSource(video.currentSrc || video.src);
      for (const source of video.querySelectorAll('source[src]')) publishSource(source.src, source.type);
    }
    for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
      const script = document.getElementById(id);
      if (script) { try { collect(JSON.parse(script.textContent)); } catch {} }
    }
  }
  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), 150);
  };
  const relevant = url => /tiktok\.com\/api\/|\/graphql\//.test(String(url));
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    if (relevant(response.url) && response.ok) response.clone().json().then(collect).catch(() => {});
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    if (relevant(url)) this.addEventListener('load', () => {
      try { collect(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
    }, {once: true});
    return originalOpen.call(this, method, url, ...args);
  };
  // 监听延迟加载、换集和 <source> 更新；不为每个网页持续轮询整个播放器。
  new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes'
      ? record.target.matches('video, source')
      : [...record.addedNodes].some(node => node.nodeType === 1 &&
        (node.matches('video, source') || node.querySelector('video, source'))))) scheduleScan();
  }).observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'type']});
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) publishResource(entry);
  }).observe({type: 'resource', buffered: true});
  document.addEventListener('loadedmetadata', scheduleScan, true);
  document.addEventListener('play', scheduleScan, true);
  window.addEventListener('popstate', scheduleScan);
  window.__professionalVideoCapture = {scan};
  if (document.readyState !== 'loading') scan();
  else document.addEventListener('DOMContentLoaded', scan, {once: true});
})();
