import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const readHwnd = (win: BrowserWindow) => {
  const handle = win.getNativeWindowHandle()
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  return String(handle.readUInt32LE(0))
}

const resolveScriptPath = () => {
  const candidates = [
    path.join(process.cwd(), 'electron', 'apply-overlay-style.ps1'),
    path.join(__dirname, '../electron/apply-overlay-style.ps1'),
    path.join(__dirname, 'apply-overlay-style.ps1'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/**
 * Prevents Windows from painting the accent/title-bar strip on the overlay
 * when focus switches to another app (WS_EX_NOACTIVATE + TOOLWINDOW).
 */
export const applyOverlayWindowStyle = async (win: BrowserWindow) => {
  if (process.platform !== 'win32') return

  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolveScriptPath(),
        '-HwndValue',
        readHwnd(win),
      ],
      { windowsHide: true, timeout: 4000 },
    )
  } catch {
    // Non-fatal — overlay still works without the style tweak
  }
}
