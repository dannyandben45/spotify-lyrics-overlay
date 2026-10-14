# Spotify Lyrics Overlay

Always-on-top floating lyrics for **Spotify Desktop on Windows**.

**Windows only.** macOS and Linux are not supported (the app uses the Windows media session API).

**No Spotify Developer account. No OAuth. No Client ID.**

---

## Download

Get the latest portable `.exe` from GitHub Releases:

**https://github.com/dannyandben45/spotify-lyrics-overlay/releases**

1. Open the newest release (e.g. `v1.0.1`)
2. Download **Spotify Lyrics Overlay x.x.x.exe**
3. Double-click to run — no installer needed

Windows may show SmartScreen on first run (unsigned app). Choose **More info → Run anyway**.

---

## How to use

1. Start **Spotify Lyrics Overlay** (the `.exe`)
2. Open **Spotify Desktop** and play a song  
   (Desktop app works best; the web player is less reliable)
3. Lyrics appear in a floating overlay on top of other windows
4. The app stays in the **system tray** (green circle near the clock)

### Tray menu

| Action | What it does |
| --- | --- |
| **Show Control Panel** | Opens settings |
| **Toggle Lyrics Overlay** | Show / hide the lyrics window |
| **Quit** | Exit the app completely |

Double-click the tray icon to open settings.

### Settings (Control Panel)

- Turn the overlay on or off
- Adjust sync / display options
- **Overlay size** — scale lyrics; use **Reset scale** to go back to default  
  (You can also drag the small triangle at the top-left of the overlay to resize diagonally)
- Close settings with **X** — the overlay keeps running; reopen from the tray

### Tips

- Closing the settings window does **not** quit the app — use **Quit** in the tray (or the quit control in settings)
- Scale resets each time you reopen the app
- Some tracks have no synced lyrics; the app will try several free sources

---

## Lyrics sources

**粵語 / 港台 / 中文歌**
1. [LRCLIB](https://lrclib.net) (synced, tries traditional + simplified)
2. NetEase Cloud Music lyric API (synced)
3. [LrcAPI](https://github.com/HisAtri/LrcApi) (`api.lrc.cx`) — synced LRC (strong for 粵語/港台)
4. [lyrics.ovh](https://lyrics.ovh) (plain fallback)

**其他歌**
1. LRCLIB → LrcAPI → NetEase → lyrics.ovh

---

## Dev (contributors)

```bash
npm install
npm run dev
```

Build a portable Windows `.exe`:

```bash
npm run dist
```

Output: `release/Spotify Lyrics Overlay x.x.x.exe`

---

## Requirements

- **Windows 10 / 11** (x64)
- **Spotify Desktop** installed and playing

---

## Attribution

This project is **not affiliated with, endorsed by, or sponsored by Spotify AB**.
“Spotify” is a trademark of Spotify AB.

Lyrics are fetched on demand from free third-party sources. Song lyrics remain
the property of their respective writers, publishers, and rights holders.
This app does not claim ownership of any lyrics.

| Source | Link |
| --- | --- |
| LRCLIB | https://lrclib.net |
| NetEase Cloud Music | https://music.163.com |
| LrcAPI | https://github.com/HisAtri/LrcApi |
| lyrics.ovh | https://lyrics.ovh |

Chinese traditional/simplified conversion uses [opencc-js](https://github.com/nk2028/opencc-js).
