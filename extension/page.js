(() => {
  if (window.__douyinOriginal) return;

  const videos = new Map();
  let probe;

  function collect(value) {
    if (!value || typeof value !== "object") return;
    const id = value.aweme_id || value.awemeId;
    if (id && value.video) {
      videos.set(String(id), value);
      if (videos.size > 100) videos.delete(videos.keys().next().value);
      return;
    }
    Object.values(value).forEach(collect);
  }

  function readBootstrap() {
    const render = document.getElementById("RENDER_DATA");
    if (render) collect(JSON.parse(decodeURIComponent(render.textContent)));
    if (window._ROUTER_DATA) collect(window._ROUTER_DATA);

    // 新版独立视频页把详情放在 React Flight 的 JSON 记录中。
    for (const script of document.scripts) {
      const match = script.textContent.match(/^self\.__pace_f\.push\((\[1,"[\s\S]*"\])\);?$/);
      if (!match) continue;
      const text = JSON.parse(match[1])[1];
      for (const line of text.split("\n")) {
        const record = line.match(/^[\da-f]+:([\[{][\s\S]*)$/i);
        if (record) collect(JSON.parse(record[1]));
      }
    }
  }

  // 只读取抖音作品接口的响应；保留页面自己的请求、响应和 SDK 调用链。
  const isVideoAPI = url => String(url).includes("/aweme/v1/web/aweme/");
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    if (isVideoAPI(response.url) && response.ok) {
      response.clone().json().then(collect).catch(() => {});
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    if (isVideoAPI(url)) {
      this.addEventListener("load", () => {
        if (this.status !== 200) return;
        // 旁路观察失败不能影响抖音播放器本身。
        try {
          collect(this.responseType === "json" ? this.response : JSON.parse(this.responseText));
        } catch { /* 接口也可能返回验证码 HTML，而不是 JSON。 */ }
      }, {once: true});
    }
    return originalOpen.call(this, method, url, ...args);
  };

  function requestDetail(id) {
    const params = new URLSearchParams({
      device_platform: "webapp", aid: "6383", channel: "channel_pc_web", aweme_id: id,
      pc_client_type: "1", version_code: "190600", version_name: "19.6.0",
      cookie_enabled: "true", browser_language: navigator.language,
      browser_platform: navigator.platform, browser_name: "Chrome",
      browser_version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || "",
      screen_width: String(screen.width), screen_height: String(screen.height)
    });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", `/aweme/v1/web/aweme/detail/?${params}`);
      xhr.withCredentials = true;
      xhr.timeout = 12000;
      xhr.onload = () => {
        if (xhr.status !== 200) {
          reject(new Error(`详情接口返回 HTTP ${xhr.status}，请在抖音页面完成验证后重试。`));
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.status_code === 2483 || /请先登录|用户未登录/.test(data.status_msg || "")) {
            throw new Error("抖音要求登录，请先在当前页面登录。 ");
          }
          collect(data);
          resolve();
        } catch (error) {
          reject(new Error(`未能读取视频详情：${error.message}`));
        }
      };
      xhr.onerror = () => reject(new Error("详情请求失败，请确认当前页面能正常播放视频。"));
      xhr.ontimeout = () => reject(new Error("详情请求超时，请稍后重试。"));
      xhr.send();
    });
  }

  async function getDetail(id) {
    if (!videos.has(id)) readBootstrap();
    if (!videos.has(id)) await requestDetail(id);
    const item = videos.get(id);
    if (!item) throw new Error("抖音未返回这个作品的详情，请刷新视频页后重试。 ");
    if (item.images?.length || item.imageInfos?.length) {
      throw new Error("当前作品是图文，本插件目前只处理普通视频。 ");
    }
    const video = item.video;
    const address = video.play_addr || video.playAddr;
    const uri = address?.uri;
    if (!uri) throw new Error("详情中没有视频内部 ID，无法探测原片。 ");
    const rates = video.bit_rate || video.bitRateList || [];
    return {
      awemeId: id, videoId: uri, title: item.desc || id,
      author: item.author?.nickname || "", needCookie: Boolean(video.is_need_set_cookie),
      transcodeSize: Math.max(0, ...rates.map(rate => Number((rate.play_addr || rate.playAddr)?.data_size || (rate.play_addr || rate.playAddr)?.dataSize || 0))),
      hd: selectHD(rates),
      width: video.width || address.width || 0, height: video.height || address.height || 0
    };
  }

  // 沿用所提供插件的选档逻辑：MP4 优先分辨率、其次码率，同档选择最短地址。
  function selectHD(rates) {
    const candidates = rates.filter(rate => rate.format === "mp4" && (rate.play_addr || rate.playAddr)?.url_list?.length)
      .map(rate => {
        const address = rate.play_addr || rate.playAddr;
        const gear = rate.gear_name || "";
        const resolution = [1440, 1080, 720, 540, 480, 360].find(value => gear.includes(String(value)))
          || (gear.includes("4_") ? 2160 : Number(gear.match(/(\d{3,4})/)?.[1]) || Math.min(address.width || 0, address.height || 0));
        return {url: address.url_list.slice().sort((a, b) => a.length - b.length)[0], resolution, bitRate: rate.bit_rate || 0};
      }).sort((a, b) => b.resolution - a.resolution || b.bitRate - a.bitRate);
    return candidates[0] || null;
  }

  function startProbe(videoId, needCookie) {
    const params = new URLSearchParams({
      video_id: videoId, ratio: "default", line: "0", is_play_url: "1",
      watermark: "0", source: "PackSourceEnum_PUBLISH"
    });
    if (needCookie) params.set("ss_is_p_v_ss", "1");
    probe = new XMLHttpRequest();
    probe.open("GET", `/aweme/v1/play/?${params}`);
    probe.withCredentials = true;
    probe.timeout = 12000;
    probe.setRequestHeader("Range", "bytes=0-0");
    probe.send();
  }

  window.__douyinOriginal = {getDetail, startProbe, stopProbe: () => probe?.abort()};
})();
