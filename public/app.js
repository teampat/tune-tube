import { PitchShifter } from "https://cdn.jsdelivr.net/npm/soundtouchjs@0.3.0/dist/soundtouch.js";

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const DRIFT_SECONDS = IS_IOS ? 0.55 : 0.4;
const SEEK_SECONDS = 0.5;
const SYNC_MS = IS_IOS ? 500 : 320;
const STRETCH_BUFFER = IS_IOS ? 4096 : 16384;
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
const unlockEl = document.getElementById("unlock");
const unlockBtn = document.getElementById("unlock-btn");
const loadSpinnerEl = document.getElementById("load-spinner");
const posterEl = document.getElementById("player-poster");
const pitchCard = document.getElementById("pitch-card");
const pitchUp = document.getElementById("pitch-up");
const pitchDown = document.getElementById("pitch-down");
const pitchReset = document.getElementById("pitch-reset");
const semitoneReadout = document.getElementById("semitone-readout");
const audioEl = document.getElementById("shifted-audio");

let ytPlayer = null;
let currentVideoId = null;
let audioReady = false;
let lastKnownYtTime = 0;
let lastYtWall = 0;
let loadToken = 0;
let currentPitch = 0;
let unlocking = false;
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

function hideUnlock() {
  unlockEl.hidden = true;
  unlockBtn.textContent = "กดเพื่อเล่น";
  hideLoading();
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
  if (currentPitch === 0) return;
  if (!ytPlayer || typeof ytPlayer.mute !== "function") return;
  try {
    ytPlayer.mute();
    ytPlayer.setVolume(0);
  } catch {
    // iframe may not be ready
  }
}

function unmuteVideo() {
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

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
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

function originalPlayhead() {
  return Math.max(0, currentYtTime());
}

function getAudioCtx() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  try {
    audioCtx = new Ctx({ latencyHint: "interactive" });
  } catch {
    audioCtx = new Ctx();
  }
  audioCtx.onstatechange = () => {
    if (currentPitch === 0 || shiftLoading) return;
    if (audioCtx.state !== "running") {
      unlockEl.hidden = false;
      unlockBtn.hidden = false;
    }
  };
  return audioCtx;
}

function kickHtmlAudio() {
  try {
    if (!audioEl.getAttribute("src") || audioEl.dataset.streamKey !== "silent") {
      audioEl.src = SILENT_WAV;
      audioEl.dataset.streamKey = "silent";
      audioEl.loop = true;
    }
    audioEl.muted = false;
    audioEl.volume = 0.001;
    const play = audioEl.play();
    if (play) play.catch(() => {});
  } catch {
    // iOS may still unlock via AudioContext.resume
  }
}

function unlockAudio() {
  const ctx = getAudioCtx();
  ctx.resume().catch(() => {});
  kickHtmlAudio();
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

function snapToOriginal() {
  if (!previewShifter) return;
  seekPreview(originalPlayhead());
  noteYtTime();
}

async function matchContextRate(buffer) {
  if (IS_IOS) return buffer;
  const ctx = getAudioCtx();
  if (Math.abs(buffer.sampleRate - ctx.sampleRate) < 1) return buffer;
  const frames = Math.max(1, Math.ceil(buffer.duration * ctx.sampleRate));
  const offline = new OfflineAudioContext(buffer.numberOfChannels, frames, ctx.sampleRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

async function decodeOriginal(videoId) {
  if (decodedBuffers.has(videoId)) return decodedBuffers.get(videoId);
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
}

function startPreview(buffer, semitones, _at) {
  const ctx = getAudioCtx();
  stopPreview();
  if (!previewGain) {
    previewGain = ctx.createGain();
    previewGain.connect(ctx.destination);
  }
  previewGain.gain.value = SHIFT_OUTPUT_GAIN;
  previewSourceRate = buffer.sampleRate;
  previewShifter = new PitchShifter(ctx, buffer, STRETCH_BUFFER);
  previewShifter.tempo = 1;
  previewShifter.pitchSemitones = semitones;
  try {
    previewShifter._soundtouch.stretch._quickSeek = false;
    previewShifter._soundtouch.stretch.setParameters(ctx.sampleRate, 82, 28, 12);
  } catch {
    // SoundTouch internals may differ by build
  }
  previewShifter.connect(previewGain);
  previewConnected = true;
  audioReady = true;
  snapToOriginal();
}

function restoreYoutubeAudio() {
  pitchJob += 1;
  abortPrepare();
  shiftLoading = false;
  stopPreview();
  audioEl.pause();
  audioEl.loop = false;
  try {
    audioEl.removeAttribute("src");
    delete audioEl.dataset.streamKey;
    audioEl.load();
  } catch {
    // ignore if the element is not ready
  }
  unmuteVideo();
  hideUnlock();
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
    restoreYoutubeAudio();
    return;
  }

  unlockAudio();
  keepVideoSilent();
  if (previewShifter && audioReady) {
    previewShifter.pitchSemitones = currentPitch;
    resumePreview();
    getAudioCtx().resume().catch(() => {});
    try {
      ytPlayer?.playVideo();
    } catch {
      // iframe may still be cueing
    }
    return;
  }
  ensureShiftedPlayback();
}

function syncAudioTime(force = false) {
  if (!audioReady || !ytPlayer || !previewShifter) return;
  const target = originalPlayhead();
  const drift = Math.abs(previewPlayedSeconds() - target);
  if (!force && drift <= DRIFT_SECONDS) return;
  if (IS_IOS && !force && previewConnected && drift < 1.4) return;
  seekPreview(target);
  noteYtTime();
}

async function playShiftedAudio() {
  const token = loadToken;
  keepVideoSilent();
  unlockAudio();
  snapToOriginal();
  await getAudioCtx().resume();
  resumePreview();

  try {
    ytPlayer?.playVideo();
  } catch {
    // iframe may still be cueing
  }

  if (loadToken !== token || currentPitch === 0) return;
  if (IS_IOS && !unlocking) {
    unlockEl.hidden = false;
    unlockBtn.hidden = false;
    unlockBtn.textContent = "กดเพื่อเล่น";
    return;
  }
  if (audioCtx?.state === "running") hideUnlock();
  else {
    unlockEl.hidden = false;
    unlockBtn.hidden = false;
    unlockBtn.textContent = "กดเพื่อเล่น";
  }
}

async function ensureShiftedPlayback() {
  if (!currentVideoId || currentPitch === 0) return;

  const wanted = currentPitch;
  if (audioReady && previewShifter && previewConnected && isYtPlaying()) {
    keepVideoSilent();
    hideLoading();
    previewShifter.pitchSemitones = wanted;
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
    startPreview(buffer, currentPitch, currentYtTime());
    await playShiftedAudio();
    noteYtTime();
    if (job === pitchJob) setStatus("");
  } catch (error) {
    if (job !== pitchJob || error.name === "AbortError") return;
    stopPreview();
    hideLoading();
    unlockEl.hidden = false;
    unlockBtn.hidden = false;
    unlockBtn.textContent = "กดเพื่อเล่น";
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
  unlocking = false;
  audioReady = false;
  ytError = null;
  shiftLoading = false;
  abortPrepare();
  stopPreview();
  decodedBuffers.clear();
  currentVideoId = null;
  lastKnownYtTime = 0;
  lastYtWall = 0;
  hideUnlock();
  unlockBtn.textContent = "กดเพื่อเล่น";
  audioEl.pause();
  try {
    audioEl.removeAttribute("src");
    delete audioEl.dataset.streamKey;
    audioEl.load();
  } catch {
    // ignore if the element is not ready
  }
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

function onPlayerStateChange(event) {
  if (currentPitch !== 0) keepVideoSilent();
  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    if (isShiftMode()) {
      getAudioCtx().resume().catch(() => {});
      resumePreview();
      if (ytTimelineJumped()) snapToOriginal();
    }
    return;
  }

  if (state === YT.PlayerState.ENDED) {
    pausePreview();
    return;
  }

  if (state === YT.PlayerState.PAUSED && isShiftMode()) {
    if (ytTimelineJumped()) snapToOriginal();
    pausePreview();
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
  renderPitch();
  audioEl.pause();
  try {
    audioEl.removeAttribute("src");
    delete audioEl.dataset.streamKey;
    audioEl.load();
  } catch {
    // ignore
  }
  hideUnlock();
  clearResults();
  showPoster(videoId);
  stage.hidden = false;
  setStatus("");
  loadBtn.disabled = true;
  fetch(`/api/prepare?videoId=${encodeURIComponent(videoId)}`).catch(() => {});

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
  loadBtn.disabled = true;
  try {
    await loadVideo(button.dataset.videoId);
  } catch (error) {
    setStatus(error.message || "โหลดวิดีโอไม่สำเร็จ", true);
  } finally {
    loadBtn.disabled = false;
  }
});

async function startUnlock() {
  if (unlocking || currentPitch === 0) return;
  unlocking = true;
  unlockBtn.textContent = "กำลังเปิดเสียง...";
  unlockAudio();
  try {
    await withTimeout(playShiftedAudio(), 6000, "ยังเปิดเสียงไม่ได้ ลองกดอีกครั้ง");
    if (!unlockEl.hidden) unlockBtn.textContent = "กดเพื่อเล่น";
  } catch (error) {
    unlockEl.hidden = false;
    unlockBtn.textContent = "กดเพื่อเล่น";
    setStatus(error.message || "ยังเปิดเสียงไม่ได้ ลองกดอีกครั้ง", true);
  } finally {
    unlocking = false;
    if (!unlockEl.hidden) unlockBtn.textContent = "กดเพื่อเล่น";
  }
}

unlockEl.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (currentPitch === 0) return;
  unlockAudio();
  resumePreview();
});

unlockEl.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  await startUnlock();
});

function onPitchPointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  unlockAudio();
}

pitchUp.addEventListener("pointerdown", onPitchPointerDown);
pitchDown.addEventListener("pointerdown", onPitchPointerDown);
pitchUp.addEventListener("click", () => setPitch(currentPitch + 1));
pitchDown.addEventListener("click", () => setPitch(currentPitch - 1));
pitchReset.addEventListener("click", () => setPitch(0));

setInterval(() => {
  if (!isShiftMode()) return;
  keepVideoSilent();

  if (!IS_IOS && previewConnected && !unlockEl.hidden && loadSpinnerEl.hidden) {
    hideUnlock();
  }

  if (IS_IOS) {
    getAudioCtx().resume().catch(() => {});
    resumePreview();
    if (audioCtx?.state !== "running" && !shiftLoading) {
      unlockEl.hidden = false;
      unlockBtn.hidden = false;
    }
  } else if (shiftLoading || isYtPlaying()) {
    getAudioCtx().resume().catch(() => {});
    connectPreview();
  } else {
    pausePreview();
  }

  if (!ytPlayer) return;
  const ytTime = ytPlayer.getCurrentTime?.();
  if (typeof ytTime !== "number") return;

  const jumped = ytTimelineJumped(ytTime);
  if (jumped && previewShifter) {
    snapToOriginal();
    if (isYtPlaying() || IS_IOS) resumePreview();
  }
  noteYtTime(ytTime);
  if (!jumped && (isYtPlaying() || IS_IOS) && previewConnected) syncAudioTime(false);
}, SYNC_MS);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && isShiftMode()) {
    getAudioCtx().resume().catch(() => {});
    kickHtmlAudio();
    resumePreview();
  }
});

renderPitch();
