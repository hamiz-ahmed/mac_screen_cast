const video = document.getElementById('movie');
const msg = document.getElementById('msg');

function showMsg(text) {
  msg.textContent = text;
  msg.classList.add('show');
}

video.addEventListener('error', () => {
  showMsg(
    'Could not play this video. MP4 files (H.264) work best on the Fire Stick — ' +
      'convert the file on your Mac and try again.'
  );
});
video.addEventListener('playing', () => msg.classList.remove('show'));

// Fire TV remote support: play/pause and d-pad keys where Silk passes them through
document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause') {
    e.preventDefault();
    if (video.paused) video.play();
    else video.pause();
  } else if (k === 'ArrowRight' || k === 'MediaFastForward') {
    video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
  } else if (k === 'ArrowLeft' || k === 'MediaRewind') {
    video.currentTime = Math.max(0, video.currentTime - 10);
  } else if (k === 'MediaPlay') {
    video.play();
  } else if (k === 'MediaPause' || k === 'MediaStop') {
    video.pause();
  }
});

// Keep the TV awake while paused (playback itself keeps it awake)
async function keepAwake() {
  try {
    await navigator.wakeLock.request('screen');
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});
keepAwake();

// Autoplay with sound can be blocked until an interaction; retry muted-then-unmute
video.play().catch(() => {
  video.muted = true;
  video.play().then(() => {
    const unmute = () => {
      video.muted = false;
      document.removeEventListener('keydown', unmute);
      document.removeEventListener('click', unmute);
    };
    document.addEventListener('keydown', unmute);
    document.addEventListener('click', unmute);
    showMsg('Press any button on the remote to enable sound');
    setTimeout(() => msg.classList.remove('show'), 4000);
  }).catch(() => showMsg('Select the video and press play'));
});
