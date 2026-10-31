import './vendor/ui/components.js';
import {createPlayer} from './player.js';
import {videoGroups} from './media-records.js';
import {$, activeStates, copyText, downloadState, element, groupedItems, icon, iconButton, loadResolutions, probeResolutions, qualitySelect, qualityText, send, sizeText, supportedPlatforms, thumb, toast} from './ui.js';

const selected = new Set();
const chosenFormats = new Map();
let items = [], jobs = [], inputTimer;
const pageURL = new URL(location.href);
// This page only lists works parsed here; videos captured on other pages are shown in the popup.
const parsedKeys = new Set(JSON.parse(sessionStorage.getItem('parsedKeys') || '[]'));
const saveParsed = () => sessionStorage.setItem('parsedKeys', JSON.stringify([...parsedKeys]));
const isDouyinLink = line => /https?:\/\/[^\s]*(douyin\.com|iesdouyin\.com)/i.test(line);
$('version').textContent = `大懒虫 ${chrome.runtime.getManifest().version}`;

/* ---------- Videos ---------- */
function visibleItems() {
  const query = $('search').value.trim().toLowerCase();
  return parsedItems().filter(item => `${item.title} ${item.author || ''} ${item.sourceUrl}`.toLowerCase().includes(query));
}
const parsedItems = () => groupedItems(items, chosenFormats).filter(item => parsedKeys.has(item.groupKey));

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
  actions.append(preview, copy, downloadState(item, jobs, () => start([item.id])));

  row.append(checkbox, main, quality, size, actions);
  return row;
}

function renderMedia() {
  const visible = visibleItems();
  const parsed = parsedItems();
  const total = parsed.length;
  probeResolutions(visible.flatMap(item => item.formats), renderMedia);
  $('visible-count').textContent = `${visible.length} 个`;
  $('table-head').hidden = visible.length === 0;
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h3').textContent = total ? '没有匹配的视频' : '还没有视频';
  $('empty').querySelector('p').textContent = total ? '换个关键词试试' : '在上方粘贴抖音链接，解析后会出现在这里';
  $('download-all').disabled = total === 0;
  $('clear').disabled = total === 0;
  const active = jobs.filter(job => activeStates.includes(job.status) && parsed.some(item => item.formats.some(format => format.id === job.mediaId))).length;
  $('job-summary').textContent = active ? `${active} 个视频下载中` : '';
  $('media-list').replaceChildren(...visible.map(mediaRow));
  renderSelection();
}

async function start(ids) {
  const {jobIds} = await send({type: 'QUEUE_DOWNLOADS', ids, threads: Number($('threads').value), mode: $('download-mode').value});
  toast(`已添加 ${jobIds.length} 个下载任务`);
}

/* ---------- Parse ---------- */
// One request per line, run one after another so platform pages are not opened all at once.
const parseJobs = new Map();
const parseByRequest = new Map();
let parseChain = Promise.resolve(), filtersReset = false;
const allLinkLines = () => [...new Set($('video-url').value.split('\n').map(line => line.trim()).filter(line => /https?:\/\/\S+\.\S+/i.test(line)))];
const linkLines = () => allLinkLines().filter(isDouyinLink);

function finishParse(job, state) {
  job.state = state;
  if (state.status === 'ready') {
    const preferred = state.items.find(item => item.id === state.preferredId) || state.items[0];
    const key = videoGroups([preferred])[0].key;
    chosenFormats.set(key, preferred.id);
    parsedKeys.add(key); saveParsed();
    selected.add(preferred.id);
    job.onReady?.(preferred);
    if (!filtersReset) { $('search').value = ''; filtersReset = true; }
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
  const skipped = allLinkLines().length - count;
  $('link-count').textContent = [count ? `识别到 ${count} 个抖音链接` : '粘贴后自动识别，每行一个抖音链接', skipped && `已忽略 ${skipped} 个非抖音链接`].filter(Boolean).join(' · ');
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
$('search').addEventListener('input', renderMedia);
$('search').addEventListener('wa-clear', renderMedia);
$('select-all').addEventListener('change', () => {
  for (const item of visibleItems()) { if ($('select-all').checked) selected.add(item.id); else selected.delete(item.id); }
  renderMedia();
});
$('batch-download').addEventListener('click', () => void start([...selected]).then(() => { selected.clear(); renderMedia(); }, error => toast(error.message, true)));
$('batch-clear').addEventListener('click', () => { selected.clear(); renderMedia(); });
$('download-all').addEventListener('click', () => void start(parsedItems().map(item => item.id)).catch(error => toast(error.message, true)));
$('clear').addEventListener('click', async () => {
  try {
    parsedKeys.clear(); saveParsed();
    selected.clear(); renderMedia();
    toast('已清空解析列表，进行中的下载不受影响');
  } catch (error) { toast(error.message, true); }
});

/* ---------- Preview ---------- */
// An expired address is resolved again from the work page, then the fresh record is previewed.
const player = createPlayer({onRefresh(item, show) {
  parseJobs.delete(item.sourceUrl);
  enqueueParse(item.sourceUrl, show);
  renderParse();
}});
const openPreview = item => player.open(item);

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
const pageTitles = {videos: '批量下载', settings: '设置'};
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
  renderMedia();
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
    for (const [key, change] of Object.entries(changes)) if (key.startsWith('job:')) {
      const index = jobs.findIndex(job => `job:${job.id}` === key);
      if (!change.newValue) { if (index >= 0) jobs.splice(index, 1); }
      else if (index < 0) jobs.push(change.newValue); else jobs[index] = change.newValue;
    }
    renderMedia();
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
