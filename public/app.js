const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const DRIFT_SECONDS = 0.28;
const PITCH_LATENCY = 0.08;

const form = document.getElementById("load-form");
const videoInput = document.getElementById("video-input");
const loadBtn = document.getElementById("load-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const stage = document.getElementById("stage");
const unlockEl = document.getElementById("unlock");
const unlockBtn = document.getElementById("unlock-btn");
const posterEl = document.getElementById("player-poster");
const pitchUp = document.getElementById("pitch-up");
const pitchDown = document.getElementById("pitch-down");
const pitchReset = document.getElementById("pitch-reset");
const semitoneReadout = document.getElementById("semitone-readout");
const semitoneLabel = document.getElementById("semitone-label");
const audioEl = document.getElementById("shifted-audio");

let ytPlayer = null;
let currentVideoId = null;
let pitchShift = null;
let audioGraphReady = false;
let audioReady = false;
let syncing = false;
let lastKnownYtTime = 0;
let loadToken = 0;
let currentPitch = 0;

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
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
    const existing = document.querySelector("script[src='https://www.youtube.com/iframe_api']");
    window.onYouTubeIframeAPIReady = () => resolve();
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onerror = () => reject(new Error("โหลด YouTube IFrame API ไม่สำเร็จ"));
      document.head.appendChild(tag);
    }
  });
}

function keepVideoSilent() {
  if (!ytPlayer || typeof ytPlayer.mute !== "function") return;
  ytPlayer.mute();
  ytPlayer.setVolume(0);
}

function showPoster(videoId) {
  posterEl.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  posterEl.hidden = false;
}

function hidePoster() {
  posterEl.hidden = true;
}

function pitchLabel(semitones) {
  if (semitones === 0) return "คีย์เดิม";
  const abs = Math.abs(semitones);
  return semitones > 0 ? `ขึ้น ${abs} ครึ่งเสียง` : `ลง ${abs} ครึ่งเสียง`;
}

function formatSemitone(semitones) {
  if (semitones > 0) return `+${semitones}`;
  return String(semitones);
}

function setPitch(semitones) {
  currentPitch = Math.max(-12, Math.min(12, Number(semitones) || 0));
  semitoneReadout.textContent = formatSemitone(currentPitch);
  semitoneLabel.textContent = pitchLabel(currentPitch);
  if (pitchShift) pitchShift.pitch = currentPitch;
}

async function ensureAudioGraph() {
  if (audioGraphReady) return;
  await Tone.start();
  if (Tone.getContext().state !== "running") {
    await Tone.getContext().resume();
  }

  const source = Tone.getContext().rawContext.createMediaElementSource(audioEl);
  pitchShift = new Tone.PitchShift({
    pitch: currentPitch,
    windowSize: 0.08,
    delayTime: 0,
    feedback: 0,
  }).toDestination();
  Tone.connect(source, pitchShift);
  audioGraphReady = true;
  unlockEl.hidden = true;
}

function targetAudioTime() {
  const ytTime = ytPlayer?.getCurrentTime?.() ?? 0;
  return Math.max(0, ytTime + PITCH_LATENCY);
}

function syncAudioTime(force = false) {
  if (!audioReady || !ytPlayer) return;
  const target = targetAudioTime();
  if (force || Math.abs(audioEl.currentTime - target) > DRIFT_SECONDS) {
    syncing = true;
    audioEl.currentTime = target;
    lastKnownYtTime = ytPlayer.getCurrentTime();
    queueMicrotask(() => {
      syncing = false;
    });
  }
}

async function playBoth() {
  await ensureAudioGraph();
  keepVideoSilent();
  syncAudioTime(true);
  const playVideo = ytPlayer.playVideo();
  const playAudio = audioEl.play();
  await Promise.all([playVideo, playAudio].filter(Boolean).map((p) => Promise.resolve(p).catch(() => {})));
  keepVideoSilent();
}

function stopPlayback() {
  loadToken += 1;
  audioReady = false;
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
      ytPlayer.stopVideo?.();
      ytPlayer.destroy();
    } catch {
      // ignore if the iframe is already gone
    }
    ytPlayer = null;
  }

  const old = document.getElementById("yt-player");
  const host = document.createElement("div");
  host.id = "yt-player";
  if (old) old.replaceWith(host);
}

function isYtPlaying() {
  return ytPlayer?.getPlayerState?.() === window.YT.PlayerState.PLAYING;
}

function onPlayerStateChange(event) {
  keepVideoSilent();
  const state = event.data;
  if (state === YT.PlayerState.PLAYING) {
    if (audioEl.paused) {
      ensureAudioGraph()
        .then(() => {
          syncAudioTime(true);
          return audioEl.play();
        })
        .catch(() => {
          unlockEl.hidden = false;
        });
    }
  } else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED) {
    audioEl.pause();
    if (state === YT.PlayerState.ENDED) audioEl.currentTime = 0;
  } else if (state === YT.PlayerState.BUFFERING) {
    audioEl.pause();
  }
}

function ytErrorMessage(code) {
  if (code === 2) return "Video ID ไม่ถูกต้อง";
  if (code === 100) return "ไม่พบวิดีโอนี้";
  if (code === 101 || code === 150) return "วิดีโอนี้ไม่อนุญาตให้ฝังในเว็บอื่น";
  return "เล่นวิดีโอ YouTube ไม่สำเร็จ";
}

function createPlayer(videoId) {
  return new Promise((resolve, reject) => {
    ytPlayer = new YT.Player("yt-player", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        fs: 1,
        origin: window.location.origin,
        enablejsapi: 1,
      },
      events: {
        onReady: (event) => {
          keepVideoSilent();
          event.target.mute();
          hidePoster();
          resolve(event.target);
        },
        onStateChange: onPlayerStateChange,
        onError: (event) => {
          setStatus(ytErrorMessage(event.data), true);
          reject(new Error(ytErrorMessage(event.data)));
        },
      },
    });
  });
}

function streamParams(videoId) {
  return new URLSearchParams({ videoId });
}

async function prepareAudio(videoId) {
  const response = await fetch(`/api/prepare?${streamParams(videoId)}`);
  if (!response.ok) {
    throw new Error(await readApiError(response, "เตรียมสตรีมเสียงไม่สำเร็จ"));
  }
}

function waitForAudioReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("หมดเวลารอสตรีมเสียง จากเซิร์ฟเวอร์"));
    }, 60_000);
    const onReady = () => {
      cleanup();
      audioReady = true;
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("โหลดสตรีมเสียงไม่สำเร็จ"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      audioEl.removeEventListener("canplay", onReady);
      audioEl.removeEventListener("loadeddata", onReady);
      audioEl.removeEventListener("error", onError);
    };
    audioEl.addEventListener("canplay", onReady, { once: true });
    audioEl.addEventListener("loadeddata", onReady, { once: true });
    audioEl.addEventListener("error", onError, { once: true });
  });
}

async function loadVideo(videoId) {
  const token = ++loadToken;
  audioReady = false;
  audioEl.pause();
  clearResults();
  showPoster(videoId);
  stage.hidden = false;
  unlockEl.hidden = audioGraphReady;
  setStatus("กำลังโหลดวิดีโอและแปลงเสียง...");
  loadBtn.disabled = true;

  const youtubeReady = (async () => {
    await loadYouTubeApi();
    if (token !== loadToken) return;
    resetYtPlayer();
    await createPlayer(videoId);
    if (token !== loadToken) return;
    ytPlayer.pauseVideo();
  })();

  await prepareAudio(videoId);
  if (token !== loadToken) return;

  currentVideoId = videoId;
  audioEl.crossOrigin = "anonymous";
  audioEl.src = `/api/stream?${streamParams(videoId)}`;
  audioEl.load();
  try {
    await Promise.all([youtubeReady, waitForAudioReady()]);
  } catch (error) {
    if (token !== loadToken) return;
    throw error;
  }
  if (token !== loadToken) return;
  keepVideoSilent();
  setStatus("พร้อมเล่น — กดเล่นบนวิดีโอแล้วเลื่อนคีย์ได้ทันที");
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

unlockBtn.addEventListener("click", async () => {
  try {
    await playBoth();
  } catch (error) {
    setStatus(error.message || "ยังเปิด Web Audio ไม่ได้", true);
  }
});

pitchUp.addEventListener("click", () => setPitch(currentPitch + 1));
pitchDown.addEventListener("click", () => setPitch(currentPitch - 1));
pitchReset.addEventListener("click", () => setPitch(0));

setInterval(() => {
  if (!ytPlayer || !audioReady || syncing) return;
  const ytTime = ytPlayer.getCurrentTime?.();
  if (typeof ytTime !== "number") return;

  const jumped = Math.abs(ytTime - lastKnownYtTime) > 1;
  lastKnownYtTime = ytTime;

  if (isYtPlaying()) {
    if (audioEl.paused) audioEl.play().catch(() => {});
    syncAudioTime(jumped);
    keepVideoSilent();
  } else {
    if (!audioEl.paused) audioEl.pause();
    if (jumped) syncAudioTime(true);
  }
}, 250);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && isYtPlaying()) {
    audioEl.play().catch(() => {});
  }
});

setPitch(0);
