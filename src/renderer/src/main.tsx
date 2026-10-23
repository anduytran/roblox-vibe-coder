import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initStore } from './store'
import { applyMotion, applyTheme } from './theme'
import './styles.css'

applyTheme()
applyMotion()
initStore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
