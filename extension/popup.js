import './vendor/ui/components.js';
import {platformNames, videoPage} from './platforms.js';
import {$, activeStates, copyText, createParser, element, groupedItems, icon, iconButton, jobFraction, loadResolutions, formatText, probeResolutions, qualitySelect, queue, send, textButton, thumb, toast} from './ui.js';

const chosenFormats = new Map();
let items = [], jobs = [];
const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
const tabURL = /^https?:/.test(tab?.url || '') ? tab.url : '';
const page = tabURL ? videoPage(tabURL) : null;

function openWorkspace(hash) {
  void chrome.tabs.create({url: chrome.runtime.getURL(`manager.html${tab ? `?tabId=${tab.id}` : ''}${hash}`)});
  window.close();
}
$('open-workspace').addEventListener('click', () => openWorkspace('#videos'));
$('open-downloads').addEventListener('click', event => { event.preventDefault(); openWorkspace('#downloads'); });

function downloadState(item) {
  const job = jobs.filter(job => item.formats.some(format => format.id === job.mediaId)).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (job && activeStates.includes(job.status)) {
    const fraction = jobFraction(job);
    const node = element('div', undefined, 'item-progress');
    const ring = element('div', undefined, fraction ? 'ring' : 'ring indeterminate');
    ring.style.setProperty('--p', String(Math.round(fraction * 100)));
    node.title = fraction ? `下载中 ${Math.round(fraction * 100)}%` : '下载中';
    node.append(ring);
    return node;
  }
  if (job?.status === 'complete' && job.mediaId === item.id) {
    const node = element('div', undefined, 'item-done');
    node.title = '已下载';
    node.append(icon('circle-check'));
    return node;
  }
  const download = iconButton('download', '下载', 'btn primary dl');
  download.onclick = async () => {
    download.disabled = true;
    try { await queue([item.id]); }
    catch (error) { toast(error.message, true); download.disabled = false; }
  };
  return download;
}

function itemRow(item) {
  const row = element('article', undefined, 'item');
  const text = element('div', undefined, 'item-text');
  const title = element('div', item.title || '网页视频', 'item-title');
  title.title = item.title || '';
  const meta = element('div', undefined, 'item-meta');
  if (item.formats.length > 1) meta.append(qualitySelect(item, id => { chosenFormats.set(item.groupKey, id); render(); }));
  else meta.append(formatText(item));
  text.append(title, meta);
  const actions = element('div', undefined, 'item-actions');
  const copy = iconButton('copy', '复制视频地址', 'btn sm icon');
  copy.onclick = () => void copyText(item.url);
  actions.append(copy, downloadState(item));
  row.append(thumb(item), text, actions);
  return row;
}

function render() {
  const visible = groupedItems(items.filter(item => item.sourceTabId === tab?.id), chosenFormats);
  probeResolutions(visible.flatMap(item => item.formats), render);
  $('page-count').textContent = String(visible.length);
  $('media-list').replaceChildren(...visible.map(itemRow));
  $('empty').hidden = visible.length > 0;
  $('empty-title').textContent = tabURL ? '这个网页还没有视频' : '此页面无法识别视频';
  $('empty-text').textContent = !tabURL ? '在普通网页中打开插件' : page ? '点击上方解析当前作品，或播放视频' : '播放视频后会自动出现在这里';

  const active = jobs.filter(job => activeStates.includes(job.status)).length;
  $('open-downloads').hidden = !jobs.length;
  $('open-downloads').classList.toggle('busy', active > 0);
  $('jobs-text').textContent = active ? `${active} 个视频下载中` : `查看下载任务（${jobs.length}）`;
}

/* ---------- Current work on platform pages ---------- */
const parser = createParser({
  onState(state) {
    $('parse-status').hidden = false;
    $('parse-status').dataset.status = state.status;
    $('parse-message').textContent = state.message;
    $('parse-status-icon').name = state.status === 'loading' ? 'refresh-cw' : state.status === 'error' ? 'circle-alert' : 'circle-check';
    $('current-actions').querySelectorAll('button').forEach(button => { button.disabled = state.status === 'loading'; });
  }
});
if (page) {
  $('current').hidden = false;
  $('current-host').textContent = `${platformNames[page.platform]} · ${page.id}`;
  const actions = page.platform === 'douyin' ? [['解析高清', 'hd', 'btn sm outline'], ['解析原片', 'original', 'btn sm primary']] : [['解析', 'hd', 'btn sm primary']];
  for (const [label, quality, className] of actions) {
    const button = textButton(label, undefined, className);
    button.onclick = () => void parser.parse(tabURL, quality);
    $('current-actions').append(button);
  }
}

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
