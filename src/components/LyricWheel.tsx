import {
  useEffect,
  useRef,
  useState,
  type TransitionEvent as ReactTransitionEvent,
} from 'react'
import type { LyricLine } from '../lib/types'

type LyricWheelProps = {
  lines: LyricLine[]
  activeIndex: number
  emptyLabel?: string
}

const ROW_PX = 50
const VIEW_ROWS = 3
const ROLL_MS = 480
const WRAP_AT_CHARS = 18

const lineText = (lines: LyricLine[], index: number) => {
  if (index < 0 || index >= lines.length) return ''
  return lines[index]?.text ?? ''
}

/** Prefer a clean 2-line split at brackets / commas when the lyric is long. */
const formatLyricForDisplay = (text: string) => {
  const trimmed = text.trim()
  if (trimmed.length <= WRAP_AT_CHARS) return trimmed

  const splitBefore = (pattern: RegExp) => {
    const match = pattern.exec(trimmed)
    if (!match || match.index === undefined) return null
    const index = match.index
    if (index < 8 || index > trimmed.length - 4) return null
    return `${trimmed.slice(0, index).trimEnd()}\n${trimmed.slice(index).trimStart()}`
  }

  const splitAfter = (pattern: RegExp) => {
    const match = pattern.exec(trimmed)
    if (!match || match.index === undefined) return null
    const end = match.index + match[0].length
    if (end < 8 || end > trimmed.length - 4) return null
    return `${trimmed.slice(0, end).trimEnd()}\n${trimmed.slice(end).trimStart()}`
  }

  return (
    splitBefore(/[（(]/) ||
    splitAfter(/[,，、]\s*/) ||
    splitAfter(/\s+/) ||
    trimmed
  )
}

export const LyricWheel = ({
  lines,
  activeIndex,
  emptyLabel = 'Music...',
}: LyricWheelProps) => {
  const [baseIndex, setBaseIndex] = useState(activeIndex)
  const [slide, setSlide] = useState(0)
  const [rolling, setRolling] = useState(false)
  const [freezeMotion, setFreezeMotion] = useState(false)
  const rollingRef = useRef(false)
  const slideRef = useRef(0)
  const queueRef = useRef<number | null>(null)
  const baseIndexRef = useRef(baseIndex)

  useEffect(() => {
    baseIndexRef.current = baseIndex
  }, [baseIndex])

  useEffect(() => {
    slideRef.current = slide
  }, [slide])

  useEffect(() => {
    if (lines.length === 0) {
      rollingRef.current = false
      queueRef.current = null
      setRolling(false)
      setSlide(0)
      setFreezeMotion(false)
      setBaseIndex(-1)
      return
    }

    const startRoll = () => {
      if (rollingRef.current) return
      rollingRef.current = true
      setFreezeMotion(false)
      // Paint idle sizes first, then morph + translate together
      setRolling(true)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!rollingRef.current) return
          setSlide(1)
        })
      })
    }

    const applyTarget = (target: number) => {
      const current = baseIndexRef.current
      if (target === current && !rollingRef.current) return

      // Seek / jump / first lyric: snap without roll
      if (target !== current + 1 || current < 0 || target < 0) {
        rollingRef.current = false
        queueRef.current = null
        setFreezeMotion(true)
        setRolling(false)
        setSlide(0)
        setBaseIndex(target)
        baseIndexRef.current = target
        window.requestAnimationFrame(() => setFreezeMotion(false))
        return
      }

      if (rollingRef.current) {
        queueRef.current = target
        return
      }

      startRoll()
    }

    applyTarget(activeIndex)
  }, [activeIndex, lines.length])

  const settleTo = (nextBase: number) => {
    setFreezeMotion(true)
    setRolling(false)
    setSlide(0)
    setBaseIndex(nextBase)
    baseIndexRef.current = nextBase
    rollingRef.current = false

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setFreezeMotion(false)

        const queued = queueRef.current
        queueRef.current = null
        if (queued === null || queued === nextBase) return

        if (queued === nextBase + 1) {
          rollingRef.current = true
          setRolling(true)
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              if (!rollingRef.current) return
              setSlide(1)
            })
          })
          return
        }

        setFreezeMotion(true)
        setBaseIndex(queued)
        baseIndexRef.current = queued
        window.requestAnimationFrame(() => setFreezeMotion(false))
      })
    })
  }

  const handleTransitionEnd = (event: ReactTransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.propertyName !== 'transform') return
    if (!rollingRef.current || slideRef.current !== 1) return
    settleTo(baseIndexRef.current + 1)
  }

  const focus = baseIndex
  const start = focus < 0 ? -1 : focus - 1
  const rowIndexes = [start, start + 1, start + 2, start + 3]

  const trackClass = [
    'lyric-wheel-track',
    rolling ? 'is-rolling' : '',
    freezeMotion ? 'is-frozen' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className="lyric-wheel"
      style={{ height: ROW_PX * VIEW_ROWS }}
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className={trackClass}
        style={{
          transform: `translateY(${-slide * ROW_PX}px)`,
          transitionDuration: freezeMotion || !rolling ? '0ms' : `${ROLL_MS}ms`,
        }}
        onTransitionEnd={handleTransitionEnd}
      >
        {rowIndexes.map((index, rowOrder) => {
          const isIntro = index === -1 && focus < 0
          const rawText = isIntro
            ? emptyLabel
            : index < 0
              ? ''
              : lineText(lines, index)
          const text = rawText ? formatLyricForDisplay(rawText) : ''

          let role = 'edge'
          if (index === focus) role = 'current'
          else if (index === focus - 1) role = 'prev'
          else if (index === focus + 1) role = 'next'

          const morph =
            rolling && index === focus
              ? 'is-morph-out'
              : rolling && index === focus + 1
                ? 'is-morph-in'
                : ''

          return (
            <div
              key={`wheel-row-${rowOrder}`}
              className={`lyric-wheel-row lyric-wheel-row--${role} ${morph}`.trim()}
              style={{
                height: ROW_PX,
                transitionDuration: freezeMotion ? '0ms' : `${ROLL_MS}ms`,
              }}
            >
              <p className="lyric-wheel-text">{text || ' '}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
