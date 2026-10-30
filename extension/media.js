import {mediaSize} from './media-records.js';

export const platformName = url => {
  const host = new URL(url).hostname;
  if (/(^|\.)douyin\.com$/.test(host)) return '抖音';
  if (/(^|\.)(kuaishou\.com|kuaishou\.cn|chenzhongtech\.com|chenzhongtech\.cn)$/.test(host)) return '快手';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'TikTok';
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) return 'X';
  if (/(^|\.)(telegram\.org|t\.me)$/.test(host)) return 'Telegram';
  return '其他网站';
};

export function normalizeMediaURL(value) {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

export function mediaType(url, contentType = '') {
  if (/video\/(mp2t|iso\.segment)/i.test(contentType)) return null;
  const path = new URL(url).pathname;
  if (/\.(ts|m4s|vtt)(?:$|\/)/i.test(path)) return null;
  if (/mpegurl/i.test(contentType) || /\.m3u8$/i.test(path)) return 'hls';
  if (/^video\//i.test(contentType) || /\.(mp4|webm|mov|m4v|ogv)$/i.test(path)) return 'video';
  if (/^audio\//i.test(contentType)) return 'audio';
  return null;
}

export async function probeMediaFile(url) {
  const response = await fetch(url, {headers: {Range: 'bytes=0-0'}, credentials: 'include', signal: AbortSignal.timeout(15000)});
  try {
    if (!response.ok) throw new Error(`视频地址返回 HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const kind = mediaType(response.url, contentType);
    if (!kind || /text\/html|application\/json/i.test(contentType)) throw new Error('地址未返回可识别的媒体文件。');
    const size = mediaSize(response.status, name => response.headers.get(name) || '', kind);
    return {url: response.url, contentType, kind, size, sizeVerified: size > 0, sizeCheckedAt: Date.now()};
  } finally { await response.body?.cancel(); }
}

export function fileName(title, quality, contentType = 'video/mp4') {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+/g, '_').trim().slice(0, 90) || '视频';
  const extension = contentType.includes('webm') ? 'webm' : contentType.includes('quicktime') ? 'mov' : 'mp4';
  return `${safe}_${quality}.${extension}`;
}

export function byteRanges(size, chunkSize = 4 * 1024 * 1024) {
  return Array.from({length: Math.ceil(size / chunkSize)}, (_, index) => ({
    start: index * chunkSize, end: Math.min(size - 1, (index + 1) * chunkSize - 1)
  }));
}

export async function fetchVideo(url, {threads, signal, onProgress, pageFetch}) {
  const read = async (start, end) => {
    if (pageFetch) return pageFetch(url, start, end, signal);
    return fetch(url, {headers: {Range: `bytes=${start}-${end}`}, credentials: 'include', signal});
  };
  const probe = await read(0, 0);
  const contentType = probe.headers.get('content-type') || 'video/mp4';
  if (/text\/html|application\/json/i.test(contentType)) {
    await probe.body?.cancel();
    throw new Error('视频地址返回了验证页面，请回到作品页重新识别。');
  }
  const total = Number(probe.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] || 0);
  const ranged = probe.status === 206;
  if (!probe.ok) {
    await probe.body?.cancel();
    throw new Error(`视频地址返回 HTTP ${probe.status}，请回到作品页重新识别。`);
  }
  let received = 0;
  const readBody = async (response, size) => {
    const reader = response.body.getReader();
    const pieces = [];
    let length = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      pieces.push(value); length += value.byteLength; received += value.byteLength;
      onProgress(received, size);
    }
    return {blob: new Blob(pieces, {type: contentType}), length};
  };
  if (!ranged) {
    // 不支持 Range 的服务器直接读取这次响应，避免取消后重新下载。
    const response = probe.status === 200 ? probe : pageFetch ? await pageFetch(url, null, null, signal) : await fetch(url, {credentials: 'include', signal});
    if (!response.ok) throw new Error(`下载返回 HTTP ${response.status}`);
    return (await readBody(response, Number(response.headers.get('content-length')) || 0)).blob;
  }
  await probe.body?.cancel();
  // 大文件减少碎片请求；保留足够分段供各线程持续工作。
  const chunkSize = Math.max(4 * 1024 ** 2, Math.min(32 * 1024 ** 2, Math.ceil(total / (threads * 4))));
  const ranges = byteRanges(total, chunkSize);
  const chunks = new Array(ranges.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(threads, ranges.length)}, async () => {
    while (next < ranges.length) {
      const index = next++;
      const {start, end} = ranges[index];
      const response = await read(start, end);
      const range = response.headers.get('content-range');
      if (response.status !== 206 || (range && range !== `bytes ${start}-${end}/${total}`) || !response.ok) {
        throw new Error('服务器返回的分段范围不一致，已停止合并，请重新识别视频。');
      }
      const part = await readBody(response, total);
      if (part.length !== end - start + 1) throw new Error('视频分段不完整，请重新下载。');
      chunks[index] = part.blob;
    }
  }));
  return new Blob(chunks, {type: contentType});
}
