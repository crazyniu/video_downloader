(() => {
if (window.__professionalVideoBridge) return;
window.__professionalVideoBridge = true;
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== 'professional-video-capture') return;
  chrome.runtime.sendMessage({type: 'CAPTURE_MEDIA', item: event.data.item}).catch(() => {});
});
})();
