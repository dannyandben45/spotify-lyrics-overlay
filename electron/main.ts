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

const isDev = !app.isPackaged

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
    controlWindow?.hide()
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

  const hardenOverlayChrome = async () => {
    if (!overlayWindow) return
    overlayWindow.setBackgroundColor('#00000000')
    overlayWindow.setFocusable(false)
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    await applyOverlayWindowStyle(overlayWindow)
  }

  if (isDev) {
    overlayWindow.loadURL(getRendererUrl('overlay'))
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: { window: 'overlay' },
    })
  }

  overlayWindow.once('ready-to-show', () => {
    void (async () => {
      if (!overlayWindow) return
      await hardenOverlayChrome()
      overlayWindow.showInactive()
      await hardenOverlayChrome()
    })()
  })

  // Re-apply after focus changes — this is when Windows paints the blue strip
  overlayWindow.on('blur', () => {
    void hardenOverlayChrome()
  })
  overlayWindow.on('show', () => {
    void hardenOverlayChrome()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
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
    overlayWindow.setIgnoreMouseEvents(enabled, { forward: true })
    // Capturing mouse can make Windows paint a wide accent/caption strip —
    // re-assert transparent + NOACTIVATE chrome every time.
    overlayWindow.setBackgroundColor('#00000000')
    overlayWindow.setFocusable(false)
    if (!enabled) {
      await applyOverlayWindowStyle(overlayWindow)
    }
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
    if (!overlayWindow) return
    overlayWindow.setBackgroundColor('#00000000')
    overlayWindow.setFocusable(false)
    void applyOverlayWindowStyle(overlayWindow)
  })

  ipcMain.handle('window:minimizeControl', () => {
    controlWindow?.minimize()
  })

  ipcMain.handle('window:hideControl', () => {
    controlWindow?.hide()
  })

  ipcMain.handle('window:showControl', () => {
    if (!controlWindow) createControlWindow()
    controlWindow?.show()
    controlWindow?.focus()
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
