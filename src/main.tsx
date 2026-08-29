import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/fonts.css'; // bundled Inter (latin + latin-ext only) — see the file
import { App } from './App';
import { isDetachedWindow } from './services/detachWindow';
import { isSidePanelWindow } from './services/sidePanel';
import './styles/global.css';

// Stamped before first paint: global.css keys the detached-window canvas
// sizing off this marker, so a resizable window gets a full, grounded
// background while the toolbar popup keeps its fixed 400x600 rules untouched.
if (isDetachedWindow()) {
  document.documentElement.dataset.detached = 'true';
}
// Side panel (index.html?panel=1, services/sidePanel.ts): the canvas follows
// the panel's own width and height instead of the popup's fixed 400x600.
if (isSidePanelWindow()) {
  document.documentElement.dataset.panel = 'true';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
