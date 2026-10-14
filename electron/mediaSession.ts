import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type NowPlaying =
  | { ok: true; playing: false }
  | {
      ok: true
      playing: true
      title: string
      artist: string
      album: string
      isPlaying: boolean
      positionMs: number
      durationMs: number
      appId: string
      trackKey: string
    }
  | { ok: false; error: string }

const resolveScriptPath = (fileName: string) => {
  const resourcesPath =
    typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  const candidates = [
    path.join(process.cwd(), 'electron', fileName),
    path.join(__dirname, '../electron', fileName),
    path.join(__dirname, fileName),
    path.join(resourcesPath, 'electron', fileName),
  ]

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }

  return candidates[0]
}

const parsePayload = (raw: string): NowPlaying => {
  const text = Buffer.from(raw.trim(), 'base64').toString('utf8')
  const parsed = JSON.parse(text) as {
    ok?: boolean
    playing?: boolean
    title?: string
    artist?: string
    album?: string
    isPlaying?: boolean
    positionMs?: number
    durationMs?: number
    appId?: string
    error?: string
  }

  if (!parsed.ok) {
    return { ok: false, error: parsed.error || 'Failed to read media session' }
  }

  if (!parsed.playing) {
    return { ok: true, playing: false }
  }

  const title = (parsed.title || '').trim()
  const artist = (parsed.artist || '').trim()
  if (!title) {
    return { ok: true, playing: false }
  }

  return {
    ok: true,
    playing: true,
    title,
    artist,
    album: (parsed.album || '').trim(),
    isPlaying: Boolean(parsed.isPlaying),
    positionMs: Number(parsed.positionMs) || 0,
    durationMs: Number(parsed.durationMs) || 0,
    appId: parsed.appId || '',
    trackKey: `${title.toLowerCase()}::${artist.toLowerCase()}`,
  }
}

let worker: ChildProcessWithoutNullStreams | null = null
let latest: NowPlaying = { ok: true, playing: false }
let latestAt = 0
let stdoutBuffer = ''
let starting: Promise<void> | null = null

const handleStdoutChunk = (chunk: string) => {
  stdoutBuffer += chunk
  const lines = stdoutBuffer.split(/\r?\n/)
  stdoutBuffer = lines.pop() ?? ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      latest = parsePayload(trimmed)
      latestAt = Date.now()
    } catch {
      // ignore malformed line
    }
  }
}

const stopWorker = () => {
  if (!worker) return
  const child = worker
  worker = null
  try {
    child.kill()
  } catch {
    // ignore
  }
}

const startWorker = async () => {
  if (worker && !worker.killed) return
  if (starting) {
    await starting
    return
  }

  starting = (async () => {
    const scriptPath = resolveScriptPath('get-now-playing-loop.ps1')
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Media session script missing: ${scriptPath}`)
    }

    stopWorker()
    stdoutBuffer = ''

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        cwd: os.homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
      },
    )

    worker = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data: string) => handleStdoutChunk(data))
    child.on('exit', () => {
      if (worker === child) worker = null
    })
    child.on('error', () => {
      if (worker === child) worker = null
    })

    // Wait briefly for first sample so callers aren't empty on cold start
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      if (latestAt > 0) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()

  try {
    await starting
  } finally {
    starting = null
  }
}

/** One-shot fallback when the persistent worker is unavailable */
const getNowPlayingOnce = async (): Promise<NowPlaying> => {
  try {
    const scriptPath = resolveScriptPath('get-now-playing.ps1')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        cwd: os.homedir(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
      },
    )

    return parsePayload(stdout)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Media session error',
    }
  }
}

/** Advance a cached SMTC sample to "now" so lyrics are not late by poll age */
const withAgedPosition = (sample: NowPlaying, sampledAt: number): NowPlaying => {
  if (!sample.ok || !sample.playing || !sample.isPlaying) return sample
  const ageMs = Math.max(0, Date.now() - sampledAt)
  if (ageMs <= 0) return sample
  let positionMs = sample.positionMs + ageMs
  if (sample.durationMs > 0) {
    positionMs = Math.min(positionMs, sample.durationMs)
  }
  return { ...sample, positionMs }
}

export const getNowPlaying = async (): Promise<NowPlaying> => {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'Media session reading is only supported on Windows',
    }
  }

  try {
    await startWorker()
  } catch {
    return getNowPlayingOnce()
  }

  // Fresh enough — avoid spawning another PowerShell
  if (latestAt > 0 && Date.now() - latestAt < 2500) {
    return withAgedPosition(latest, latestAt)
  }

  // Worker stalled — one-shot then restart
  const once = await getNowPlayingOnce()
  latest = once
  latestAt = Date.now()
  stopWorker()
  void startWorker().catch(() => {})
  return once
}

export const stopMediaSessionWorker = () => {
  stopWorker()
}
