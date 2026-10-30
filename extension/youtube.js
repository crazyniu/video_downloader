// Browser adaptation of yt-dlp's player-response / format extraction flow.
// yt-dlp 2026.10.26 is Unlicense; see PLATFORM_SOURCES.md.
(() => {
  if (window.__youtubeDownloader) return;
  const players = new Map();
  const playback = new Map();
  const published = new Set();
  const muxedItags = new Set([18, 22, 37, 38, 59, 78]);

  function currentId() {
    const url = new URL(location.href);
    return url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
  }

  function rememberPlayer(data) {
    if (data?.videoDetails?.videoId) players.set(data.videoDetails.videoId, data);
  }

  function rememberPlayback(value, videoId) {
    const url = new URL(value, location.href);
    if (!url.hostname.endsWith(".googlevideo.com") || !url.pathname.endsWith("/videoplayback")) return;
    const itag = url.searchParams.get("itag");
    const mime = url.searchParams.get("mime") || "";
    // SABR/UMP streams are not standalone video files.
    if (!itag || !/^(video|audio)\//.test(mime) || url.searchParams.get("sabr") === "1") return;
    for (const key of ["range", "rn", "rbuf"]) url.searchParams.delete(key);
    playback.set(`${videoId}:${itag}`, {url: url.href, itag: Number(itag), mimeType: mime, contentLength: url.searchParams.get("clen")});
  }

  function formatURL(format) {
    if (format.url) return format.url;
    const cipher = new URLSearchParams(format.signatureCipher || format.cipher || "");
    // Encrypted signatures are supplied by the active player's actual requests.
    if (!cipher.has("url") || cipher.has("s")) return null;
    const url = new URL(cipher.get("url"));
    if (cipher.has("sig")) url.searchParams.set(cipher.get("sp") || "signature", cipher.get("sig"));
    return url.href;
  }

  function getDetail(id) {
    rememberPlayer(window.ytInitialPlayerResponse);
    const player = document.querySelector("#movie_player");
    if (typeof player?.getPlayerResponse === "function") rememberPlayer(player.getPlayerResponse());
    if (currentId() !== id) throw new Error("YouTube 页面已切换，请重新解析当前视频。");
    const data = players.get(id);
    if (!data) throw new Error("尚未读取到这个视频的播放器详情，请播放视频后重试。");
    if (data.videoDetails.isLiveContent && !data.videoDetails.isPostLiveDvr) {
      const live = data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
      if (live?.isLiveNow) throw new Error("当前是直播流，请在直播结束后下载。");
    }
    const status = data.playabilityStatus;
    if (status?.status !== "OK" && !data.streamingData) {
      throw new Error(status?.reason || "当前视频不可播放，请先在 YouTube 页面登录或完成验证。");
    }
    const title = data.videoDetails.title || id;
    const author = data.videoDetails.author || "";
    const raw = [...(data.streamingData?.formats || []), ...(data.streamingData?.adaptiveFormats || [])];
    for (const [key, item] of playback) {
      if (key.startsWith(`${id}:`) && !raw.some(f => Number(f.itag) === item.itag)) raw.push(item);
    }
    const formats = [];
    let encrypted = 0;
    for (const format of raw) {
      if (format.drmFamilies?.length || format.drmTrackType) continue;
      const observed = playback.get(`${id}:${format.itag}`);
      const url = observed?.url || formatURL(format);
      if (!url) { encrypted++; continue; }
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".googlevideo.com")) continue;
      const contentType = format.mimeType || observed?.mimeType || "";
      const kind = contentType.startsWith("audio/") ? "audio" : "video";
      if (!/^(video|audio)\//.test(contentType)) continue;
      const videoOnly = kind === "video" && !format.audioQuality && !muxedItags.has(Number(format.itag));
      formats.push({
        url, title, author, videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        contentType, kind, videoOnly, itag: String(format.itag),
        quality: format.qualityLabel || (kind === "audio" ? "音轨" : `格式 ${format.itag}`),
        size: Number(format.contentLength || observed?.contentLength || 0),
        height: Number(format.height || 0), bitrate: Number(format.bitrate || 0),
        audioTrack: format.audioTrack || null, observed: Boolean(observed),
      });
    }
    formats.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    const video = formats.filter(f => f.kind === "video");
    if (!video.length) {
      throw new Error(encrypted ? "当前格式使用加密签名，请先播放视频并选择所需画质，再重新扫描以读取播放器的有效地址。" : "未找到可下载的普通视频文件；当前播放器可能使用 SABR 流式传输。");
    }
    return {id, platform: "youtube", title, author, formats, preferred: video[0], encrypted,
      message: encrypted ? "部分画质需要先在播放器中播放后才能识别。" : "已读取播放器可用格式。"};
  }

  function scan(force = false) {
    if (force) published.clear();
    const id = currentId();
    if (!id) return;
    let detail;
    try { detail = getDetail(id); }
    catch { return; } // 自动扫描不打断网页；手动解析会显示 getDetail 的错误。
    for (const item of detail.formats) {
      const key = `${id}:${item.url}`;
      if (published.has(key)) continue;
      published.add(key);
      window.postMessage({source: "professional-video-capture", item}, "*");
    }
    return detail;
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const videoId = currentId();
    const response = await originalFetch.apply(this, args);
    const request = args[0];
    const requestedURL = typeof request === "string" ? request : request.url || String(request);
    const url = new URL(requestedURL, location.href);
    if (url.hostname.endsWith(".googlevideo.com") && response.ok && /^(video|audio)\//.test(response.headers.get("content-type") || "")) {
      rememberPlayback(response.url || url.href, videoId);
      scan();
    } else if (url.pathname === "/youtubei/v1/player" && response.ok) {
      response.clone().json().then(data => { rememberPlayer(data); scan(); }).catch(() => {});
    }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const parsed = new URL(url, location.href);
    const videoId = currentId();
    if (parsed.hostname.endsWith(".googlevideo.com")) this.addEventListener("load", () => {
      if (this.status < 200 || this.status >= 300 || !/^(video|audio)\//.test(this.getResponseHeader("content-type") || "")) return;
      rememberPlayback(this.responseURL || parsed.href, videoId);
      scan();
    }, {once: true});
    else if (parsed.pathname === "/youtubei/v1/player") this.addEventListener("load", () => {
      try { rememberPlayer(this.responseType === "json" ? this.response : JSON.parse(this.responseText)); scan(); }
      catch { /* 接口可能返回验证页面。 */ }
    }, {once: true});
    return originalOpen.call(this, method, url, ...args);
  };

  window.__youtubeDownloader = {getDetail, scan};
  if (document.readyState !== "loading") scan();
  else document.addEventListener("DOMContentLoaded", scan, {once: true});
})();
