/* global Mp4Muxer */
// WebCodecs -> fragmented-MP4 broadcast engine. Replaces MediaRecorder, which
// proved to silently produce nothing on this macOS/Electron combo. Here every
// stage is explicit: track frames -> VideoEncoder/AudioEncoder (hardware) ->
// mp4-muxer (fragmented) -> onData callbacks with wire-ready chunks.
//
// Segments: a viewer joining needs a fresh init segment starting on a
// keyframe. requestNewSegment() queues that up; the next keyframe starts a
// new muxer and onInit(mime) fires before its chunks flow.

const ScreenEncoder = (() => {
  let running = false;
  let videoEncoder = null;
  let audioEncoder = null;
  let videoReader = null;
  let audioReader = null;
  let muxer = null;

  let onData = null;
  let onInit = null;
  let onError = null;

  let width = 0;
  let height = 0;
  let aspectMode = 'wide'; // 'wide' = center-crop to 16:9, 'full' = whole screen
  let baseVideoConfig = null;
  let audioCodec = null; // 'mp4a.40.2' | 'opus' | null
  let videoConfigMeta = null;
  let audioConfigMeta = null;

  let segmentState = 'waiting-key'; // 'waiting-key' | 'active'
  let vQueue = [];
  let aQueue = [];
  let audioDeadline = 0; // start segment without audio after this time
  let lastKeyTime = 0;

  let bytesOut = 0;
  let chunksOut = 0;
  let firstFragments = [];
  let collectFirst = true;

  // stage counters: pinpoint exactly where the pipeline dies
  let framesIn = 0;
  let encodeCalls = 0;
  let vChunksSeen = 0;
  let aChunksSeen = 0;
  let keysSeen = 0;
  let lastError = null;

  function fail(err) {
    lastError = err instanceof Error ? err.message : String(err);
    if (onError) onError(lastError);
  }

  function mimeString() {
    const a =
      audioCodec === 'mp4a.40.2' ? ',mp4a.40.2' : audioCodec === 'opus' ? ',opus' : '';
    return `video/mp4; codecs="avc1.640028${a}"`;
  }

  function emit(data) {
    bytesOut += data.byteLength;
    chunksOut += 1;
    // copy: the muxer may reuse its buffer after the callback returns
    const buf = data.slice().buffer;
    if (collectFirst && firstFragments.length < 12) firstFragments.push(buf);
    if (onData) onData(buf);
  }

  function startSegment() {
    try {
      startSegmentInner();
    } catch (err) {
      fail(err);
    }
  }

  function startSegmentInner() {
    const withAudio = Boolean(audioCodec && audioConfigMeta);
    // Announce the new generation BEFORE constructing the muxer: the
    // constructor synchronously writes the ftyp header into onData, and the
    // receiver must see the init notice first or it discards those bytes.
    if (onInit) onInit(mimeString());
    muxer = new Mp4Muxer.Muxer({
      // writes are strictly sequential (verified), so position can be ignored,
      // but the callback must declare both params or the muxer rejects it
      target: new Mp4Muxer.StreamTarget({ onData: (data, _position) => emit(data) }),
      video: { codec: 'avc', width, height },
      ...(withAudio
        ? {
            audio: {
              codec: audioCodec === 'opus' ? 'opus' : 'aac',
              numberOfChannels: audioConfigMeta.decoderConfig.numberOfChannels,
              sampleRate: audioConfigMeta.decoderConfig.sampleRate,
            },
          }
        : {}),
      fastStart: 'fragmented',
      firstTimestampBehavior: 'cross-track-offset',
    });

    const videoStart = vQueue.length ? vQueue[0].timestamp : 0;
    try {
      for (const chunk of vQueue) muxer.addVideoChunk(chunk, videoConfigMeta);
      if (withAudio) {
        for (const chunk of aQueue) {
          if (chunk.timestamp >= videoStart) muxer.addAudioChunk(chunk, audioConfigMeta);
        }
      }
    } catch (err) {
      return fail(err);
    }
    vQueue = [];
    aQueue = [];
    segmentState = 'active';
  }

  function maybeStartSegment() {
    if (segmentState !== 'waiting-key' || !vQueue.length || !videoConfigMeta) return;
    if (audioCodec && !audioConfigMeta && Date.now() < audioDeadline) return;
    if (audioCodec && !audioConfigMeta) audioCodec = null; // audio never came
    startSegment();
  }

  function handleVideoChunk(chunk, meta) {
    if (!running) return;
    vChunksSeen += 1;
    if (chunk.type === 'key') keysSeen += 1;
    if (meta && meta.decoderConfig) videoConfigMeta = meta;
    if (segmentState === 'waiting-key') {
      if (chunk.type !== 'key') return; // discard deltas before segment start
      vQueue.push(chunk);
      maybeStartSegment();
      return;
    }
    if (!muxer) return;
    try {
      muxer.addVideoChunk(chunk, videoConfigMeta);
    } catch (err) {
      fail(err);
    }
  }

  function handleAudioChunk(chunk, meta) {
    if (!running) return;
    aChunksSeen += 1;
    if (meta && meta.decoderConfig) audioConfigMeta = meta;
    if (segmentState === 'waiting-key') {
      aQueue.push(chunk);
      if (aQueue.length > 200) aQueue.shift();
      maybeStartSegment();
      return;
    }
    if (!muxer || !audioCodec) return;
    try {
      muxer.addAudioChunk(chunk, audioConfigMeta);
    } catch (err) {
      fail(err);
    }
  }

  async function videoLoop(track, fps) {
    const processor = new MediaStreamTrackProcessor({ track });
    videoReader = processor.readable.getReader();
    // fragments flush at each keyframe, so this is also the delivery cadence
    const keyIntervalMs = 1000;
    let canvas = null;
    let cctx = null;
    for (;;) {
      let result;
      try {
        result = await videoReader.read();
      } catch {
        break;
      }
      const frame = result.value;
      if (result.done || !running) {
        if (frame) frame.close();
        break;
      }
      framesIn += 1;
      if (videoEncoder.state !== 'configured' || videoEncoder.encodeQueueSize > 2) {
        frame.close(); // drop under backpressure rather than lag behind
        continue;
      }
      // GPU-backed screen-capture frames hit a VideoToolbox path that never
      // emits labeled keyframes (verified: 106 chunks, zero 'key'), which
      // deadlocks fragmenting. Routing frames through a canvas converts them
      // into ordinary frames, where keyframe requests provably work.
      const fw = frame.displayWidth;
      const fh = frame.displayHeight;
      // Optional 16:9 center-crop: Mac screens are 3:2-ish, TVs and browser
      // windows are 16:9 — cropping fills them edge-to-edge (and a fullscreen
      // movie on the Mac then fills the TV exactly).
      let srcX = 0;
      let srcY = 0;
      let srcW = fw;
      let srcH = fh;
      if (aspectMode === 'wide') {
        const targetH = Math.round((fw * 9) / 16);
        if (targetH <= fh) {
          srcH = targetH;
          srcY = Math.floor((fh - targetH) / 2);
        } else {
          const targetW = Math.round((fh * 16) / 9);
          srcW = targetW;
          srcX = Math.floor((fw - targetW) / 2);
        }
      }
      const outW = srcW & ~1; // H.264 needs even dimensions
      const outH = srcH & ~1;
      if (!canvas || canvas.width !== outW || canvas.height !== outH) {
        canvas = new OffscreenCanvas(outW, outH);
        cctx = canvas.getContext('2d', { desynchronized: true });
      }
      if (outW !== width || outH !== height) {
        width = outW;
        height = outH;
        try {
          videoEncoder.configure({ ...baseVideoConfig, width, height });
        } catch (err) {
          fail(err);
          frame.close();
          continue;
        }
      }
      const ts = frame.timestamp;
      cctx.drawImage(frame, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
      frame.close();
      const now = performance.now();
      const wantKey =
        segmentState === 'waiting-key' || now - lastKeyTime > keyIntervalMs;
      if (wantKey) lastKeyTime = now;
      let copy = null;
      try {
        copy = new VideoFrame(canvas, { timestamp: ts });
        videoEncoder.encode(copy, { keyFrame: wantKey });
        encodeCalls += 1;
      } catch (err) {
        fail(err);
      }
      if (copy) copy.close();
    }
  }

  async function audioLoop(track) {
    const processor = new MediaStreamTrackProcessor({ track });
    audioReader = processor.readable.getReader();
    for (;;) {
      let result;
      try {
        result = await audioReader.read();
      } catch {
        break;
      }
      const data = result.value;
      if (result.done || !running) {
        if (data) data.close();
        break;
      }
      if (!audioEncoder) {
        try {
          audioEncoder = new AudioEncoder({
            output: handleAudioChunk,
            error: (e) => fail(e),
          });
          audioEncoder.configure({
            codec: audioCodec,
            sampleRate: data.sampleRate,
            numberOfChannels: data.numberOfChannels,
            bitrate: 256000,
          });
        } catch (err) {
          audioEncoder = null;
          audioCodec = null;
          data.close();
          continue;
        }
      }
      if (audioEncoder.state === 'configured' && audioEncoder.encodeQueueSize < 6) {
        try {
          audioEncoder.encode(data);
        } catch (err) {
          fail(err);
        }
      }
      data.close();
    }
  }

  async function pickAudioCodec(track) {
    if (!track || typeof AudioEncoder === 'undefined') return null;
    const s = track.getSettings();
    const base = {
      sampleRate: s.sampleRate || 48000,
      numberOfChannels: s.channelCount || 2,
      bitrate: 256000,
    };
    for (const codec of ['mp4a.40.2', 'opus']) {
      try {
        const res = await AudioEncoder.isConfigSupported({ codec, ...base });
        if (res.supported) return codec;
      } catch {}
    }
    return null;
  }

  return {
    async start({ stream, preset, aspect, onData: d, onInit: i, onError: e }) {
      this.stop();
      running = true;
      aspectMode = aspect || 'wide';
      onData = d;
      onInit = i;
      onError = e;
      bytesOut = 0;
      chunksOut = 0;
      framesIn = 0;
      encodeCalls = 0;
      vChunksSeen = 0;
      aChunksSeen = 0;
      lastError = null;
      firstFragments = [];
      collectFirst = true;
      videoConfigMeta = null;
      audioConfigMeta = null;
      muxer = null;
      vQueue = [];
      aQueue = [];
      segmentState = 'waiting-key';
      audioDeadline = Date.now() + 2000;
      lastKeyTime = 0;

      const vTrack = stream.getVideoTracks()[0];
      const settings = vTrack.getSettings();
      width = settings.width;
      height = settings.height;

      videoEncoder = new VideoEncoder({
        output: handleVideoChunk,
        error: (err) => fail(err),
      });
      const config = {
        codec: 'avc1.640028',
        width,
        height,
        bitrate: preset.bitrate,
        framerate: preset.fps,
        latencyMode: 'realtime',
        avc: { format: 'avc' },
      };
      baseVideoConfig = config;
      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported) {
        throw new Error(`H.264 encoding not supported at ${width}x${height}`);
      }
      videoEncoder.configure(config);

      const aTrack = stream.getAudioTracks()[0] || null;
      audioCodec = await pickAudioCodec(aTrack);

      videoLoop(vTrack, preset.fps);
      if (aTrack && audioCodec) audioLoop(aTrack);
      return mimeString();
    },

    stop() {
      running = false;
      for (const r of [videoReader, audioReader]) {
        if (r) r.cancel().catch(() => {});
      }
      videoReader = audioReader = null;
      for (const enc of [videoEncoder, audioEncoder]) {
        if (enc && enc.state !== 'closed') {
          try {
            enc.close();
          } catch {}
        }
      }
      videoEncoder = audioEncoder = null;
      muxer = null;
      vQueue = [];
      aQueue = [];
    },

    // A (re)joining viewer needs a fresh init segment starting on a keyframe
    requestNewSegment() {
      if (!running) return;
      segmentState = 'waiting-key';
      muxer = null;
      vQueue = [];
      aQueue = [];
      audioDeadline = Date.now() + 2000;
    },

    stats: () => ({
      bytesOut,
      chunksOut,
      running,
      framesIn,
      encodeCalls,
      vChunksSeen,
      aChunksSeen,
      keysSeen,
      vQueueLen: vQueue.length,
      haveVideoConfig: Boolean(videoConfigMeta),
      haveAudioConfig: Boolean(audioConfigMeta),
      audioCodec,
      segmentState,
      lastError,
    }),
    peekFirstFragments: () => firstFragments.slice(),
    stopCollectingFragments() {
      collectFirst = false;
      firstFragments = [];
    },
    currentMime: () => mimeString(),
  };
})();
