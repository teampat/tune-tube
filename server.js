const { execFile } = require("child_process");
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

async function ensureAudioFile(videoId) {
  const dest = cachedAudioPath(videoId);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return dest;

  const existing = inFlight.get(videoId);
  if (existing) return existing;

  const job = (async () => {
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
      "--no-progress",
      "--force-overwrites",
      "--no-keep-video",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

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
