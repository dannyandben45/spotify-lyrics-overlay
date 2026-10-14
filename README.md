# Spotify Lyrics Overlay

Always-on-top floating lyrics for Spotify on Windows.

**No Spotify Developer account. No OAuth. No Client ID.**

The app reads whatever Spotify Desktop is playing through Windows media session, then loads lyrics from free sources.

**粵語 / 港台 / 中文歌**
1. Optional [KKBOX Open API](https://developer.kkbox.com/) — match the correct track in HK/TW (metadata only; KKBOX has no public lyrics API)
2. [LrcAPI](https://github.com/HisAtri/LrcApi) (`api.lrc.cx`) — synced LRC (strong for 粵語/港台)
3. NetEase Cloud Music lyric API (synced)
4. [LRCLIB](https://lrclib.net) (synced, tries traditional + simplified)
5. [lyrics.ovh](https://lyrics.ovh) (plain fallback)

**其他歌**
1. LRCLIB → LrcAPI → NetEase → lyrics.ovh

To enable KKBOX matching, set in `.env`:

```
KKBOX_CLIENT_ID=...
KKBOX_CLIENT_SECRET=...
```

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
