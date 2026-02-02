/**
 * Claude Code Mobile Controller - Frontend Application
 * Using xterm.js with iOS touch scroll fix
 */

(function () {
  'use strict';

  // DOM Elements
  const terminalContainer = document.getElementById('terminal');
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const ptyStatus = document.getElementById('pty-status');
  const welcome = document.getElementById('welcome');
  const exitScreen = document.getElementById('exit-screen');
  const exitInfo = document.getElementById('exit-info');
  const startBtn = document.getElementById('start-btn');
  const restartBtn = document.getElementById('restart-btn');
  const startDir = document.getElementById('start-dir');
  const startArgs = document.getElementById('start-args');
  const optionsContainer = document.getElementById('options-container');
  const optionsPrompt = document.getElementById('options-prompt');
  const optionsButtons = document.getElementById('options-buttons');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const notifyBtn = document.getElementById('notify-btn');
  const navToggleBtn = document.getElementById('nav-toggle-btn');
  const navKeys = document.getElementById('nav-keys');
  const autoBtnToggle = document.getElementById('auto-btn-toggle');
  const urlBanner = document.getElementById('url-banner');
  const urlText = document.getElementById('url-text');
  const loginForm = document.getElementById('login-form');
  const loginUser = document.getElementById('login-user');
  const loginPass = document.getElementById('login-pass');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');
  const startOptions = document.getElementById('start-options');

  // State
  let ws = null;
  let term = null;
  let fitAddon = null;
  let isConnected = false;
  let isAuthenticated = false;
  let isPtyRunning = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const MAX_RECONNECT_DELAY = 30000;

  // URL detection
  let urlBuffer = '';
  let lastDetectedUrl = null;
  let urlShownThisSession = false;

  // Initialize xterm.js
  function initTerminal() {
    if (term) return;

    // Smaller font for mobile
    const isMobile = window.innerWidth < 600;

    term = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 11 : 14,
      fontFamily: '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, monospace',
      theme: {
        background: '#000000',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        selectionBackground: '#444444',
      },
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(webLinksAddon);

    term.open(terminalContainer);

    // Initial fit with delay to allow DOM to settle
    setTimeout(() => {
      safeFit();
      // Second fit for Firefox
      setTimeout(() => safeFit(), 100);
    }, 50);

    // Native scrolling now enabled via CSS - no custom handler needed

    // Handle resize
    window.addEventListener('resize', () => safeFit());

    // Handle mobile viewport changes (address bar show/hide on Firefox/Chrome mobile)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => safeFit());
    }

    // Handle orientation changes
    window.addEventListener('orientationchange', () => {
      setTimeout(() => safeFit(), 300);
    });

    // Handle terminal data (user typing)
    term.onData((data) => {
      if (isPtyRunning && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  function safeFit() {
    try {
      if (!fitAddon) return;

      const container = document.getElementById('terminal-container');
      if (!container) return;

      // Force browser to recalculate layout (Firefox fix)
      void container.offsetHeight;

      // Wait for layout to settle
      requestAnimationFrame(() => {
        const width = container.offsetWidth;
        const height = container.offsetHeight;

        if (width > 0 && height > 0) {
          fitAddon.fit();

          // Notify backend of terminal size change
          if (ws?.readyState === WebSocket.OPEN && term) {
            const { cols, rows } = term;
            ws.send(JSON.stringify({
              type: 'resize',
              cols,
              rows
            }));
          }
        }
      });
    } catch (e) {
      console.warn('[Terminal] Fit error:', e);
    }
  }

  // Native scrolling now handled via CSS (.xterm-viewport with overflow-y: auto)
  // Custom touch handler removed to avoid conflicts with alternate buffer

  function writeToTerminal(data) {
    if (term) {
      term.write(data);
    }
    scanForUrls(data);
  }

  function clearTerminal() {
    if (term) {
      term.clear();
    }
  }

  function scanForUrls(data) {
    if (urlShownThisSession) return;

    // Strip escape sequences and join lines for URL detection
    const cleanData = data
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b/g, '');
    urlBuffer += cleanData;

    if (urlBuffer.length > 16000) {
      urlBuffer = urlBuffer.slice(-16000);
    }

    // Remove newlines/carriage returns to handle wrapped URLs
    const joinedBuffer = urlBuffer.replace(/[\r\n]+/g, '');

    // Look for OAuth URLs (claude.ai or anthropic.com)
    const urlMatch = joinedBuffer.match(/https:\/\/claude\.ai\/oauth\/authorize\?[^\s<>"']+/gi) ||
                     joinedBuffer.match(/https:\/\/console\.anthropic\.com\/oauth[^\s<>"']+/gi);

    if (urlMatch) {
      const url = urlMatch[urlMatch.length - 1];
      if (url.length > 50) {
        lastDetectedUrl = url;
        urlText.textContent = 'Click to authenticate';
        urlBanner.classList.remove('hidden');
        urlShownThisSession = true;
        console.log('[URL] Detected:', url.substring(0, 100) + '...');
      }
    }
  }

  function hideUrlBanner() {
    urlBanner.classList.add('hidden');
  }

  // Auth button handlers
  document.getElementById('url-open-btn')?.addEventListener('click', () => {
    if (lastDetectedUrl) {
      window.open(lastDetectedUrl, '_blank');
    }
  });

  document.getElementById('url-close-btn')?.addEventListener('click', () => {
    hideUrlBanner();
    lastDetectedUrl = null;
  });

  // Connection status
  function updateConnectionStatus(status) {
    statusDot.className = 'status-dot ' + status;
    switch (status) {
      case 'connected': statusText.textContent = 'Connected'; break;
      case 'disconnected': statusText.textContent = 'Disconnected'; break;
      default: statusText.textContent = 'Connecting...';
    }
  }

  // WebSocket
  function connect() {
    if (ws) {
      try { ws.close(); } catch (e) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      isConnected = true;
      reconnectAttempts = 0;
      updateConnectionStatus('connected');
    };

    ws.onclose = (event) => {
      isConnected = false;
      if (event.code === 4001) {
        isAuthenticated = false;
        showLoginForm();
        loginError.textContent = 'Session expired';
        loginError.classList.remove('hidden');
        return;
      }
      updateConnectionStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      updateConnectionStatus('disconnected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error('[WS] Bad message:', e);
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    statusText.textContent = `Reconnecting in ${Math.round(delay/1000)}s...`;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // Message handling
  function handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        handleState(msg);
        break;
      case 'output':
        writeToTerminal(msg.data);
        break;
      case 'options':
        showOptions(msg.prompt, msg.options);
        break;
      case 'started':
        handleStarted();
        break;
      case 'exit':
        handleExit(msg.exitCode, msg.signal);
        break;
      case 'error':
        writeToTerminal(`\r\n[Error] ${msg.message}\r\n`);
        break;
      case 'hideOptions':
        hideOptions();
        break;
    }
  }

  function handleState(state) {
    isPtyRunning = state.pty?.running || false;
    updatePtyStatus();

    if (state.buffer) {
      clearTerminal();
      writeToTerminal(state.buffer);
    }

    if (state.lastTrigger?.options) {
      showOptions(state.lastTrigger.prompt, state.lastTrigger.options);
    }

    if (isPtyRunning) {
      welcome.classList.add('hidden');
      exitScreen.classList.add('hidden');
    } else if (state.pty?.exitCode != null) {
      handleExit(state.pty.exitCode);
    } else {
      showWelcome();
    }
  }

  function handleStarted() {
    isPtyRunning = true;
    welcome.classList.add('hidden');
    exitScreen.classList.add('hidden');
    hideUrlBanner();
    lastDetectedUrl = null;
    urlBuffer = '';
    urlShownThisSession = false;
    updatePtyStatus();
    clearTerminal();
    if (term) term.focus();
  }

  function handleExit(exitCode, signal) {
    isPtyRunning = false;
    updatePtyStatus();
    hideOptions();
    hideUrlBanner();
    exitInfo.textContent = signal ? `Signal: ${signal}` : `Exit: ${exitCode}`;
    exitScreen.classList.remove('hidden');
  }

  function showWelcome() {
    welcome.classList.remove('hidden');
    exitScreen.classList.add('hidden');
    if (isAuthenticated) {
      showStartOptions();
    } else {
      showLoginForm();
    }
  }

  function updatePtyStatus() {
    ptyStatus.textContent = isPtyRunning ? 'Running' : 'Stopped';
    sendBtn.disabled = !isPtyRunning;
    stopBtn.classList.toggle('hidden', !isPtyRunning);
  }

  // Options UI
  let lastOptions = null;
  let autoButtonsEnabled = localStorage.getItem('autoButtons') === 'true';

  function showOptions(prompt, options) {
    lastOptions = { prompt, options };
    if (!autoButtonsEnabled) return;
    renderOptions(prompt, options);
  }

  function renderOptions(prompt, options) {
    optionsPrompt.textContent = prompt || 'Select:';
    // Clear children safely without innerHTML
    while (optionsButtons.firstChild) {
      optionsButtons.removeChild(optionsButtons.firstChild);
    }
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = opt.label;
      btn.onclick = () => {
        if (opt.value) sendRawInput(opt.value);
        sendRawInput('\r');
        hideOptions();
      };
      optionsButtons.appendChild(btn);
    }
    optionsContainer.classList.remove('hidden');
  }

  function hideOptions() {
    optionsContainer.classList.add('hidden');
  }

  // Input
  function sendInput(text) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    hideUrlBanner();
    lastDetectedUrl = null;
    urlBuffer = '';
    ws.send(JSON.stringify({ type: 'input', data: text }));
    ws.send(JSON.stringify({ type: 'input', data: '\r' }));
  }

  function sendRawInput(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', data }));
  }

  function startClaude(args = [], cwd = '') {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = { type: 'start', args };
    if (cwd) msg.cwd = cwd;
    ws.send(JSON.stringify(msg));
  }

  // Event listeners
  startBtn.addEventListener('click', () => {
    const args = startArgs.value.trim();
    const cwd = startDir.value.trim();
    if (cwd) localStorage.setItem('lastDir', cwd);
    startClaude(args ? args.split(' ') : [], cwd);
  });

  restartBtn.addEventListener('click', () => {
    exitScreen.classList.add('hidden');
    const cwd = startDir.value.trim();
    if (cwd) localStorage.setItem('lastDir', cwd);
    startClaude([], cwd);
  });

  stopBtn.addEventListener('click', () => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
  });

  sendBtn.addEventListener('click', () => {
    const text = textInput.value;
    if (text) {
      sendInput(text);
      textInput.value = '';
      hideOptions();
    } else if (isPtyRunning) {
      sendRawInput('\r');
    }
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  startDir.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startBtn.click();
  });

  startArgs.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startBtn.click();
  });

  // Nav keys
  const keyMap = {
    'up': '\x1b[A', 'down': '\x1b[B', 'left': '\x1b[D', 'right': '\x1b[C',
    'enter': '\r', 'escape': '\x1b', 'backspace': '\x7f', 'y': 'y', 'n': 'n'
  };

  navKeys.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (btn && keyMap[btn.dataset.key]) {
      sendRawInput(keyMap[btn.dataset.key]);
    }
  });

  // Toggles
  function updateAutoBtnToggle() {
    autoBtnToggle.classList.toggle('notify-on', autoButtonsEnabled);
    if (autoButtonsEnabled && lastOptions) {
      renderOptions(lastOptions.prompt, lastOptions.options);
    } else {
      hideOptions();
    }
  }

  autoBtnToggle.addEventListener('click', () => {
    autoButtonsEnabled = !autoButtonsEnabled;
    localStorage.setItem('autoButtons', autoButtonsEnabled);
    updateAutoBtnToggle();
  });
  updateAutoBtnToggle();

  let navKeysVisible = localStorage.getItem('navKeys') === 'true';
  function updateNavToggle() {
    navKeys.classList.toggle('hidden', !navKeysVisible);
    navToggleBtn.classList.toggle('notify-on', navKeysVisible);
  }
  navToggleBtn.addEventListener('click', () => {
    navKeysVisible = !navKeysVisible;
    localStorage.setItem('navKeys', navKeysVisible);
    updateNavToggle();
  });
  updateNavToggle();

  // Notifications - Web Push
  let notificationsEnabled = localStorage.getItem('notifications') === 'true';

  function updateNotifyButton() {
    notifyBtn.textContent = notificationsEnabled ? '🔔' : '🔕';
    notifyBtn.classList.toggle('notify-on', notificationsEnabled);
    notifyBtn.classList.toggle('notify-off', !notificationsEnabled);
  }

  async function subscribeToPush() {
    try {
      const reg = await navigator.serviceWorker.ready;

      // Get VAPID public key from server
      const keyRes = await fetch('/api/vapid-public-key');
      if (!keyRes.ok) return false;
      const { publicKey } = await keyRes.json();

      // Subscribe to push
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      // Send subscription to server
      const subRes = await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });

      return subRes.ok;
    } catch (err) {
      console.error('[Push] Subscribe failed:', err);
      return false;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  notifyBtn.addEventListener('click', async () => {
    if (notificationsEnabled) {
      notificationsEnabled = false;
    } else {
      if ('Notification' in window && 'serviceWorker' in navigator) {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          notificationsEnabled = await subscribeToPush();
        }
      }
    }
    localStorage.setItem('notifications', notificationsEnabled);
    updateNotifyButton();
  });

  updateNotifyButton();

  // Auto-resubscribe if notifications were enabled
  if (notificationsEnabled && 'serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(() => subscribeToPush());
  }

  // Auth
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth-check');
      if (res.ok) {
        isAuthenticated = true;
        showStartOptions();
        return true;
      }
    } catch (e) {}
    isAuthenticated = false;
    showLoginForm();
    return false;
  }

  function showLoginForm() {
    welcome.classList.remove('hidden');
    loginForm.classList.remove('hidden');
    startOptions.classList.add('hidden');
    loginUser.focus();
  }

  function showStartOptions() {
    welcome.classList.remove('hidden');
    loginForm.classList.add('hidden');
    startOptions.classList.remove('hidden');

    const lastDir = localStorage.getItem('lastDir');
    if (lastDir) {
      startDir.value = lastDir;
      const label = document.getElementById('last-dir-label');
      const name = document.getElementById('last-dir-name');
      if (label && name) {
        name.textContent = lastDir;
        label.classList.remove('hidden');
      }
    }
    startDir.focus();
  }

  loginBtn.addEventListener('click', async () => {
    const user = loginUser.value;
    const pass = loginPass.value;
    loginError.classList.add('hidden');

    if (!user || !pass) {
      loginError.textContent = 'Enter username and password';
      loginError.classList.remove('hidden');
      return;
    }

    loginBtn.disabled = true;
    try {
      // Get CSRF token first
      const csrfRes = await fetch('/api/csrf-token');
      const { token } = await csrfRes.json();

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token
        },
        body: JSON.stringify({ username: user, password: pass })
      });
      if (res.ok) {
        isAuthenticated = true;
        showStartOptions();
        connect();
      } else {
        const data = await res.json();
        loginError.textContent = data.error || 'Invalid credentials';
        loginError.classList.remove('hidden');
      }
    } catch (e) {
      loginError.textContent = 'Connection error';
      loginError.classList.remove('hidden');
    }
    loginBtn.disabled = false;
  });

  loginPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });

  // Init - Register service worker for push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[SW] Registered:', reg.scope))
      .catch(err => console.error('[SW] Registration failed:', err));
  }

  initTerminal();
  showLoginForm();
  checkAuth().then(ok => {
    if (ok) connect();
  });

})();
