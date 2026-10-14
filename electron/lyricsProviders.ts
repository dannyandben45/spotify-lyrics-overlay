import * as OpenCC from 'opencc-js'

/** LRCLIB requires clients to identify themselves via User-Agent */
const APP_USER_AGENT =
  'SpotifyLyricsOverlay/1.0 (https://github.com/dannyandben45/spotify-lyrics-overlay)'

const lrclibHeaders = {
  'User-Agent': APP_USER_AGENT,
}

const FETCH_TIMEOUT_MS = 8000

const fetchWithTimeout = async (
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export type LyricLine = {
  timeMs: number
  text: string
}

export type LyricsQuery = {
  title: string
  artist: string
  album?: string
  durationSec: number
}

type LyricsFetchResult = {
  lines: LyricLine[]
  /** Duration of the master the LRC was timed against, when known */
  sourceDurationMs: number | null
}

const emptyResult = (): LyricsFetchResult => ({
  lines: [],
  sourceDurationMs: null,
})

/**
 * Spotify masters often differ in length from CN karaoke sources (no Spotify lyrics).
 * Scale LRC timestamps when we know (or can estimate) the source duration.
 */
const alignLyricsToTrackDuration = (
  lines: LyricLine[],
  sourceDurationMs: number | null,
  trackDurationMs: number,
): LyricLine[] => {
  if (lines.length === 0 || trackDurationMs < 5000) return lines

  let sourceMs =
    sourceDurationMs && sourceDurationMs > 5000 ? sourceDurationMs : null

  if (!sourceMs) {
    const last = lines[lines.length - 1]?.timeMs ?? 0
    if (last < 5000) return lines
    const coverage = last / trackDurationMs
    // Same-length master (lyric ends near song end) — keep as-is
    if (coverage >= 0.88 && coverage <= 1.05) return lines
    // Lyrics end early: estimate source length (typical short outro)
    if (coverage >= 0.72 && coverage < 0.88) {
      sourceMs = Math.round(last / 0.9)
    } else {
      return lines
    }
  }

  const ratio = trackDurationMs / sourceMs
  if (ratio < 0.9 || ratio > 1.15) return lines
  if (Math.abs(1 - ratio) < 0.012) return lines

  return lines.map((line) => ({
    ...line,
    timeMs: Math.max(0, Math.round(line.timeMs * ratio)),
  }))
}

// Search NetEase in Simplified; always display lyrics in Traditional
const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' })
const toTraditional = OpenCC.Converter({ from: 'cn', to: 't' })

const toTraditionalLines = (lines: LyricLine[]): LyricLine[] =>
  lines.map((line) => ({
    ...line,
    text: toTraditional(line.text),
  }))

const usefulAlbum = (title: string, album?: string) => {
  const a = album?.trim()
  if (!a) return undefined
  if (a === title.trim()) return undefined
  return a
}

const uniqueStrings = (values: string[]) => {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    output.push(trimmed)
  }
  return output
}

const parseLrc = (lrc: string): LyricLine[] => {
  const lines: LyricLine[] = []
  const pattern = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/g

  for (const rawLine of lrc.split(/\r?\n/)) {
    let match: RegExpExecArray | null
    pattern.lastIndex = 0

    while ((match = pattern.exec(rawLine)) !== null) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ?? '0'
      const millis =
        fraction.length <= 2
          ? Number(fraction.padEnd(2, '0')) * 10
          : Number(fraction.padEnd(3, '0'))
      const text = match[4].trim()
      if (!text) continue
      // Skip NetEase metadata / translation markers (簡／繁)
      if (
        text.startsWith('作词') ||
        text.startsWith('作詞') ||
        text.startsWith('作曲') ||
        text.startsWith('编曲') ||
        text.startsWith('編曲')
      ) {
        continue
      }

      lines.push({
        timeMs: minutes * 60_000 + seconds * 1000 + millis,
        text,
      })
    }
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

const plainToTimedLines = (plain: string, durationSec: number): LyricLine[] => {
  const rows = plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (rows.length === 0) return []

  const totalMs = Math.max(durationSec * 1000, rows.length * 3000)
  const step = Math.floor(totalMs / rows.length)

  return rows.map((text, index) => ({
    timeMs: index * step,
    text,
  }))
}

type LrcLibTrack = {
  id?: number
  duration?: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
  instrumental?: boolean
}

/**
 * Crowd-sourced LRCLIB sometimes returns evenly-spaced "guess" LRC
 * (e.g. King Gnu AIZO tagged 238s but marked Approximate timing, vocals at 0:00).
 * Those look synced but run ~10s early vs real masters.
 */
const isLowQualitySyncedLrc = (
  syncedLyrics: string,
  lines: LyricLine[],
): boolean => {
  if (/approximate\s+timing/i.test(syncedLyrics)) return true
  if (lines.length < 6) return false

  const first = lines[0]?.timeMs ?? 0
  if (first > 1500) return false

  const sample = lines.slice(0, Math.min(lines.length, 12))
  const gaps: number[] = []
  for (let i = 1; i < sample.length; i += 1) {
    gaps.push(sample[i].timeMs - sample[i - 1].timeMs)
  }
  if (gaps.length < 5) return false

  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  if (average < 1500 || average > 5000) return false

  const variance =
    gaps.reduce((sum, gap) => sum + (gap - average) ** 2, 0) / gaps.length
  const stdDev = Math.sqrt(variance)
  return stdDev < average * 0.18
}

const lrcLibTrackToResult = (
  track: LrcLibTrack,
  fallbackDurationSec: number,
): LyricsFetchResult => {
  if (track.instrumental) return emptyResult()
  const sourceDurationMs =
    typeof track.duration === 'number' && track.duration > 0
      ? Math.round(track.duration * 1000)
      : null

  if (track.syncedLyrics) {
    const lines = parseLrc(track.syncedLyrics)
    if (lines.length === 0) return emptyResult()
    if (isLowQualitySyncedLrc(track.syncedLyrics, lines)) return emptyResult()
    return { lines, sourceDurationMs }
  }
  if (track.plainLyrics) {
    return {
      lines: plainToTimedLines(track.plainLyrics, fallbackDurationSec),
      sourceDurationMs: sourceDurationMs ?? Math.round(fallbackDurationSec * 1000),
    }
  }
  return emptyResult()
}

const scoreLrcLibCandidate = (
  track: LrcLibTrack,
  durationSec: number,
): number => {
  const hasSynced = Boolean(track.syncedLyrics)
  const base = hasSynced ? 0 : 10_000
  if (typeof track.duration === 'number' && track.duration > 0) {
    // Prefer real synced LRC; among those, closest duration wins
    return base + Math.abs(track.duration - durationSec)
  }
  // Unknown duration: mild penalty so exact duration matches rank higher
  return base + 3
}

const fetchFromLrcLib = async (query: LyricsQuery): Promise<LyricsFetchResult> => {
  const durationSec = Math.round(query.durationSec || 0)
  const album = usefulAlbum(query.title, query.album)
  const candidates = new Map<string, LrcLibTrack>()

  const remember = (track: LrcLibTrack) => {
    const key =
      track.id != null
        ? `id:${track.id}`
        : `d:${track.duration ?? '?'}|${(track.syncedLyrics ?? track.plainLyrics ?? '').slice(0, 80)}`
    if (!candidates.has(key)) candidates.set(key, track)
  }

  // Exact + nearby durations: Spotify length often ≠ CN karaoke length
  const durationTries = uniqueStrings(
    [
      durationSec,
      durationSec - 1,
      durationSec + 1,
      durationSec - 2,
      durationSec + 2,
      Math.round(durationSec * 0.95),
      Math.round(durationSec * 0.94),
      Math.round(durationSec * 0.91),
      Math.round(durationSec * 0.9),
    ]
      .filter((value) => value > 30)
      .map(String),
  ).map(Number)

  for (const duration of durationTries) {
    const getUrl = new URL('https://lrclib.net/api/get')
    getUrl.searchParams.set('track_name', query.title)
    getUrl.searchParams.set('artist_name', query.artist)
    if (album) getUrl.searchParams.set('album_name', album)
    getUrl.searchParams.set('duration', String(duration))

    try {
      const response = await fetchWithTimeout(getUrl.toString(), {
        headers: lrclibHeaders,
      })
      if (!response.ok) continue
      remember((await response.json()) as LrcLibTrack)
    } catch {
      // try next
    }
  }

  const search = new URL('https://lrclib.net/api/search')
  search.searchParams.set('track_name', query.title)
  search.searchParams.set('artist_name', query.artist)
  if (album) search.searchParams.set('album_name', album)

  try {
    const searchResponse = await fetchWithTimeout(search.toString(), {
      headers: lrclibHeaders,
    })
    if (searchResponse.ok) {
      const results = (await searchResponse.json()) as LrcLibTrack[]
      if (Array.isArray(results)) {
        for (const track of results) remember(track)
      }
    }
  } catch {
    // keep get-only candidates
  }

  const ranked = [...candidates.values()].sort(
    (a, b) => scoreLrcLibCandidate(a, durationSec) - scoreLrcLibCandidate(b, durationSec),
  )

  for (const track of ranked) {
    if (!track.syncedLyrics) continue
    const result = lrcLibTrackToResult(track, durationSec)
    if (result.lines.length > 0) return result
  }

  for (const track of ranked) {
    if (!track.plainLyrics) continue
    const result = lrcLibTrackToResult(track, durationSec)
    if (result.lines.length > 0) return result
  }

  return emptyResult()
}

const neteaseHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
}

type NeteaseSong = {
  id: number
  name: string
  dt?: number
  artists?: Array<{ name: string }>
  ar?: Array<{ name: string }>
}

const searchNeteaseSongs = async (keyword: string): Promise<NeteaseSong[]> => {
  // cloudsearch works better outside CN than /api/search/get/web
  try {
    const response = await fetchWithTimeout(
      'https://music.163.com/api/cloudsearch/pc',
      {
        method: 'POST',
        headers: {
          ...neteaseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          s: keyword,
          type: '1',
          offset: '0',
          limit: '8',
        }),
      },
    )
    if (response.ok) {
      const searchJson = (await response.json()) as {
        result?: { songs?: NeteaseSong[] }
      }
      const songs = searchJson.result?.songs
      if (songs && songs.length > 0) return songs
    }
  } catch {
    // fallback below
  }

  const searchUrl = new URL('https://music.163.com/api/search/get/web')
  searchUrl.searchParams.set('s', keyword)
  searchUrl.searchParams.set('type', '1')
  searchUrl.searchParams.set('offset', '0')
  searchUrl.searchParams.set('limit', '8')

  const searchResponse = await fetchWithTimeout(searchUrl.toString(), {
    headers: neteaseHeaders,
  })
  if (!searchResponse.ok) return []

  const searchJson = (await searchResponse.json()) as {
    result?: { songs?: NeteaseSong[] }
  }

  return searchJson.result?.songs ?? []
}

const fetchFromNetease = async (query: LyricsQuery): Promise<LyricsFetchResult> => {
  const simplifiedTitle = toSimplified(query.title)
  const simplifiedArtist = toSimplified(query.artist)
  const primaryArtist = query.artist.split(',')[0]?.trim() || query.artist
  const simplifiedPrimaryArtist = toSimplified(primaryArtist)
  const trackDurationMs = Math.round((query.durationSec || 0) * 1000)

  const keywords = uniqueStrings([
    `${simplifiedArtist} ${simplifiedTitle}`,
    `${simplifiedPrimaryArtist} ${simplifiedTitle}`,
    `${simplifiedTitle} ${simplifiedPrimaryArtist}`,
    `${query.artist} ${query.title}`,
    `${primaryArtist} ${query.title}`,
    simplifiedTitle,
    query.title,
  ])

  const songMap = new Map<number, NeteaseSong>()

  for (const keyword of keywords) {
    const songs = await searchNeteaseSongs(keyword)
    for (const song of songs) {
      if (!songMap.has(song.id)) songMap.set(song.id, song)
    }
    if (songMap.size >= 8) break
  }

  const songs = [...songMap.values()]
  if (songs.length === 0) return emptyResult()

  const titleCandidates = uniqueStrings([
    query.title.toLowerCase(),
    simplifiedTitle.toLowerCase(),
  ])
  const artistCandidates = uniqueStrings([
    primaryArtist.toLowerCase(),
    simplifiedPrimaryArtist.toLowerCase(),
    'mr',
    'mr.',
  ])

  const ranked = songs.slice().sort((a, b) => {
    const aName = a.name.toLowerCase()
    const bName = b.name.toLowerCase()
    const aTitle = titleCandidates.some((title) => aName.includes(title)) ? 0 : 1
    const bTitle = titleCandidates.some((title) => bName.includes(title)) ? 0 : 1
    if (aTitle !== bTitle) return aTitle - bTitle

    const aArtists = [...(a.artists ?? []), ...(a.ar ?? [])]
      .map((item) => item.name.toLowerCase())
      .join(' ')
    const bArtists = [...(b.artists ?? []), ...(b.ar ?? [])]
      .map((item) => item.name.toLowerCase())
      .join(' ')
    const aArtist = artistCandidates.some((artist) => aArtists.includes(artist))
      ? 0
      : 1
    const bArtist = artistCandidates.some((artist) => bArtists.includes(artist))
      ? 0
      : 1
    if (aArtist !== bArtist) return aArtist - bArtist

    if (trackDurationMs > 0) {
      const da = Math.abs((a.dt ?? trackDurationMs) - trackDurationMs)
      const db = Math.abs((b.dt ?? trackDurationMs) - trackDurationMs)
      return da - db
    }
    return 0
  })

  for (const song of ranked.slice(0, 5)) {
    const lyricUrl = new URL('https://music.163.com/api/song/lyric')
    lyricUrl.searchParams.set('id', String(song.id))
    lyricUrl.searchParams.set('lv', '1')
    lyricUrl.searchParams.set('kv', '1')
    lyricUrl.searchParams.set('tv', '-1')

    const lyricResponse = await fetchWithTimeout(lyricUrl.toString(), {
      headers: neteaseHeaders,
    })
    if (!lyricResponse.ok) continue

    const lyricJson = (await lyricResponse.json()) as {
      lrc?: { lyric?: string }
    }

    const lrc = lyricJson.lrc?.lyric?.trim()
    if (!lrc) continue

    const lines = parseLrc(lrc)
    if (lines.length > 0) {
      return {
        lines,
        sourceDurationMs: song.dt && song.dt > 0 ? song.dt : null,
      }
    }
  }

  return emptyResult()
}

const fetchFromLyricsOvh = async (query: LyricsQuery): Promise<LyricsFetchResult> => {
  const artist = encodeURIComponent(query.artist.split(',')[0]?.trim() || query.artist)
  const title = encodeURIComponent(query.title)
  const url = `https://api.lyrics.ovh/v1/${artist}/${title}`

  const response = await fetchWithTimeout(url)
  if (!response.ok) return emptyResult()

  const json = (await response.json()) as { lyrics?: string }
  const plain = json.lyrics?.trim()
  if (!plain) return emptyResult()

  const durationSec = query.durationSec || 180
  return {
    lines: plainToTimedLines(plain, durationSec),
    sourceDurationMs: Math.round(durationSec * 1000),
  }
}

const looksLikeLrcPayload = (text: string) => {
  if (!text) return false
  if (text.startsWith('{')) return false
  // Real LRC starts with [mm:ss...] (allow leading tags like [Verse] then timed lines)
  if (/\[\d{1,2}:\d{2}/.test(text)) return true
  return false
}

/**
 * LrcAPI (api.lrc.cx) — free LRC aggregator (Kugou etc.).
 * Strong for 粵語/港台 when NetEase is blocked overseas.
 * Docs: https://github.com/HisAtri/LrcApi
 *
 * Important: do NOT prefer album=title. For Mr.《方向感》Spotify reports
 * album "方向感"; passing that album makes LrcAPI return a different Mandarin track.
 */
const fetchFromLrcApi = async (query: LyricsQuery): Promise<LyricsFetchResult> => {
  const primaryArtist = query.artist.split(',')[0]?.trim() || query.artist
  const titleVariants = uniqueStrings([query.title, toSimplified(query.title)])
  const artistVariants = uniqueStrings([
    primaryArtist,
    primaryArtist.replace(/\.$/, ''),
    toSimplified(primaryArtist),
    query.artist,
    toSimplified(query.artist),
  ])

  // Prefer no-album first. Only use album when it adds info (not same as title).
  const album = usefulAlbum(query.title, query.album) ?? ''
  const albumVariants = album ? ['', album] : ['']

  const headers = {
    'User-Agent': APP_USER_AGENT,
  }

  for (const albumName of albumVariants) {
    for (const title of titleVariants) {
      for (const artist of artistVariants) {
        const url = new URL('https://api.lrc.cx/lyrics')
        url.searchParams.set('title', title)
        url.searchParams.set('artist', artist)
        if (albumName) url.searchParams.set('album', albumName)

        try {
          const response = await fetchWithTimeout(url.toString(), { headers })
          if (!response.ok) continue

          const text = (await response.text()).trim()
          if (!looksLikeLrcPayload(text)) continue

          const lines = parseLrc(text)
          if (lines.length > 0) {
            const last = lines[lines.length - 1]?.timeMs ?? 0
            return {
              lines,
              // No official duration — estimate from last line for aligner
              sourceDurationMs: last > 0 ? Math.round(last / 0.9) : null,
            }
          }
        } catch {
          // try next variant
        }
      }
    }
  }

  return emptyResult()
}

const isLikelyCjkTrack = (query: LyricsQuery) =>
  /[\u4e00-\u9fff]/.test(`${query.title} ${query.artist} ${query.album ?? ''}`)

const fetchFromLrcLibWithVariants = async (
  query: LyricsQuery,
): Promise<LyricsFetchResult> => {
  const album = usefulAlbum(query.title, query.album)
  const variants = uniqueStrings([
    query.title,
    toSimplified(query.title),
  ]).flatMap((title) =>
    uniqueStrings([query.artist, toSimplified(query.artist)]).map((artist) => ({
      ...query,
      title,
      artist,
      album: album ? toSimplified(album) : undefined,
    })),
  )

  const seen = new Set<string>()
  for (const variant of variants) {
    const key = `${variant.title}|${variant.artist}`
    if (seen.has(key)) continue
    seen.add(key)
    const result = await fetchFromLrcLib(variant)
    if (result.lines.length > 0) return result
  }
  return emptyResult()
}

export const fetchLyricsWithFallbacks = async (
  query: LyricsQuery,
): Promise<{ lines: LyricLine[]; source: string | null }> => {
  const cjk = isLikelyCjkTrack(query)
  const trackDurationMs = Math.round((query.durationSec || 0) * 1000)

  // Prefer sources that publish track duration (better sync vs Spotify masters).
  // Spotify-without-lyrics tracks often use a different-length CN karaoke LRC.
  const providers: Array<{
    name: string
    run: () => Promise<LyricsFetchResult>
  }> = cjk
    ? [
        { name: 'lrclib', run: () => fetchFromLrcLibWithVariants(query) },
        { name: 'netease', run: () => fetchFromNetease(query) },
        { name: 'lrc.cx', run: () => fetchFromLrcApi(query) },
        { name: 'lyrics.ovh', run: () => fetchFromLyricsOvh(query) },
      ]
    : [
        { name: 'lrclib', run: () => fetchFromLrcLibWithVariants(query) },
        { name: 'lrc.cx', run: () => fetchFromLrcApi(query) },
        { name: 'netease', run: () => fetchFromNetease(query) },
        { name: 'lyrics.ovh', run: () => fetchFromLyricsOvh(query) },
      ]

  for (const provider of providers) {
    try {
      const result = await provider.run()
      if (result.lines.length > 0) {
        const aligned = alignLyricsToTrackDuration(
          result.lines,
          result.sourceDurationMs,
          trackDurationMs,
        )
        return {
          lines: toTraditionalLines(aligned),
          source: provider.name,
        }
      }
    } catch {
      // try next free source
    }
  }

  return { lines: [], source: null }
}
