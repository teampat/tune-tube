# TuneTube

เล่นคลิป YouTube พร้อมเลื่อนคีย์เสียงแบบเรียลไทม์ ใช้บนเดสก์ท็อปและแท็บเล็ต (Chrome / Brave)

YouTube iframe จับเสียงตรงๆ ไม่ได้เพราะ CORS ดังนั้นแอปจะปิดเสียงวิดีโอ แล้วดึงเสียงผ่านเซิร์ฟเวอร์ (`yt-dlp` + `ffmpeg`) มาเลื่อนคีย์ด้วย Tone.js

## ต้องการอะไรบ้าง

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [ffmpeg](https://ffmpeg.org/)
- Chrome ที่ล็อกอิน YouTube แล้ว (เครื่อง local) หรือไฟล์ `cookies.txt` (เซิร์ฟเวอร์ / Docker)

## รันบนเครื่องตัวเอง

```bash
npm install
npm start
```

เปิด [http://localhost:3000](http://localhost:3000)

แท็บเล็ตใน Wi‑Fi เดียวกันใช้ URL ที่พิมพ์ในเทอร์มินัลบรรทัด `tablet:`

ครั้งแรก macOS อาจถามสิทธิ์ **Chrome Safe Storage** ให้กด Allow เพื่อให้ `yt-dlp` อ่านคุกกี้จาก Chrome

## Docker

ถ้าเคย `compose up` แล้ว Docker สร้าง `cookies.txt` เป็นโฟลเดอร์ ให้ลบทิ้งก่อน:

```bash
rm -rf cookies.txt
mkdir -p cookies
yt-dlp --cookies-from-browser chrome --cookies cookies/cookies.txt --skip-download "https://www.youtube.com"
docker compose up -d
```

อย่า commit คุกกี้ — โฟลเดอร์ `cookies/` ถูกละเว้นใน `.gitignore` แล้ว

หรือดึง image จาก Docker Hub (รองรับ `linux/amd64` และ `linux/arm64`):

```bash
docker pull teampat/tunetube
```

Build แล้ว push ทั้งสองสถาปัตยกรรม:

```bash
docker compose build --push
```

## ใช้งาน

1. ค้นหาเพลง หรือวางลิงก์ YouTube
2. เลือกคลิป
3. แตะเพื่อเปิดเสียง (เบราว์เซอร์บังคับคลิกก่อนใช้ Web Audio)
4. เล่นวิดีโอตามปกติ แล้วใช้ปุ่ม **− / + / รีเซ็ต** เพื่อเลื่อนคีย์

## API

| เส้นทาง | คำอธิบาย |
|---|---|
| `GET /api/search?q=` | ค้นหาคลิปบน YouTube |
| `GET /api/prepare?videoId=` | ดาวน์โหลดและแปลงเสียงเป็น `.m4a` แล้วเก็บใน `cache/` |
| `GET /api/stream?videoId=` | สตรีมไฟล์เสียงที่แปลงแล้ว (รองรับ Range) |
