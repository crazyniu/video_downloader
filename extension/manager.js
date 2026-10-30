import './vendor/ui/components.js';
import Hls from './vendor/ui/hls.js';
import {videoGroups} from './media-records.js';
import {$, activeStates, copyText, element, groupedItems, icon, iconButton, jobFraction, jobStates, loadResolutions, probeResolutions, qualitySelect, qualityText, send, sizeText, speedText, supportedPlatforms, textButton, thumb, toast} from './ui.js';

const selected = new Set();
const chosenFormats = new Map();
let items = [], jobs = [], inputTimer;
const pageURL = new URL(location.href);
const sourceTabId = Number(pageURL.searchParams.get('tabId')) || 0;
$('version').textContent = `大懒虫 ${chrome.runtime.getManifest().version}`;

/* ---------- Videos ---------- */
function visibleItems() {
  const query = $('search').value.trim().toLowerCase();
  const platform = $('platform').value;
  return groupedItems(items, chosenFormats).filter(item =>
    ($('scope').value !== 'current' || item.sourceTabId === sourceTabId) &&
    (platform === 'all' || (platform === 'other' ? !supportedPlatforms.includes(item.platform) : item.platform === platform)) &&
    `${item.title} ${item.sourceUrl}`.toLowerCase().includes(query));
}

function renderSelection() {
  const visible = visibleItems();
  const checked = visible.filter(item => selected.has(item.id)).length;
  $('select-all').checked = visible.length > 0 && checked === visible.length;
  $('select-all').indeterminate = checked > 0 && checked < visible.length;
  $('select-all').disabled = visible.length === 0;
  $('batch-bar').hidden = selected.size === 0;
  $('batch-summary').textContent = `已选 ${selected.size} 个视频`;
  document.querySelectorAll('.media-row').forEach(row => { row.dataset.selected = String(selected.has(row.dataset.id)); });
}

function mediaRow(item) {
  const row = element('article', undefined, item.formats.length > 1 ? 'media-row has-formats' : 'media-row');
  row.dataset.id = item.id;

  const checkbox = element('wa-checkbox');
  checkbox.checked = selected.has(item.id);
  checkbox.append(element('span', `选择 ${item.title}`, 'sr-only'));
  checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); renderSelection(); });

  const main = element('div', undefined, 'media-main');
  const text = element('div', undefined, 'media-text');
  const title = element('div', item.title || '网页视频', 'media-title ellipsis');
  title.title = item.title || '';
  const meta = element('div', undefined, 'media-meta');
  meta.append(element('span', item.platform, supportedPlatforms.includes(item.platform) ? 'pill brand' : 'pill'));
  if (item.author) meta.append(element('span', item.author, 'ellipsis'));
  if (item.videoOnly) meta.append(element('span', '自动合并音轨', 'pill'));
  if (item.kind === 'hls' && !item.quality?.includes('HLS')) meta.append(element('span', 'HLS', 'pill'));
  const source = element('a', new URL(item.sourceUrl).hostname, 'source ellipsis');
  source.href = item.sourceUrl; source.target = '_blank'; source.rel = 'noreferrer'; source.title = item.sourceUrl;
  meta.append(source);
  text.append(title, meta);
  main.append(thumb(item), text);

  const quality = element('div', undefined, 'media-quality');
  if (item.formats.length > 1) {
    quality.append(qualitySelect(item, id => {
      chosenFormats.set(item.groupKey, id);
      if (selected.delete(item.id)) selected.add(id);
      renderMedia();
    }));
  } else quality.textContent = qualityText(item);

  const size = element('div', item.formats.length > 1 ? '' : sizeText(item.size), item.size ? 'media-size' : 'media-size unknown');
  if (item.size) size.title = `${item.size.toLocaleString('zh-CN')} 字节`;

  const actions = element('div', undefined, 'media-actions');
  const preview = iconButton('eye', '预览');
  preview.onclick = () => openPreview(item);
  const copy = iconButton('copy', '复制视频地址');
  copy.onclick = () => void copyText(item.url);
  const download = textButton('', 'download', 'btn soft sm');
  download.append(element('span', '下载', 'label'));
  download.setAttribute('aria-label', '下载');
  download.onclick = () => void start([item.id]);
  actions.append(preview, copy, download);

  row.append(checkbox, main, quality, size, actions);
  return row;
}

function renderMedia() {
  const visible = visibleItems();
  const total = videoGroups(items).length;
  probeResolutions(visible.flatMap(item => item.formats), renderMedia);
  $('visible-count').textContent = `${visible.length} 个`;
  $('table-head').hidden = visible.length === 0;
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h3').textContent = total ? '没有匹配的视频' : '还没有视频';
  $('empty').querySelector('p').textContent = total ? '换个关键词，或调整平台和网页筛选' : '在上方粘贴链接，或打开视频网页并播放';
  $('media-list').replaceChildren(...visible.map(mediaRow));
  renderSelection();
}

async function start(ids) {
  try {
    const {jobIds} = await send({type: 'QUEUE_DOWNLOADS', ids, threads: Number($('threads').value), mode: $('download-mode').value});
    toast(`已添加 ${jobIds.length} 个下载任务`);
  } catch (error) { toast(error.message, true); }
}

/* ---------- Parse ---------- */
// One request per line, run one after another so platform pages are not opened all at once.
const parseJobs = new Map();
const parseByRequest = new Map();
let parseChain = Promise.resolve(), filtersReset = false;
const linkLines = () => [...new Set($('video-url').value.split('\n').map(line => line.trim()).filter(line => /https?:\/\/\S+\.\S+/i.test(line)))];

function finishParse(job, state) {
  job.state = state;
  if (state.status === 'ready') {
    const preferred = state.items.find(item => item.id === state.preferredId) || state.items[0];
    chosenFormats.set(videoGroups([preferred])[0].key, preferred.id);
    selected.add(preferred.id);
    job.onReady?.(preferred);
    if (!filtersReset) { $('scope').value = 'all'; $('platform').value = 'all'; $('search').value = ''; filtersReset = true; }
  }
  if (state.status !== 'loading') { parseByRequest.delete(job.requestId); job.done?.(); }
  renderParse();
}

function enqueueParse(value, onReady) {
  const job = {value, onReady, requestId: crypto.randomUUID(), quality: $('parse-quality').value, state: {status: 'queued', message: '等待解析'}};
  parseJobs.set(value, job);
  parseByRequest.set(job.requestId, job);
  parseChain = parseChain.then(() => new Promise(resolve => {
    job.done = resolve;
    job.state = {status: 'loading', message: '正在识别…'};
    renderParse();
    send({type: 'PARSE_URL', requestId: job.requestId, value: job.value, quality: job.quality})
      .catch(error => finishParse(job, {status: 'error', message: error.message}));
  }));
}

function parseLines(retryFailed = false) {
  clearTimeout(inputTimer);
  filtersReset = false;
  for (const value of linkLines()) {
    const job = parseJobs.get(value);
    if (!job || (retryFailed && job.state.status === 'error')) enqueueParse(value);
  }
  renderParse();
}

function resultRow(job) {
  const {status, message, sourceTabId} = job.state;
  const row = element('li', undefined, 'result');
  row.dataset.status = status;
  const state = element('span', undefined, 'result-state');
  state.append(status === 'loading' ? element('wa-spinner') : icon(status === 'ready' ? 'circle-check' : status === 'error' ? 'circle-alert' : 'link'));
  const text = element('span', undefined, 'result-text');
  const link = element('span', job.value.match(/https?:\/\/\S+/i)?.[0] || job.value, 'result-link ellipsis');
  link.title = job.value;
  text.append(link, element('span', message, 'result-message ellipsis'));
  const actions = element('span', undefined, 'result-actions');
  if (status === 'error') {
    if (sourceTabId) {
      const open = iconButton('external-link', '打开来源网页', 'btn sm icon');
      open.onclick = () => void chrome.tabs.update(sourceTabId, {active: true}).catch(error => toast(error.message, true));
      actions.append(open);
    }
    const retry = iconButton('refresh-cw', '重试', 'btn sm icon');
    retry.onclick = () => { parseJobs.delete(job.value); enqueueParse(job.value); renderParse(); };
    actions.append(retry);
  }
  row.append(state, text, actions);
  return row;
}

function renderParse() {
  const all = [...parseJobs.values()];
  const count = linkLines().length;
  $('link-count').textContent = count ? `识别到 ${count} 个链接` : '粘贴后自动识别，每行一个链接';
  $('parse-results').hidden = !all.length;
  const ready = all.filter(job => job.state.status === 'ready');
  const failed = all.filter(job => job.state.status === 'error').length;
  const pending = all.length - ready.length - failed;
  $('results-summary').textContent = [pending && `${pending} 个解析中`, ready.length && `${ready.length} 个完成`, failed && `${failed} 个失败`].filter(Boolean).join(' · ');
  $('results-clear').disabled = pending > 0;
  $('results-list').replaceChildren(...all.map(resultRow));
}

$('parse-form').addEventListener('submit', event => { event.preventDefault(); parseLines(true); });
$('video-url').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); parseLines(true); }
});
const fitInput = () => { $('video-url').style.height = 'auto'; $('video-url').style.height = `${$('video-url').scrollHeight}px`; };
$('video-url').addEventListener('input', event => {
  clearTimeout(inputTimer);
  fitInput();
  renderParse();
  if (!event.isComposing && linkLines().some(line => !parseJobs.has(line))) inputTimer = setTimeout(() => parseLines(), 800);
});
$('results-clear').addEventListener('click', () => {
  for (const [value, job] of parseJobs) if (job.state.status !== 'loading' && job.state.status !== 'queued') parseJobs.delete(value);
  $('video-url').value = '';
  fitInput();
  renderParse();
});

/* ---------- Toolbar ---------- */
for (const name of supportedPlatforms) {
  const option = element('wa-option', name); option.value = name;
  $('platform').insertBefore(option, $('platform').querySelector('[value=other]'));
}
if (!sourceTabId) $('scope').querySelector('[value=current]').disabled = true;
$('search').addEventListener('input', renderMedia);
$('search').addEventListener('wa-clear', renderMedia);
$('platform').addEventListener('change', renderMedia);
$('scope').addEventListener('change', renderMedia);
$('select-all').addEventListener('change', () => {
  for (const item of visibleItems()) { if ($('select-all').checked) selected.add(item.id); else selected.delete(item.id); }
  renderMedia();
});
$('batch-download').addEventListener('click', () => void start([...selected]));
$('batch-clear').addEventListener('click', () => { selected.clear(); renderMedia(); });
$('rescan').addEventListener('click', async () => {
  $('rescan').disabled = true;
  try {
    const ids = $('scope').value === 'current' ? [sourceTabId] : [...new Set(items.map(item => item.sourceTabId).filter(id => id > 0))];
    if (!ids.length) ids.push(...(await chrome.tabs.query({})).filter(tab => /^https?:/.test(tab.url || '')).map(tab => tab.id));
    const results = await Promise.allSettled(ids.map(async tabId => {
      await chrome.scripting.executeScript({target: {tabId, allFrames: true}, files: ['bridge.js']});
      await chrome.scripting.executeScript({target: {tabId, allFrames: true}, world: 'MAIN', files: ['capture.js']});
      await chrome.scripting.executeScript({target: {tabId, allFrames: true}, world: 'MAIN', func: () => window.__professionalVideoCapture?.scan(true)});
    }));
    const scanned = results.filter(result => result.status === 'fulfilled').length;
    toast(scanned ? `已重新扫描 ${scanned} 个网页` : '来源网页已关闭，请重新打开作品页并播放视频', !scanned);
  } catch (error) { toast(error.message, true); }
  finally { $('rescan').disabled = false; }
});
$('clear').addEventListener('click', async () => {
  try {
    await send({type: 'CLEAR_LIBRARY'});
    selected.clear(); await refresh();
    toast('已清空视频记录，进行中的下载不受影响');
  } catch (error) { toast(error.message, true); }
});

/* ---------- Downloads ---------- */
function jobRow(job) {
  const active = activeStates.includes(job.status);
  const row = element('div', undefined, active ? 'job-row active' : 'job-row');
  row.dataset.status = job.status;
  const badge = element('div', undefined, 'job-icon');
  badge.append(icon(job.status === 'complete' ? 'circle-check' : job.status === 'error' ? 'circle-alert' : job.status === 'canceled' ? 'x' : 'arrow-down-to-line'));

  const body = element('div', undefined, 'job-body');
  const title = element('div', job.title, 'job-title ellipsis'); title.title = job.title;
  body.append(title);
  const fraction = jobFraction(job);
  if (active || job.status === 'error') {
    const progress = element('wa-progress-bar', undefined, 'job-progress');
    progress.label = `${job.title} 下载进度`;
    progress.value = Math.min(100, fraction * 100);
    progress.indeterminate = !fraction && ['fetching', 'merging'].includes(job.status);
    body.append(progress);
  }
  const meta = element('div', undefined, 'job-meta');
  meta.append(element('span', jobStates[job.status], 'state'));
  if (active && fraction) meta.append(element('span', `${Math.round(fraction * 100)}%`));
  if (job.received || job.size) meta.append(element('span', job.status === 'complete' ? sizeText(job.size || job.received) : `${sizeText(job.received)}${job.size ? ` / ${sizeText(job.size)}` : ''}`));
  if (active && job.speed) meta.append(element('span', speedText(job.speed)));
  const quality = qualityText({...job, id: job.mediaId});
  if (quality) meta.append(element('span', quality));
  body.append(meta);
  if (job.status === 'error' && job.error) body.append(element('p', job.error, 'job-error'));
  const notes = {running: '地址可能已失效，正在按来源网页重新解析…', done: '已按来源网页重新解析，新任务已加入列表', failed: `重新解析失败：${job.refreshError}`};
  if (job.refresh) body.append(element('p', notes[job.refresh], job.refresh === 'failed' ? 'job-note failed' : 'job-note'));

  const actions = element('div', undefined, 'job-actions');
  if (active) {
    const cancel = textButton('取消', undefined, 'btn sm outline');
    cancel.onclick = () => void send({type: 'CANCEL_JOB', id: job.id}).catch(error => toast(error.message, true));
    actions.append(cancel);
  }
  if (['error', 'canceled'].includes(job.status) && job.sourceUrl && !['running', 'done'].includes(job.refresh)) {
    const retry = textButton('重新解析下载', 'refresh-cw', 'btn sm soft');
    retry.onclick = () => void send({type: 'REFRESH_JOB', id: job.id}).catch(error => toast(error.message, true));
    actions.append(retry);
  }
  row.append(badge, body, actions);
  return row;
}

function renderJobs() {
  const active = jobs.filter(job => activeStates.includes(job.status)).length;
  $('active-count').textContent = String(active);
  $('complete-count').textContent = String(jobs.filter(job => job.status === 'complete').length);
  $('failed-count').textContent = String(jobs.filter(job => ['error', 'canceled'].includes(job.status)).length);
  if (!jobs.length) {
    const empty = element('div', undefined, 'empty');
    const art = element('div', undefined, 'empty-art'); art.append(icon('folder-down'));
    const link = element('a', '去选择视频'); link.href = '#videos';
    const hint = element('p'); hint.append('在视频列表点击下载后，任务会出现在这里。', link);
    empty.append(art, element('h3', '暂无下载任务'), hint);
    $('job-list').replaceChildren(empty);
    return;
  }
  $('job-list').replaceChildren(...jobs.toSorted((a, b) => b.createdAt - a.createdAt).map(jobRow));
}

/* ---------- Preview ---------- */
let previewHls;
const previewVideo = $('preview-video');
const timeText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let previewItem;
const previewNotice = (text, refreshable = false) => { $('preview-notice').textContent = text; $('preview-problem').hidden = !text; $('preview-refresh').hidden = !refreshable; };
const togglePlay = () => { if (previewVideo.paused) void playPreview(); else previewVideo.pause(); };
function closePreviewMedia() {
  previewVideo.pause();
  if (previewHls) { previewHls.destroy(); previewHls = null; }
  previewVideo.removeAttribute('src');
  previewVideo.load();
  $('preview-loading').hidden = true;
  $('preview-seek').value = 0;
  $('preview-seek').disabled = true;
  $('preview-time').textContent = '0:00 / 0:00';
}
function playPreview() {
  return previewVideo.play().catch(error => { if (error.name !== 'AbortError') previewNotice('暂时无法播放，可点击播放重试或打开来源网页。'); });
}
function openPreview(item) {
  previewItem = item;
  closePreviewMedia();
  previewNotice(item.videoOnly ? '此画质只有画面，下载时会自动合并音轨。' : '');
  $('preview-loading').hidden = false;
  $('video-preview').label = item.title || '视频预览';
  $('preview-source').href = item.sourceUrl;
  $('video-preview').open = true;
  if (item.kind === 'hls' && !previewVideo.canPlayType('application/vnd.apple.mpegurl')) {
    previewHls = new Hls({enableWorker: false});
    previewHls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) { previewHls.stopLoad(); $('preview-loading').hidden = true; previewNotice('预览加载失败，视频地址可能已失效。', true); }
    });
    previewHls.loadSource(item.url);
    previewHls.attachMedia(previewVideo);
  } else previewVideo.src = item.url;
  void playPreview();
}
$('preview-refresh').addEventListener('click', () => {
  previewNotice('正在按来源网页重新解析…');
  parseJobs.delete(previewItem.sourceUrl);
  enqueueParse(previewItem.sourceUrl, fresh => { if ($('video-preview').open) openPreview(fresh); });
  renderParse();
});
$('video-preview').addEventListener('wa-after-hide', event => { if (event.target === $('video-preview')) closePreviewMedia(); });
$('preview-play').addEventListener('click', togglePlay);
previewVideo.addEventListener('click', togglePlay);
for (const type of ['play', 'pause', 'ended']) previewVideo.addEventListener(type, () => {
  const label = previewVideo.paused ? '播放' : '暂停';
  $('preview-play').title = label; $('preview-play').setAttribute('aria-label', label);
  $('preview-play').querySelector('wa-icon').name = previewVideo.paused ? 'play' : 'pause';
});
for (const type of ['timeupdate', 'loadedmetadata', 'durationchange']) previewVideo.addEventListener(type, () => {
  const duration = Number.isFinite(previewVideo.duration) ? previewVideo.duration : 0;
  $('preview-time').textContent = `${timeText(previewVideo.currentTime)} / ${timeText(duration)}`;
  $('preview-seek').disabled = !duration;
  $('preview-seek').max = duration || 100;
  $('preview-seek').value = previewVideo.currentTime;
});
$('preview-seek').addEventListener('input', () => { previewVideo.currentTime = $('preview-seek').value; });
$('preview-mute').addEventListener('click', () => {
  previewVideo.muted = !previewVideo.muted;
  const label = previewVideo.muted ? '取消静音' : '静音';
  $('preview-mute').title = label; $('preview-mute').setAttribute('aria-label', label);
  $('preview-mute').querySelector('wa-icon').name = previewVideo.muted ? 'volume-x' : 'volume-2';
});
previewVideo.addEventListener('loadeddata', () => {
  $('preview-loading').hidden = true;
  if (!previewVideo.videoWidth) previewNotice('暂未读取到视频画面，请选择其他画质或打开来源网页。');
});
previewVideo.addEventListener('playing', () => { $('preview-loading').hidden = true; });
previewVideo.addEventListener('waiting', () => { if ($('video-preview').open) $('preview-loading').hidden = false; });
previewVideo.addEventListener('error', () => {
  $('preview-loading').hidden = true;
  if (previewVideo.error?.code === 3) previewNotice('浏览器无法解码此画质，请选择其他画质或直接下载。');
  else previewNotice('预览加载失败，视频地址可能已失效。', true);
});

/* ---------- Settings ---------- */
const modeHints = {auto: '普通视频由 Chrome 直接下载；HLS、分轨视频自动使用扩展下载器。', parallel: '所有视频都由扩展分段并行下载，再保存为文件。'};
const preferences = await chrome.storage.local.get(['downloadThreads', 'downloadMode']);
if (preferences.downloadThreads) $('threads').value = preferences.downloadThreads;
if (preferences.downloadMode) $('download-mode').value = preferences.downloadMode;
$('mode-hint').textContent = modeHints[$('download-mode').value];
$('threads').addEventListener('change', () => void chrome.storage.local.set({downloadThreads: $('threads').value}));
$('download-mode').addEventListener('change', () => {
  $('mode-hint').textContent = modeHints[$('download-mode').value];
  void chrome.storage.local.set({downloadMode: $('download-mode').value});
});
$('help').addEventListener('click', () => { $('help-dialog').open = true; });

/* ---------- Routing & data ---------- */
const pageTitles = {videos: '视频', downloads: '下载', settings: '设置'};
function renderPage() {
  const page = location.hash.slice(1) in pageTitles ? location.hash.slice(1) : 'videos';
  for (const name of Object.keys(pageTitles)) $(`${name}-view`).hidden = name !== page;
  document.querySelectorAll('.tab').forEach(tab => {
    if (tab.dataset.page === page) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
  document.title = `${pageTitles[page]} · 大懒虫`;
  $('batch-bar').classList.toggle('off-page', page !== 'videos');
}
window.addEventListener('hashchange', renderPage);
renderPage();

async function refresh() {
  const data = await send({type: 'LIST_LIBRARY'});
  items = data.items.sort((a, b) => b.createdAt - a.createdAt);
  jobs = data.jobs;
  for (const id of selected) if (!items.some(item => item.id === id)) selected.delete(id);
  renderMedia(); renderJobs();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const [key, change] of Object.entries(changes)) {
    const job = key.startsWith('parse:') && change.newValue && parseByRequest.get(key.slice(6));
    if (!job) continue;
    if (change.newValue.status === 'loading') { job.state = change.newValue; renderParse(); }
    else { finishParse(job, change.newValue); void chrome.storage.session.remove(key); }
  }
  if (Object.keys(changes).some(key => key.startsWith('media:')) || Object.values(changes).some(change => change.newValue?.status === 'ready')) {
    void refresh().catch(error => toast(error.message, true));
  } else if (Object.keys(changes).some(key => key.startsWith('job:'))) {
    for (const [key, change] of Object.entries(changes)) if (key.startsWith('job:') && change.newValue) {
      const index = jobs.findIndex(job => job.id === change.newValue.id);
      if (index < 0) jobs.push(change.newValue); else jobs[index] = change.newValue;
    }
    renderJobs();
  }
});
await loadResolutions();
await refresh().catch(error => toast(error.message, true));

const initialURL = pageURL.searchParams.get('url');
if (initialURL) {
  pageURL.searchParams.delete('url');
  history.replaceState(null, '', pageURL);
  $('video-url').value = initialURL;
  parseLines();
}
