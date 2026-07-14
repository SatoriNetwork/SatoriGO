import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/fonts.css'; // bundled Inter (latin + latin-ext only) — see the file
import { App } from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
