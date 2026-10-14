import { useEffect, useRef, useState } from 'react'
import { lyricsSourceAttribution } from '../lib/attribution'
import { findActiveLineIndex } from '../lib/lyrics'
import { usePlaybackSync } from '../hooks/usePlaybackSync'

export const ControlPanel = () => {
  const [offsetMs, setOffsetMs] = useState(0)
  const [overlayScale, setOverlayScale] = useState(1)
  const lastTrackIdRef = useRef<string | null>(null)
  const playback = usePlaybackSync({ enabled: true, offsetMs })

  // Reset nudge when the track changes; keep it when the same song is replayed
  useEffect(() => {
    const trackId = playback.trackId
    if (!trackId) return
    if (
      lastTrackIdRef.current !== null &&
      lastTrackIdRef.current !== trackId
    ) {
      setOffsetMs(0)
    }
    lastTrackIdRef.current = trackId
  }, [playback.trackId])

  useEffect(() => {
    return window.lyricsApi.onOverlayScale((scale) => {
      setOverlayScale(scale)
    })
  }, [])

  const handleNudge = (delta: number) => {
    setOffsetMs((value) => Math.max(-15000, Math.min(15000, value + delta)))
  }

  const handleResetScale = () => {
    void window.lyricsApi.setOverlayScale(1)
  }

  const activeIndex = findActiveLineIndex(playback.lines, playback.progressMs)
  const sourceLabel = lyricsSourceAttribution(playback.source)
  const previewLine =
    playback.status === 'loading' || playback.status === 'idle'
      ? 'Loading…'
      : activeIndex >= 0
        ? playback.lines[activeIndex]?.text
        : playback.status === 'ready'
          ? 'Music...'
          : playback.trackId
            ? 'No lyrics'
            : 'Music...'

  return (
    <div className="control-shell px-6 py-7">
      <header className="mb-8">
        <p className="mb-2 text-xs font-semibold tracking-[0.22em] text-[var(--accent)] uppercase">
          Lyrics Overlay
        </p>
        <h1 className="font-display text-4xl leading-none tracking-tight text-[var(--ink)]">
          Float lyrics over anything
        </h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--muted)]">
          No Spotify login needed. Open Spotify Desktop, play a song, and lyrics
          float on top.
        </p>
      </header>

      <section className="mb-5 rounded-2xl border border-[var(--line)] bg-[rgba(26,34,28,0.72)] p-4 backdrop-blur">
        <h2 className="mb-2 text-sm font-semibold">Sync timing</h2>
        <p className="mb-3 text-xs text-[var(--muted)]">
          If lyrics are early/late, nudge the offset. Current:{' '}
          <span className="text-[var(--ink)]">
            {offsetMs >= 0 ? '+' : ''}
            {(offsetMs / 1000).toFixed(1)}s
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleNudge(-500)}
            className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:bg-white/5"
            aria-label="Lyrics earlier by half second"
          >
            −0.5s
          </button>
          <button
            type="button"
            onClick={() => handleNudge(500)}
            className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:bg-white/5"
            aria-label="Lyrics later by half second"
          >
            +0.5s
          </button>
          <button
            type="button"
            onClick={() => setOffsetMs(0)}
            className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:bg-white/5"
            aria-label="Reset sync offset"
          >
            Reset
          </button>
        </div>
      </section>

      <section className="mb-5 rounded-2xl border border-[var(--line)] bg-[rgba(26,34,28,0.72)] p-4 backdrop-blur">
        <h2 className="mb-2 text-sm font-semibold">Overlay size</h2>
        <p className="mb-3 text-xs text-[var(--muted)]">
          Drag the top-left triangle diagonally to scale. Current:{' '}
          <span className="text-[var(--ink)]">
            {Math.round(overlayScale * 100)}%
          </span>
        </p>
        <button
          type="button"
          onClick={handleResetScale}
          className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:bg-white/5"
          aria-label="Reset overlay scale to 100 percent"
        >
          Reset scale
        </button>
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-[rgba(26,34,28,0.72)] p-4 backdrop-blur">
        <h2 className="mb-1 text-sm font-semibold">Now playing</h2>
        <p className="text-lg font-semibold tracking-tight">
          {playback.title || '—'}
        </p>
        <p className="mb-4 text-sm text-[var(--muted)]">
          {playback.artists || 'Start a song in Spotify Desktop'}
        </p>
        <div className="rounded-xl bg-black/25 px-4 py-5 text-center">
          <p className="font-display text-2xl leading-snug italic">
            {previewLine}
          </p>
          {sourceLabel ? (
            <p className="mt-3 text-[11px] tracking-wide text-[var(--muted)]">
              {sourceLabel}
            </p>
          ) : null}
        </div>
      </section>

      <footer className="mt-6 space-y-1 text-[11px] leading-relaxed text-[var(--muted)]">
        <p>
          Not affiliated with, endorsed by, or sponsored by Spotify AB.
        </p>
        <p>
          Lyrics courtesy of{' '}
          <a
            href="https://lrclib.net"
            className="underline decoration-[var(--line)] underline-offset-2 transition hover:text-[var(--ink)]"
            target="_blank"
            rel="noreferrer"
          >
            LRCLIB
          </a>
          , NetEase Cloud Music,{' '}
          <a
            href="https://github.com/HisAtri/LrcApi"
            className="underline decoration-[var(--line)] underline-offset-2 transition hover:text-[var(--ink)]"
            target="_blank"
            rel="noreferrer"
          >
            LrcAPI
          </a>
          , and{' '}
          <a
            href="https://lyrics.ovh"
            className="underline decoration-[var(--line)] underline-offset-2 transition hover:text-[var(--ink)]"
            target="_blank"
            rel="noreferrer"
          >
            lyrics.ovh
          </a>
          . Rights belong to their respective owners.
        </p>
      </footer>
    </div>
  )
}
