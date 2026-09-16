import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';
import './i18n.js';
import './plugins/index.js'; // register bundled plugins' UI slots before first paint

// ErrorBoundary sits outside the router: a throw during routing or in any screen below it
// would otherwise unmount everything and leave a blank page with no explanation (#441).
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
