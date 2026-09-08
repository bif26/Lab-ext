// Open Practice Panel button
document.getElementById('openPanel').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.id) {
      // Open side panel directly from popup (user gesture)
      chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true, path: 'src/sidepanel/index.html' }, () => {
        chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }, () => {
          // Clear any pending flag
          chrome.storage.local.remove('lsPendingSidePanelOpen');
          window.close();
        });
      });
    }
  });
});

// Change Language button
document.getElementById('changeLang').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.id) {
      // Set flag to show language setup in side panel
      chrome.storage.session.set({ 'lsRequestLanguageSetup': Date.now() });
      // Open side panel directly
      chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true, path: 'src/sidepanel/index.html' }, () => {
        chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }, () => {
          window.close();
        });
      });
    }
  });
});

// Feedback button
document.getElementById('feedback').addEventListener('click', () => {
  window.open('https://languageshadow.com/feedback', '_blank');
});

// On popup open, check if there is a pending side panel open request (from content script)
chrome.storage.local.get('lsPendingSidePanelOpen', (result) => {
  if (result.lsPendingSidePanelOpen === true) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true, path: 'src/sidepanel/index.html' }, () => {
          chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }, () => {
            chrome.storage.local.remove('lsPendingSidePanelOpen');
          });
        });
      }
    });
  }
});