import {fetchVideo} from './media.js';
import {FFmpeg} from './vendor/ffmpeg/index.js';
const queue = [];
const controllers = new Map();
const urls = new Map();
const nativeCompletions = new Map();
let active = 0;
const send = async message => {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
};
const update = (id, patch) => send({type: 'JOB_UPDATE', id, patch});

async function mux(blobs, signal) {
  const ffmpeg = new FFmpeg();
  signal.addEventListener('abort', () => ffmpeg.terminate(), {once: true});
  try {
    await ffmpeg.load({coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
    for (let i = 0; i < blobs.length; i++) await ffmpeg.writeFile(`input${i}`, new Uint8Array(await blobs[i].arrayBuffer()));
    const args = blobs.flatMap((_, index) => ['-i', `input${index}`]);
    if (blobs.length === 2) args.push('-map', '0:v:0', '-map', '1:a:0');
    const code = await ffmpeg.exec([...args, '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
    if (code !== 0) throw new Error('音视频封装失败，未生成下载文件。');
    return new Blob([await ffmpeg.readFile('output.mp4')], {type: 'video/mp4'});
  } finally { ffmpeg.terminate(); }
}

async function hlsVideo(url, threads, signal, progress) {
  let response = await fetch(url, {signal, credentials: 'include'});
  if (!response.ok) throw new Error(`播放列表返回 HTTP ${response.status}`);
  let text = await response.text();
  const variants = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]+)\r?\n([^#\r\n]+)/g)];
  if (variants.length) {
    const best = variants.sort((a, b) => Number(b[1].match(/BANDWIDTH=(\d+)/)?.[1] || 0) - Number(a[1].match(/BANDWIDTH=(\d+)/)?.[1] || 0))[0];
    if (/AUDIO="/.test(best[1])) throw new Error('此播放列表有独立音轨，请播放视频后选择列表中识别到的完整媒体。');
    url = new URL(best[2].trim(), url).href;
    response = await fetch(url, {signal, credentials: 'include'});
    if (!response.ok) throw new Error(`播放列表返回 HTTP ${response.status}`);
    text = await response.text();
  }
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('当前是直播流，暂不支持直播录制。');
  if (/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text) || text.includes('#EXT-X-BYTERANGE')) throw new Error('此播放列表采用加密或字节区间分段，暂不支持下载。');
  const init = text.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const segments = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const sources = [...(init ? [init] : []), ...segments].map(path => new URL(path, url).href);
  const parts = new Array(sources.length);
  let next = 0, received = 0, done = 0;
  await Promise.all(Array.from({length: Math.min(threads, sources.length)}, async () => {
    while (next < sources.length) {
      const index = next++;
      const result = await fetch(sources[index], {signal, credentials: 'include'});
      if (!result.ok) throw new Error(`视频分段返回 HTTP ${result.status}`);
      parts[index] = await result.arrayBuffer();
      received += parts[index].byteLength;
      progress(received, 0, ++done / sources.length);
    }
  }));
  return new Blob(parts);
}

async function run(job) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const signal = controller.signal;
  let lastProgress = 0, lastReceived = 0;
  const progress = (received, size, fraction) => {
    if (Date.now() - lastProgress < 300 && received !== size && fraction !== 1) return;
    const now = Date.now();
    const speed = lastProgress ? Math.max(0, received - lastReceived) * 1000 / (now - lastProgress) : 0;
    lastProgress = now; lastReceived = received;
    void update(job.id, {received, size, fraction, speed}).catch(console.error);
  };
  const pageFetch = job.url.startsWith('blob:') ? async (url, start, end) => {
    signal.throwIfAborted();
    const result = await send({type: 'PAGE_RANGE', tabId: job.sourceTabId, frameId: job.frameId, url, start, end});
    signal.throwIfAborted();
    return new Response(Uint8Array.from(atob(result.data), char => char.charCodeAt(0)), {status: result.status, headers: result.headers});
  } : undefined;
  try {
    await update(job.id, {status: 'fetching'});
    if (job.engine === 'browser') {
      const completion = new Promise(resolve => nativeCompletions.set(job.id, resolve));
      await send({type: 'START_NATIVE', id: job.id});
      if (signal.aborted) await send({type: 'CANCEL_JOB', id: job.id});
      const poll = setInterval(() => { void send({type: 'SYNC_NATIVE', id: job.id}).catch(error => { controller.abort(); nativeCompletions.get(job.id)?.(error); }); }, 1000);
      try {
        const error = await completion;
        if (error) throw error;
      } finally { clearInterval(poll); }
      return;
    }
    let blob;
    if (job.audioUrl) {
      const tracks = [{received: 0, size: 0}, {received: 0, size: 0}];
      const trackProgress = index => (received, size) => {
        tracks[index] = {received, size};
        progress(tracks[0].received + tracks[1].received, tracks[0].size && tracks[1].size ? tracks[0].size + tracks[1].size : 0);
      };
      const blobs = await Promise.all([
        fetchVideo(job.url, {threads: job.threads, signal, onProgress: trackProgress(0), pageFetch}),
        fetchVideo(job.audioUrl, {threads: job.threads, signal, onProgress: trackProgress(1)})
      ]);
      await update(job.id, {status: 'merging'});
      blob = await mux(blobs, signal);
    } else if (job.kind === 'hls') {
      blob = await hlsVideo(job.url, job.threads, signal, progress);
      await update(job.id, {status: 'merging'});
      blob = await mux([blob], signal);
    } else blob = await fetchVideo(job.url, {threads: job.threads, signal, onProgress: progress, pageFetch});
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    urls.set(job.id, url);
    await send({type: 'SAVE_BLOB', id: job.id, url});
  } catch (error) {
    controller.abort();
    if (urls.has(job.id)) { URL.revokeObjectURL(urls.get(job.id)); urls.delete(job.id); }
    await update(job.id, {status: error.name === 'AbortError' ? 'canceled' : 'error', error: error.message});
  } finally { controllers.delete(job.id); nativeCompletions.delete(job.id); }
}
function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    run(job).finally(() => { active--; pump(); });
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'ENQUEUE') { queue.push(...message.jobs); pump(); }
  if (message.type === 'CANCEL') {
    const index = queue.findIndex(job => job.id === message.id);
    if (index !== -1) { queue.splice(index, 1); void update(message.id, {status: 'canceled'}); }
    controllers.get(message.id)?.abort();
  }
  if (message.type === 'LIVE_IDS') { respond({ids: [...queue.map(job => job.id), ...controllers.keys()]}); return; }
  if (message.type === 'RELEASE') {
    nativeCompletions.get(message.id)?.();
    if (urls.has(message.id)) { URL.revokeObjectURL(urls.get(message.id)); urls.delete(message.id); }
  }
  respond({ok: true});
});
