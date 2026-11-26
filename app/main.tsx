import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import {
  createDesktopCapabilities,
  detectDesktopBridge,
  readDesktopStartupInfo,
} from './services/desktop';
import type { ChatFgmCapabilities } from './services/capabilities';
import './styles/global.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('ChatFGM root element was not found.');
}

const root = createRoot(rootElement);

function renderApplication(capabilities?: ChatFgmCapabilities): void {
  root.render(
    <StrictMode>
      <App capabilities={capabilities} />
    </StrictMode>,
  );
}

function renderStartupFailure(message: string): void {
  root.render(
    <StrictMode>
      <main className="desktop-startup-error" role="alert">
        <h1>ChatFGM 无法启动</h1>
        <p>{message}</p>
      </main>
    </StrictMode>,
  );
}

async function bootstrap(): Promise<void> {
  const detection = detectDesktopBridge();
  if (detection.kind === 'absent') {
    // Normal browser development and the existing browser test entries.
    renderApplication();
    return;
  }
  if (detection.kind === 'invalid') {
    renderStartupFailure(
      '无法连接桌面服务，请重新启动应用。',
    );
    return;
  }

  const startup = await readDesktopStartupInfo(detection.bridge);
  if (startup.status !== 'success') {
    renderStartupFailure(
      startup.status === 'error'
        ? startup.message
        : '无法获取启动信息，请重新启动应用。',
    );
    return;
  }
  // The desktop shell integrates the native window controls into the
  // application header. Browser entries keep the existing header layout.
  document.documentElement.dataset.desktopShell = 'true';
  renderApplication(createDesktopCapabilities(detection.bridge));
}

void bootstrap();
