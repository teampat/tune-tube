const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");

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
app.use(express.static(path.join(__dirname, "public")));

const inFlight = new Map();

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

async function ensureAudioFile(videoId) {
  const dest = cachedAudioPath(videoId);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return dest;

  const existing = inFlight.get(videoId);
  if (existing) return existing;

  const job = (async () => {
    const args = [
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
      "--no-progress",
      "--force-overwrites",
      "--no-keep-video",
    ];
    addCookieArgs(args);
    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    await execFileAsync("yt-dlp", args, DOWNLOAD_TIMEOUT_MS);

    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
      throw new Error("แปลงไฟล์เสียงไม่สำเร็จ");
    }
    return dest;
  })().finally(() => inFlight.delete(videoId));

  inFlight.set(videoId, job);
  return job;
}

function sendJsonError(res, error) {
  if (error.code === "ENOENT") {
    res.status(500).json({ error: "yt-dlp is not installed or not in PATH" });
    return;
  }
  const timedOut = /timeout|timed out/i.test(error.message || "");
  res.status(timedOut ? 504 : 502).json({ error: friendlyYtError(error.message) });
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
    const searchArgs = [
      "--flat-playlist",
      "--skip-download",
      "--no-warnings",
      "--ignore-no-formats-error",
      "--socket-timeout",
      "15",
      "-J",
    ];
    addCookieArgs(searchArgs);
    searchArgs.push(`ytsearch6:${query}`);
    const { stdout } = await execFileAsync("yt-dlp", searchArgs);
    const data = JSON.parse(stdout);
    const results = (data.entries || [])
      .filter((entry) => entry && entry.id)
      .map((entry) => ({
        videoId: entry.id,
        title: entry.title || entry.id,
        channel: entry.uploader || entry.channel || "",
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
        thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
      }));
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

  try {
    await ensureAudioFile(videoId);
    res.json({ ok: true, videoId });
  } catch (error) {
    sendJsonError(res, error);
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
