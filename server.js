const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const PORT = Number(process.env.PORT) || 3000;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER || "chrome";
const COOKIES_FILE = process.env.YTDLP_COOKIES || path.join(__dirname, "cookies.txt");
const SEARCH_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const CACHE_DIR = path.join(__dirname, "cache");

fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

const inFlight = new Map();

function parseYtProgress(line) {
  const percentMatch = line.match(/\[download\]\s+([\d.]+)\s*%/);
  if (percentMatch) {
    const eta = line.match(/\bETA\s+(\S+)/);
    const speed = line.match(/\bat\s+(\S+)/);
    const etaValue = eta?.[1] && !/unknown/i.test(eta[1]) ? eta[1] : null;
    const speedValue = speed?.[1] && !/unknown/i.test(speed[1]) ? speed[1] : null;
    return {
      phase: "download",
      percent: Math.max(0, Math.min(100, Number(percentMatch[1]))),
      eta: etaValue,
      speed: speedValue,
    };
  }
  if (/\[ExtractAudio\]|\[Merger\]|\[Fixup|Destination:.*\.m4a/i.test(line)) {
    return { phase: "convert", percent: 100 };
  }
  return null;
}

function publishProgress(videoId, data) {
  const job = inFlight.get(videoId);
  if (!job) return;
  job.progress = data;
  for (const listener of job.listeners) {
    try {
      listener(data);
    } catch {
      // ignore a disconnected SSE client
    }
  }
}

function spawnYtDlp(args, timeout, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, {
      env: { ...process.env, LANG: "C.UTF-8", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    let log = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timed out"));
    }, timeout);
    const handle = (buf) => {
      const text = String(buf);
      log += text;
      if (log.length > 16_384) log = log.slice(-12_288);
      for (const line of text.split(/\r|\n/)) {
        const parsed = parseYtProgress(line.trim());
        if (parsed) onProgress(parsed);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(log.trim() || `yt-dlp exited ${code}`));
    });
  });
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function execFileAsync(cmd, args, timeout = SEARCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LANG: "C.UTF-8", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(stderr?.trim() || error.message);
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseVideoId(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (VIDEO_ID_RE.test(value)) return value;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return VIDEO_ID_RE.test(id) ? id : null;
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
    return null;
  }
  return null;
}

function addCookieArgs(args) {
  try {
    if (
      COOKIES_FILE &&
      fs.existsSync(COOKIES_FILE) &&
      fs.statSync(COOKIES_FILE).isFile() &&
      fs.statSync(COOKIES_FILE).size > 80
    ) {
      args.push("--cookies", COOKIES_FILE);
      return;
    }
  } catch {
    // fall through to browser cookies on local machines
  }

  if (!COOKIES_FROM_BROWSER || COOKIES_FROM_BROWSER === "none") return;
  args.push("--cookies-from-browser", COOKIES_FROM_BROWSER);
}

function withYtDlpDefaults(args) {
  const next = ["--js-runtimes", "node", ...args];
  addCookieArgs(next);
  return next;
}

function youtubeCookieHeader() {
  try {
    if (!COOKIES_FILE || !fs.existsSync(COOKIES_FILE) || !fs.statSync(COOKIES_FILE).isFile()) {
      return "";
    }
    const parts = [];
    for (const line of fs.readFileSync(COOKIES_FILE, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const cols = line.split("\t");
      if (cols.length < 7) continue;
      const domain = cols[0].replace(/^#HttpOnly_/i, "");
      if (!/youtube\.com|google\.com|youtu\.be/i.test(domain)) continue;
      parts.push(`${cols[5]}=${cols[6]}`);
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

function collectByKey(node, key, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node[key]?.videoId) out.push(node[key]);
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, key, out);
  } else {
    for (const value of Object.values(node)) collectByKey(value, key, out);
  }
  return out;
}

function ytText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((part) => part.text || "").join("");
  return "";
}

function parseClock(value) {
  const parts = ytText(value)
    .split(":")
    .map((part) => Number(part));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function mapSearchHits(renderers, limit = 8) {
  const results = [];
  const seen = new Set();
  for (const item of renderers) {
    const videoId = item?.videoId;
    if (!VIDEO_ID_RE.test(videoId) || seen.has(videoId)) continue;
    seen.add(videoId);
    results.push({
      videoId,
      title: ytText(item.title) || videoId,
      channel: ytText(item.ownerText || item.shortBylineText || item.longBylineText),
      duration: parseClock(item.lengthText),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function searchViaInnertube(query) {
  const cookie = youtubeCookieHeader();
  const { data } = await axios.post(
    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
    {
      context: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20260101.00.00",
          hl: "th",
          gl: "TH",
        },
      },
      query,
    },
    {
      timeout: 12_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/results?search_query=" + encodeURIComponent(query),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    },
  );

  const renderers = [];
  collectByKey(data, "videoRenderer", renderers);
  collectByKey(data, "compactVideoRenderer", renderers);
  return mapSearchHits(renderers);
}

function friendlyYtError(message) {
  const text = String(message || "").trim();
  if (/sign in to confirm|not a bot/i.test(text)) {
    return "YouTube บล็อกการดึงเสียง (bot check) ให้ใส่ cookies.txt ที่ล็อกอิน YouTube แล้ว";
  }
  if (/ffmpeg is not installed|ffprobe/i.test(text)) {
    return "ต้องติดตั้ง ffmpeg เพื่อแปลงเสียงให้เบราว์เซอร์เล่นได้";
  }
  if (/could not copy|unable to find|failed to decrypt/i.test(text) && /cookie/i.test(text)) {
    return "อ่าน cookies จาก Chrome ไม่สำเร็จ ลองปิด Chrome แล้วเปิดใหม่ หรือล็อกอิน YouTube ใน Chrome ก่อน";
  }
  if (/private video/i.test(text)) return "วิดีโอนี้เป็นส่วนตัว";
  if (/video unavailable/i.test(text)) return "วิดีโอไม่พร้อมใช้งาน";
  return text.replace(/^ERROR:\s*/i, "") || "ดึงเสียงจาก YouTube ไม่สำเร็จ";
}

function cachedAudioPath(videoId) {
  return path.join(CACHE_DIR, `${videoId}.m4a`);
}

async function ensureAudioFile(videoId, onProgress) {
  const dest = cachedAudioPath(videoId);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    onProgress?.({ phase: "done", percent: 100 });
    return dest;
  }

  const existing = inFlight.get(videoId);
  if (existing) {
    if (onProgress) {
      existing.listeners.add(onProgress);
      if (existing.progress) onProgress(existing.progress);
    }
    try {
      return await existing.promise;
    } finally {
      if (onProgress) existing.listeners.delete(onProgress);
    }
  }

  const listeners = new Set();
  if (onProgress) listeners.add(onProgress);
  const job = {
    listeners,
    progress: { phase: "download", percent: 0 },
    promise: null,
  };
  inFlight.set(videoId, job);

  job.promise = (async () => {
    publishProgress(videoId, { phase: "download", percent: 0 });
    const args = withYtDlpDefaults([
      "-f",
      "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
      "-x",
      "--audio-format",
      "m4a",
      "--audio-quality",
      "0",
      "--postprocessor-args",
      "ffmpeg:-movflags +faststart",
      "-o",
      path.join(CACHE_DIR, `${videoId}.%(ext)s`),
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--force-overwrites",
      "--no-keep-video",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    await spawnYtDlp(args, DOWNLOAD_TIMEOUT_MS, (progress) => publishProgress(videoId, progress));

    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
      throw new Error("แปลงไฟล์เสียงไม่สำเร็จ");
    }
    publishProgress(videoId, { phase: "done", percent: 100 });
    return dest;
  })().finally(() => inFlight.delete(videoId));

  return job.promise;
}

function sendJsonError(res, error) {
  if (error.code === "ENOENT") {
    res.status(500).json({ error: "yt-dlp is not installed or not in PATH" });
    return;
  }
  const timedOut = /timeout|timed out/i.test(error.message || "");
  res.status(500).json({
    error: timedOut ? "ค้นหาหรือดึงเสียงใช้เวลานานเกินไป" : friendlyYtError(error.message),
  });
}

app.get("/api/health", (_req, res) => {
  let cookies = false;
  try {
    cookies =
      Boolean(COOKIES_FILE) &&
      fs.existsSync(COOKIES_FILE) &&
      fs.statSync(COOKIES_FILE).isFile() &&
      fs.statSync(COOKIES_FILE).size > 80;
  } catch {
    cookies = false;
  }
  res.json({ ok: true, cookies });
});

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "")
    .replace(/[\n\r]/g, " ")
    .trim()
    .slice(0, 200);

  if (!query) {
    res.status(400).json({ error: "ใส่คำค้นหา" });
    return;
  }

  const directId = parseVideoId(query);
  if (directId) {
    res.json({
      results: [
        {
          videoId: directId,
          title: query,
          channel: "",
          duration: null,
          thumbnail: `https://i.ytimg.com/vi/${directId}/mqdefault.jpg`,
        },
      ],
    });
    return;
  }

  try {
    let results = [];
    try {
      results = await searchViaInnertube(query);
    } catch (error) {
      console.error("innertube search failed:", error.message);
    }

    if (!results.length) {
      const searchArgs = withYtDlpDefaults([
        "--flat-playlist",
        "--skip-download",
        "--no-warnings",
        "--ignore-no-formats-error",
        "--socket-timeout",
        "15",
        "-J",
        `ytsearch6:${query}`,
      ]);
      const { stdout } = await execFileAsync("yt-dlp", searchArgs, 20_000);
      const data = JSON.parse(stdout);
      results = (data.entries || [])
        .filter((entry) => entry && entry.id)
        .map((entry) => ({
          videoId: entry.id,
          title: entry.title || entry.id,
          channel: entry.uploader || entry.channel || "",
          duration: Number.isFinite(entry.duration) ? entry.duration : null,
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
        }));
    }

    res.json({ results });
  } catch (error) {
    sendJsonError(res, error);
  }
});

app.get("/api/prepare", async (req, res) => {
  const videoId = parseVideoId(req.query.videoId);
  if (!videoId) {
    res.status(400).json({ error: "Invalid or missing videoId" });
    return;
  }

  const wantsSse = /text\/event-stream/i.test(req.headers.accept || "");
  if (!wantsSse) {
    try {
      await ensureAudioFile(videoId);
      res.json({ ok: true, videoId });
    } catch (error) {
      sendJsonError(res, error);
    }
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  req.socket.setTimeout(DOWNLOAD_TIMEOUT_MS + 15_000);

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 10_000);

  try {
    await ensureAudioFile(videoId, (progress) => {
      if (!closed) writeSse(res, progress);
    });
    if (!closed) {
      writeSse(res, { phase: "done", percent: 100 });
      res.end();
    }
  } catch (error) {
    if (!closed) {
      writeSse(res, {
        error: /timeout|timed out/i.test(error.message || "")
          ? "ค้นหาหรือดึงเสียงใช้เวลานานเกินไป"
          : friendlyYtError(error.message),
      });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
});

app.get("/api/stream", async (req, res) => {
  const videoId = parseVideoId(req.query.videoId);
  if (!videoId) {
    res.status(400).json({ error: "Invalid or missing videoId" });
    return;
  }

  try {
    const filePath = await ensureAudioFile(videoId);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(filePath, {
      headers: { "Content-Type": "audio/mp4" },
    });
  } catch (error) {
    if (!res.headersSent) sendJsonError(res, error);
    else res.destroy();
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        urls.push(`http://${addr.address}:${PORT}`);
      }
    }
  }
  return urls;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TuneTube running at http://localhost:${PORT}`);
  for (const url of lanUrls()) {
    console.log(`tablet: ${url}`);
  }
});
