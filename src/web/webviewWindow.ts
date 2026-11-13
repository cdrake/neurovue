import { listen } from './event'

// The browser tab is the one "main" window.
export function getCurrentWebviewWindow() {
  return { label: 'main', listen, onFocusChanged: listen }
}
