import Hls from './vendor/ui/hls.js';
import {$, qualityText, sizeText, toast} from './ui.js';

const markup = `
  <wa-dialog id="video-preview" label="视频预览" class="preview-dialog">
    <div id="player" class="player" data-paused="true">
      <video id="preview-video" playsinline preload="metadata" aria-label="预览视频"></video>
      <button id="preview-big-play" class="player-big-play" type="button" tabindex="-1" aria-hidden="true"><wa-icon name="play"></wa-icon></button>
      <div id="preview-loading" class="player-loading" hidden><wa-spinner></wa-spinner></div>
      <div class="player-controls">
        <input id="preview-seek" class="player-seek" type="range" min="0" max="100" step="0.01" value="0" aria-label="播放进度" disabled>
        <div class="player-bar">
          <button id="preview-play" class="player-btn" type="button" title="播放" aria-label="播放"><wa-icon name="play"></wa-icon></button>
          <span id="preview-time" class="player-time">0:00 / 0:00</span>
          <span class="player-gap"></span>
          <button id="preview-mute" class="player-btn" type="button" title="静音" aria-label="静音"><wa-icon name="volume-2"></wa-icon></button>
          <button id="preview-fullscreen" class="player-btn" type="button" title="全屏" aria-label="全屏"><wa-icon name="maximize"></wa-icon></button>
        </div>
      </div>
    </div>
    <div id="preview-problem" class="player-notice" role="status" hidden><wa-icon name="info"></wa-icon><span id="preview-notice"></span><button id="preview-refresh" class="btn sm outline" type="button" hidden><wa-icon name="refresh-cw"></wa-icon>按来源重新解析</button></div>
    <div slot="footer" class="preview-footer">
      <span id="preview-meta" class="preview-meta ellipsis"></span>
      <a id="preview-source" class="btn sm outline" target="_blank" rel="noreferrer">打开来源<wa-icon name="external-link"></wa-icon></a>
    </div>
  </wa-dialog>`;

const timeText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const setButton = (button, label, name) => { button.title = label; button.setAttribute('aria-label', label); button.querySelector('wa-icon').name = name; };
const defaultBounds = () => ({maxWidth: Math.min(960, innerWidth - 32), maxHeight: Math.min(innerHeight * 0.7, 640), minWidth: 440});

// Video preview dialog shared by the popup and the batch download page.
// onRefresh(item, show) resolves an expired address again and calls show(freshItem); without it the refresh button stays hidden.
export function createPlayer({onRefresh, bounds = defaultBounds, fullscreen = true} = {}) {
  document.body.insertAdjacentHTML('beforeend', markup);
  const dialog = $('video-preview'), player = $('player'), video = $('preview-video');
  let hls, current;
  $('preview-fullscreen').hidden = !fullscreen;

  const notice = (text, refreshable = false) => { $('preview-notice').textContent = text; $('preview-problem').hidden = !text; $('preview-refresh').hidden = !(refreshable && onRefresh); };
  const toggle = () => { if (video.paused) void play(); else video.pause(); };
  const play = () => video.play().catch(error => { if (error.name !== 'AbortError') notice('暂时无法播放，可点击播放重试或打开来源网页。'); });

  function renderTime() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const seek = $('preview-seek');
    $('preview-time').textContent = `${timeText(video.currentTime)} / ${timeText(duration)}`;
    seek.disabled = !duration;
    seek.max = duration || 100;
    seek.value = video.currentTime;
    const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    seek.style.setProperty('--p', `${duration ? video.currentTime / duration * 100 : 0}%`);
    seek.style.setProperty('--b', `${duration ? Math.min(100, buffered / duration * 100) : 0}%`);
  }

  // Fit the dialog to the video so portrait works fill the height instead of sitting in a wide black box.
  function fit() {
    const {videoWidth: width, videoHeight: height} = video;
    if (!width || !height || document.fullscreenElement) return;
    const aspect = width / height;
    const {maxWidth, maxHeight, minWidth} = bounds();
    let playerWidth = maxHeight * aspect, playerHeight = maxHeight;
    if (playerWidth > maxWidth) { playerWidth = maxWidth; playerHeight = maxWidth / aspect; }
    dialog.style.setProperty('--width', `${Math.round(Math.max(playerWidth, Math.min(minWidth, maxWidth)))}px`);
    player.style.setProperty('--player-h', `${Math.round(playerHeight)}px`);
  }

  function reset() {
    video.pause();
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
    $('preview-loading').hidden = true;
    dialog.style.removeProperty('--width');
    player.style.removeProperty('--player-h');
    renderTime();
  }

  function open(item) {
    current = item;
    reset();
    notice(item.videoOnly ? '此画质只有画面，下载时会自动合并音轨。' : '');
    $('preview-loading').hidden = false;
    dialog.label = item.title || '视频预览';
    $('preview-source').href = item.sourceUrl;
    $('preview-meta').textContent = [qualityText(item), item.size ? sizeText(item.size) : '', item.author].filter(Boolean).join(' · ');
    dialog.open = true;
    if (item.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      hls = new Hls({enableWorker: false});
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) { hls.stopLoad(); $('preview-loading').hidden = true; notice('预览加载失败，视频地址可能已失效。', true); }
      });
      hls.loadSource(item.url);
      hls.attachMedia(video);
    } else video.src = item.url;
    void play();
  }

  $('preview-refresh').addEventListener('click', () => {
    notice('正在按来源网页重新解析…');
    onRefresh(current, fresh => { if (dialog.open) open(fresh); });
  });
  dialog.addEventListener('wa-after-hide', event => {
    if (event.target !== dialog) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    reset();
  });
  $('preview-play').addEventListener('click', toggle);
  $('preview-big-play').addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', () => { if (fullscreen) $('preview-fullscreen').click(); });
  for (const type of ['play', 'pause', 'ended']) video.addEventListener(type, () => {
    player.dataset.paused = String(video.paused);
    setButton($('preview-play'), video.paused ? '播放' : '暂停', video.paused ? 'play' : 'pause');
  });
  for (const type of ['timeupdate', 'loadedmetadata', 'durationchange', 'progress', 'emptied']) video.addEventListener(type, renderTime);
  video.addEventListener('loadedmetadata', fit);
  $('preview-seek').addEventListener('input', () => { video.currentTime = Number($('preview-seek').value); renderTime(); });
  $('preview-mute').addEventListener('click', () => { video.muted = !video.muted; });
  video.addEventListener('volumechange', () => setButton($('preview-mute'), video.muted ? '取消静音' : '静音', video.muted ? 'volume-x' : 'volume-2'));
  $('preview-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void player.requestFullscreen().catch(error => toast(error.message, true));
  });
  document.addEventListener('fullscreenchange', () => {
    const full = document.fullscreenElement === player;
    setButton($('preview-fullscreen'), full ? '退出全屏' : '全屏', full ? 'minimize' : 'maximize');
    if (!full) fit();
  });
  // Space plays / pauses, arrows seek 5 s; the seek slider keeps its own arrow keys.
  dialog.addEventListener('keydown', event => {
    if (event.target.closest?.('input, a, .btn') || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === ' ' || event.key === 'k') { event.preventDefault(); toggle(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      video.currentTime = Math.max(0, video.currentTime + (event.key === 'ArrowLeft' ? -5 : 5));
    } else if (event.key === 'm') $('preview-mute').click();
    else if (event.key === 'f' && fullscreen) $('preview-fullscreen').click();
  });
  video.addEventListener('loadeddata', () => {
    $('preview-loading').hidden = true;
    if (!video.videoWidth) notice('暂未读取到视频画面，请选择其他画质或打开来源网页。');
  });
  video.addEventListener('playing', () => { $('preview-loading').hidden = true; });
  video.addEventListener('waiting', () => { if (dialog.open) $('preview-loading').hidden = false; });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src') && !hls) return;
    $('preview-loading').hidden = true;
    if (video.error?.code === 3) notice('浏览器无法解码此画质，请选择其他画质或直接下载。');
    else notice('预览加载失败，视频地址可能已失效。', true);
  });

  return {open};
}
