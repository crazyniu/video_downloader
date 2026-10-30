// Adapted from KS-Downloader's HTML/API extraction flow (GPL-3.0).
// See PLATFORM_SOURCES.md for upstream revision and license.
(() => {
  if (window.__kuaishouDownloader) return;
  const videos = new Map();

  function collect(value) {
    if (!value || typeof value !== "object") return;
    // live_api returns currentWork.mp4Url beside currentWork.photo.
    const photo = value.photo || value;
    const id = photo.id || photo.photoId || (photo.share_info ? new URLSearchParams(photo.share_info).get("photoId") : null);
    const url = value.mp4Url || photo.photoUrl;
    if (id && url) {
      videos.set(String(id), {...photo, photoUrl: url, author: value.author || photo.author});
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("VisionVideoDetailPhoto:") && item?.photoUrl) {
        const authorRef = item.author?.__ref;
        videos.set(key.slice("VisionVideoDetailPhoto:".length), {...item, author: value[authorRef] || item.author});
      } else if (key !== "author") collect(item);
    }
  }

  const isDetailAPI = url => /\/graphql|\/live_api\/profile\/feedbyid/.test(String(url));
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    if (isDetailAPI(response.url) && response.ok) response.clone().json().then(collect).catch(() => {});
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    if (isDetailAPI(url)) this.addEventListener("load", () => {
      if (this.status !== 200) return;
      try { collect(this.responseType === "json" ? this.response : JSON.parse(this.responseText)); }
      catch { /* 页面可能返回验证 HTML；不打断播放器。 */ }
    }, {once: true});
    return originalOpen.call(this, method, url, ...args);
  };

  async function getDetail(id) {
    const state = window.__APOLLO_STATE__?.defaultClient;
    if (state) {
      const photo = state[`VisionVideoDetailPhoto:${id}`];
      const author = Object.values(state).find(item => item?.photo?.__ref === `VisionVideoDetailPhoto:${id}`)?.author;
      if (photo) collect({photo: {...photo, id}, author: state[author?.__ref]});
    }
    collect(window.INIT_STATE);
    if (!videos.has(id)) {
      const response = await window.fetch("/graphql", {
        method: "POST", credentials: "include", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          operationName: "visionVideoDetail", variables: {photoId: id, page: "detail"},
          query: "query visionVideoDetail($photoId: String, $page: String) { visionVideoDetail(photoId: $photoId, page: $page) { status type author { id name } photo { id caption photoUrl coverUrl duration } } }"
        }), signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`快手详情接口返回 HTTP ${response.status}。`);
      const data = await response.json();
      collect(data);
      if (!videos.has(id)) throw new Error(data.errors?.[0]?.message || "快手没有返回视频地址，请先登录、完成验证并播放视频后重试。");
    }
    const photo = videos.get(id);
    return {id, videoId: id, platform: "kuaishou", title: photo.caption || id, author: photo.author?.name || photo.userName || "", url: photo.photoUrl, quality: "快手 MP4", extension: "mp4", contentType: "video/mp4", kind: "video", videoOnly: false};
  }

  window.__kuaishouDownloader = {getDetail};
})();
