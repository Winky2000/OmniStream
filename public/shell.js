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
      if (raw.startsWith('/')) {
        const parts = raw.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
      }
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        const u = new URL(raw);
        const parts = u.pathname.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : '';
      }
      // relative like index.html
      const parts = raw.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : raw;
    } catch (_) {
      return '';
    }
  }

  function wireActiveNav() {
    const currentFile = getCurrentPageFile();
    if (!currentFile) return;

    const links = document.querySelectorAll('.sidebar-nav a[href]');
    links.forEach(a => {
      const hrefFile = normalizeHrefToFile(a.getAttribute('href'));
      if (!hrefFile) return;
      if (hrefFile !== currentFile) return;
      if (a.classList.contains('nav-link')) {
        if (!a.classList.contains('nav-link-active')) a.classList.add('nav-link-active');
      }
      if (a.classList.contains('submenu-link')) {
        if (!a.classList.contains('submenu-link-active')) a.classList.add('submenu-link-active');
        // If a submenu item is active, ensure its submenu is visible.
        const submenu = a.closest('.settings-submenu');
        if (submenu && !submenu.classList.contains('open')) submenu.classList.add('open');
      }
    });
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
    wireActiveNav();
    wireSubmenus();
    wireSidebarToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
