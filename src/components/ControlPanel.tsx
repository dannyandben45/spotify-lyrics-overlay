import { useEffect, useState } from 'react'
import { findActiveLineIndex } from '../lib/lyrics'
import { usePlaybackSync } from '../hooks/usePlaybackSync'

const OFFSET_KEY = 'lyrics-sync-offset-ms'

export const ControlPanel = () => {
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [clickThrough, setClickThrough] = useState(false)
  const [offsetMs, setOffsetMs] = useState(() => {
    const saved = Number(localStorage.getItem(OFFSET_KEY) ?? '0')
    return Number.isFinite(saved) ? saved : 0
  })
  const playback = usePlaybackSync({ enabled: true, offsetMs })

  useEffect(() => {
    localStorage.setItem(OFFSET_KEY, String(offsetMs))
  }, [offsetMs])

  const handleToggleOverlay = async () => {
    const next = !overlayVisible
    setOverlayVisible(next)
    await window.lyricsApi.setOverlayVisible(next)
  }

  const handleToggleClickThrough = async () => {
    const next = !clickThrough
    setClickThrough(next)
    await window.lyricsApi.setClickThrough(next)
  }

  const handleNudge = (delta: number) => {
    setOffsetMs((value) => Math.max(-15000, Math.min(15000, value + delta)))
  }

  const activeIndex = findActiveLineIndex(playback.lines, playback.progressMs)
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
        <h2 className="mb-3 text-sm font-semibold">Overlay</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleToggleOverlay}
            className="rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:bg-white/5"
            aria-label="Toggle lyrics overlay"
          >
            {overlayVisible ? 'Hide overlay' : 'Show overlay'}
          </button>
          <button
            type="button"
            onClick={handleToggleClickThrough}
            className="rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:bg-white/5"
            aria-label="Toggle click through"
          >
            {clickThrough ? 'Disable click-through' : 'Enable click-through'}
          </button>
          <button
            type="button"
            onClick={() => window.lyricsApi.hideControl()}
            className="rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold text-[var(--muted)] transition hover:bg-white/5"
            aria-label="Hide to tray"
          >
            Hide to tray
          </button>
        </div>
      </section>

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
        </div>
      </section>
    </div>
  )
}
