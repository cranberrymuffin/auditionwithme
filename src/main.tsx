import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// The product uses one deliberate, fixed dark palette throughout.
document.documentElement.classList.add('dark')

if ('serviceWorker' in navigator) {
  // autoUpdate silently installs+activates a new SW as soon as one is found;
  // reload once it takes control so the open tab actually gets the new build.
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // The browser only re-checks sw.js on navigation by default, which
      // isn't enough for a PWA left open across a deploy. Poll for updates.
      const check = () => registration.update()
      setInterval(check, 60 * 1000)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })
  void updateSW
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
