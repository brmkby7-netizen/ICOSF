# Hifz: Quran memorization

A small installable web app (PWA) for memorizing the Quran ayah by ayah. You can use it on your phone or computer, and it needs no account. Progress is stored only on the device.

## Features

- **Range practice**: choose a range (say ayat 1–5), how many times each ayah repeats, and how many times to read the linked ayat together. With each ayah ×3 and linking ×2:
  1. Ayah 1 ×3
  2. Ayah 2 ×3, then 1–2 together ×2
  3. Ayah 3 ×3, then 1–3 together ×2
  4. …and so on, ending with 1–5 together ×2
- **Understand before you memorize**: under the range you pick, the surah page shows what those ayat are about, from classical tafsir only (nothing AI-written):
  - **Flow of the passage**: Ibn Kathir's section headings with the ayat each one covers (for example 78:1–5 "Refutation against the Idolators' Denial of the Occurrence of the Day of Judgement", then 6–16 "Mentioning Allah's Power…"). Tap one to read that part of the tafsir.
  - **Story and reason for revelation**, where Ibn Kathir tells one (for example why Surat Ad-Duha was revealed).
  - **In brief**: the short explanations from Tazkirul Quran (Maulana Wahiduddin Khan).
  - **Read the tafsir**: the full Ibn Kathir (Abridged) text for the range, in a sheet, with the Arabic it quotes. **About this surah** shows Ibn Kathir's introduction when the range starts at ayah 1.
  - **Move on** shows the meaning of the next ayah before you add it, and says when it starts a new section. After moving on, the card leads with the new ayah.
  - **Meaning hints**: in Test yourself ("Meaning" shows the current ayah's translation) and in revision ("Meaning", next to "First word": the first ayah's translation and the passage's flow).
  - The texts are loaded from Quran.com when needed (they aren't bundled), and stay available offline once loaded. Ibn Kathir's sections are matched to ayat by the Arabic they quote: 99.9% of ayat fall in a section (surah 105 has no Ibn Kathir text on Quran.com, so only Tazkirul Quran is shown there).
- **Pick by Mushaf page**: choose a page of the Madinah Mushaf (604 pages) and the range becomes the ayat of this surah on that page. The row also tells you which page your range is on.
- **Move on**: when you're ready, the range slides forward by one ayah without starting over. You read the new ayah (6) ×3, then the new range (2–6) together ×2. The range is saved per surah, so you can pick up another day. There's an optional pause after each repeat so you can recite.
- **Today's revision** (spaced repetition): when Move on drops an ayah from the range, it joins your revision automatically. It comes back later that day, the next morning, then after 2, 3 and 7 days, then roughly doubling, but never longer than a maximum gap (30 days by default). Ayat you tick ✓ as already memorized join the long-term rotation; ticking a whole surah spreads it over two weeks. The Today tab lists due passages, old revision first, up to a daily limit, and says when you're behind. Each review: recite from memory (with an optional first-word hint or Listen), reveal, tap any ayah you slipped on (it comes back tomorrow), then grade Forgot / Hard / Good / Easy. Progress shows ayat in revision and weak spots.
- **Fix an ayah's timing** (any reciter): tap the clock icon next to an ayah to nudge its start or end, listen to check, or play around the ayah and tap "Start is here" / "End is here". Neighbouring edges can move with it; fixes are saved per reciter and can be reset.
- **Test yourself (recitation check)**: recite a range from memory and the app listens on the device. Each word you get right is revealed; missed or wrong words turn red; tajweed and single-sound points get a soft orange underline you can tap for the explanation (for example "necessary madd too short: 3 counts instead of 6"). It follows you from ayah to ayah, notices a skipped word or ayah, handles stops and restarts, and offers to send ayat with mistakes to revision. Uses the open HisnLabs tajweed-v2 speech model (Apache-2.0) with ONNX Runtime Web; a one-time 37 MB download, then it works offline and your voice never leaves the phone. Tested on professional recordings: about 97% of skipped words caught, about 2% of correct words falsely flagged red.
- **Hide text** on the surah page: blur the Arabic and tap an ayah to check yourself.
- **Reciters**: every mp3quran.net Hafs recording with published ayah timings (about 100, including Alafasy, Al-Sudais, Al-Shuraim, Al-Husary, Al-Minshawi, Abdul Basit, Al-Ghamdi, Al-Ajmi, Al-Dosari, Maher Al-Muaiqly) loops ayat straight away. The list is loaded live, with well-known reciters grouped first. Tap **Reciter** to open the list and search by name in English or Arabic. The search forgives the different ways names are spelled ("Sudais" finds Alsudaes, "Alafasy" finds Alafasi, "Muaiqly" finds Al Meaqli, "السديس" or "عبد الباسط" work too); press Enter to pick the top match. Details for the original two:
  - **Idris Abkar**: all 114 surahs. Ayah timings come from mp3quran.net, so looping works straight away.
  - **Islam Sobhi**: 109 surahs. mp3quran.net doesn't publish ayah timings for this recording, so you mark them once per surah: tap along while the surah plays, once when ayah 1 begins and once at the end of each ayah. The timings are saved on the device. You can save part-way and continue later, or re-mark at any time.
- **Ayah-by-ayah reading view** in Uthmani script using the KFGQPC Uthmanic Script Hafs font (the Madinah Mushaf font), with tajweed colors and a color key. Tajweed colors and the English translation (Saheeh International) can each be turned off (Saheeh International). The ayah being recited is highlighted, and the page can scroll to follow it.
- **Progress**: mark single ayat or whole surahs as memorized, and see your totals by surah and by juz.
- **Offline**: the app itself, plus any Quran text and timings you've already opened, are cached for offline use. You can also save a surah's audio for offline playback.
- **Apple-style interface**: the system font, large titles that collapse into a translucent top bar, a bottom tab bar (Today, Surahs, Progress, Settings), grouped inset lists, iOS switches, a floating mini player and bottom sheets.
- **Keeps going when the phone sleeps**: within a session the audio never stops between repeats. It jumps silently from ayah to ayah and plays muted through the "pause to recite" gaps, because a phone suspends a page whose audio has stopped. If something else interrupts it (a call, another app), it shows as paused and Play (in the app or on the lock screen) carries on from the same place. **Keep screen on** (Settings, on by default) stops the phone from sleeping while a session plays or Test yourself is listening.
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
| Tafsir: Ibn Kathir (Abridged, id 169), Tazkirul Quran (id 817) | `api.quran.com/api/v4/tafsirs/{id}/by_chapter/{surah}` (loaded at runtime) |
| Madinah Mushaf page of every ayah | `data/pages.json` (from Quran.com's page numbers) |

The audio is one MP3 per surah. Ayah segments are played by seeking to each ayah's start time and stopping at its end time.

## Code layout

```
index.html            app shell and settings dialog
css/styles.css        design tokens (light/dark) and layout
js/app.js             router and views: surah list, surah/practice, marking, progress
js/player.js          segment player and practice sessions (cumulative / single ayah / whole surah)
js/marker.js          tap-to-mark ayah timings
js/revision.js        revision scheduler (spaced repetition) and today's plan
js/context.js         classical tafsir for a range: flow, story, brief, full text; Mushaf pages
js/search.js          reciter search (English and Arabic, spelling-tolerant)
js/recite/            recitation check: engine (rules), mel (spectrogram), worker (model), mic, session, client
models/tajweed-v2/    speech model (Apache-2.0, see NOTICE.md)
vendor/onnxruntime-web/  ONNX Runtime Web 1.30 (MIT)
data/phonetic/        expected pronunciation of every ayah (generated)
js/api.js             Quran.com and mp3quran.net clients, offline audio
js/storage.js         localStorage: settings, memorized ayat, timings, backup
js/ui.js              helpers and icons
sw.js                 service worker (offline cache)
fonts/                KFGQPC Uthmanic Script Hafs (unmodified; free to use and
                      redistribute under the King Fahd Complex licence in the font)
```

## Adding a reciter

Add an entry to `RECITERS` in `js/api.js` with the reciter's mp3quran reciter id, moshaf id and server URL. If mp3quran publishes timings for that recording (see `https://mp3quran.net/api/v3/ayat_timing/reads`), set `timingRead` to its read id. Otherwise leave it `null`, and users will mark the timings themselves.
