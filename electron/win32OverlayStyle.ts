import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import koffi from 'koffi'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_POPUP = 0x80000000
const WS_VISIBLE = 0x10000000
const WS_CLIPSIBLINGS = 0x04000000
const WS_CLIPCHILDREN = 0x02000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const WS_MINIMIZEBOX = 0x00020000
const WS_MAXIMIZEBOX = 0x00010000
const WS_SYSMENU = 0x00080000
const WS_EX_NOACTIVATE = 0x08000000
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_APPWINDOW = 0x00040000
const WS_EX_LAYERED = 0x00080000
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020

const WM_NCPAINT = 0x0085
const WM_NCACTIVATE = 0x0086

const DWMWA_NCRENDERING_POLICY = 2
const DWMWA_TRANSITIONS_FORCEDISABLED = 3
const DWMWA_BORDER_COLOR = 34
const DWMWA_CAPTION_COLOR = 35
const DWMWA_SYSTEMBACKDROP_TYPE = 38
const DWMWA_COLOR_NONE = 0xfffffffe
const DWMNCRP_DISABLED = 1
const DWMSBT_NONE = 1

type NativeApi = {
  GetWindowLongPtrW: (hWnd: unknown, nIndex: number) => bigint | number
  SetWindowLongPtrW: (
    hWnd: unknown,
    nIndex: number,
    dwNewLong: bigint | number,
  ) => bigint | number
  SetWindowPos: (
    hWnd: unknown,
    hWndInsertAfter: unknown,
    X: number,
    Y: number,
    cx: number,
    cy: number,
    uFlags: number,
  ) => number
  DefWindowProcW: (
    hWnd: unknown,
    Msg: number,
    wParam: bigint | number,
    lParam: bigint | number,
  ) => bigint | number
  DwmSetWindowAttribute: (
    hwnd: unknown,
    dwAttribute: number,
    pvAttribute: Buffer,
    cbAttribute: number,
  ) => number
  DwmExtendFrameIntoClientArea: (hwnd: unknown, margins: Buffer) => number
}

let nativeApi: NativeApi | null = null
let nativeFailed = false

const loadNativeApi = (): NativeApi | null => {
  if (nativeApi) return nativeApi
  if (nativeFailed || process.platform !== 'win32') return null

  try {
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')

    nativeApi = {
      GetWindowLongPtrW: user32.func(
        'intptr __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)',
      ),
      SetWindowLongPtrW: user32.func(
        'intptr __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, intptr dwNewLong)',
      ),
      SetWindowPos: user32.func(
        'bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)',
      ),
      DefWindowProcW: user32.func(
        'intptr __stdcall DefWindowProcW(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)',
      ),
      DwmSetWindowAttribute: dwmapi.func(
        'long __stdcall DwmSetWindowAttribute(void *hwnd, uint32 dwAttribute, void *pvAttribute, uint32 cbAttribute)',
      ),
      DwmExtendFrameIntoClientArea: dwmapi.func(
        'long __stdcall DwmExtendFrameIntoClientArea(void *hwnd, void *pMarInset)',
      ),
    }
    return nativeApi
  } catch {
    nativeFailed = true
    return null
  }
}

const toBig = (value: bigint | number) =>
  typeof value === 'bigint' ? value : BigInt(value)

const toNum = (value: unknown): bigint | number => {
  if (typeof value === 'bigint' || typeof value === 'number') return value
  if (Buffer.isBuffer(value)) {
    if (value.length >= 8) return value.readBigUInt64LE(0)
    if (value.length >= 4) return value.readUInt32LE(0)
  }
  return 0
}

const writeInt32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32LE(value, 0)
  return buffer
}

const writeUInt32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

/** DWM color / backdrop only — no SetWindowPos (avoids caption flash) */
export const applyNativeSoft = (win: BrowserWindow) => {
  const api = loadNativeApi()
  if (!api) return false

  const hwnd = win.getNativeWindowHandle()
  api.DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY, writeInt32(DWMNCRP_DISABLED), 4)
  api.DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, writeUInt32(DWMWA_COLOR_NONE), 4)
  api.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, writeUInt32(DWMWA_COLOR_NONE), 4)
  api.DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, writeInt32(DWMSBT_NONE), 4)
  api.DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, writeInt32(1), 4)
  return true
}

const applyNativeFull = (win: BrowserWindow) => {
  const api = loadNativeApi()
  if (!api) return false

  const hwnd = win.getNativeWindowHandle()

  // Strip any remaining caption / thick-frame styles Electron may leave
  let style = toBig(api.GetWindowLongPtrW(hwnd, GWL_STYLE))
  style |= BigInt(WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
  if (win.isVisible()) style |= BigInt(WS_VISIBLE)
  style &= ~BigInt(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
  api.SetWindowLongPtrW(hwnd, GWL_STYLE, style)

  let ex = toBig(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  ex |= BigInt(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED)
  ex &= ~BigInt(WS_EX_APPWINDOW)
  api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex)

  applyNativeSoft(win)

  const margins = Buffer.alloc(16)
  margins.writeInt32LE(-1, 0)
  margins.writeInt32LE(-1, 4)
  margins.writeInt32LE(-1, 8)
  margins.writeInt32LE(-1, 12)
  api.DwmExtendFrameIntoClientArea(hwnd, margins)

  api.SetWindowPos(
    hwnd,
    null,
    0,
    0,
    0,
    0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
  )
  return true
}

/**
 * Block Windows from painting the non-client caption.
 * WM_NCACTIVATE with lParam=-1 tells DefWindowProc not to repaint NC.
 */
export const installOverlayNcHooks = (win: BrowserWindow) => {
  if (process.platform !== 'win32') return

  const api = loadNativeApi()
  const hwnd = win.getNativeWindowHandle()

  try {
    win.hookWindowMessage(WM_NCPAINT, () => {
      applyNativeSoft(win)
      return true
    })

    win.hookWindowMessage(WM_NCACTIVATE, (wParam, _lParam) => {
      applyNativeSoft(win)
      if (api) {
        // -1 => DefWindowProc must not repaint the non-client area
        api.DefWindowProcW(hwnd, WM_NCACTIVATE, toNum(wParam), -1)
      }
      return true
    })
  } catch {
    // Older Electron / unsupported — ignore
  }
}

/**
 * 1px size nudge clears a phantom Win11 titlebar that can stick after focus changes.
 * Keeps final size identical so lyrics layout does not jump.
 * Uses setResizable toggle — required when min===max size locks the window.
 */
export const nudgeOverlayToClearCaption = (win: BrowserWindow) => {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  applyNativeSoft(win)

  const [w, h] = win.getSize()
  try {
    win.setResizable(true)
    win.setMinimumSize(1, 1)
    win.setMaximumSize(10000, 10000)
    win.setSize(w, h + 1)
    win.setSize(w, h)
    win.setMinimumSize(w, h)
    win.setMaximumSize(w, h)
    win.setResizable(false)
  } catch {
    // ignore
  }

  applyNativeSoft(win)
  win.setBackgroundColor('#00000000')
  win.setFocusable(false)
}

const resolveScriptPath = () => {
  const resourcesPath =
    typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  const candidates = [
    path.join(process.cwd(), 'electron', 'apply-overlay-style.ps1'),
    path.join(__dirname, '../electron/apply-overlay-style.ps1'),
    path.join(__dirname, 'apply-overlay-style.ps1'),
    path.join(resourcesPath, 'electron', 'apply-overlay-style.ps1'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return candidates[0]
}

const readHwndString = (win: BrowserWindow) => {
  const handle = win.getNativeWindowHandle()
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  return String(handle.readUInt32LE(0))
}

const applyViaPowerShell = async (win: BrowserWindow, soft: boolean) => {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolveScriptPath(),
    '-HwndValue',
    readHwndString(win),
  ]
  if (soft) args.push('-Soft')

  await execFileAsync('powershell.exe', args, {
    windowsHide: true,
    timeout: 4000,
  })
}

export type OverlayStyleOptions = {
  soft?: boolean
}

export const applyOverlayWindowStyle = async (
  win: BrowserWindow,
  options: OverlayStyleOptions = {},
) => {
  if (process.platform !== 'win32') return
  const soft = Boolean(options.soft)

  try {
    if (soft ? applyNativeSoft(win) : applyNativeFull(win)) return
  } catch {
    // fall through
  }

  try {
    await applyViaPowerShell(win, soft)
  } catch {
    // Non-fatal
  }
}
