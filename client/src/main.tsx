import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { ActiveProvider } from '@/context/ActiveContext';
import { ServerProvider } from '@/context/ServerContext';
import { readHashAction, readPageParams } from '@/lib/params';
import { ShellPage } from '@/pages/ShellPage';
import { FileListingPage } from '@/pages/FileListingPage';
import { I18nProvider } from '@/context/I18nContext';

// Fix mobile rotation / address-bar resize issues by mapping the *visual* viewport height
// to a CSS variable. Some browsers keep `100vh` stale after orientation changes.
function installViewportHeightVar() {
  const setVh = () => {
    const h = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--vh', `${h * 0.01}px`);
  };

  setVh();

  window.addEventListener('resize', setVh, { passive: true } as any);
  window.addEventListener('orientationchange', setVh, { passive: true } as any);
  window.visualViewport?.addEventListener('resize', setVh, { passive: true } as any);
  // iOS Safari sometimes only updates visualViewport during scroll after rotation.
  window.visualViewport?.addEventListener('scroll', setVh, { passive: true } as any);
}

installViewportHeightVar();

// Serve static docs without mounting SPA
if (window.location.pathname.startsWith('/docs')) {
  window.location.replace('/docs/index.html');
} else {
  const { wsServer } = readPageParams();
  const hashAction = readHashAction();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        {hashAction.action === 'shell' ? (
          <ShellPage wsServer={wsServer} udid={hashAction.params.get('udid') || ''} />
        ) : hashAction.action === 'list-files' ? (
          <FileListingPage
            wsServer={wsServer}
            udid={hashAction.params.get('udid') || ''}
            initialPath={hashAction.params.get('path') || '/'}
          />
        ) : (
          <ActiveProvider>
            <ServerProvider wsServer={wsServer}>
              <App />
            </ServerProvider>
          </ActiveProvider>
        )}
      </I18nProvider>
    </React.StrictMode>,
  );
}
