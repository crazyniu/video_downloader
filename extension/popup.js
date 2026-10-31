import './vendor/ui/components.js';
import {videoGroups} from './media-records.js';
import {videoPage} from './platforms.js';
import {createPlayer} from './player.js';
import {$, activeStates, copyText, downloadState, element, iconButton, loadResolutions, formatText, probeResolutions, queue, send, sizeText, thumb, toast} from './ui.js';

// One row per work, selected by group key.
const selected = new Set();
let items = [], jobs = [], visible = [];

// No quality picker: each work downloads its largest file. On Douyin the largest file is the original upload (原画).
function bestFormats() {
  return videoGroups(items).map(group => {
    const best = group.formats.reduce((a, b) => (b.size || 0) > (a.size || 0) ? b : a);
    return {...best, groupKey: group.key, formats: group.formats};
  });
}
// The popup is small: the preview fills its width, and fullscreen is not available in extension popups.
const player = createPlayer({fullscreen: false, bounds: () => ({maxWidth: innerWidth - 16, maxHeight: 420, minWidth: innerWidth - 16})});
const formatLabel = item => item.platform === '抖音' && item.formats.length > 1 ? `原画 · ${sizeText(item.size)}` : formatText(item);

$('open-workspace').addEventListener('click', () => {
  void chrome.tabs.create({url: chrome.runtime.getURL('manager.html#videos')});
  window.close();
});

function itemRow(item) {
  const row = element('article', undefined, 'item');
  row.dataset.selected = String(selected.has(item.groupKey));
  const checkbox = element('wa-checkbox');
  checkbox.checked = selected.has(item.groupKey);
  checkbox.append(element('span', `选择 ${item.title}`, 'sr-only'));
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(item.groupKey); else selected.delete(item.groupKey);
    row.dataset.selected = String(checkbox.checked);
    renderSelection();
  });
  const text = element('div', undefined, 'item-text');
  const title = element('div', item.title || '网页视频', 'item-title');
  title.title = item.title || '';
  const meta = element('div', undefined, 'item-meta');
  meta.append(formatLabel(item));
  text.append(title, meta);
  const actions = element('div', undefined, 'item-actions');
  const preview = iconButton('eye', '预览', 'btn sm icon');
  preview.onclick = () => player.open(item);
  const copy = iconButton('copy', '复制视频地址', 'btn sm icon');
  copy.onclick = () => void copyText(item.url);
  actions.append(preview, copy, downloadState(item, jobs, () => queue([item.id])));
  row.append(checkbox, thumb(item), text, actions);
  return row;
}

function renderSelection() {
  const checked = visible.filter(item => selected.has(item.groupKey)).length;
  $('select-all').checked = visible.length > 0 && checked === visible.length;
  $('select-all').indeterminate = checked > 0 && checked < visible.length;
  $('select-all').disabled = visible.length === 0;
  const active = jobs.filter(job => activeStates.includes(job.status)).length;
  $('batch').hidden = visible.length === 0 && !active;
  $('batch-download').hidden = visible.length === 0;
  $('batch-label').textContent = checked ? `下载所选（${checked}）` : `全部下载（${visible.length}）`;
  $('batch-summary').textContent = active ? `${active} 个视频下载中` : checked ? `已选 ${checked} 个` : '';
}

function render() {
  visible = bestFormats();
  for (const key of selected) if (!visible.some(item => item.groupKey === key)) selected.delete(key);
  probeResolutions(visible, render);
  $('page-count').textContent = String(visible.length);
  $('clear').hidden = visible.length === 0;
  $('media-list').replaceChildren(...visible.map(itemRow));
  $('empty').hidden = visible.length > 0;
  renderSelection();
}

$('select-all').addEventListener('change', () => {
  for (const item of visible) { if ($('select-all').checked) selected.add(item.groupKey); else selected.delete(item.groupKey); }
  render();
});
$('batch-download').addEventListener('click', async () => {
  const chosen = visible.filter(item => selected.has(item.groupKey));
  const targets = chosen.length ? chosen : visible;
  if (!targets.length) return;
  $('batch-download').disabled = true;
  try {
    const {jobIds} = await queue(targets.map(item => item.id));
    selected.clear();
    toast(`已添加 ${jobIds.length} 个下载任务`);
    render();
  } catch (error) { toast(error.message, true); }
  finally { $('batch-download').disabled = false; }
});
$('clear').addEventListener('click', async () => {
  try {
    await send({type: 'CLEAR_LIBRARY'});
    selected.clear();
    await refresh();
    toast('已清空，进行中的下载不受影响');
  } catch (error) { toast(error.message, true); }
});

/* ---------- Auto-parse the work open in the current tab ---------- */
// The page's own player often only streams a compressed copy, so the work page is parsed once for its original file.
const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
const page = /^https?:/.test(tab?.url || '') ? videoPage(tab.url) : null;
function showAutoStatus(state) {
  $('auto-status').hidden = !state || state.status === 'ready';
  if (!state) return;
  $('auto-status').dataset.status = state.status;
  $('auto-text').textContent = state.status === 'error' ? `当前作品解析失败：${state.message}` : state.message || '正在解析当前作品…';
}
async function autoParse() {
  if (!page) return;
  const parsed = items.some(item => item.quality !== '网页视频' && videoPage(item.sourceUrl)?.id === page.id);
  const key = `video:${tab.id}`;
  const current = (await chrome.storage.session.get(key))[key];
  if (parsed || (current?.status === 'loading' && current.awemeId === page.id)) return;
  showAutoStatus({status: 'loading'});
  await send({type: 'ANALYZE', tabId: tab.id, quality: 'original'}).catch(error => showAutoStatus({status: 'error', message: error.message}));
}
chrome.storage.onChanged.addListener((changes, area) => {
  const change = area === 'session' && page && changes[`video:${tab.id}`];
  if (change?.newValue) showAutoStatus(change.newValue);
});

/* ---------- Data ---------- */
async function refresh() {
  const data = await send({type: 'LIST_LIBRARY'});
  items = data.items.sort((a, b) => b.createdAt - a.createdAt);
  jobs = data.jobs;
  render();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (Object.keys(changes).some(key => key.startsWith('media:'))) { void refresh(); return; }
  let changed = false;
  for (const [key, change] of Object.entries(changes)) if (key.startsWith('job:')) {
    const index = jobs.findIndex(job => `job:${job.id}` === key);
    if (!change.newValue) { if (index >= 0) jobs.splice(index, 1); }
    else if (index < 0) jobs.push(change.newValue); else jobs[index] = change.newValue;
    changed = true;
  }
  if (changed) render();
});
await loadResolutions();
await refresh().catch(error => toast(error.message, true));
void autoParse();
