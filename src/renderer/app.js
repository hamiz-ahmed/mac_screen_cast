/* global api, ScreenEncoder */

const PRESETS = {
  smooth: { width: 1280, height: 720, fps: 30, bitrate: 3_500_000 },
  balanced: { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  sharp: { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
};

const el = {
  watchUrl: document.getElementById('watchUrl'),
  copyUrl: document.getElementById('copyUrl'),
  displayField: document.getElementById('displayField'),
  displaySelect: document.getElementById('displaySelect'),
  qualitySelect: document.getElementById('qualitySelect'),
  fitSelect: document.getElementById('fitSelect'),
  muteMac: document.getElementById('muteMac'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  permBox: document.getElementById('permBox'),
  permBtn: document.getElementById('permBtn'),
  status: document.getElementById('status'),
  chooseBtn: document.getElementById('chooseBtn'),
  movieName: document.getElementById('movieName'),
  playerUrl: document.getElementById('playerUrl'),
  copyPlayerUrl: document.getElementById('copyPlayerUrl'),
};

const state = {
  port: null,
  broadcasting: false,
  starting: false,
  rebuilding: false,
  stream: null,
  ws: null,
  viewers: 0,
  watchdogTimer: null,
  lastBytes: 0,
  stalls: 0,
};

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Capture (macOS rules learned the hard way) ----------------------------
// Never pass width/height to getDisplayMedia (freezes after one frame);
// never overlap capture sessions (also freezes); always verify frames flow.

let lastCaptureStop = 0;

function stopCaptureTracks() {
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }
  lastCaptureStop = Date.now();
}

// Health check with the SAME sink type the encoder uses. Crucial discovery:
// an audio-loopback-inclusive capture can freeze its video for processing
// sinks (frame processors / encoders) while still feeding rendering sinks —
// so checking with a <video> element gives false positives. Runs on a clone
// so the check leaves the real track untouched.
async function captureIsAlive(stream, ms = 1800) {
  const clone = stream.getVideoTracks()[0].clone();
  const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
  let frames = 0;
  const deadline = Date.now() + ms;
  try {
    while (frames < 2 && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r(null), Math.max(50, deadline - Date.now()))),
      ]);
      if (!result || result.done || !result.value) break;
      result.value.close();
      frames += 1;
    }
  } catch {}
  try {
    await reader.cancel();
  } catch {}
  clone.stop();
  return frames >= 2;
}

async function acquireCapture(preset) {
  stopCaptureTracks();
  const sinceStop = Date.now() - lastCaptureStop;
  if (sinceStop < 2000) await sleep(2000 - sinceStop);

  const videoConstraints = { frameRate: { ideal: preset.fps } };
  // Music through mic-style processing sounds muffled and pumpy — disable it
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const capture = async (withAudio) => {
    await api.setWantAudio(withAudio);
    const stream = await navigator.mediaDevices.getDisplayMedia(
      withAudio
        ? { video: videoConstraints, audio: audioConstraints }
        : { video: videoConstraints }
    );
    for (const t of stream.getAudioTracks()) {
      t.applyConstraints(audioConstraints).catch(() => {});
    }
    return stream;
  };

  // Try a capture variant and verify frames actually reach a processor
  const attempt = async (withAudio) => {
    const stream = await capture(withAudio);
    try {
      await stream.getVideoTracks()[0].applyConstraints({
        width: preset.width,
        height: preset.height,
      });
    } catch {}
    if (await captureIsAlive(stream)) return stream;
    for (const t of stream.getTracks()) t.stop();
    lastCaptureStop = Date.now();
    return null;
  };

  let stream = null;
  let sawPermissionError = false;
  try {
    stream = await attempt(true);
  } catch (err) {
    sawPermissionError = err && err.name === 'NotAllowedError';
  }
  if (!stream) {
    setStatus('Rebuilding capture (video-only)…');
    await sleep(1500);
    try {
      stream = await attempt(false);
    } catch (err) {
      el.permBox.classList.remove('hidden');
      const e = new Error('Screen capture was blocked — grant Screen Recording access.');
      e.permission = true;
      throw e;
    }
  }
  if (!stream) {
    if (sawPermissionError) el.permBox.classList.remove('hidden');
    throw new Error(
      'macOS screen capture is stuck. Wait ~10 seconds and press Start again; if it keeps happening, quit and reopen the app.'
    );
  }
  return stream;
}

// The system-audio loopback can pause its samples while the Mac is silent,
// which would starve the muxer; routing through WebAudio with a constant
// source keeps audio frames flowing no matter what.
let audioCtx = null;
function stabilizeAudioTrack(stream) {
  audioCtx = audioCtx || new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  audioCtx.resume().catch(() => {});
  const dest = audioCtx.createMediaStreamDestination();
  audioCtx.createMediaStreamSource(stream).connect(dest);
  const keepAlive = audioCtx.createConstantSource();
  keepAlive.offset.value = 0;
  keepAlive.connect(dest);
  keepAlive.start();
  return dest.stream.getAudioTracks()[0];
}

// --- Broadcast transport ---------------------------------------------------

function connectStreamWs() {
  return new Promise((resolve) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return resolve();
    const ws = new WebSocket(`ws://localhost:${state.port}/stream?role=sender`);
    state.ws = ws;
    ws.onopen = () => resolve();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'viewer-joined') {
        ScreenEncoder.requestNewSegment();
      } else if (msg.type === 'viewers') {
        state.viewers = msg.n;
      }
    };
    ws.onclose = () => {
      state.ws = null;
      if (state.broadcasting) {
        setTimeout(async () => {
          if (!state.broadcasting) return;
          await connectStreamWs();
          ScreenEncoder.requestNewSegment();
        }, 1500);
      }
    };
  });
}

function wsSendBinary(buf) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(buf);
}

function wsSendInit(mime) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'mse-init', mime }));
  }
}

// --- Self-check ------------------------------------------------------------
// Decode our own first fragments locally before claiming "Broadcasting" —
// if the pipeline is broken, say so instead of streaming nothing.

async function selfCheck(mime) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const frs = ScreenEncoder.peekFirstFragments();
    if (frs.length >= 2 && ScreenEncoder.stats().bytesOut > 20000) break;
    await sleep(200);
  }
  const frs = ScreenEncoder.peekFirstFragments();
  if (frs.length < 2) {
    return { ok: false, error: 'The encoder produced no data (capture may be frozen).' };
  }
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    v.src = url;
    const finish = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: 'Self-check timed out validating the stream.' }),
      5000
    );
    ms.addEventListener('sourceopen', () => {
      let sb;
      try {
        sb = ms.addSourceBuffer(mime);
      } catch (err) {
        clearTimeout(timeout);
        return finish({ ok: false, error: `Codec not playable: ${mime}` });
      }
      sb.addEventListener('error', () => {
        clearTimeout(timeout);
        finish({ ok: false, error: 'Generated fragments failed to decode.' });
      });
      let i = 0;
      const next = () => {
        if (i < frs.length) {
          try {
            sb.appendBuffer(frs[i++]);
          } catch (err) {
            clearTimeout(timeout);
            finish({ ok: false, error: 'Fragment append failed.' });
          }
        } else {
          clearTimeout(timeout);
          finish(
            sb.buffered.length > 0
              ? { ok: true }
              : { ok: false, error: 'No decodable media in the first fragments.' }
          );
        }
      };
      sb.addEventListener('updateend', next);
      next();
    });
  });
}

// --- Watchdog: report honestly, never die silently -------------------------

function armWatchdog() {
  clearInterval(state.watchdogTimer);
  state.lastBytes = ScreenEncoder.stats().bytesOut;
  state.stalls = 0;
  state.watchdogTimer = setInterval(async () => {
    if (!state.broadcasting || state.rebuilding) return;
    const { bytesOut } = ScreenEncoder.stats();
    const delta = bytesOut - state.lastBytes;
    state.lastBytes = bytesOut;
    if (delta === 0) {
      state.stalls += 1;
      if (state.stalls >= 2) rebuildBroadcast();
    } else {
      state.stalls = 0;
      const sound = /mp4a|opus/.test(ScreenEncoder.currentMime())
        ? 'with sound'
        : 'no audio';
      const mbps = ((delta * 8) / 3 / 1e6).toFixed(1);
      const watching =
        state.viewers === 0
          ? 'no one watching yet'
          : `${state.viewers} watching`;
      setStatus(`Broadcasting ${sound} · ${watching} · ${mbps} Mb/s`, 'live');
    }
  }, 3000);
}

async function rebuildBroadcast() {
  if (state.rebuilding || !state.broadcasting) return;
  state.rebuilding = true;
  setStatus('Stream stalled — rebuilding…', 'error');
  try {
    ScreenEncoder.stop();
    stopCaptureTracks();
    await sleep(2000);
    const preset = PRESETS[el.qualitySelect.value];
    state.stream = await acquireCapture(preset);
    await startEngine(preset);
    setStatus('Broadcast rebuilt.', 'live');
  } catch (err) {
    setStatus(`${err.message} Retrying in 10 s…`, 'error');
    setTimeout(() => {
      state.rebuilding = false;
      rebuildBroadcast();
    }, 10000);
    return;
  }
  state.rebuilding = false;
}

// --- Engine wiring ---------------------------------------------------------

async function startEngine(preset) {
  const hasAudio = state.stream.getAudioTracks().length > 0;
  if (hasAudio) {
    try {
      state.stream = new MediaStream([
        state.stream.getVideoTracks()[0],
        stabilizeAudioTrack(state.stream),
      ]);
    } catch {}
    if (el.muteMac.checked) api.setSystemMute(true);
  }
  state.stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.broadcasting && !state.rebuilding) rebuildBroadcast();
  });
  return ScreenEncoder.start({
    stream: state.stream,
    preset,
    aspect: el.fitSelect.value,
    onData: wsSendBinary,
    onInit: wsSendInit,
    onError: (msg) => {
      if (state.broadcasting) setStatus(`Encoder error: ${msg}`, 'error');
    },
  });
}

// --- Start / stop ----------------------------------------------------------

async function startBroadcast() {
  if (state.starting || state.broadcasting) return;
  state.starting = true;
  el.startBtn.disabled = true;
  try {
    await api.setDisplay(Number(el.displaySelect.value));
    const preset = PRESETS[el.qualitySelect.value];
    await connectStreamWs();
    setStatus('Capturing screen…');
    state.stream = await acquireCapture(preset);
    setStatus('Starting encoder…');
    const mime = await startEngine(preset);
    setStatus('Verifying the stream…');
    const check = await selfCheck(mime);
    if (!check.ok) throw new Error(check.error);
    ScreenEncoder.stopCollectingFragments();

    state.broadcasting = true;
    el.stopBtn.disabled = false;
    setStatus('Broadcasting — open the URL above on any device.', 'live');
    armWatchdog();
  } catch (err) {
    ScreenEncoder.stop();
    stopCaptureTracks();
    api.setSystemMute(false);
    setStatus(err.message, 'error');
    el.startBtn.disabled = false;
  } finally {
    state.starting = false;
    if (state.broadcasting) el.startBtn.disabled = true;
  }
}

async function stopBroadcast() {
  state.broadcasting = false;
  state.rebuilding = false;
  clearInterval(state.watchdogTimer);
  ScreenEncoder.stop();
  stopCaptureTracks();
  el.startBtn.disabled = false;
  el.stopBtn.disabled = true;
  setStatus('Stopped.');
  api.setSystemMute(false);
}

// --- Movies ----------------------------------------------------------------

async function chooseMovie() {
  const res = await api.pickVideo();
  if (!res.ok) return;
  el.movieName.textContent = res.name;
  el.movieName.classList.add('chosen');
  setStatus(
    res.compatible
      ? 'Movie ready — open the player link on the viewing device.'
      : 'Heads up: MKV/AVI often fail — MP4 works best.',
    res.compatible ? '' : 'error'
  );
}

// --- Init ------------------------------------------------------------------

async function init() {
  const s = await api.getState();
  state.port = s.port;
  el.watchUrl.textContent = s.watchUrl;
  el.playerUrl.textContent = s.playerUrl;

  el.displaySelect.innerHTML = '';
  for (const d of s.displays) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.label} (${d.width}×${d.height})`;
    el.displaySelect.appendChild(opt);
  }
  el.displayField.style.display = s.displays.length > 1 ? '' : 'none';

  if (s.screenAccess === 'denied' || s.screenAccess === 'restricted') {
    el.permBox.classList.remove('hidden');
  }

  const copy = (text, btn) => {
    navigator.clipboard.writeText(text).then(() => {
      const prev = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => (btn.textContent = prev), 1500);
    });
  };
  el.copyUrl.addEventListener('click', () => copy(el.watchUrl.textContent, el.copyUrl));
  el.copyPlayerUrl.addEventListener('click', () =>
    copy(el.playerUrl.textContent, el.copyPlayerUrl)
  );
  el.permBtn.addEventListener('click', () => api.openScreenSettings());
  el.startBtn.addEventListener('click', startBroadcast);
  el.stopBtn.addEventListener('click', stopBroadcast);
  el.chooseBtn.addEventListener('click', chooseMovie);

  connectStreamWs();
  setStatus('Ready.');
}

init();
