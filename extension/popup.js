document.addEventListener('DOMContentLoaded', () => {
  const btnReadArticle = document.getElementById('btnReadArticle');
  const btnReadSelection = document.getElementById('btnReadSelection');
  const statusNotice = document.getElementById('statusNotice');

  function showStatus(text, isError = false) {
    if (!statusNotice) return;
    statusNotice.textContent = text;
    statusNotice.className = 'status-notice' + (isError ? ' error' : '');
    statusNotice.style.display = 'block';
  }

  // Check if Guy Reader background engine is active
  try {
    chrome.runtime.sendMessage({ action: 'check-engine-health' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.available) {
        showStatus('✨ מצב דפדפן עצמאי פעיל (קולות Edge AI טבעיים)', false);
      }
    });
  } catch (_) {}

  // Check if current tab is a PDF document
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab && tab.url && (tab.url.toLowerCase().endsWith('.pdf') || tab.url.toLowerCase().includes('.pdf'))) {
      showStatus('📄 זיהינו קובץ PDF: סמן טקסט, לחץ קליק ימני בעכבר ובחר "🔊 הקרא עם Guy Reader"');
    }
  }).catch(() => {});

  async function sendToActiveTab(action) {
    let tabs;
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      showStatus('Cannot access active tab.', true);
      return;
    }

    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      showStatus('No active browser tab found.', true);
      return;
    }

    const isPdf = tab.url && (tab.url.toLowerCase().endsWith('.pdf') || tab.url.toLowerCase().includes('.pdf'));
    if (isPdf) {
      showStatus('📄 קובץ PDF: סמן טקסט ב-PDF, לחץ עליו קליק ימני ובחר "🔊 הקרא עם Guy Reader"', false);
      return;
    }

    showStatus('Connecting to page...');

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
      showStatus('Guy_reader cannot run on internal browser pages. Please open an article or web page.', true);
      return;
    }

    async function trySendMessage() {
      return await chrome.tabs.sendMessage(tab.id, { action });
    }

    let response = null;
    try {
      response = await trySendMessage();
    } catch (err) {
      // Content script is not running yet on this open tab; inject it dynamically
      showStatus('Loading reader into webpage...');
      try {
        if (chrome.scripting) {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(() => {});
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
          await new Promise(r => setTimeout(r, 120));
          response = await trySendMessage();
        }
      } catch (injectErr) {
        console.error('Script injection error:', injectErr);
        showStatus('Please refresh this webpage once and click again.', true);
        return;
      }
    }

    if (response && response.success) {
      window.close();
    } else {
      showStatus('Starting speech playback...');
      setTimeout(() => window.close(), 400);
    }
  }

  btnReadArticle.addEventListener('click', () => {
    sendToActiveTab('read-from-start');
  });

  btnReadSelection.addEventListener('click', () => {
    sendToActiveTab('read-from-selection');
  });
});
