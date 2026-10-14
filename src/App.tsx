import { useEffect } from 'react'
import { ControlPanel } from './components/ControlPanel'
import { LyricsOverlay } from './components/LyricsOverlay'

const getWindowMode = () => {
  const params = new URLSearchParams(window.location.search)
  return params.get('window') === 'overlay' ? 'overlay' : 'control'
}

const App = () => {
  const mode = getWindowMode()

  useEffect(() => {
    if (mode !== 'overlay') return
    document.documentElement.classList.add('overlay-mode')
    document.title = ''
    return () => {
      document.documentElement.classList.remove('overlay-mode')
    }
  }, [mode])

  if (mode === 'overlay') {
    return <LyricsOverlay />
  }

  return <ControlPanel />
}

export default App
