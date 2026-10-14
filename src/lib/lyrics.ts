import type { LyricLine } from './types'

export type SyncedLyricsResult = {
  lines: LyricLine[]
  source: string | null
}

export const fetchSyncedLyrics = async (params: {
  title: string
  artist: string
  album?: string
  durationSec: number
}): Promise<SyncedLyricsResult> => {
  const result = await window.lyricsApi.fetchLyrics({
    title: params.title,
    artist: params.artist,
    album: params.album,
    durationSec: params.durationSec,
  })

  return {
    lines: result.lines ?? [],
    source: result.source ?? null,
  }
}

export const findActiveLineIndex = (
  lines: LyricLine[],
  progressMs: number,
): number => {
  if (lines.length === 0) return -1

  let active = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].timeMs <= progressMs) active = i
    else break
  }
  return active
}
