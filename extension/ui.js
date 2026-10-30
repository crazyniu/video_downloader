// Shared helpers for popup.html and manager.html.
import {platformNames} from './platforms.js';
import {videoGroups} from './media-records.js';

export const $ = id => document.getElementById(id);
export const supportedPlatforms = Object.values(platformNames);
export const jobStates = {queued: '排队中', fetching: '下载中', merging: '合并音视频', saving: '正在保存', complete: '已完成', error: '失败', canceled: '已取消'};
export const activeStates = ['queued', 'fetching', 'merging', 'saving'];

export const sizeText = bytes => !bytes ? '大小未知' : bytes >= 1000 ** 3 ? `${(bytes / 1000 ** 3).toFixed(2)} GB` : bytes >= 1000 ** 2 ? `${(bytes / 1000 ** 2).toFixed(1)} MB` : bytes >= 1000 ? `${(bytes / 1000).toFixed(1)} KB` : `${bytes} B`;
export const speedText = speed => speed >= 1000 ** 2 ? `${(speed / 1000 ** 2).toFixed(1)} MB/s` : `${Math.round(speed / 1000)} KB/s`;
export const jobFraction = job => ['complete', 'saving'].includes(job.status) ? 1 : job.fraction || (job.size ? job.received / job.size : 0);

export async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function icon(name, slot) {
  const node = element('wa-icon');
  node.name = name;
  if (slot) node.slot = slot;
  return node;
}

export function iconButton(name, label, className = 'btn icon') {
  const node = element('button', undefined, className);
  node.type = 'button'; node.title = label;
  node.setAttribute('aria-label', label);
  node.append(icon(name));
  return node;
}

export function textButton(label, iconName, className = 'btn') {
  const node = element('button', undefined, className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.append(label);
  return node;
}


// Resolution comes from the platform when it reports one; otherwise it is read from the file's metadata.
const resolutions = new Map();
const probing = new Set();
const heightOf = format => format.height || resolutions.get(format.id) || 0;
const labelKind = {'原片候选': '原片', '高清 MP4': '高清', 'HLS': 'HLS'};
export function qualityText(format) {
  const height = heightOf(format);
  const kind = labelKind[format.quality] || '';
  if (height) return kind ? `${height}P ${kind}` : `${height}P`;
  if (kind) return kind;
  return format.kind === 'audio' ? '音轨' : '';
}
export const formatText = format => [qualityText(format), sizeText(format.size)].filter(Boolean).join(' · ');

export async function loadResolutions() {
  const stored = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) if (key.startsWith('res:')) resolutions.set(key.slice(4), value);
}

let probeQueue = [], probeRunning = 0, probeListener;
export function probeResolutions(formats, onChange) {
  probeListener = onChange;
  for (const format of formats) {
    if (heightOf(format) || resolutions.has(format.id) || probing.has(format.id) || format.kind !== 'video') continue;
    probing.add(format.id);
    probeQueue.push(format);
  }
  pumpProbes();
}
function pumpProbes() {
  while (probeRunning < 2 && probeQueue.length) {
    const format = probeQueue.shift();
    probeRunning++;
    const video = document.createElement('video');
    video.muted = true; video.preload = 'metadata';
    const done = height => {
      clearTimeout(timer);
      video.removeAttribute('src'); video.load();
      probing.delete(format.id);
      resolutions.set(format.id, height);
      void chrome.storage.session.set({[`res:${format.id}`]: height});
      probeRunning--;
      probeListener?.();
      pumpProbes();
    };
    const timer = setTimeout(() => done(0), 12000);
    video.addEventListener('loadedmetadata', () => done(Math.min(video.videoWidth, video.videoHeight) || Math.max(video.videoWidth, video.videoHeight)), {once: true});
    video.addEventListener('error', () => done(0), {once: true});
    video.src = format.url;
  }
}

export function thumb(item) {
  const node = element('div', undefined, 'thumb');
  node.dataset.platform = item.platform;
  if (supportedPlatforms.includes(item.platform)) node.textContent = item.platform.slice(0, 1);
  else node.append(icon(item.kind === 'hls' ? 'film' : 'video'));
  return node;
}

// One row per work, best resolution first; the chosen quality decides which record the row stands for.
export function groupedItems(items, chosen) {
  return videoGroups(items).map(group => {
    // Streams captured from the page's own player add nothing once formats with a known quality exist.
    const known = group.formats.filter(format => qualityText(format));
    const formats = (known.length ? known : group.formats).toSorted((a, b) => heightOf(b) - heightOf(a) || (b.size || 0) - (a.size || 0));
    return {...(formats.find(item => item.id === chosen.get(group.key)) || formats[0]), groupKey: group.key, formats};
  });
}

export function qualitySelect(item, onChange, className = 'quality-select') {
  const select = element('wa-select', undefined, `${className} label-hidden`);
  select.size = 's'; select.label = `选择 ${item.title} 的画质`; select.value = item.id;
  for (const format of item.formats) {
    const option = element('wa-option', formatText(format));
    option.value = format.id;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export async function queue(ids) {
  const {downloadThreads = '8', downloadMode = 'auto'} = await chrome.storage.local.get(['downloadThreads', 'downloadMode']);
  return send({type: 'QUEUE_DOWNLOADS', ids, threads: Number(downloadThreads), mode: downloadMode});
}

let toastTimer;
export function toast(text, error = false) {
  let node = document.querySelector('.toast');
  clearTimeout(toastTimer);
  if (!text) { node?.remove(); return; }
  if (!node) {
    node = element('div', undefined, 'toast');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.append(node);
  }
  node.classList.remove('leaving');
  node.dataset.error = String(error);
  node.replaceChildren(icon(error ? 'circle-alert' : 'circle-check'), element('span', text));
  toastTimer = setTimeout(() => {
    node.classList.add('leaving');
    toastTimer = setTimeout(() => node.remove(), 200);
  }, error ? 6000 : 2600);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制视频地址'); }
  catch (error) { toast(error.message, true); }
}

// Parse requests report progress through chrome.storage.session under parse:<requestId>.
export function createParser({onState, onReady}) {
  let requestId, state;
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = area === 'session' && requestId && changes[`parse:${requestId}`]?.newValue;
    if (!change) return;
    state = change;
    onState(state);
    if (state.status === 'ready') onReady?.(state);
    if (state.status !== 'loading') void chrome.storage.session.remove(`parse:${requestId}`);
  });
  return {
    get state() { return state; },
    async parse(value, quality) {
      if (!value || state?.status === 'loading') return;
      requestId = crypto.randomUUID();
      state = {status: 'loading', message: '正在识别链接…'};
      onState(state);
      try { await send({type: 'PARSE_URL', requestId, value, quality}); }
      catch (error) { state = {status: 'error', message: error.message}; onState(state); }
    },
    reset() { state = null; }
  };
}
