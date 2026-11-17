import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { install as installConsoleCapture } from './domain/consoleCapture'
import './styles.css'

// First, so it sees everything logged and every GPU device NiiVue asks for.
installConsoleCapture()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
