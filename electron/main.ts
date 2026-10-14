import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  type Rectangle,
} from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNowPlaying } from './mediaSession'
import {
  applyOverlayWindowStyle,
  installOverlayNcHooks,
  nudgeOverlayToClearCaption,
} from './win32OverlayStyle'
import { fetchLyricsWithFallbacks } from './lyricsProviders'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let controlWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let closingControl = false
let controlParked = false
let controlSavedBounds: Rectangle | null = null
let overlayStyleReady = false

const isDev = !app.isPackaged

type HardenOptions = {
  clickThrough?: boolean
  /** Soft = DWM attributes only (no SetWindowPos) */
  soft?: boolean
}

/**
 * Re-assert transparent / NOACTIVATE chrome.
 * Soft path never calls SetWindowPos — that redraw is what flashes the caption.
 * Never toggles overlay opacity/visibility.
 */
const hardenOverlayChrome = async (opts: HardenOptions = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  const soft = opts.soft ?? overlayStyleReady
  overlayWindow.setBackgroundColor('#00000000')
  overlayWindow.setFocusable(false)
  if (opts.clickThrough !== undefined) {
    overlayWindow.setIgnoreMouseEvents(opts.clickThrough, { forward: true })
  }
  await applyOverlayWindowStyle(overlayWindow, { soft })
  if (!soft) overlayStyleReady = true
}

/** Clear phantom Win11 caption after taskbar / app focus returns */
const clearOverlayCaption = () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  nudgeOverlayToClearCaption(overlayWindow)
}

/**
 * Closing settings with hide() makes Win11 DWM paint a caption strip on the
 * transparent overlay. Park the control window off-screen instead — no hide(),
 * no overlay blink, no caption flash.
 */
const hideControlPanel = () => {
  if (!controlWindow || controlWindow.isDestroyed()) return
  if (controlParked) return

  closingControl = true
  void (async () => {
    await hardenOverlayChrome({ clickThrough: true, soft: true })
    if (!controlWindow || controlWindow.isDestroyed()) {
      closingControl = false
      return
    }

    controlSavedBounds = controlWindow.getBounds()
    const { width, height } = controlSavedBounds
    // Leave taskbar so click-to-restore does not activate DWM caption paint
    controlWindow.setSkipTaskbar(true)
    controlWindow.setOpacity(0)
    controlWindow.setIgnoreMouseEvents(true)
    controlWindow.setBounds({ x: -32000, y: -32000, width, height })
    controlParked = true

    await hardenOverlayChrome({ clickThrough: true, soft: true })
    clearOverlayCaption()
    closingControl = false
  })()
}

const showControlPanel = () => {
  if (!controlWindow || controlWindow.isDestroyed()) {
    createControlWindow()
  }
  if (!controlWindow) return

  void (async () => {
    await hardenOverlayChrome({ clickThrough: true, soft: true })
    if (!controlWindow || controlWindow.isDestroyed()) return

    const display = screen.getPrimaryDisplay().workArea
    const bounds =
      controlSavedBounds ??
      ({
        width: 420,
        height: 560,
        x: Math.round(display.x + (display.width - 420) / 2),
        y: Math.round(display.y + (display.height - 560) / 2),
      } satisfies Rectangle)

    controlWindow.setBounds(bounds)
    controlWindow.setOpacity(1)
    controlWindow.setIgnoreMouseEvents(false)
    controlWindow.setSkipTaskbar(false)
    controlParked = false

    if (!controlWindow.isVisible()) {
      controlWindow.show()
    }
    controlWindow.focus()
    await hardenOverlayChrome({ clickThrough: true, soft: true })
    clearOverlayCaption()
  })()
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
    // Hidden until opened from tray — avoids taskbar focus → overlay caption flash
    skipTaskbar: true,
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

  controlWindow.on('show', () => {
    void hardenOverlayChrome({ clickThrough: true, soft: true })
    clearOverlayCaption()
  })

  // Taskbar click focuses settings — that is when Win11 paints the overlay caption
  controlWindow.on('focus', () => {
    if (closingControl) return
    void hardenOverlayChrome({ clickThrough: true, soft: true })
    clearOverlayCaption()
  })
}

const OVERLAY_WIDTH = 720
const OVERLAY_HEIGHT = 240
const OVERLAY_SCALE_MIN = 0.7
const OVERLAY_SCALE_MAX = 1.8

const clampOverlayScale = (scale: number) =>
  Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, scale))

const applyOverlayScale = (scale: number) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false as const }
  const next = clampOverlayScale(scale)
  const width = Math.round(OVERLAY_WIDTH * next)
  const height = Math.round(OVERLAY_HEIGHT * next)
  const [x, y] = overlayWindow.getPosition()
  const display = screen.getDisplayMatching({
    x,
    y,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  })
  const work = display.workArea
  const maxW = Math.max(120, work.width - 40)
  const maxH = Math.max(80, work.height - 40)
  const finalW = Math.min(width, maxW)
  const finalH = Math.min(height, maxH)
  const finalScale = Math.min(finalW / OVERLAY_WIDTH, finalH / OVERLAY_HEIGHT)
  const w = Math.round(OVERLAY_WIDTH * finalScale)
  const h = Math.round(OVERLAY_HEIGHT * finalScale)

  overlayWindow.setMinimumSize(w, h)
  overlayWindow.setMaximumSize(w, h)
  overlayWindow.setBounds({
    x: Math.min(x, work.x + work.width - w),
    y: Math.min(y, work.y + work.height - h),
    width: w,
    height: h,
  })

  const payload = { ok: true as const, scale: finalScale }
  if (!overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:scale', finalScale)
  }
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('overlay:scale', finalScale)
  }
  return payload
}

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
    // toolbar type reduces Win11 caption chrome on transparent windows
    // Do NOT set backgroundMaterial — it regresses caption paint on Electron 35.5+
    ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
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
  installOverlayNcHooks(overlayWindow)

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
    void (async () => {
      await hardenOverlayChrome({ clickThrough: true, soft: false })
      overlayWindow?.showInactive()
      await hardenOverlayChrome({ clickThrough: true, soft: true })
      clearOverlayCaption()
    })()
  })

  overlayWindow.on('show', () => {
    void hardenOverlayChrome({ clickThrough: true, soft: true })
    clearOverlayCaption()
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
        showControlPanel()
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
    showControlPanel()
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
    // Soft only — never SetWindowPos on hover (that flashes the header)
    await hardenOverlayChrome({ clickThrough: enabled, soft: true })
    return { ok: true }
  })

  ipcMain.handle('overlay:lockFixedSize', () => applyOverlayScale(1))

  ipcMain.handle('overlay:setScale', (_event, scale: number) => {
    if (!overlayWindow) return { ok: false, scale: 1 }
    return applyOverlayScale(Number(scale) || 1)
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
    void hardenOverlayChrome({ clickThrough: true, soft: true })
  })

  ipcMain.handle('window:minimizeControl', () => {
    hideControlPanel()
  })

  ipcMain.handle('window:hideControl', () => {
    hideControlPanel()
    return { ok: true }
  })

  ipcMain.handle('window:showControl', () => {
    showControlPanel()
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

  // Win11 paints a fake caption on transparent overlays on any app focus change
  const scrubCaption = () => {
    void hardenOverlayChrome({ clickThrough: true, soft: true })
    clearOverlayCaption()
    setTimeout(clearOverlayCaption, 16)
    setTimeout(clearOverlayCaption, 50)
  }

  app.on('browser-window-blur', () => {
    if (closingControl) return
    scrubCaption()
  })

  app.on('browser-window-focus', () => {
    if (closingControl) return
    scrubCaption()
  })

  // Power monitor / display sleep can also leave a stuck caption
  if (process.platform === 'win32') {
    setInterval(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return
      if (!overlayWindow.isVisible()) return
      applyOverlayWindowStyle(overlayWindow, { soft: true }).catch(() => {})
    }, 2000)
  }

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
