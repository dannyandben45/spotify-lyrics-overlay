import * as OpenCC from 'opencc-js'

/** LRCLIB requires clients to identify themselves via User-Agent */
const APP_USER_AGENT =
  'SpotifyLyricsOverlay/1.0 (https://github.com/dannyandben45/spotify-lyrics-overlay)'

const lrclibHeaders = {
  'User-Agent': APP_USER_AGENT,
}

const FETCH_TIMEOUT_MS = 4500
/** Duration delta (ms) good enough to stop waiting on slower providers */
const GOOD_ENOUGH_SCORE_MS = 3500

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
 * Spotify masters often differ in length from CN karaoke sources.
 * Only scale timestamps for large mismatches — small gaps (outro / silence)
 * must NOT be stretched or mid-song lines go early/late (e.g. 用背脊唱情歌
 * Spotify ~217s vs NetEase/LRCLIB ~210–215s).
 */
const alignLyricsToTrackDuration = (
  lines: LyricLine[],
  sourceDurationMs: number | null,
  trackDurationMs: number,
): LyricLine[] => {
  if (lines.length === 0 || trackDurationMs < 5000) return lines

  const last = lines[lines.length - 1]?.timeMs ?? 0
  let sourceMs =
    sourceDurationMs && sourceDurationMs > 5000 ? sourceDurationMs : null

  if (!sourceMs) {
    if (last < 5000) return lines
    const coverage = last / trackDurationMs
    // Lyric body already covers the track — keep original timing
    if (coverage >= 0.85 && coverage <= 1.08) return lines
    // Only estimate when the LRC is clearly for a much shorter/longer cut
    if (coverage >= 0.55 && coverage < 0.78) {
      sourceMs = Math.round(last / 0.9)
    } else {
      return lines
    }
  }

  const deltaMs = Math.abs(trackDurationMs - sourceMs)
  // Outro / padding differences under ~10s: keep karaoke timing as-is
  if (deltaMs < 10_000) return lines

  const ratio = trackDurationMs / sourceMs
  if (ratio < 0.88 || ratio > 1.14) return lines
  if (Math.abs(1 - ratio) < 0.02) return lines

  // If last line already sits near the Spotify end, stretching would hurt
  if (last > 0 && last / trackDurationMs >= 0.9) return lines

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
    const delta = Math.abs(track.duration - durationSec)
    // Hard-reject far-off masters (often wrong mix / karaoke)
    if (delta > 8) return base + 50_000 + delta
    return base + delta
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

  // Search first (1 request) — covers most tracks without duration guessing
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
    // fall through to get
  }

  // Only if search missed: exact duration get (±1) in parallel
  if (candidates.size === 0 && durationSec > 30) {
    const durationTries = uniqueStrings([
      String(durationSec),
      String(durationSec - 1),
      String(durationSec + 1),
    ]).map(Number)

    await Promise.all(
      durationTries.map(async (duration) => {
        const getUrl = new URL('https://lrclib.net/api/get')
        getUrl.searchParams.set('track_name', query.title)
        getUrl.searchParams.set('artist_name', query.artist)
        if (album) getUrl.searchParams.set('album_name', album)
        getUrl.searchParams.set('duration', String(duration))
        try {
          const response = await fetchWithTimeout(getUrl.toString(), {
            headers: lrclibHeaders,
          })
          if (!response.ok) return
          remember((await response.json()) as LrcLibTrack)
        } catch {
          // ignore
        }
      }),
    )
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
  const primaryArtist = query.artist.split(',')[0]?.trim() || query.artist
  const simplifiedPrimaryArtist = toSimplified(primaryArtist)
  const trackDurationMs = Math.round((query.durationSec || 0) * 1000)

  // Keep keyword fan-out tiny — each search is a full RTT
  const keywords = uniqueStrings([
    `${simplifiedPrimaryArtist} ${simplifiedTitle}`,
    `${primaryArtist} ${query.title}`,
    simplifiedTitle,
  ])

  const songMap = new Map<number, NeteaseSong>()

  for (const keyword of keywords) {
    const songs = await searchNeteaseSongs(keyword)
    for (const song of songs) {
      if (!songMap.has(song.id)) songMap.set(song.id, song)
    }
    if (songMap.size >= 5) break
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

  for (const song of ranked.slice(0, 3)) {
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
  // Cap variants — nested fan-out was the slow path for many 粵語 tracks
  const attempts = uniqueStrings([
    `${query.title}\0${primaryArtist}`,
    `${toSimplified(query.title)}\0${toSimplified(primaryArtist)}`,
  ]).map((pair) => {
    const [title, artist] = pair.split('\0')
    return { title, artist }
  })

  const headers = {
    'User-Agent': APP_USER_AGENT,
  }

  for (const { title, artist } of attempts) {
    const url = new URL('https://api.lrc.cx/lyrics')
    url.searchParams.set('title', title)
    url.searchParams.set('artist', artist)

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
          sourceDurationMs: last > 0 ? Math.round(last / 0.9) : null,
        }
      }
    } catch {
      // try next
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
    `${query.title}\0${query.artist}`,
    `${toSimplified(query.title)}\0${toSimplified(query.artist)}`,
  ]).map((pair) => {
    const [title, artist] = pair.split('\0')
    return {
      ...query,
      title,
      artist,
      album: album ? toSimplified(album) : undefined,
    }
  })

  for (const variant of variants) {
    const result = await fetchFromLrcLib(variant)
    if (result.lines.length > 0) return result
  }
  return emptyResult()
}

/** Lower is better — duration match beats first-hit LRCLIB guesses. */
const scoreSyncedCandidate = (
  result: LyricsFetchResult,
  trackDurationMs: number,
): number => {
  if (result.lines.length === 0) return Number.POSITIVE_INFINITY

  const lastMs = result.lines[result.lines.length - 1]?.timeMs ?? 0
  let score = 0

  if (result.sourceDurationMs && result.sourceDurationMs > 0 && trackDurationMs > 0) {
    score += Math.abs(result.sourceDurationMs - trackDurationMs)
  } else {
    // Unknown master length — weak estimate from last lyric
    score += 4000
    if (trackDurationMs > 0 && lastMs > 0) {
      score += Math.abs(lastMs - trackDurationMs * 0.92)
    }
  }

  // Timed past the Spotify song → almost certainly wrong master
  if (trackDurationMs > 0 && lastMs > trackDurationMs + 12_000) {
    score += 20_000
  }

  // Empty / intro-only timestamps
  if (result.lines.every((line) => !line.text.trim())) {
    score += 50_000
  }

  return score
}

export const fetchLyricsWithFallbacks = async (
  query: LyricsQuery,
): Promise<{ lines: LyricLine[]; source: string | null }> => {
  const cjk = isLikelyCjkTrack(query)
  const trackDurationMs = Math.round((query.durationSec || 0) * 1000)

  // Timed providers race in parallel; return as soon as one is a close duration match.
  // CJK: NetEase / LrcAPI usually beat crowd LRCLIB for 粵語港台 sync.
  const timedProviders: Array<{
    name: string
    run: () => Promise<LyricsFetchResult>
  }> = cjk
    ? [
        { name: 'netease', run: () => fetchFromNetease(query) },
        { name: 'lrc.cx', run: () => fetchFromLrcApi(query) },
        { name: 'lrclib', run: () => fetchFromLrcLibWithVariants(query) },
      ]
    : [
        { name: 'lrclib', run: () => fetchFromLrcLibWithVariants(query) },
        { name: 'lrc.cx', run: () => fetchFromLrcApi(query) },
        { name: 'netease', run: () => fetchFromNetease(query) },
      ]

  type Ranked = {
    name: string
    result: LyricsFetchResult
    score: number
  }

  const ranked: Ranked[] = []
  let remaining = timedProviders.length
  let earlyResolve: ((value: Ranked | null) => void) | null = null
  const earlyGate = new Promise<Ranked | null>((resolve) => {
    earlyResolve = resolve
  })

  const toPayload = (entry: Ranked) => {
    const aligned = alignLyricsToTrackDuration(
      entry.result.lines,
      entry.result.sourceDurationMs,
      trackDurationMs,
    )
    return {
      lines: toTraditionalLines(aligned),
      source: entry.name,
    }
  }

  const tasks = timedProviders.map(async (provider) => {
    try {
      const result = await provider.run()
      if (result.lines.length === 0) return
      const entry: Ranked = {
        name: provider.name,
        result,
        score: scoreSyncedCandidate(result, trackDurationMs),
      }
      ranked.push(entry)
      // Close duration match → show lyrics immediately, don't wait on LRCLIB etc.
      if (entry.score <= GOOD_ENOUGH_SCORE_MS) {
        earlyResolve?.(entry)
        earlyResolve = null
      }
    } catch {
      // provider failed
    } finally {
      remaining -= 1
      if (remaining <= 0) {
        earlyResolve?.(null)
        earlyResolve = null
      }
    }
  })

  const earlyWinner = await earlyGate
  if (earlyWinner) {
    void Promise.allSettled(tasks)
    return toPayload(earlyWinner)
  }

  await Promise.allSettled(tasks)
  ranked.sort((a, b) => a.score - b.score)
  const best = ranked.find((entry) => entry.score < 15_000) ?? ranked[0]
  if (best) return toPayload(best)

  try {
    const plain = await fetchFromLyricsOvh(query)
    if (plain.lines.length > 0) {
      return {
        lines: toTraditionalLines(plain.lines),
        source: 'lyrics.ovh',
      }
    }
  } catch {
    // no plain lyrics
  }

  return { lines: [], source: null }
}
