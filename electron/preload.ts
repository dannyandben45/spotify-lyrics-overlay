import { contextBridge, ipcRenderer } from 'electron'

export type NowPlayingResult =
  | { ok: true; playing: false }
  | {
      ok: true
      playing: true
      title: string
      artist: string
      album: string
      isPlaying: boolean
      positionMs: number
      durationMs: number
      appId: string
      trackKey: string
    }
  | { ok: false; error: string }

const api = {
  getNowPlaying: (): Promise<NowPlayingResult> =>
    ipcRenderer.invoke('media:nowPlaying'),
  fetchLyrics: (query: {
    title: string
    artist: string
    album?: string
    durationSec: number
  }): Promise<{ lines: Array<{ timeMs: number; text: string }>; source: string | null }> =>
    ipcRenderer.invoke('lyrics:fetch', query),
  setOverlayVisible: (visible: boolean) =>
    ipcRenderer.invoke('overlay:setVisible', visible),
  setClickThrough: (enabled: boolean) =>
    ipcRenderer.invoke('overlay:setClickThrough', enabled),
  lockOverlayFixedSize: () => ipcRenderer.invoke('overlay:lockFixedSize'),
  startOverlayDrag: (point: { screenX: number; screenY: number }) =>
    ipcRenderer.send('overlay:dragStart', point),
  moveOverlayDrag: (point: { screenX: number; screenY: number }) =>
    ipcRenderer.send('overlay:dragMove', point),
  endOverlayDrag: () => ipcRenderer.send('overlay:dragEnd'),
  minimizeControl: () => ipcRenderer.invoke('window:minimizeControl'),
  hideControl: () => ipcRenderer.invoke('window:hideControl'),
  showControl: () => ipcRenderer.invoke('window:showControl'),
  sendPlaybackUpdate: (payload: unknown) =>
    ipcRenderer.send('playback:update', payload),
  onPlaybackUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload)
    }
    ipcRenderer.on('playback:update', listener)
    return () => {
      ipcRenderer.removeListener('playback:update', listener)
    }
  },
}

contextBridge.exposeInMainWorld('lyricsApi', api)

export type LyricsApi = typeof api
