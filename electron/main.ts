import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
} from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNowPlaying } from './mediaSession'
import { applyOverlayWindowStyle } from './win32OverlayStyle'
import { fetchLyricsWithFallbacks } from './lyricsProviders'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let controlWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let closingControl = false
let overlayStyleReady = false
let hardenOverlayTimer: ReturnType<typeof setTimeout> | null = null
let restoreOverlayOpacityTimer: ReturnType<typeof setTimeout> | null = null

const isDev = !app.isPackaged

type HardenOptions = {
  clickThrough?: boolean
  /** Soft = no SWP_FRAMECHANGED (avoids caption flash on focus changes) */
  soft?: boolean
  /** Hide overlay for one frame so a caption paint is not visible */
  concealFlash?: boolean
}

/**
 * Re-assert transparent / NOACTIVATE chrome.
 * Soft re-applies are used after focus changes so Windows does not flash
 * the caption strip via SWP_FRAMECHANGED.
 */
const hardenOverlayChrome = (opts: HardenOptions = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  const soft = opts.soft ?? overlayStyleReady
  const concealFlash = Boolean(opts.concealFlash)

  const applyOnce = async () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    overlayWindow.setBackgroundColor('#00000000')
    overlayWindow.setFocusable(false)
    if (opts.clickThrough !== undefined) {
      overlayWindow.setIgnoreMouseEvents(opts.clickThrough, { forward: true })
    }
    await applyOverlayWindowStyle(overlayWindow, { soft })
    if (!soft) overlayStyleReady = true
  }

  if (hardenOverlayTimer) clearTimeout(hardenOverlayTimer)
  if (restoreOverlayOpacityTimer) clearTimeout(restoreOverlayOpacityTimer)

  if (concealFlash) {
    // Hide for the focus transition so the caption paint is never visible
    overlayWindow.setOpacity(0)
    void (async () => {
      await applyOnce()
      await new Promise((resolve) => {
        hardenOverlayTimer = setTimeout(() => {
          hardenOverlayTimer = null
          resolve(undefined)
        }, 80)
      })
      await applyOnce()
      if (!overlayWindow || overlayWindow.isDestroyed()) return
      overlayWindow.setOpacity(1)
    })()
    return
  }

  void applyOnce()
  hardenOverlayTimer = setTimeout(() => {
    hardenOverlayTimer = null
    void applyOnce()
  }, 100)
}

const hideControlPanel = () => {
  if (!controlWindow || controlWindow.isDestroyed()) return
  closingControl = true
  // Conceal before focus leaves settings — otherwise the caption strip flashes once
  hardenOverlayChrome({ clickThrough: true, soft: true, concealFlash: true })
  controlWindow.hide()
  setTimeout(() => {
    closingControl = false
  }, 250)
}

// Keep GPU on — disabling hardware acceleration makes "transparent" areas
// show a noticeable tint on Windows.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-transparent-visuals')
}

const getPreloadPath = () => path.join(__dirname, 'preload.mjs')

const getRendererUrl = (windowName: 'control' | 'overlay') => {
  const rendererUrl =
    process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173/'
  const url = new URL(rendererUrl)
  url.searchParams.set('window', windowName)
  return url.toString()
}

const createTrayIcon = () => {
  const size = 16
  const canvas = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const dx = x - 7.5
      const dy = y - 7.5
      const inside = dx * dx + dy * dy <= 36
      canvas[i] = 30
      canvas[i + 1] = 215
      canvas[i + 2] = 96
      canvas[i + 3] = inside ? 255 : 0
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}

const createControlWindow = () => {
  controlWindow = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 360,
    minHeight: 420,
    show: false,
    title: 'Spotify Lyrics Overlay',
    backgroundColor: '#0f1410',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    controlWindow.loadURL(getRendererUrl('control'))
  } else {
    controlWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: { window: 'control' },
    })
  }

  // Keep hidden on launch — open via tray or overlay settings icon
  controlWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideControlPanel()
  })

  // Soft harden only — full FRAMECHANGED re-apply flashes the caption bar
  controlWindow.on('show', () => {
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })
  controlWindow.on('blur', () => {
    if (closingControl) return
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })
}

const OVERLAY_WIDTH = 720
const OVERLAY_HEIGHT = 240

const createOverlayWindow = () => {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.workAreaSize
  const overlayWidth = Math.min(OVERLAY_WIDTH, width - 80)

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: OVERLAY_HEIGHT,
    minWidth: overlayWidth,
    maxWidth: overlayWidth,
    minHeight: OVERLAY_HEIGHT,
    maxHeight: OVERLAY_HEIGHT,
    x: Math.round((width - overlayWidth) / 2),
    y: height - OVERLAY_HEIGHT - 40,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    // Critical: never take activation — stops Windows accent/title strip
    focusable: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    title: '',
    roundedCorners: false,
    ...(process.platform === 'win32'
      ? { backgroundMaterial: 'none' as const }
      : {}),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  overlayWindow.removeMenu()
  overlayWindow.setMenuBarVisibility(false)
  overlayWindow.setBackgroundColor('#00000000')
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setFocusable(false)

  if (isDev) {
    overlayWindow.loadURL(getRendererUrl('overlay'))
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: { window: 'overlay' },
    })
  }

  overlayWindow.once('ready-to-show', () => {
    if (!overlayWindow) return
    overlayStyleReady = false
    hardenOverlayChrome({ clickThrough: true, soft: false })
    overlayWindow.showInactive()
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })

  // Soft re-apply after focus changes — avoid FRAMECHANGED caption flash
  overlayWindow.on('blur', () => {
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })
  overlayWindow.on('show', () => {
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
    overlayStyleReady = false
  })
}

const buildTrayMenu = () =>
  Menu.buildFromTemplate([
    {
      label: 'Show Control Panel',
      click: () => {
        if (!controlWindow) createControlWindow()
        controlWindow?.show()
        controlWindow?.focus()
      },
    },
    {
      label: 'Toggle Lyrics Overlay',
      click: () => {
        if (!overlayWindow) {
          createOverlayWindow()
          return
        }
        if (overlayWindow.isVisible()) overlayWindow.hide()
        else overlayWindow.showInactive()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

const createTray = () => {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Spotify Lyrics Overlay')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => {
    controlWindow?.show()
    controlWindow?.focus()
  })
}

const registerIpc = () => {
  ipcMain.handle('media:nowPlaying', async () => getNowPlaying())

  ipcMain.handle(
    'lyrics:fetch',
    async (
      _event,
      query: {
        title: string
        artist: string
        album?: string
        durationSec: number
      },
    ) => fetchLyricsWithFallbacks(query),
  )

  ipcMain.handle('overlay:setVisible', (_event, visible: boolean) => {
    if (!overlayWindow) createOverlayWindow()
    if (visible) overlayWindow?.showInactive()
    else overlayWindow?.hide()
    return { ok: true }
  })

  ipcMain.handle('overlay:setClickThrough', async (_event, enabled: boolean) => {
    if (!overlayWindow) return { ok: false }
    // Soft only — full FRAMECHANGED here flashes the header on every hover
    hardenOverlayChrome({ clickThrough: enabled, soft: true })
    return { ok: true }
  })

  ipcMain.handle('overlay:lockFixedSize', () => {
    if (!overlayWindow) return { ok: false }
    const [x, y] = overlayWindow.getPosition()
    overlayWindow.setMinimumSize(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    overlayWindow.setMaximumSize(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    overlayWindow.setBounds({
      x,
      y,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    })
    return { ok: true }
  })

  let dragOffset: { x: number; y: number } | null = null

  ipcMain.on(
    'overlay:dragStart',
    (_event, point: { screenX: number; screenY: number }) => {
      if (!overlayWindow) return
      const [x, y] = overlayWindow.getPosition()
      dragOffset = {
        x: point.screenX - x,
        y: point.screenY - y,
      }
    },
  )

  ipcMain.on(
    'overlay:dragMove',
    (_event, point: { screenX: number; screenY: number }) => {
      if (!overlayWindow || !dragOffset) return
      overlayWindow.setPosition(
        Math.round(point.screenX - dragOffset.x),
        Math.round(point.screenY - dragOffset.y),
      )
    },
  )

  ipcMain.on('overlay:dragEnd', () => {
    dragOffset = null
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })

  ipcMain.handle('window:minimizeControl', () => {
    controlWindow?.minimize()
  })

  ipcMain.handle('window:hideControl', () => {
    hideControlPanel()
    return { ok: true }
  })

  ipcMain.handle('window:showControl', () => {
    if (!controlWindow) createControlWindow()
    // Opening settings leaves overlay interactive briefly — force click-through
    hardenOverlayChrome({ clickThrough: true, soft: true })
    controlWindow?.show()
    controlWindow?.focus()
    hardenOverlayChrome({ clickThrough: true, soft: true })
    return { ok: true }
  })

  ipcMain.handle('app:quit', () => {
    isQuitting = true
    app.quit()
    return { ok: true }
  })

  ipcMain.on('playback:update', (_event, payload) => {
    if (!overlayWindow) return
    overlayWindow.webContents.send('playback:update', payload)
  })
}

const startApp = () => {
  Menu.setApplicationMenu(null)
  registerIpc()
  createTray()
  createControlWindow()
  createOverlayWindow()

  // Focus moving to another app — soft harden (no FRAMECHANGED flash)
  app.on('browser-window-blur', () => {
    if (closingControl) return
    hardenOverlayChrome({ clickThrough: true, soft: true })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow()
      createOverlayWindow()
      return
    }
    // macOS dock click — show settings only on demand
  })
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    setTimeout(startApp, 400)
    return
  }
  startApp()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // Keep running in tray on Windows
})
