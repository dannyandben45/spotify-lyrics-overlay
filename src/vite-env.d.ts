/// <reference types="vite/client" />

import type { LyricsApi } from '../electron/preload'

declare global {
  interface Window {
    lyricsApi: LyricsApi
  }
}
