(function () {
  function applyThemeFromLocalStorage() {
    try {
      const savedTheme = localStorage.getItem('omnistreamTheme') || 'default';
      if (savedTheme && savedTheme !== 'default') {
        document.documentElement.setAttribute('data-theme', savedTheme);
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
    } catch (_) {
      // ignore
    }
  }

  function getCurrentPageFile() {
    try {
      const path = String(window.location.pathname || '/');
      if (path === '/' || path.endsWith('/')) return 'index.html';
      const parts = path.split('/').filter(Boolean);
      const last = parts.length ? parts[parts.length - 1] : 'index.html';
      return last || 'index.html';
    } catch (_) {
      return 'index.html';
    }
  }

  function normalizeHrefToFile(href) {
    try {
      if (!href) return '';
      const raw = String(href).trim();
      if (!raw || raw === '#' || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return '';

      const stripQueryHash = (s) => String(s || '').split('#')[0].split('?')[0];
      const cleaned = stripQueryHash(raw);

      if (cleaned.startsWith('/')) {
        const parts = cleaned.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
      }
      if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
        const u = new URL(cleaned);
        const parts = stripQueryHash(u.pathname).split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
      }
      // relative like index.html
      const parts = cleaned.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : cleaned;
    } catch (_) {
      return '';
    }
  }

  function wireActiveNav() {
    const currentFile = getCurrentPageFile();
    if (!currentFile) return;

    const links = document.querySelectorAll('.sidebar-nav a[href], .top-tabs a[href], .subtabs a[href]');
    links.forEach(a => {
      const hrefFile = normalizeHrefToFile(a.getAttribute('href'));
      if (!hrefFile) return;

      // Top tabs can stay active for an entire area.
      if (a.classList.contains('tab-link')) {
        const group = String(a.getAttribute('data-group') || '').trim();
        if (group === 'stats' && typeof isStatsAreaPage === 'function' && isStatsAreaPage(currentFile)) {
          a.classList.add('tab-link-active');
          return;
        }
        if (group === 'newsletter' && typeof isNewsletterAreaPage === 'function' && isNewsletterAreaPage(currentFile)) {
          a.classList.add('tab-link-active');
          return;
        }
        if (group === 'settings' && typeof isSettingsAreaPage === 'function' && isSettingsAreaPage(currentFile)) {
          a.classList.add('tab-link-active');
          return;
        }
      }

      if (hrefFile !== currentFile) return;

      if (a.classList.contains('nav-link')) {
        a.classList.add('nav-link-active');
      }
      if (a.classList.contains('tab-link')) {
        a.classList.add('tab-link-active');
      }
      if (a.classList.contains('subtab-link')) {
        a.classList.add('subtab-link-active');
      }
      if (a.classList.contains('submenu-link')) {
        a.classList.add('submenu-link-active');
        const submenu = a.closest('.settings-submenu');
        if (submenu && !submenu.classList.contains('open')) submenu.classList.add('open');
      }
    });
  }

  function installTopTabs() {
    const appShell = document.querySelector('.app-shell');
    const main = document.querySelector('.main-content');
    if (!appShell || !main) return;

    // Prevent double-injection.
    if (main.querySelector('.top-tabs')) {
      appShell.classList.add('use-tabs');
      return;
    }

    const tabs = [
      { label: 'Dashboard', href: 'index.html' },
      { label: 'MiniView', href: 'glance.html' },
      { label: 'Stats', href: 'reports.html' },
      { label: 'Newsletter', href: 'subscribers.html#send' },
      { label: 'Settings', href: 'admin.html' },
      { label: 'About', href: 'about.html' },
      { label: 'Logout', href: '/logout' }
    ];

    const bar = document.createElement('div');
    bar.className = 'top-tabs';

    const nav = document.createElement('nav');
    nav.className = 'tab-nav';

    tabs.forEach(t => {
      const a = document.createElement('a');
      a.className = 'tab-link';
      a.href = t.href;
      a.textContent = t.label;
      if (t.label === 'Logout') a.classList.add('tab-link-logout');
      if (t.label === 'Stats') a.setAttribute('data-group', 'stats');
      if (t.label === 'Newsletter') a.setAttribute('data-group', 'newsletter');
      if (t.label === 'Settings') a.setAttribute('data-group', 'settings');
      nav.appendChild(a);
    });

    bar.appendChild(nav);

    // Insert at the top of the main content.
    main.insertBefore(bar, main.firstChild);
    appShell.classList.add('use-tabs');
  }

  function isNewsletterAreaPage(file) {
    return file === 'subscribers.html'
      || file === 'templates.html'
      || file === 'custom-header.html'
      || file === 'sent-newsletters.html';
  }

  function isSettingsAreaPage(file) {
    return file === 'admin.html'
      || file === 'system.html'
      || file === 'overseerr.html'
      || file === 'servers.html'
      || file === 'display.html'
      || file === 'notifications.html'
      || file === 'notifiers.html'
      || file === 'user.html'
      || file === 'change-password.html';
  }

  function getHashPanel() {
    try {
      const h = String(window.location.hash || '').trim();
      if (!h || h === '#') return '';
      return h.replace(/^#/, '').trim();
    } catch (_) {
      return '';
    }
  }

  function setActiveNewsletterSubtab(main) {
    if (!main) return;
    const currentFile = getCurrentPageFile();
    const hashPanel = getHashPanel();
    const links = main.querySelectorAll('.newsletter-subtabs .subtab-link');
    links.forEach(a => {
      const file = a.getAttribute('data-file') || '';
      const panel = a.getAttribute('data-panel') || '';

      const active = (file === currentFile) && (!panel || panel === hashPanel);
      a.classList.toggle('subtab-link-active', !!active);
    });
  }

  function installNewsletterSubtabs() {
    const currentFile = getCurrentPageFile();
    if (!isNewsletterAreaPage(currentFile)) return;

    const main = document.querySelector('.main-content');
    if (!main) return;

    if (main.querySelector('.newsletter-subtabs')) {
      setActiveNewsletterSubtab(main);
      return;
    }

    const topTabs = main.querySelector('.top-tabs');
    if (!topTabs) return;

    const subtabs = document.createElement('div');
    subtabs.className = 'subtabs newsletter-subtabs';

    const nav = document.createElement('nav');
    nav.className = 'subtab-nav';

    const items = [
      { label: 'Email', href: 'subscribers.html#email', file: 'subscribers.html', panel: 'email' },
      { label: 'Templates', href: 'templates.html', file: 'templates.html' },
      { label: 'Custom Header', href: 'custom-header.html', file: 'custom-header.html' },
      { label: 'Subscribers List', href: 'subscribers.html#subscribers', file: 'subscribers.html', panel: 'subscribers' },
      { label: 'Sent History', href: 'sent-newsletters.html', file: 'sent-newsletters.html' }
    ];

    items.forEach(t => {
      const a = document.createElement('a');
      a.className = 'subtab-link';
      a.href = t.href;
      a.textContent = t.label;
      if (t.file) a.setAttribute('data-file', t.file);
      if (t.panel) a.setAttribute('data-panel', t.panel);
      nav.appendChild(a);
    });

    subtabs.appendChild(nav);
    if (topTabs.nextSibling) main.insertBefore(subtabs, topTabs.nextSibling);
    else main.appendChild(subtabs);

    // Used for CSS tweaks on subscribers.html (hide its internal panel tabs).
    main.classList.add('has-newsletter-subtabs');
    setActiveNewsletterSubtab(main);

    // Keep active state in sync when switching hash panels on subscribers.html.
    window.addEventListener('hashchange', () => setActiveNewsletterSubtab(main));
  }

  function setActiveSettingsSubtab(main) {
    if (!main) return;
    const currentFile = getCurrentPageFile();
    let hashPanel = getHashPanel();

    // Some pages switch panels without updating the URL hash.
    // Keep Settings subtabs in sync with the page's internal state.
    if (!hashPanel && currentFile === 'system.html') {
      try {
        const activeSystemTab = document.querySelector('.system-tab.system-tab-active');
        const p = activeSystemTab && activeSystemTab.dataset ? String(activeSystemTab.dataset.panel || '').trim() : '';
        if (p) hashPanel = p;
      } catch (_) {
        // ignore
      }
    }
    if (!hashPanel && currentFile === 'overseerr.html') {
      // The Settings subtab deep-links to #config, but the page may be visited without a hash.
      hashPanel = 'config';
    }
    const links = main.querySelectorAll('.settings-subtabs .subtab-link');
    links.forEach(a => {
      const file = a.getAttribute('data-file') || '';
      const panel = a.getAttribute('data-panel') || '';

      let active = (file === currentFile);
      if (active && panel) active = (panel === hashPanel);
      a.classList.toggle('subtab-link-active', !!active);
    });
  }

  function installSettingsSubtabs() {
    const currentFile = getCurrentPageFile();
    if (!isSettingsAreaPage(currentFile)) return;

    const main = document.querySelector('.main-content');
    if (!main) return;

    if (main.querySelector('.settings-subtabs')) {
      setActiveSettingsSubtab(main);
      return;
    }

    const topTabs = main.querySelector('.top-tabs');
    if (!topTabs) return;

    const subtabs = document.createElement('div');
    subtabs.className = 'subtabs settings-subtabs';

    const nav = document.createElement('nav');
    nav.className = 'subtab-nav';

    const items = [
      { label: 'Connected servers', href: 'admin.html', file: 'admin.html' },

      { label: 'Servers', href: 'servers.html', file: 'servers.html' },
      { label: 'Display', href: 'display.html', file: 'display.html' },
      { label: 'Notifications', href: 'notifications.html', file: 'notifications.html' },
      { label: 'Notifiers', href: 'notifiers.html', file: 'notifiers.html' },

      { label: 'Overseerr', href: 'overseerr.html#config', file: 'overseerr.html', panel: 'config' },

      { label: 'Config', href: 'system.html#config', file: 'system.html', panel: 'config' },

      { label: 'Backups', href: 'system.html#tools-backups', file: 'system.html', panel: 'tools-backups' },
      { label: 'Mobile devices', href: 'system.html#tools-mobile-devices', file: 'system.html', panel: 'tools-mobile-devices' },
      { label: 'Platform Icons', href: 'system.html#tools-platform-icons', file: 'system.html', panel: 'tools-platform-icons' },

      { label: 'Health', href: 'system.html#health', file: 'system.html', panel: 'health' },

      
    ];

    items.forEach(t => {
      const a = document.createElement('a');
      a.className = 'subtab-link';
      a.href = t.href;
      a.textContent = t.label;
      if (t.file) a.setAttribute('data-file', t.file);
      if (t.panel) a.setAttribute('data-panel', t.panel);
      nav.appendChild(a);
    });

    subtabs.appendChild(nav);
    if (topTabs.nextSibling) main.insertBefore(subtabs, topTabs.nextSibling);
    else main.appendChild(subtabs);

    main.classList.add('has-settings-subtabs');
    setActiveSettingsSubtab(main);
    window.addEventListener('hashchange', () => setActiveSettingsSubtab(main));

    // system.html has its own internal tabs that don't change the hash.
    if (getCurrentPageFile() === 'system.html') {
      document.querySelectorAll('.system-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          setTimeout(() => setActiveSettingsSubtab(main), 0);
        });
      });
    }
  }

  function isStatsAreaPage(file) {
    return file === 'reports.html' || file === 'history.html' || file === 'libraries.html';
  }

  function installStatsSubtabs() {
    const currentFile = getCurrentPageFile();
    if (!isStatsAreaPage(currentFile)) return;

    const main = document.querySelector('.main-content');
    if (!main) return;

    // Prevent double-injection.
    if (main.querySelector('.subtabs')) return;

    const topTabs = main.querySelector('.top-tabs');
    if (!topTabs) return;

    const subtabs = document.createElement('div');
    subtabs.className = 'subtabs';

    const nav = document.createElement('nav');
    nav.className = 'subtab-nav';

    const items = [
      { label: 'Stats', href: 'reports.html' },
      { label: 'History', href: 'history.html' },
      { label: 'Libraries', href: 'libraries.html' }
    ];

    items.forEach(t => {
      const a = document.createElement('a');
      a.className = 'subtab-link';
      a.href = t.href;
      a.textContent = t.label;
      nav.appendChild(a);
    });

    subtabs.appendChild(nav);
    // Place directly under the main top tabs.
    if (topTabs.nextSibling) main.insertBefore(subtabs, topTabs.nextSibling);
    else main.appendChild(subtabs);
  }

  function submenuStorageKey(toggleEl) {
    if (!toggleEl) return '';
    if (toggleEl.classList.contains('newsletter-toggle')) return 'omnistreamSubmenuNewsletter';
    if (toggleEl.classList.contains('settings-toggle')) return 'omnistreamSubmenuSettings';
    return '';
  }

  function wireSubmenus() {
    document.querySelectorAll('.settings-group').forEach(group => {
      const toggle = group.querySelector('.newsletter-toggle, .settings-toggle');
      const submenu = group.querySelector('.settings-submenu');
      if (!toggle || !submenu) return;

      // Restore submenu open state (if not already set in markup).
      try {
        const key = submenuStorageKey(toggle);
        if (key) {
          const saved = localStorage.getItem(key);
          if (saved === 'open' && !submenu.classList.contains('open')) submenu.classList.add('open');
          if (saved === 'closed' && submenu.classList.contains('open')) submenu.classList.remove('open');
        }
      } catch (_) {
        // ignore
      }

      try {
        toggle.setAttribute('aria-expanded', submenu.classList.contains('open') ? 'true' : 'false');
      } catch (_) {
        // ignore
      }

      toggle.addEventListener('click', () => {
        submenu.classList.toggle('open');
        const isOpen = submenu.classList.contains('open');
        try {
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        } catch (_) {
          // ignore
        }
        try {
          const key = submenuStorageKey(toggle);
          if (key) localStorage.setItem(key, isOpen ? 'open' : 'closed');
        } catch (_) {
          // ignore
        }
      });
    });
  }

  function wireSidebarToggle() {
    const appShell = document.querySelector('.app-shell');
    const sidebarToggle = document.getElementById('sidebarToggle') || document.querySelector('.sidebar-toggle');
    if (!appShell || !sidebarToggle) return;

    try {
      const savedSidebar = localStorage.getItem('omnistreamSidebar') || 'open';
      if (savedSidebar === 'collapsed') {
        appShell.classList.add('sidebar-collapsed');
        if (sidebarToggle && sidebarToggle.textContent) sidebarToggle.textContent = 'Show menu';
      } else {
        if (sidebarToggle && sidebarToggle.textContent) sidebarToggle.textContent = 'Hide menu';
      }
    } catch (_) {
      // ignore
    }

    sidebarToggle.addEventListener('click', () => {
      const collapsed = appShell.classList.toggle('sidebar-collapsed');
      if (sidebarToggle && sidebarToggle.textContent) sidebarToggle.textContent = collapsed ? 'Show menu' : 'Hide menu';
      try {
        localStorage.setItem('omnistreamSidebar', collapsed ? 'collapsed' : 'open');
      } catch (_) {
        // ignore
      }
    });
  }

  function init() {
    applyThemeFromLocalStorage();
    installTopTabs();
    installStatsSubtabs();
    installNewsletterSubtabs();
    installSettingsSubtabs();
    wireActiveNav();

    // wireActiveNav highlights by file only; ensure panel-based subtabs win.
    const main = document.querySelector('.main-content');
    if (main) {
      if (main.querySelector('.newsletter-subtabs')) setActiveNewsletterSubtab(main);
      if (main.querySelector('.settings-subtabs')) setActiveSettingsSubtab(main);
    }

    wireSubmenus();
    wireSidebarToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
