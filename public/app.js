const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const DRIFT_SECONDS = IS_IOS ? 0.85 : 0.4;
const PITCH_LATENCY = 0;
const SYNC_MS = IS_IOS ? 600 : 320;
const SHIFT_OUTPUT_GAIN = 0.7;

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
const pitchCard = document.querySelector(".pitch-card");
const pitchUp = document.getElementById("pitch-up");
const pitchDown = document.getElementById("pitch-down");
const pitchReset = document.getElementById("pitch-reset");
const semitoneReadout = document.getElementById("semitone-readout");
const audioEl = document.getElementById("shifted-audio");

let ytPlayer = null;
let currentVideoId = null;
let audioReady = false;
let syncing = false;
let lastKnownYtTime = 0;
let loadToken = 0;
let currentPitch = 0;
let unlocking = false;
let ytError = null;
let prepareAbort = null;
let shiftLoading = false;
let pitchJob = 0;

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

function hasAudioSource() {
  return Boolean(audioEl.getAttribute("src"));
}

function streamParams(videoId) {
  const params = new URLSearchParams({ videoId });
  if (currentPitch) params.set("pitch", String(currentPitch));
  return params;
}

function attachAudio(videoId) {
  if (!videoId) return;
  const src = `/api/stream?${streamParams(videoId)}`;
  audioEl.crossOrigin = "anonymous";
  audioEl.volume = SHIFT_OUTPUT_GAIN;
  if (audioEl.getAttribute("src") !== src) {
    audioEl.src = src;
    audioEl.load();
  }
}

function restoreYoutubeAudio() {
  pitchJob += 1;
  abortPrepare();
  shiftLoading = false;
  audioReady = false;
  audioEl.pause();
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
  currentPitch = Math.max(-12, Math.min(12, Number(semitones) || 0));
  renderPitch();

  if (!currentVideoId) return;

  if (currentPitch === 0) {
    restoreYoutubeAudio();
    return;
  }

  keepVideoSilent();
  ensureShiftedPlayback();
}

function targetAudioTime() {
  const ytTime = ytPlayer?.getCurrentTime?.() ?? 0;
  return Math.max(0, ytTime + PITCH_LATENCY);
}

function syncAudioTime(force = false) {
  if (!audioReady || !ytPlayer) return;
  const target = targetAudioTime();
  const drift = Math.abs(audioEl.currentTime - target);
  if (!force && drift <= DRIFT_SECONDS) return;
  if (IS_IOS && !force && !audioEl.paused && drift < 1.25) return;

  syncing = true;
  try {
    audioEl.currentTime = target;
  } catch {
    // iOS can reject seeks during buffering
  }
  lastKnownYtTime = ytPlayer.getCurrentTime();
  window.setTimeout(() => {
    syncing = false;
  }, IS_IOS ? 180 : 0);
}

async function playShiftedAudio() {
  const token = loadToken;
  keepVideoSilent();
  try {
    ytPlayer?.playVideo();
  } catch {
    // iframe may still be cueing
  }

  attachAudio(currentVideoId);
  const alreadyPlaying = !audioEl.paused;
  syncAudioTime(!alreadyPlaying);

  try {
    await withTimeout(audioEl.play(), 4000, "เบราว์เซอร์ยังบล็อกเสียง ลองกดอีกครั้ง");
  } catch (error) {
    if (!audioEl.paused) {
      hideUnlock();
      return;
    }
    throw new Error(error.message || "เบราว์เซอร์ยังบล็อกเสียง ลองกดอีกครั้ง");
  }
  if (loadToken !== token || currentPitch === 0) return;
  if (audioEl.paused) {
    throw new Error("เบราว์เซอร์ยังบล็อกเสียง ลองกดอีกครั้ง");
  }
  hideUnlock();
}

async function ensureShiftedPlayback() {
  if (!currentVideoId || currentPitch === 0) return;

  const wanted = currentPitch;
  const expectedSrc = `/api/stream?${streamParams(currentVideoId)}`;
  if (audioReady && audioEl.getAttribute("src") === expectedSrc && !audioEl.paused) {
    keepVideoSilent();
    hideLoading();
    return;
  }

  const job = ++pitchJob;
  abortPrepare();
  shiftLoading = true;
  audioReady = false;
  showLoading();
  setStatus("กำลังปรับคีย์...");

  try {
    await prepareAudio(currentVideoId);
    if (job !== pitchJob || currentPitch !== wanted || currentPitch === 0) return;
    attachAudio(currentVideoId);
    await waitForAudioReady();
    if (job !== pitchJob || currentPitch !== wanted || currentPitch === 0) return;

    try {
      await playShiftedAudio();
      if (job === pitchJob) setStatus("");
    } catch (error) {
      hideLoading();
      unlockEl.hidden = false;
      unlockBtn.hidden = false;
      unlockBtn.textContent = "กดเพื่อเล่น";
      setStatus(error.message || "กดปุ่มเพื่อเล่นคีย์ใหม่", true);
      return;
    }
  } catch (error) {
    if (job !== pitchJob || error.name === "AbortError") return;
    hideUnlock();
    setStatus(error.message || "โหลดเสียงไม่สำเร็จ", true);
  } finally {
    if (job === pitchJob) shiftLoading = false;
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
  hideUnlock();
  unlockBtn.textContent = "กดเพื่อเล่น";
  audioEl.pause();
  try {
    audioEl.removeAttribute("src");
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
    if (isShiftMode() && audioEl.paused) {
      audioEl.play().catch(() => {
        unlockEl.hidden = false;
        hideLoading();
        unlockBtn.hidden = false;
      });
    }
    return;
  }

  if (state === YT.PlayerState.ENDED) {
    audioEl.pause();
    audioEl.currentTime = 0;
    return;
  }

  if (state === YT.PlayerState.PAUSED && isShiftMode()) {
    audioEl.pause();
  }
}

function ytErrorMessage(code) {
  if (code === 2) return "Video ID ไม่ถูกต้อง";
  if (code === 100) return "ไม่พบวิดีโอนี้";
  if (code === 101 || code === 150) return "วิดีโอนี้ไม่อนุญาตให้ฝังในเว็บอื่น";
  return "เล่นวิดีโอ YouTube ไม่สำเร็จ";
}

function isYtPlaying() {
  return ytPlayer?.getPlayerState?.() === window.YT.PlayerState.PLAYING;
}

async function prepareAudio(videoId) {
  abortPrepare();
  prepareAbort = new AbortController();
  const response = await fetch(`/api/prepare?${streamParams(videoId)}`, {
    signal: prepareAbort.signal,
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "เตรียมสตรีมเสียงไม่สำเร็จ"));
  }
}

function waitForAudioReady() {
  return new Promise((resolve, reject) => {
    const succeed = () => {
      cleanup();
      audioReady = true;
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("หมดเวลารอสตรีมเสียง จากเซิร์ฟเวอร์"));
    }, 180_000);
    const onReady = () => {
      if (audioEl.readyState >= 1) succeed();
    };
    const onError = () => {
      cleanup();
      reject(new Error("โหลดสตรีมเสียงไม่สำเร็จ"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      audioEl.removeEventListener("canplay", onReady);
      audioEl.removeEventListener("loadeddata", onReady);
      audioEl.removeEventListener("canplaythrough", onReady);
      audioEl.removeEventListener("error", onError);
    };
    const poll = setInterval(onReady, 100);
    audioEl.addEventListener("canplay", onReady);
    audioEl.addEventListener("loadeddata", onReady);
    audioEl.addEventListener("canplaythrough", onReady);
    audioEl.addEventListener("error", onError, { once: true });
    onReady();
  });
}

async function loadVideo(videoId) {
  const token = ++loadToken;
  currentVideoId = videoId;
  ytError = null;
  audioReady = false;
  shiftLoading = false;
  abortPrepare();
  currentPitch = 0;
  renderPitch();
  audioEl.pause();
  try {
    audioEl.removeAttribute("src");
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
  if (hasAudioSource()) {
    const playPromise = audioEl.play();
    if (playPromise) playPromise.catch(() => {});
  }
});

unlockEl.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  await startUnlock();
});

pitchUp.addEventListener("click", () => setPitch(currentPitch + 1));
pitchDown.addEventListener("click", () => setPitch(currentPitch - 1));
pitchReset.addEventListener("click", () => setPitch(0));

setInterval(() => {
  if (!isShiftMode()) return;
  keepVideoSilent();

  if (!audioEl.paused && hasAudioSource() && !unlockEl.hidden && loadSpinnerEl.hidden) {
    hideUnlock();
  }

  if (hasAudioSource() && audioEl.paused && unlockEl.hidden && isYtPlaying()) {
    audioEl.play().catch(() => {
      unlockEl.hidden = false;
      hideLoading();
      unlockBtn.hidden = false;
    });
  }

  if (!ytPlayer || syncing) return;
  const ytTime = ytPlayer.getCurrentTime?.();
  if (typeof ytTime !== "number") return;

  const jumped = Math.abs(ytTime - lastKnownYtTime) > 1.2;
  lastKnownYtTime = ytTime;
  if (isYtPlaying() && !audioEl.paused) syncAudioTime(jumped);
}, SYNC_MS);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && isShiftMode() && isYtPlaying()) {
    audioEl.play().catch(() => {});
  }
});

setPitch(0);
