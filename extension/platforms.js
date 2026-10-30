export const platformNames = {douyin: "抖音", kuaishou: "快手", youtube: "YouTube"};

export function videoPage(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  let platform, id;
  if (parsed.protocol !== "https:") return null;
  if (host === "www.douyin.com") {
    platform = "douyin";
    id = parsed.searchParams.get("modal_id") || parsed.searchParams.get("vid") || parsed.pathname.match(/^\/video\/(\d+)/)?.[1];
    if (!/^\d+$/.test(id || "")) return null;
  } else if (["kuaishou.com", "kuaishou.cn", "chenzhongtech.com", "chenzhongtech.cn"].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    platform = "kuaishou";
    id = parsed.searchParams.get("photoId") || parsed.pathname.match(/^\/(?:short-video|fw\/photo)\/([\w-]+)/)?.[1];
    if (!/^[\w-]+$/.test(id || "")) return null;
  } else if (["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    platform = "youtube";
    id = host === "youtu.be" ? parsed.pathname.slice(1) : parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (!/^[\w-]{11}$/.test(id || "")) return null;
  } else return null;
  return {platform, id};
}

export function isMediaURL(url, platform = "douyin") {
  const parsed = new URL(url);
  const domains = platform === "kuaishou"
    ? ["kwai.net", "kwaicdn.com", "kwimgs.com", "yximgs.com", "gifshow.com", "kuaishou.com", "kuaishouzt.com", "ks-cdn.com"]
    : ["douyinvod.com", "idouyinvod.com", "ixigua.com", "365yg.com", "bytecdn.cn", "amemv.com", "snssdk.com", "toutiaovod.com"];
  return parsed.protocol === "https:" && domains.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
}
