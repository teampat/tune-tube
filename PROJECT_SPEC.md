# YouTube Pitch Shifter Web Application Specification

## 1. Project Overview
A web-based application designed to play YouTube videos while dynamically shifting the audio pitch (key) in real-time. Target platforms include desktop and tablet mobile browsers (specifically Chrome and Brave on Android/iPadOS).

## 2. Technical Architecture & Constraints
Due to Cross-Origin Resource Sharing (CORS) and browser Same-Origin policies, YouTube IFrame audio cannot be directly captured by the Web Audio API on the client side.

- **Frontend:**
  - Embeds standard YouTube IFrame via the YouTube IFrame Player API.
  - Automatically mutes the IFrame (`player.mute()`) to silence un-pitched audio.
  - Fetches the raw audio stream via the Backend Proxy.
  - Feeds the stream into an HTML5 `<audio>` element with `crossOrigin = "anonymous"`.
  - Connects the audio source to `AudioContext` and uses `Tone.PitchShift` (Tone.js) to alter semitones in real-time.
  - Bi-directionally syncs Play/Pause/Seek events between the YouTube video and the shifted audio stream.
  - Handles mobile Autoplay Policies by explicitly calling `Tone.start()` / `audioCtx.resume()` on user click.

- **Backend:**
  - Node.js + Express.
  - Uses `yt-dlp` to extract the direct best-audio stream URL for a given YouTube Video ID.
  - Proxies/pipes the stream payload directly to the frontend while enforcing `Access-Control-Allow-Origin: *` to bypass CORS restrictions.

## 3. Tech Stack
- Runtime: Node.js (v18+)
- Backend Framework: Express.js, Axios, cors
- CLI Dependency: `yt-dlp` installed and present in system PATH
- Frontend Libraries:
  - YouTube IFrame Player API
  - Tone.js (via CDN: unpkg.com/tone)

## 4. API Endpoints
- `GET /api/stream?videoId=:id`
  - Runs `yt-dlp -g -f bestaudio "https://www.youtube.com/watch?v=:id"`
  - Fetches and pipes the response with headers:
    - `Content-Type: audio/webm` (or matching mime)
    - `Access-Control-Allow-Origin: *`
    - `Accept-Ranges: bytes`