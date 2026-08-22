const video = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const soundHint = document.getElementById('soundHint');

let hasAudio = false;
let active = false; // an mse-init has been received and MSE is set up

function showOverlay(text) {
  overlayText.textContent = text;
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
  updateSoundHint();
}
function updateSoundHint() {
  const show = hasAudio && video.muted && overlay.classList.contains('hidden');
  soundHint.classList.toggle('show', show);
}

// Any interaction is a user gesture that unlocks sound. Fire TV remotes
// drive a virtual cursor in Silk (clicks, not keys), so listen for both.
function unlockSound() {
  if (video.muted) {
    video.muted = false;
    video.play().catch(() => {});
    updateSoundHint();
  }
}
for (const ev of ['keydown', 'click', 'pointerdown', 'touchstart']) {
  document.addEventListener(ev, unlockSound);
}

// Try playing with sound; fall back to muted if the browser blocks it
async function tryPlay() {
  try {
    video.muted = false;
    await video.play();
  } catch (e) {
    video.muted = true;
    video.play().catch(() => {});
  }
  updateSoundHint();
}

// ---------------------------- MSE playback ---------------------------------

let ws = null;
let retryTimer = null;
let mediaSource = null;
let sourceBuffer = null;
let chunkQueue = [];
let objectUrl = null;
let lastData = 0;
let progressive = false;

// ------------------------ Progressive fallback ------------------------------
// The live broadcast as a plain, ever-growing MP4 at /live.mp4 — no
// MediaSource at all, plays anywhere. The server ends the file when a new
// broadcast generation starts; we just reopen it.

let progressiveRetryTimer = null;
let lastProgressTime = 0;
let lastProgressWallclock = 0;

function openProgressive() {
  showOverlay('Starting stream…');
  hasAudio = true;
  video.srcObject = null;
  video.src = '/live.mp4?t=' + Date.now();
  lastProgressTime = 0;
  lastProgressWallclock = Date.now();
  tryPlay();
}

function scheduleProgressiveRetry() {
  if (progressiveRetryTimer) return;
  progressiveRetryTimer = setTimeout(() => {
    progressiveRetryTimer = null;
    openProgressive();
  }, 1800);
}

function progressiveMode() {
  if (progressive) return;
  progressive = true;
  active = false;
  teardownMse();
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  video.addEventListener('error', scheduleProgressiveRetry);
  video.addEventListener('ended', scheduleProgressiveRetry);
  openProgressive();
}

// Progressive watchdog: stay near the live edge, recover from stalls
setInterval(() => {
  if (!progressive) return;
  try {
    if (video.currentTime !== lastProgressTime) {
      lastProgressTime = video.currentTime;
      lastProgressWallclock = Date.now();
      if (!overlay.classList.contains('hidden') && video.currentTime > 0) hideOverlay();
    } else if (Date.now() - lastProgressWallclock > 8000) {
      showOverlay('Reconnecting…');
      lastProgressWallclock = Date.now();
      openProgressive();
    }
    const seek = video.seekable;
    if (seek.length && seek.end(seek.length - 1) - video.currentTime > 7) {
      video.currentTime = seek.end(seek.length - 1) - 3;
    }
    if (video.paused) video.play().catch(() => {});
  } catch (e) {}
}, 2500);

function teardownMse() {
  chunkQueue = [];
  sourceBuffer = null;
  if (mediaSource) {
    try {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch (e) {}
    mediaSource = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  active = false;
}

function setupMse(mime) {
  if (progressive) return;
  if (!window.MediaSource) {
    progressiveMode();
    return;
  }
  teardownMse();
  active = true;
  hasAudio = /mp4a|opus/i.test(mime);
  showOverlay('Starting stream…');

  mediaSource = new MediaSource();
  objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  // Some browsers refuse to open MediaSource on plain-http origins (silently
  // — sourceopen just never fires). Fall back to progressive playback.
  const thisSource = mediaSource;
  setTimeout(() => {
    if (mediaSource === thisSource && mediaSource.readyState === 'closed') {
      progressiveMode();
    }
  }, 1500);
  mediaSource.addEventListener('sourceopen', () => {
    if (!mediaSource) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
    } catch (e) {
      showOverlay('This browser cannot decode the stream (' + mime + ').');
      return;
    }
    sourceBuffer.addEventListener('updateend', pump);
    sourceBuffer.addEventListener('error', () => {
      showOverlay('Playback error — reconnecting…');
      reconnect();
    });
    pump();
  });
  tryPlay();
}

function pump() {
  if (!sourceBuffer || sourceBuffer.updating) return;
  // Timestamps may not start at 0 — jump onto the buffered range immediately
  try {
    const buf = sourceBuffer.buffered;
    if (buf.length && video.currentTime < buf.start(buf.length - 1)) {
      const end = buf.end(buf.length - 1);
      video.currentTime = Math.max(buf.start(buf.length - 1), end - CUSHION);
    }
  } catch (e) {}
  // Trim old data so the buffer never fills up
  try {
    const buf = sourceBuffer.buffered;
    if (buf.length && buf.end(buf.length - 1) - buf.start(0) > 30) {
      sourceBuffer.remove(buf.start(0), buf.end(buf.length - 1) - 10);
      return; // updateend re-enters pump
    }
  } catch (e) {}
  if (!chunkQueue.length) return;
  try {
    sourceBuffer.appendBuffer(chunkQueue.shift());
  } catch (e) {
    try {
      const buf = sourceBuffer.buffered;
      if (buf.length) sourceBuffer.remove(buf.start(0), buf.end(buf.length - 1) - 5);
    } catch (e2) {}
  }
}

// Stay near the live edge but keep a cushion of buffered media — playing at
// the exact edge starves between fragments and stutters.
const CUSHION = 3;
setInterval(() => {
  if (!active || !sourceBuffer) return;
  try {
    const buf = sourceBuffer.buffered;
    if (!buf.length) return;
    const start = buf.start(buf.length - 1);
    const end = buf.end(buf.length - 1);
    if (video.currentTime < start || end - video.currentTime > CUSHION + 4) {
      video.currentTime = Math.max(start, end - CUSHION);
    }
    if (video.paused) video.play().catch(() => {});
  } catch (e) {}
}, 2000);

video.addEventListener('canplay', () => {
  if (active && video.paused) tryPlay();
});
video.addEventListener('playing', () => {
  if (active || progressive) hideOverlay();
});

// If media data stops arriving, reconnect — rejoining makes the Mac cut a
// fresh segment for us.
setInterval(() => {
  if (!active || !lastData) return;
  if (Date.now() - lastData > 8000) {
    lastData = 0;
    showOverlay('Stream stalled — reconnecting…');
    reconnect();
  }
}, 3000);

function reconnect() {
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
  teardownMse();
  scheduleConnect(800);
}

function scheduleConnect(delay) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function connect() {
  ws = new WebSocket('ws://' + location.host + '/stream?role=viewer');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    if (!active) showOverlay('Waiting for the Mac to start broadcasting…');
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'mse-init') {
        lastData = Date.now();
        setupMse(msg.mime);
      } else if (msg.type === 'stream-ended') {
        showOverlay('Waiting for the Mac to start broadcasting…');
        teardownMse();
      }
      return;
    }
    if (active) {
      lastData = Date.now();
      chunkQueue.push(ev.data);
      pump();
    }
  };
  ws.onclose = () => {
    ws = null;
    if (active) showOverlay('Connection lost — retrying…');
    teardownMse();
    scheduleConnect(2000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch (e) {}
  };
}

// Keep the screen awake while watching
async function keepAwake() {
  try {
    await navigator.wakeLock.request('screen');
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});
keepAwake();

connect();
