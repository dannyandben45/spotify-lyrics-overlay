import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const resolveScriptPath = () => {
  const resourcesPath =
    typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  const candidates = [
    path.join(process.cwd(), 'electron', 'get-now-playing.ps1'),
    path.join(__dirname, '../electron/get-now-playing.ps1'),
    path.join(__dirname, 'get-now-playing.ps1'),
    path.join(resourcesPath, 'electron', 'get-now-playing.ps1'),
  ]

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }

  return candidates[0]
}

export const getNowPlaying = async (): Promise<NowPlaying> => {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'Media session reading is only supported on Windows',
    }
  }

  try {
    const scriptPath = resolveScriptPath()
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
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

    // PowerShell returns UTF-8 JSON wrapped in base64 (avoids CP950/Big5 mojibake)
    const text = Buffer.from(stdout.trim(), 'base64').toString('utf8')
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
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Media session error',
    }
  }
}
