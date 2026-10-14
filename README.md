# Spotify Lyrics Overlay

Always-on-top floating lyrics for Spotify on Windows.

**No Spotify Developer account. No OAuth. No Client ID.**

The app reads whatever Spotify Desktop is playing through Windows media session, then loads lyrics from free sources.

**粵語 / 港台 / 中文歌**
1. [LRCLIB](https://lrclib.net) (synced, tries traditional + simplified)
2. NetEase Cloud Music lyric API (synced)
3. [LrcAPI](https://github.com/HisAtri/LrcApi) (`api.lrc.cx`) — synced LRC (strong for 粵語/港台)
4. [lyrics.ovh](https://lyrics.ovh) (plain fallback)

**其他歌**
1. LRCLIB → LrcAPI → NetEase → lyrics.ovh

## For anyone using it

1. Run the app
2. Open **Spotify Desktop** and play a track
3. Lyrics float on top of other windows
4. Close the control panel — overlay stays (system tray)

## Dev

```bash
npm install
npm run dev
```

## Notes

- Windows only (uses system media session)
- Prefer Spotify Desktop over the web player
- Some tracks have no synced lyrics on LRCLIB

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
