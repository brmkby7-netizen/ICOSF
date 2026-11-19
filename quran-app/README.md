# Hifz: Quran memorization

A small installable web app (PWA) for memorizing the Quran ayah by ayah. You can use it on your phone or computer, and it needs no account. Progress is stored only on the device.

## Features

- **Range practice**: choose a range (say ayat 1–5), how many times each ayah repeats, and how many times to read the linked ayat together. With each ayah ×3 and linking ×2:
  1. Ayah 1 ×3
  2. Ayah 2 ×3, then 1–2 together ×2
  3. Ayah 3 ×3, then 1–3 together ×2
  4. …and so on, ending with 1–5 together ×2
- **Move on**: when you're ready, the range slides forward by one ayah without starting over. You read the new ayah (6) ×3, then the new range (2–6) together ×2. The range is saved per surah, so you can pick up another day. There's an optional pause after each repeat so you can recite.
- **Today's revision** (spaced repetition): when Move on drops an ayah from the range, it joins your revision automatically. It comes back later that day, the next morning, then after 2, 3 and 7 days, then roughly doubling, but never longer than a maximum gap (30 days by default). Ayat you tick ✓ as already memorized join the long-term rotation; ticking a whole surah spreads it over two weeks. The Today tab lists due passages, old revision first, up to a daily limit, and says when you're behind. Each review: recite from memory (with an optional first-word hint or Listen), reveal, tap any ayah you slipped on (it comes back tomorrow), then grade Forgot / Hard / Good / Easy. Progress shows ayat in revision and weak spots.
- **Fix an ayah's timing** (any reciter): tap the clock icon next to an ayah to nudge its start or end, listen to check, or play around the ayah and tap "Start is here" / "End is here". Neighbouring edges can move with it; fixes are saved per reciter and can be reset.
- **Hide text** on the surah page: blur the Arabic and tap an ayah to check yourself.
- **Reciters**: every mp3quran.net Hafs recording with published ayah timings (about 100, including Alafasy, Al-Sudais, Al-Shuraim, Al-Husary, Al-Minshawi, Abdul Basit, Al-Ghamdi, Al-Ajmi, Al-Dosari, Maher Al-Muaiqly) loops ayat straight away. The list is loaded live, with well-known reciters grouped first. Details for the original two:
  - **Idris Abkar**: all 114 surahs. Ayah timings come from mp3quran.net, so looping works straight away.
  - **Islam Sobhi**: 109 surahs. mp3quran.net doesn't publish ayah timings for this recording, so you mark them once per surah: tap along while the surah plays, once when ayah 1 begins and once at the end of each ayah. The timings are saved on the device. You can save part-way and continue later, or re-mark at any time.
- **Ayah-by-ayah reading view** in Uthmani script using the KFGQPC Uthmanic Script Hafs font (the Madinah Mushaf font), with tajweed colors and a color key. Tajweed colors and the English translation (Saheeh International) can each be turned off (Saheeh International). The ayah being recited is highlighted, and the page can scroll to follow it.
- **Progress**: mark single ayat or whole surahs as memorized, and see your totals by surah and by juz.
- **Offline**: the app itself, plus any Quran text and timings you've already opened, are cached for offline use. You can also save a surah's audio for offline playback.
- **Apple-style interface**: the system font, large titles that collapse into a translucent top bar, a bottom tab bar (Today, Surahs, Progress, Settings), grouped inset lists, iOS switches, a floating mini player and bottom sheets.
- Light and dark mode, playback speed, lock-screen media controls, and backup export/import (Settings).

## Running it

It's a static site with no build step. Serve the `quran-app/` folder over HTTP:

```sh
cd quran-app
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly from disk won't work, because ES modules and the service worker both need HTTP. To publish it, host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages). Installing it as an app requires HTTPS.

## Data sources

| What | Source |
| --- | --- |
| Surah list, KFGQPC-encoded text (`qpc_hafs`), tajweed markup, translation, juz boundaries | `api.quran.com/api/v4` |
| Recitation audio (whole-surah MP3s) | `cdn.mp3quran.net` |
| Reciter surah lists, Idris Abkar ayah timings | `mp3quran.net/api/v3` |

The audio is one MP3 per surah. Ayah segments are played by seeking to each ayah's start time and stopping at its end time.

## Code layout

```
index.html            app shell and settings dialog
css/styles.css        design tokens (light/dark) and layout
js/app.js             router and views: surah list, surah/practice, marking, progress
js/player.js          segment player and practice sessions (cumulative / single ayah / whole surah)
js/marker.js          tap-to-mark ayah timings
js/revision.js        revision scheduler (spaced repetition) and today's plan
js/api.js             Quran.com and mp3quran.net clients, offline audio
js/storage.js         localStorage: settings, memorized ayat, timings, backup
js/ui.js              helpers and icons
sw.js                 service worker (offline cache)
fonts/                KFGQPC Uthmanic Script Hafs (unmodified; free to use and
                      redistribute under the King Fahd Complex licence in the font)
```

## Adding a reciter

Add an entry to `RECITERS` in `js/api.js` with the reciter's mp3quran reciter id, moshaf id and server URL. If mp3quran publishes timings for that recording (see `https://mp3quran.net/api/v3/ayat_timing/reads`), set `timingRead` to its read id. Otherwise leave it `null`, and users will mark the timings themselves.
