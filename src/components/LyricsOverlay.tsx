import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { lyricsSourceAttribution } from '../lib/attribution'
import { findActiveLineIndex } from '../lib/lyrics'
import type { PlaybackPayload } from '../lib/types'
import { LyricWheel } from './LyricWheel'

const emptyPlayback: PlaybackPayload = {
  connected: false,
  trackId: null,
  title: '',
  artists: '',
  isPlaying: false,
  progressMs: 0,
  durationMs: 0,
  lines: [],
  source: null,
  status: 'loading',
}

const SCALE_MIN = 0.7
const SCALE_MAX = 1.8
/** Pixels of diagonal drag ≈ +1.0 scale */
const DIAGONAL_PX_PER_SCALE = 420

const clampScale = (value: number) =>
  Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(value * 100) / 100))

const isPointInRect = (x: number, y: number, rect: DOMRect) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

export const LyricsOverlay = () => {
  const [playback, setPlayback] = useState<PlaybackPayload>(emptyPlayback)
  // Always start at 100% — scale is session-only, not persisted
  const [scale, setScale] = useState(() => {
    document.documentElement.style.setProperty('--overlay-scale', '1')
    return 1
  })
  const dragHandleRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const scaleCornerRef = useRef<HTMLButtonElement | null>(null)
  const draggingRef = useRef(false)
  const scalingRef = useRef<{
    startScreenX: number
    startScreenY: number
    startScale: number
  } | null>(null)
  const clickThroughRef = useRef(true)
  const scaleRef = useRef(scale)
  const applyingExternalScaleRef = useRef(false)

  useEffect(() => {
    scaleRef.current = scale
    document.documentElement.style.setProperty('--overlay-scale', String(scale))
    if (applyingExternalScaleRef.current) {
      applyingExternalScaleRef.current = false
      return
    }
    void window.lyricsApi.setOverlayScale(scale).then((result) => {
      if (
        result.ok &&
        typeof result.scale === 'number' &&
        Math.abs(result.scale - scaleRef.current) > 0.01
      ) {
        applyingExternalScaleRef.current = true
        setScale(clampScale(result.scale))
      }
    })
  }, [scale])

  useEffect(() => {
    return window.lyricsApi.onPlaybackUpdate((payload) => {
      setPlayback(payload as PlaybackPayload)
    })
  }, [])

  useEffect(() => {
    return window.lyricsApi.onOverlayScale((nextScale) => {
      const clamped = clampScale(nextScale)
      if (Math.abs(clamped - scaleRef.current) < 0.01) return
      applyingExternalScaleRef.current = true
      setScale(clamped)
    })
  }, [])

  useEffect(() => {
    localStorage.removeItem('overlay-scale')
    void window.lyricsApi.setOverlayScale(1)
  }, [])

  useEffect(() => {
    void window.lyricsApi.setClickThrough(true)
    clickThroughRef.current = true

    const setClickThrough = (enabled: boolean) => {
      if (clickThroughRef.current === enabled) return
      clickThroughRef.current = enabled
      void window.lyricsApi.setClickThrough(enabled)
    }

    const isOverInteractive = (clientX: number, clientY: number) => {
      const handle = dragHandleRef.current
      const toolbar = toolbarRef.current
      const corner = scaleCornerRef.current
      if (handle && isPointInRect(clientX, clientY, handle.getBoundingClientRect())) {
        return true
      }
      if (
        toolbar &&
        isPointInRect(clientX, clientY, toolbar.getBoundingClientRect())
      ) {
        return true
      }
      if (
        corner &&
        isPointInRect(clientX, clientY, corner.getBoundingClientRect())
      ) {
        return true
      }
      return false
    }

    const handleMouseMove = (event: MouseEvent) => {
      if (scalingRef.current) {
        setClickThrough(false)
        // Diagonal only: average of right + down (ignore pure left/right or up/down stretch)
        const dx = event.screenX - scalingRef.current.startScreenX
        const dy = event.screenY - scalingRef.current.startScreenY
        const diagonal = (dx + dy) / 2
        const next = clampScale(
          scalingRef.current.startScale + diagonal / DIAGONAL_PX_PER_SCALE,
        )
        setScale(next)
        return
      }

      if (draggingRef.current) {
        setClickThrough(false)
        window.lyricsApi.moveOverlayDrag({
          screenX: event.screenX,
          screenY: event.screenY,
        })
        return
      }

      setClickThrough(!isOverInteractive(event.clientX, event.clientY))
    }

    const handleMouseUp = () => {
      if (scalingRef.current) {
        scalingRef.current = null
        setClickThrough(true)
        return
      }
      if (!draggingRef.current) return
      draggingRef.current = false
      window.lyricsApi.endOverlayDrag()
      setClickThrough(true)
    }

    const handleMouseLeave = () => {
      if (draggingRef.current || scalingRef.current) return
      setClickThrough(true)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    document.documentElement.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.documentElement.removeEventListener('mouseleave', handleMouseLeave)
      void window.lyricsApi.setClickThrough(true)
    }
  }, [])

  const handleDragStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    if (event.button !== 0) return

    event.preventDefault()
    draggingRef.current = true
    clickThroughRef.current = false
    void window.lyricsApi.setClickThrough(false)
    window.lyricsApi.startOverlayDrag({
      screenX: event.screenX,
      screenY: event.screenY,
    })
  }

  const handleScaleStart = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    scalingRef.current = {
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startScale: scaleRef.current,
    }
    clickThroughRef.current = false
    void window.lyricsApi.setClickThrough(false)
  }

  const handleQuitApp = () => {
    void window.lyricsApi.quitApp()
  }

  const activeIndex = findActiveLineIndex(playback.lines, playback.progressMs)
  const sourceLabel = lyricsSourceAttribution(playback.source)
  const isPending =
    playback.status === 'idle' || playback.status === 'loading'
  const isConfirmedNoLyrics =
    (playback.status === 'empty' || playback.status === 'error') &&
    Boolean(playback.trackId)
  const isReady = playback.status === 'ready' && playback.lines.length > 0

  return (
    <div className="overlay-shell">
      <div className="overlay-card relative">
        <button
          ref={scaleCornerRef}
          type="button"
          className="overlay-scale-corner"
          onMouseDown={handleScaleStart}
          aria-label={`Scale overlay diagonally, currently ${Math.round(scale * 100)} percent. Drag along the diagonal to resize.`}
          title="Drag diagonally to scale"
          tabIndex={0}
        />

        <div
          ref={toolbarRef}
          className="absolute top-1 right-2 z-10 flex items-center gap-0.5"
        >
          <button
            type="button"
            className="overlay-settings cursor-pointer rounded-lg p-1.5 text-white/80 transition hover:text-white"
            onClick={() => {
              clickThroughRef.current = true
              void window.lyricsApi.setClickThrough(true)
              void window.lyricsApi.showControl()
            }}
            aria-label="Open settings"
            tabIndex={0}
          >
            <svg
              className="overlay-settings-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.4 1.04.72 1.62.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.62-.94l2.39.96c.25.1.54 0 .68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z" />
            </svg>
          </button>
          <button
            type="button"
            className="overlay-settings cursor-pointer rounded-lg p-1.5 text-white/80 transition hover:text-white"
            onClick={handleQuitApp}
            aria-label="Close app"
            tabIndex={0}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div
          ref={dragHandleRef}
          className="overlay-drag-handle overlay-text-shadow cursor-move pt-2 pr-16 pb-2 pl-6 text-left"
          onMouseDown={handleDragStart}
          role="presentation"
          aria-label="Drag overlay"
        >
          <p className="truncate text-xs font-medium text-white/85">
            {playback.title || ' '}
          </p>
          <p className="truncate text-[11px] text-white/55">
            {playback.artists || ' '}
          </p>
        </div>

        <div
          className="overlay-lyrics overlay-text-shadow pointer-events-none px-8 pb-3 pt-1 text-center"
          aria-hidden={false}
        >
          {isPending ? (
            <div
              className="flex h-[9.375rem] items-center justify-center"
              aria-label="Loading lyrics"
              role="status"
            >
              <span className="lyrics-spinner" aria-hidden />
            </div>
          ) : isConfirmedNoLyrics ? (
            <div className="flex h-[9.375rem] items-center justify-center">
              <p className="font-display text-3xl text-white italic">No lyrics</p>
            </div>
          ) : isReady ? (
            <LyricWheel
              key={playback.trackId ?? 'track'}
              lines={playback.lines}
              activeIndex={activeIndex}
              emptyLabel="Music..."
            />
          ) : (
            <div className="flex h-[9.375rem] items-center justify-center">
              <p className="font-display text-3xl text-white/80 italic">Music...</p>
            </div>
          )}
          {isReady && sourceLabel ? (
            <p className="mt-1 text-[10px] tracking-wide text-white/35">
              {sourceLabel}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
