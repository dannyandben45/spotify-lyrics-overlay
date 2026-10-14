import { useEffect, useRef, useState } from 'react'
import { fetchSyncedLyrics, type SyncedLyricsResult } from '../lib/lyrics'
import type { PlaybackPayload } from '../lib/types'

const SEEK_THRESHOLD_MS = 2200
const STALE_BEHIND_MS = 900
const EMPTY_RETRY_MS = 20_000
// Bump when lyric matching logic changes so stale wrong lyrics are refetched
const LYRICS_CACHE_VERSION = 7

const idlePayload = (partial?: Partial<PlaybackPayload>): PlaybackPayload => ({
  connected: true,
  trackId: null,
  title: '',
  artists: '',
  isPlaying: false,
  progressMs: 0,
  durationMs: 0,
  lines: [],
  source: null,
  status: 'idle',
  ...partial,
})

type Options = {
  enabled: boolean
  offsetMs?: number
}

export const usePlaybackSync = ({ enabled, offsetMs = 0 }: Options) => {
  const [playback, setPlayback] = useState<PlaybackPayload>(idlePayload())
  const lyricsCache = useRef<Map<string, SyncedLyricsResult>>(new Map())
  const emptyRetryAt = useRef<Map<string, number>>(new Map())
  const fetchingTracks = useRef<Set<string>>(new Set())
  const anchorPositionRef = useRef(0)
  const anchorAtRef = useRef(Date.now())
  const isPlayingRef = useRef(false)
  const trackIdRef = useRef<string | null>(null)
  const offsetRef = useRef(offsetMs)

  useEffect(() => {
    offsetRef.current = offsetMs
  }, [offsetMs])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let pollTimer: number | undefined
    let tickTimer: number | undefined

    const estimatedProgress = () => {
      const base = anchorPositionRef.current
      if (!isPlayingRef.current) return base
      return base + (Date.now() - anchorAtRef.current)
    }

    const publish = (next: PlaybackPayload) => {
      if (cancelled) return
      const withOffset = {
        ...next,
        progressMs: Math.max(0, next.progressMs + offsetRef.current),
      }
      setPlayback(withOffset)
      window.lyricsApi.sendPlaybackUpdate(withOffset)
    }

    const adoptPosition = (incoming: number, force = false) => {
      const current = estimatedProgress()
      const delta = incoming - current

      // Ignore slightly-stale SMTC samples that would pull lyrics backward
      if (!force && delta < 0 && Math.abs(delta) < STALE_BEHIND_MS) {
        return current
      }

      // Hard correct on seek / big drift
      if (force || Math.abs(delta) > SEEK_THRESHOLD_MS || delta > 0) {
        anchorPositionRef.current = incoming
        anchorAtRef.current = Date.now()
        return incoming
      }

      return current
    }

    const poll = async () => {
      const startedAt = Date.now()
      const result = await window.lyricsApi.getNowPlaying()
      const latency = Math.floor((Date.now() - startedAt) / 2)

      if (!result.ok) {
        publish(
          idlePayload({
            status: 'error',
            message: result.error,
          }),
        )
        return
      }

      if (!result.playing) {
        trackIdRef.current = null
        isPlayingRef.current = false
        publish(
          idlePayload({
            status: 'idle',
          }),
        )
        return
      }

      const trackId = result.trackKey
      const cacheKey = `${trackId}::v${LYRICS_CACHE_VERSION}`
      const title = result.title
      const artists = result.artist
      const album = result.album
      const durationMs = result.durationMs
      const trackChanged = trackIdRef.current !== trackId
      trackIdRef.current = trackId
      isPlayingRef.current = result.isPlaying

      // Compensate half of PowerShell round-trip while playing
      const sampled =
        result.positionMs + (result.isPlaying ? Math.max(0, latency) : 0)
      const progressMs = adoptPosition(sampled, trackChanged)

      let cached = lyricsCache.current.get(cacheKey)
      const needsFetch =
        !cached &&
        !fetchingTracks.current.has(cacheKey) &&
        Date.now() >= (emptyRetryAt.current.get(cacheKey) ?? 0)

      if (needsFetch) {
        fetchingTracks.current.add(cacheKey)
        publish({
          connected: true,
          trackId,
          title,
          artists,
          isPlaying: result.isPlaying,
          progressMs,
          durationMs,
          lines: [],
          source: null,
          status: 'loading',
          message: 'Fetching lyrics…',
        })

        try {
          const primaryArtist = artists.split(',')[0]?.trim() || artists
          const fetched = await fetchSyncedLyrics({
            title,
            artist: primaryArtist,
            album,
            durationSec: durationMs / 1000 || 180,
          })
          if (fetched.lines.length > 0) {
            cached = fetched
            lyricsCache.current.set(cacheKey, fetched)
            emptyRetryAt.current.delete(cacheKey)
          } else {
            cached = { lines: [], source: null }
            emptyRetryAt.current.set(cacheKey, Date.now() + EMPTY_RETRY_MS)
          }
        } catch {
          fetchingTracks.current.delete(cacheKey)
          emptyRetryAt.current.set(cacheKey, Date.now() + EMPTY_RETRY_MS)
          publish({
            connected: true,
            trackId,
            title,
            artists,
            isPlaying: result.isPlaying,
            progressMs: estimatedProgress(),
            durationMs,
            lines: [],
            source: null,
            status: 'error',
            message: 'Could not load lyrics',
          })
          return
        } finally {
          fetchingTracks.current.delete(cacheKey)
        }
      }

      const resolvedLines = cached?.lines ?? []
      const resolvedSource = cached?.source ?? null
      if (resolvedLines.length > 0) {
        publish({
          connected: true,
          trackId,
          title,
          artists,
          isPlaying: result.isPlaying,
          progressMs: estimatedProgress(),
          durationMs,
          lines: resolvedLines,
          source: resolvedSource,
          status: 'ready',
        })
        return
      }

      if (fetchingTracks.current.has(cacheKey)) {
        publish({
          connected: true,
          trackId,
          title,
          artists,
          isPlaying: result.isPlaying,
          progressMs: estimatedProgress(),
          durationMs,
          lines: [],
          source: null,
          status: 'loading',
          message: 'Fetching lyrics…',
        })
        return
      }

      publish({
        connected: true,
        trackId,
        title,
        artists,
        isPlaying: result.isPlaying,
        progressMs: estimatedProgress(),
        durationMs,
        lines: [],
        source: null,
        status: 'empty',
        message: 'No lyrics',
      })
    }

    const tick = () => {
      setPlayback((previous) => {
        if (!previous.trackId) return previous
        if (previous.status !== 'ready' && previous.status !== 'loading') {
          return previous
        }

        let nextProgress = estimatedProgress()
        if (previous.durationMs > 0) {
          nextProgress = Math.min(previous.durationMs, nextProgress)
        }
        nextProgress = Math.max(0, nextProgress + offsetRef.current)

        if (nextProgress === previous.progressMs) return previous

        const next = { ...previous, progressMs: nextProgress }
        window.lyricsApi.sendPlaybackUpdate(next)
        return next
      })
    }

    void poll()
    pollTimer = window.setInterval(() => {
      void poll()
    }, 1000)
    tickTimer = window.setInterval(tick, 100)

    return () => {
      cancelled = true
      if (pollTimer) window.clearInterval(pollTimer)
      if (tickTimer) window.clearInterval(tickTimer)
    }
  }, [enabled])

  return playback
}
