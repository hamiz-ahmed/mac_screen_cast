const video = document.getElementById('movie');
const msg = document.getElementById('msg');

function showMsg(text) {
  msg.textContent = text;
  msg.classList.add('show');
}

video.addEventListener('error', () => {
  const code = video.error && video.error.code;
  if (code === 2) {
    // network hiccup (server restart, Wi-Fi blip) — self-heal, don't lecture
    setTimeout(recover, 1500);
    return;
  }
  showMsg(
    'Could not play this video. MP4 files (H.264) work best on the Fire Stick — ' +
      'convert the file on your Mac and try again.'
  );
});
video.addEventListener('playing', () => msg.classList.remove('show'));

// ---- Presence + self-healing ----------------------------------------------
// The socket tells the Mac a movie page is open — the app holds a keep-awake
// assertion while any consumer is connected, so a paused film can't let the
// Mac idle-sleep. Its close/open also signals "Mac unreachable" / "Mac is
// back".
let presenceWs = null;
function connectPresence() {
  presenceWs = new WebSocket('ws://' + location.host + '/stream?role=player');
  presenceWs.onopen = () => {
    if (!video.paused && Date.now() - lastAdvance > 4000) recover();
  };
  presenceWs.onclose = () => {
    presenceWs = null;
    setTimeout(connectPresence, 2000);
  };
  presenceWs.onerror = () => {
    try {
      presenceWs.close();
    } catch (e) {}
  };
}

// Reload the source and seek back to where we were — the page never needs a
// manual refresh to survive a server outage.
function recover() {
  const at = Math.max(0, (video.currentTime || lastTime) - 0.5);
  showMsg('Reconnecting…');
  video.src = '/media?t=' + Date.now();
  video.addEventListener('loadedmetadata', function seekBack() {
    video.removeEventListener('loadedmetadata', seekBack);
    try {
      video.currentTime = at;
    } catch (e) {}
  });
  video.play().catch(() => {});
}

// Watchdog: playing but not progressing for ~8 s means the stream is dead
let lastTime = 0;
let lastAdvance = Date.now();
setInterval(() => {
  if (video.paused) {
    lastAdvance = Date.now();
    return;
  }
  if (video.currentTime !== lastTime) {
    lastTime = video.currentTime;
    lastAdvance = Date.now();
  } else if (Date.now() - lastAdvance > 8000) {
    lastAdvance = Date.now();
    recover();
  }
}, 2000);

connectPresence();

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
