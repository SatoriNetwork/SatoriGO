import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/fonts.css'; // bundled Inter (latin + latin-ext only) — see the file
import { App } from './App';
import { isDetachedWindow } from './services/detachWindow';
import './styles/global.css';

// Stamped before first paint: global.css keys the detached-window canvas
// sizing off this marker, so a resizable window gets a full, grounded
// background while the toolbar popup keeps its fixed 400x600 rules untouched.
if (isDetachedWindow()) {
  document.documentElement.dataset.detached = 'true';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
