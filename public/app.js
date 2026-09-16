import { PitchShifter } from "https://cdn.jsdelivr.net/npm/soundtouchjs@0.3.0/dist/soundtouch.js";

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_CHROMIUM =
  !IS_IOS && /Chrome|Chromium|Edg|OPR|SamsungBrowser/i.test(navigator.userAgent);
const DRIFT_SECONDS = IS_IOS ? 0.9 : 0.4;
const SEEK_SECONDS = IS_IOS ? 1.35 : 0.5;
const SYNC_MS = IS_IOS ? 400 : 250;
const STRETCH_BUFFER = IS_IOS ? 2048 : 4096;
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
let SHIFT_OUTPUT_GAIN = 0.75;
let PITCH_LIMIT = 12;

const form = document.getElementById("load-form");
const videoInput = document.getElementById("video-input");
const loadBtn = document.getElementById("load-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const stage = document.getElementById("stage");
const loadSpinnerEl = document.getElementById("load-spinner");
const posterEl = document.getElementById("player-poster");
const pitchCard = document.getElementById("pitch-card");
const pitchUp = document.getElementById("pitch-up");
const pitchDown = document.getElementById("pitch-down");
const pitchReset = document.getElementById("pitch-reset");
const semitoneReadout = document.getElementById("semitone-readout");
const audioEl = document.getElementById("shifted-audio");
const resumeHitEl = document.getElementById("player-resume-hit");

let ytPlayer = null;
let currentVideoId = null;
let audioReady = false;
let lastKnownYtTime = 0;
let lastYtWall = 0;
let loadToken = 0;
let currentPitch = 0;
let ytError = null;
let prepareAbort = null;
let shiftLoading = false;
let pitchJob = 0;
let audioCtx = null;
let previewShifter = null;
let previewGain = null;
let previewConnected = false;
let previewSourceRate = 0;
let decodedBuffers = new Map();
let decodeJobs = new Map();
let iosWarmNode = null;
let iosDummyShifter = false;
let iosDummyBuf = null;
let ytForcedMute = false;
let lastSyncYtTime = 0;
let lastSeekAt = 0;
let lastMuteAt = 0;
let playbackHeld = false;
let pausedByBackground = false;
let sawPauseAfterShow = false;
let lastPitchAt = 0;
let resumeHitHideTimer = 0;

async function loadServerConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const data = await response.json();
    if (Number.isFinite(data.shiftOutputGain)) SHIFT_OUTPUT_GAIN = data.shiftOutputGain;
    if (Number.isFinite(data.pitchLimit)) PITCH_LIMIT = data.pitchLimit;
  } catch {
    // keep defaults
  }
}

const configReady = loadServerConfig();

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function isShiftMode() {
  return currentPitch !== 0 && audioReady;
}

function showLoading() {
  loadSpinnerEl.hidden = false;
  pitchCard.classList.add("is-loading");
}

function hideLoading() {
  loadSpinnerEl.hidden = true;
  pitchCard.classList.remove("is-loading");
}

function abortPrepare() {
  if (!prepareAbort) return;
  prepareAbort.abort();
  prepareAbort = null;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function clearResults() {
  resultsEl.innerHTML = "";
  resultsEl.hidden = true;
}

function renderResults(results) {
  resultsEl.innerHTML = "";
  if (!results.length) {
    resultsEl.hidden = true;
    return;
  }

  for (const item of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result";
    button.dataset.videoId = item.videoId;

    const img = document.createElement("img");
    img.src = item.thumbnail;
    img.alt = "";
    img.loading = "lazy";

    const body = document.createElement("div");
    const title = document.createElement("p");
    title.className = "result-title";
    title.textContent = item.title;

    const meta = document.createElement("p");
    meta.className = "result-meta";
    meta.textContent = [item.channel, formatDuration(item.duration)].filter(Boolean).join(" • ");

    body.append(title, meta);
    button.append(img, body);
    resultsEl.append(button);
  }

  resultsEl.hidden = false;
}

async function readApiError(response, fallback) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    if (data.error) return data.error;
  } catch {
    // HTML/text from a proxy (Cloudflare 502, nginx, etc.)
  }
  if (response.status === 502 || response.status === 504) {
    return "เซิร์ฟเวอร์ไม่ตอบ API — ให้ proxy ทั้งเว็บไปที่ container และตั้ง timeout อย่างน้อย 120 วินาที";
  }
  return fallback;
}

async function searchVideos(query) {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error(await readApiError(response, "ค้นหาไม่สำเร็จ"));
  }
  const data = await response.json().catch(() => ({}));
  return data.results || [];
}

function parseVideoId(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (VIDEO_ID_RE.test(value)) return value;

  const candidates = [value];
  if (!/^https?:\/\//i.test(value)) candidates.push(`https://${value}`);

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0];
        if (VIDEO_ID_RE.test(id)) return id;
      }
      if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
        const fromQuery = url.searchParams.get("v");
        if (VIDEO_ID_RE.test(fromQuery)) return fromQuery;
        const parts = url.pathname.split("/").filter(Boolean);
        if (["embed", "shorts", "live", "v"].includes(parts[0]) && VIDEO_ID_RE.test(parts[1])) {
          return parts[1];
        }
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function loadYouTubeApi() {
  return new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("โหลด YouTube IFrame API ไม่สำเร็จ")), 10_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const existing = document.querySelector("script[src='https://www.youtube.com/iframe_api']");
    window.onYouTubeIframeAPIReady = done;
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onerror = () => {
        clearTimeout(timer);
        reject(new Error("โหลด YouTube IFrame API ไม่สำเร็จ"));
      };
      document.head.appendChild(tag);
    }
  });
}

function keepVideoSilent() {
  if (currentPitch === 0) {
    ytForcedMute = false;
    return;
  }
  if (!ytPlayer || typeof ytPlayer.mute !== "function") return;
  if (ytForcedMute) {
    try {
      if (ytPlayer.isMuted?.()) return;
    } catch {
      return;
    }
  }
  try {
    ytPlayer.mute();
    ytPlayer.setVolume(0);
    ytForcedMute = true;
    lastMuteAt = performance.now();
  } catch {
    // iframe may not be ready
  }
}

function unmuteVideo() {
  ytForcedMute = false;
  if (!ytPlayer || typeof ytPlayer.unMute !== "function") return;
  try {
    ytPlayer.unMute();
    ytPlayer.setVolume(100);
  } catch {
    // iframe may not be ready
  }
}

function showPoster(videoId) {
  posterEl.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  posterEl.hidden = false;
}

function hidePoster() {
  posterEl.hidden = true;
}

function formatSemitone(semitones) {
  if (semitones > 0) return `+${semitones}`;
  return String(semitones);
}

function currentYtTime() {
  const t = ytPlayer?.getCurrentTime?.();
  return Number.isFinite(t) ? t : 0;
}

function isYtAdvancing() {
  return ytPlayer?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
}

function noteYtTime(t = currentYtTime()) {
  lastKnownYtTime = t;
  lastYtWall = performance.now();
}

function ytTimelineJumped(ytTime = currentYtTime()) {
  if (!lastYtWall) return false;
  const elapsed = (performance.now() - lastYtWall) / 1000;
  const expected = isYtAdvancing() ? lastKnownYtTime + elapsed : lastKnownYtTime;
  return Math.abs(ytTime - expected) > SEEK_SECONDS;
}

function pitchLatency() {
  const ctx = audioCtx;
  if (!ctx?.sampleRate) return 0;
  const node = STRETCH_BUFFER / ctx.sampleRate;
  const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  const device = out || base;
  // Chrome ScriptProcessor keeps one extra buffer in flight.
  return IS_CHROMIUM ? node * 2 + device : node + device;
}

function originalPlayhead() {
  return Math.max(0, currentYtTime() + pitchLatency());
}

function getAudioCtx() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  try {
    audioCtx = new Ctx({ latencyHint: IS_IOS ? "playback" : "interactive" });
  } catch {
    audioCtx = new Ctx();
  }
  audioCtx.onstatechange = () => {
    if (isPageHidden() || playbackHeld || pausedByBackground || audioCtx.state === "running") return;
    audioCtx.resume().catch(() => {});
    if (currentPitch !== 0) kickHtmlAudio();
  };
  return audioCtx;
}

function claimIosAudioSession() {
  if (!IS_IOS) return;
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch {
    // older Safari
  }
}

function muteEcho() {
  return lastMuteAt > 0 && performance.now() - lastMuteAt < 700;
}

function markPitchLive() {
  lastPitchAt = performance.now();
  playbackHeld = false;
  pausedByBackground = false;
  sawPauseAfterShow = true;
}

function isPageHidden() {
  return document.hidden || document.visibilityState === "hidden";
}

function hideBackgroundResumeHit() {
  clearTimeout(resumeHitHideTimer);
  resumeHitHideTimer = 0;
  resumeHitEl.hidden = true;
}

function showBackgroundResumeHit() {
  if (currentPitch === 0 || !currentVideoId) {
    hideBackgroundResumeHit();
    return;
  }
  resumeHitEl.hidden = false;
}

function beginResumeAfterBackground() {
  if (isPageHidden() || currentPitch === 0 || !currentVideoId) {
    hideBackgroundResumeHit();
    return;
  }
  pausedByBackground = false;
  playbackHeld = false;
  sawPauseAfterShow = true;
  lastPitchAt = performance.now();
  unlockAudio();
  keepVideoSilent();
  if (IS_IOS) armIosShifter();
  try {
    ytPlayer?.playVideo();
  } catch {
    // iframe may still be cueing
  }
  restorePitchOutput();
  clearTimeout(resumeHitHideTimer);
  resumeHitHideTimer = setTimeout(hideBackgroundResumeHit, 400);
}

function pauseForBackground() {
  pausedByBackground = true;
  sawPauseAfterShow = false;
  playbackHeld = true;
  try {
    ytPlayer?.pauseVideo();
  } catch {
    // iframe may not be ready
  }
  pausePreview();
  try {
    audioEl.pause();
  } catch {
    // ignore
  }
  showBackgroundResumeHit();
}

function restorePitchOutput() {
  if (isPageHidden() || currentPitch === 0) return;
  if (pausedByBackground || (playbackHeld && !isYtPlaying())) return;
  playbackHeld = false;
  claimIosAudioSession();
  if (audioCtx) audioCtx.resume().catch(() => {});
  kickHtmlAudio();
  const real = currentVideoId && decodedBuffers.get(currentVideoId);
  if (IS_IOS && real && (!previewShifter || iosDummyShifter)) {
    startPreview(real, currentPitch, currentYtTime());
  } else if (IS_IOS) {
    reconnectIosPreview();
  }
  resumePreview();
  snapToOriginal(true);
}

function onPageShown() {
  if (isPageHidden()) return;
  if (audioCtx) audioCtx.resume().catch(() => {});
  if (!pausedByBackground) return;
  playbackHeld = true;
  pausePreview();
  try {
    ytPlayer?.pauseVideo();
  } catch {
    // iframe may have auto-resumed
  }
  try {
    audioEl.pause();
  } catch {
    // ignore
  }
  const state = ytPlayer?.getPlayerState?.();
  sawPauseAfterShow =
    state === window.YT?.PlayerState?.PAUSED ||
    state === window.YT?.PlayerState?.CUED ||
    state === window.YT?.PlayerState?.ENDED;
  showBackgroundResumeHit();
}

function kickHtmlAudio() {
  if (isPageHidden()) return;
  try {
    audioEl.srcObject = null;
    if (!audioEl.getAttribute("src") || audioEl.dataset.streamKey !== "silent") {
      audioEl.src = SILENT_WAV;
      audioEl.dataset.streamKey = "silent";
      audioEl.loop = true;
    }
    audioEl.muted = false;
    audioEl.volume = 0.001;
    audioEl.playsInline = true;
    const play = audioEl.play();
    if (play) play.catch(() => {});
  } catch {
    // iOS may still unlock via AudioContext.resume
  }
}

function warmIosGraph() {
  if (!IS_IOS) return;
  const ctx = getAudioCtx();
  if (iosWarmNode) return;
  try {
    iosWarmNode = ctx.createScriptProcessor(STRETCH_BUFFER, 1, 1);
    iosWarmNode.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
    };
    iosWarmNode.connect(ctx.destination);
  } catch {
    iosWarmNode = null;
  }
}

function coolIosWarmGraph() {
  if (!iosWarmNode) return;
  try {
    iosWarmNode.disconnect();
  } catch {
    // already disconnected
  }
  iosWarmNode = null;
}

function wirePreviewOutput() {
  const ctx = getAudioCtx();
  if (!previewGain) {
    previewGain = ctx.createGain();
    previewGain.gain.value = SHIFT_OUTPUT_GAIN;
  }
  try {
    previewGain.disconnect();
  } catch {
    // not connected yet
  }
  previewGain.connect(ctx.destination);
}

function clearPitchMedia() {
  try {
    audioEl.pause();
    audioEl.srcObject = null;
    audioEl.removeAttribute("src");
    delete audioEl.dataset.streamKey;
    audioEl.loop = false;
    audioEl.load();
  } catch {
    // ignore if the element is not ready
  }
}

function getIosDummyBuffer() {
  const ctx = getAudioCtx();
  if (iosDummyBuf && iosDummyBuf.sampleRate === ctx.sampleRate) return iosDummyBuf;
  iosDummyBuf = ctx.createBuffer(
    2,
    Math.max(STRETCH_BUFFER * 4, Math.floor(ctx.sampleRate * 0.25)),
    ctx.sampleRate,
  );
  return iosDummyBuf;
}

function reconnectIosPreview() {
  if (!previewShifter || !previewGain) return;
  try {
    previewShifter.connect(previewGain);
  } catch {
    // already connected
  }
  previewConnected = true;
  if (currentPitch !== 0) previewGain.gain.value = SHIFT_OUTPUT_GAIN;
}

function attachDecodedBuffer(buffer, semitones) {
  const source = previewShifter?._filter?.sourceSound;
  if (!previewShifter || !source?.buffer) {
    startPreview(buffer, semitones, currentYtTime());
    return;
  }
  source.buffer = buffer;
  source.position = 0;
  previewShifter._filter.sourcePosition = 0;
  previewShifter.duration = buffer.duration;
  previewSourceRate = buffer.sampleRate;
  previewShifter.tempo = 1;
  previewShifter.pitchSemitones = semitones;
  iosDummyShifter = false;
  audioReady = true;
  reconnectIosPreview();
  coolIosWarmGraph();
  snapToOriginal(true);
}

function armIosShifter() {
  if (!IS_IOS || !currentVideoId) return;
  const real = decodedBuffers.get(currentVideoId);
  if (previewShifter && !iosDummyShifter && real) {
    reconnectIosPreview();
    return;
  }
  if (real) {
    startPreview(real, currentPitch || 1, currentYtTime());
    if (currentPitch === 0 && previewGain) previewGain.gain.value = 0;
    return;
  }
  if (previewShifter) {
    reconnectIosPreview();
    return;
  }
  startPreview(getIosDummyBuffer(), currentPitch || 1, currentYtTime());
}

function unlockAudio() {
  claimIosAudioSession();
  const ctx = getAudioCtx();
  ctx.resume().catch(() => {});
  kickHtmlAudio();
  warmIosGraph();
  if (ctx.state === "running") return;
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    // gesture may still unlock via resume()
  }
}

function stopPreview() {
  previewConnected = false;
  audioReady = false;
  previewSourceRate = 0;
  iosDummyShifter = false;
  if (previewShifter) {
    try {
      previewShifter.disconnect();
    } catch {
      // already disconnected
    }
    previewShifter = null;
  }
}

function connectPreview() {
  if (!previewShifter || !previewGain || previewConnected) return;
  previewShifter.connect(previewGain);
  previewConnected = true;
}

function disconnectPreview() {
  if (!previewShifter || !previewConnected) return;
  if (IS_IOS) {
    if (previewGain) previewGain.gain.value = 0;
    return;
  }
  try {
    previewShifter.disconnect();
  } catch {
    // already disconnected
  }
  previewConnected = false;
}

function pausePreview() {
  if (IS_IOS) {
    if (previewGain) previewGain.gain.value = 0;
    return;
  }
  disconnectPreview();
}

function resumePreview() {
  if (previewGain) previewGain.gain.value = SHIFT_OUTPUT_GAIN;
  connectPreview();
  if (IS_IOS) getAudioCtx().resume().catch(() => {});
}

function seekPreview(seconds) {
  if (!previewShifter || !previewShifter.duration) return;
  const t = Math.max(0, Math.min(seconds, previewShifter.duration - 0.05));
  const bufRate = previewSourceRate || previewShifter.sampleRate;
  const frame = Math.max(0, Math.floor(t * bufRate));
  try {
    previewShifter._filter.sourcePosition = frame;
    previewShifter.sourcePosition = frame;
    previewShifter.timePlayed = t;
  } catch {
    const ctxRate = previewShifter.sampleRate || audioCtx?.sampleRate || bufRate;
    previewShifter.percentagePlayed = (t * bufRate) / (previewShifter.duration * ctxRate);
  }
}

function previewPlayedSeconds() {
  if (!previewShifter) return 0;
  const bufRate = previewSourceRate || previewShifter.sampleRate;
  if (!bufRate) return 0;
  const pos = previewShifter._filter?.sourcePosition ?? previewShifter.sourcePosition ?? 0;
  return pos / bufRate;
}

function snapToOriginal(force = false) {
  if (!previewShifter) return;
  if (!force && IS_IOS && audioReady && performance.now() - lastSeekAt < 1200) return;
  lastSeekAt = performance.now();
  seekPreview(originalPlayhead());
  noteYtTime();
}

async function matchContextRate(buffer) {
  const ctx = getAudioCtx();
  if (Math.abs(buffer.sampleRate - ctx.sampleRate) < 1) return buffer;
  try {
    const frames = Math.max(1, Math.ceil(buffer.duration * ctx.sampleRate));
    const offline = new OfflineAudioContext(buffer.numberOfChannels, frames, ctx.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(0);
    return await offline.startRendering();
  } catch {
    return buffer;
  }
}

async function decodeOriginal(videoId) {
  if (decodedBuffers.has(videoId)) return decodedBuffers.get(videoId);
  const pending = decodeJobs.get(videoId);
  if (pending) return pending;
  const job = (async () => {
    const response = await fetch(`/api/stream?videoId=${encodeURIComponent(videoId)}`);
    if (!response.ok) {
      throw new Error(await readApiError(response, "โหลดเสียงต้นฉบับไม่สำเร็จ"));
    }
    const bytes = await response.arrayBuffer();
    const copy = bytes.slice(0);
    const decoded = await getAudioCtx().decodeAudioData(copy);
    const buffer = await matchContextRate(decoded);
    decodedBuffers.set(videoId, buffer);
    return buffer;
  })().finally(() => decodeJobs.delete(videoId));
  decodeJobs.set(videoId, job);
  return job;
}

function startPreview(buffer, semitones, _at) {
  const ctx = getAudioCtx();
  stopPreview();
  wirePreviewOutput();
  previewGain.gain.value = SHIFT_OUTPUT_GAIN;
  previewSourceRate = buffer.sampleRate;
  previewShifter = new PitchShifter(ctx, buffer, STRETCH_BUFFER);
  previewShifter.tempo = 1;
  previewShifter.pitchSemitones = semitones;
  previewShifter.connect(previewGain);
  previewConnected = true;
  iosDummyShifter = buffer === iosDummyBuf;
  audioReady = !iosDummyShifter;
  if (audioReady) coolIosWarmGraph();
  snapToOriginal(true);
}

function restoreYoutubeAudio() {
  pitchJob += 1;
  abortPrepare();
  shiftLoading = false;
  if (IS_IOS) {
    if (previewGain) previewGain.gain.value = 0;
    unmuteVideo();
    return;
  }
  stopPreview();
  clearPitchMedia();
  unmuteVideo();
}

function renderPitch() {
  semitoneReadout.textContent = formatSemitone(currentPitch);
  pitchCard.classList.toggle("is-flat", currentPitch === 0);
  pitchCard.classList.toggle("is-up", currentPitch > 0);
  pitchCard.classList.toggle("is-down", currentPitch < 0);
  pitchReset.disabled = currentPitch === 0;
}

function setPitch(semitones) {
  currentPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Number(semitones) || 0));
  renderPitch();

  if (!currentVideoId) return;

  if (currentPitch === 0) {
    hideBackgroundResumeHit();
    restoreYoutubeAudio();
    return;
  }

  lastPitchAt = performance.now();
  playbackHeld = false;
  pausedByBackground = false;
  sawPauseAfterShow = true;
  hideBackgroundResumeHit();

  keepVideoSilent();
  claimIosAudioSession();
  unlockAudio();
  if (IS_IOS) armIosShifter();
  if (previewShifter && audioReady && !iosDummyShifter) {
    previewShifter.pitchSemitones = currentPitch;
    playShiftedAudio();
    return;
  }
  if (startShiftedFromCache()) return;
  ensureShiftedPlayback();
}

function startShiftedFromCache() {
  const buffer = decodedBuffers.get(currentVideoId);
  if (!buffer) return false;
  startPreview(buffer, currentPitch, currentYtTime());
  playShiftedAudio();
  return true;
}

function syncAudioTime(force = false) {
  if (!audioReady || !ytPlayer || !previewShifter) return;
  const target = originalPlayhead();
  const drift = Math.abs(previewPlayedSeconds() - target);
  if (!force && drift <= DRIFT_SECONDS) return;
  if (IS_IOS && !force && previewConnected && drift < 1.8) return;
  if (IS_IOS && !force && performance.now() - lastSeekAt < 1200) return;
  lastSeekAt = performance.now();
  seekPreview(target);
  noteYtTime();
}

function keepPlayingVideo() {
  if (isPageHidden() || isYtPlaying()) return;
  try {
    ytPlayer?.playVideo();
  } catch {
    // iframe may still be cueing
  }
}

function playShiftedAudio() {
  markPitchLive();
  if (!ytForcedMute) keepVideoSilent();
  claimIosAudioSession();
  unlockAudio();
  snapToOriginal(true);
  getAudioCtx().resume().catch(() => {});
  resumePreview();
  keepPlayingVideo();
  if (audioReady) coolIosWarmGraph();
}

async function ensureShiftedPlayback() {
  if (!currentVideoId || currentPitch === 0) return;

  const wanted = currentPitch;
  if (audioReady && previewShifter && previewConnected && isYtPlaying()) {
    keepVideoSilent();
    hideLoading();
    previewShifter.pitchSemitones = wanted;
    resumePreview();
    return;
  }

  const job = ++pitchJob;
  abortPrepare();
  shiftLoading = true;
  showLoading();
  setStatus("กำลังโหลดเสียง...");

  try {
    unlockAudio();
    await getAudioCtx().resume();
    await prepareAudio(currentVideoId);
    if (job !== pitchJob || currentPitch !== wanted || currentPitch === 0) return;
    const buffer = await decodeOriginal(currentVideoId);
    if (job !== pitchJob || currentPitch !== wanted || currentPitch === 0) return;
    markPitchLive();
    if (previewShifter?._filter?.sourceSound) attachDecodedBuffer(buffer, currentPitch);
    else startPreview(buffer, currentPitch, currentYtTime());
    playShiftedAudio();
    noteYtTime();
    if (job === pitchJob) setStatus("");
  } catch (error) {
    if (job !== pitchJob || error.name === "AbortError") return;
    stopPreview();
    hideLoading();
    setStatus(error.message || "โหลดเสียงไม่สำเร็จ", true);
  } finally {
    if (job === pitchJob) {
      shiftLoading = false;
      hideLoading();
    }
  }
}

function stopPlayback() {
  loadToken += 1;
  pitchJob += 1;
  audioReady = false;
  ytError = null;
  shiftLoading = false;
  abortPrepare();
  stopPreview();
  decodedBuffers.clear();
  currentVideoId = null;
  lastKnownYtTime = 0;
  lastYtWall = 0;
  playbackHeld = false;
  pausedByBackground = false;
  hideBackgroundResumeHit();
  hideLoading();
  clearPitchMedia();
  resetYtPlayer();
}

function resetYtPlayer() {
  if (ytPlayer) {
    try {
      ytPlayer.destroy();
    } catch {
      // ignore if the iframe is already gone
    }
    ytPlayer = null;
  }

  const wrap = document.querySelector(".player-wrap");
  wrap.querySelectorAll("iframe").forEach((node) => node.remove());
  document.getElementById("yt-player")?.remove();

  const host = document.createElement("div");
  host.id = "yt-player";
  wrap.prepend(host);
}

function createPlayer(videoId, token) {
  return new Promise((resolve, reject) => {
    if (!document.getElementById("yt-player")) {
      reject(new Error("ไม่พบช่องวิดีโอ"));
      return;
    }

    let settled = false;
    const done = (player) => {
      if (settled) return;
      settled = true;
      resolve(player);
    };

    const player = new YT.Player("yt-player", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        fs: 1,
        origin: window.location.origin,
        widget_referrer: window.location.href,
        enablejsapi: 1,
      },
      events: {
        onReady: (event) => {
          if (token !== loadToken) {
            try {
              event.target.destroy();
            } catch {
              // stale player after a newer song was chosen
            }
            done(null);
            return;
          }
          ytPlayer = event.target;
          if (currentPitch === 0) unmuteVideo();
          else keepVideoSilent();
          hidePoster();
          done(event.target);
        },
        onStateChange: (event) => {
          if (token !== loadToken) return;
          onPlayerStateChange(event);
        },
        onError: (event) => {
          if (token !== loadToken) return;
          ytError = ytErrorMessage(event.data);
          setStatus(ytError, true);
          done(null);
        },
      },
    });

    if (!player) reject(new Error("สร้าง YouTube player ไม่สำเร็จ"));
  });
}

function holdPlayback() {
  playbackHeld = true;
  pausePreview();
  snapToOriginal();
}

function onPlayerStateChange(event) {
  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    if (pausedByBackground) {
      if (currentPitch !== 0) {
        try {
          ytPlayer?.pauseVideo();
        } catch {
          // keep held after fold until a tap on the player
        }
        holdPlayback();
        showBackgroundResumeHit();
        return;
      }
      if (!sawPauseAfterShow) {
        try {
          ytPlayer?.pauseVideo();
        } catch {
          // swallow iframe autoplay once
        }
        holdPlayback();
        sawPauseAfterShow = true;
        return;
      }
      pausedByBackground = false;
      playbackHeld = false;
      return;
    }
    hideBackgroundResumeHit();
    playbackHeld = false;
    if (currentPitch !== 0) {
      keepVideoSilent();
      restorePitchOutput();
    }
    return;
  }

  if (state === YT.PlayerState.ENDED) {
    holdPlayback();
    return;
  }

  if (state === YT.PlayerState.PAUSED && currentPitch !== 0) {
    if (pausedByBackground) sawPauseAfterShow = true;
    if (!audioReady || shiftLoading || muteEcho()) return;
    holdPlayback();
  }
}

function ytErrorMessage(code) {
  if (code === 2) return "Video ID ไม่ถูกต้อง";
  if (code === 100) return "ไม่พบวิดีโอนี้";
  if (code === 101 || code === 150) return "วิดีโอนี้ไม่อนุญาตให้ฝังในเว็บอื่น";
  return "เล่นวิดีโอ YouTube ไม่สำเร็จ";
}

function isYtPlaying() {
  const state = ytPlayer?.getPlayerState?.();
  return (
    state === window.YT.PlayerState.PLAYING ||
    state === window.YT.PlayerState.BUFFERING
  );
}

async function prepareAudio(videoId) {
  abortPrepare();
  prepareAbort = new AbortController();
  const params = new URLSearchParams({ videoId });
  const response = await fetch(`/api/prepare?${params}`, {
    signal: prepareAbort.signal,
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "เตรียมสตรีมเสียงไม่สำเร็จ"));
  }
  await response.json().catch(() => ({}));
}

async function loadVideo(videoId) {
  const token = ++loadToken;
  currentVideoId = videoId;
  ytError = null;
  audioReady = false;
  shiftLoading = false;
  abortPrepare();
  stopPreview();
  currentPitch = 0;
  lastKnownYtTime = 0;
  lastYtWall = 0;
  playbackHeld = false;
  pausedByBackground = false;
  hideBackgroundResumeHit();
  renderPitch();
  clearPitchMedia();
  hideLoading();
  clearResults();
  showPoster(videoId);
  stage.hidden = false;
  setStatus("");
  loadBtn.disabled = true;
  unlockAudio();
  fetch(`/api/prepare?videoId=${encodeURIComponent(videoId)}`).catch(() => {});
  decodeOriginal(videoId).catch(() => {});

  try {
    await loadYouTubeApi();
    if (token !== loadToken) return;
    resetYtPlayer();
    await createPlayer(videoId, token);
  } catch (error) {
    if (token !== loadToken) return;
    setStatus(error.message || "โหลดวิดีโอไม่สำเร็จ", true);
  } finally {
    if (token === loadToken) loadBtn.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = videoInput.value.trim();
  if (!query) {
    setStatus("ใส่คำค้นหา หรือวางลิงก์ YouTube", true);
    return;
  }

  const videoId = parseVideoId(query);
  stopPlayback();
  unlockAudio();
  loadBtn.disabled = true;

  try {
    if (videoId) {
      clearResults();
      await loadVideo(videoId);
      return;
    }

    setStatus("กำลังค้นหา...");
    stage.hidden = true;
    const results = await searchVideos(query);
    renderResults(results);
    setStatus(results.length ? `พบ ${results.length} รายการ — เลือกคลิปเพื่อเล่น` : "ไม่พบผลลัพธ์");
  } catch (error) {
    clearResults();
    setStatus(error.message || "ค้นหาไม่สำเร็จ", true);
  } finally {
    loadBtn.disabled = false;
  }
});

resultsEl.addEventListener("click", async (event) => {
  const button = event.target.closest(".result");
  if (!button?.dataset.videoId) return;

  stopPlayback();
  unlockAudio();
  loadBtn.disabled = true;
  try {
    await loadVideo(button.dataset.videoId);
  } catch (error) {
    setStatus(error.message || "โหลดวิดีโอไม่สำเร็จ", true);
  } finally {
    loadBtn.disabled = false;
  }
});

function onPitchPointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const btn = event.currentTarget;
  const next =
    btn === pitchReset
      ? 0
      : Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, currentPitch + (btn === pitchUp ? 1 : -1)));
  unlockAudio();
  if (!IS_IOS || !currentVideoId) return;
  if (next === 0) return;
  lastPitchAt = performance.now();
  playbackHeld = false;
  pausedByBackground = false;
  sawPauseAfterShow = true;
  hideBackgroundResumeHit();
  keepVideoSilent();
  claimIosAudioSession();
  getAudioCtx().resume().catch(() => {});
  armIosShifter();
}

resumeHitEl.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  beginResumeAfterBackground();
});
resumeHitEl.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  beginResumeAfterBackground();
  hideBackgroundResumeHit();
});

pitchUp.addEventListener("pointerdown", onPitchPointerDown);
pitchDown.addEventListener("pointerdown", onPitchPointerDown);
pitchReset.addEventListener("pointerdown", onPitchPointerDown);
pitchUp.addEventListener("click", () => setPitch(currentPitch + 1));
pitchDown.addEventListener("click", () => setPitch(currentPitch - 1));
pitchReset.addEventListener("click", () => setPitch(0));

setInterval(() => {
  if (isPageHidden()) {
    pauseForBackground();
    return;
  }
  if (currentPitch === 0 || !previewShifter || !audioReady) return;

  const ytTime = ytPlayer?.getCurrentTime?.();
  const hasTime = typeof ytTime === "number";
  const state = ytPlayer?.getPlayerState?.();
  const ended = state === window.YT?.PlayerState?.ENDED;
  const paused =
    state === window.YT?.PlayerState?.PAUSED || state === window.YT?.PlayerState?.CUED;
  const muteGlitch = muteEcho();
  const playing = isYtPlaying();

  if (pausedByBackground) {
    pausePreview();
  } else if (ended || (paused && !muteGlitch) || (playbackHeld && !playing)) {
    playbackHeld = true;
    pausePreview();
  } else if (audioReady && playing) {
    playbackHeld = false;
    if (previewGain && previewGain.gain.value < SHIFT_OUTPUT_GAIN / 2) resumePreview();
  } else if (audioReady && muteGlitch && !playbackHeld) {
    getAudioCtx().resume().catch(() => {});
    resumePreview();
    if (!playing) keepPlayingVideo();
  }

  if (!hasTime) return;

  const jumped = ytTimelineJumped(ytTime);
  if (jumped && previewShifter) snapToOriginal();
  noteYtTime(ytTime);
  lastSyncYtTime = ytTime;
  if (!playbackHeld && !jumped && audioReady && previewConnected && playing) {
    syncAudioTime(false);
  }
}, SYNC_MS);

document.addEventListener("visibilitychange", () => {
  if (isPageHidden()) pauseForBackground();
  else onPageShown();
});
document.addEventListener("webkitvisibilitychange", () => {
  if (isPageHidden()) pauseForBackground();
  else onPageShown();
});
window.addEventListener("pagehide", pauseForBackground);
window.addEventListener("pageshow", onPageShown);
document.addEventListener("freeze", pauseForBackground);

renderPitch();
audioEl.playsInline = true;
