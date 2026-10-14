export type SpotifyArtist = {
  name: string
}

export type SpotifyTrack = {
  id: string
  name: string
  duration_ms: number
  artists: SpotifyArtist[]
  album?: {
    name: string
    images?: Array<{ url: string }>
  }
}

export type SpotifyCurrentlyPlaying = {
  is_playing: boolean
  progress_ms: number
  item: SpotifyTrack | null
  currently_playing_type?: string
}

export type LyricLine = {
  timeMs: number
  text: string
}

export type PlaybackPayload = {
  connected: boolean
  trackId: string | null
  title: string
  artists: string
  isPlaying: boolean
  progressMs: number
  durationMs: number
  lines: LyricLine[]
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  message?: string
}
