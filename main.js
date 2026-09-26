'use strict';
const { Plugin, PluginSettingTab, Setting, setIcon, Platform, Notice, TFile } = require('obsidian');

const STARS = '********';
const DEFAULTS = {
  maskedPaths: [],     // notes/folders to mask
  revealAll: false,    // ribbon eye open = everything shown in clear
  hoverOnly: true,     // desktop: show eye buttons on hover only
  hideInSearch: true,  // masked notes left out of search results
  hideInSwitcher: true // masked notes left out of the quick switcher
};

class EyeHiderPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    if (Array.isArray(data.hiddenPaths) && !data.maskedPaths) data.maskedPaths = data.hiddenPaths; // v1 migration
    delete data.hiddenPaths; delete data.revealHidden;
    this.settings = Object.assign({}, DEFAULTS, data);
    this.observed = new WeakSet();
    this.observers = [];
    this.pending = false;

    // Ribbon eye: shut = masks on, open = everything revealed
    this.ribbonEl = this.addRibbonIcon('eye-off', 'Reveal all', () => this.toggleRevealAll());
    this.updateRibbon();

    this.addCommand({ id: 'toggle-reveal-all', name: 'Reveal / mask everything', callback: () => this.toggleRevealAll() });
    this.addCommand({
      id: 'toggle-current',
      name: 'Mask / unmask current note',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (!checking) this.onEyeClick(f.path);
        return true;
      },
    });

    // Long-press / right-click menu
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const masked = this.isMasked(file.path);
      menu.addItem((item) => item
        .setTitle(masked ? 'Unmask' : 'Mask with stars')
        .setIcon(masked ? 'eye' : 'eye-off')
        .onClick(() => this.onEyeClick(file.path)));
    }));

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(oldPath, file.path)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onDelete(file.path)));
    this.registerEvent(this.app.vault.on('modify', () => this.schedule()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.attach()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.schedule()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.schedule()));

    this.addSettingTab(new EyeHiderSettingTab(this.app, this));
    this.applyBodyClasses();
    this.app.workspace.onLayoutReady(() => {
      this.attach();
      this.patchSwitcher();
    });
  }

  onunload() {
    this.observers.forEach((o) => o.disconnect());
    document.querySelectorAll('.eh-btn, .eh-overlay').forEach((el) => el.remove());
    document.querySelectorAll('.eh-mask-text, .eh-gone, .eh-masked-content, .eh-is-masked, .eh-hidden')
      .forEach((el) => el.classList.remove('eh-mask-text', 'eh-gone', 'eh-masked-content', 'eh-is-masked', 'eh-hidden'));
    document.body.classList.remove('eh-hover-only');
  }

  // ---------- state ----------
  coveringEntry(path) {
    if (!path) return null;
    let best = null;
    for (const p of this.settings.maskedPaths) {
      if (path === p || path.startsWith(p + '/')) {
        if (!best || p.length > best.length) best = p;
      }
    }
    return best;
  }
  isMasked(path) { return this.coveringEntry(path) !== null; }
  isMaskActive(path) { return !this.settings.revealAll && this.isMasked(path); }

  async save() {
    await this.saveData(this.settings);
    this.schedule();
  }

  async onEyeClick(path) {
    const list = this.settings.maskedPaths;
    const i = list.indexOf(path);
    if (i >= 0) {
      list.splice(i, 1);
    } else {
      const cover = this.coveringEntry(path);
      if (cover) {
        new Notice(`Masked by the folder "${cover}". Unmask that folder instead.`);
        return;
      }
      list.push(path);
    }
    await this.save();
  }

  async removeMask(path) {
    this.settings.maskedPaths = this.settings.maskedPaths.filter((p) => p !== path);
    await this.save();
  }

  async toggleRevealAll() {
    this.settings.revealAll = !this.settings.revealAll;
    this.updateRibbon();
    await this.save();
  }

  updateRibbon() {
    if (!this.ribbonEl) return;
    const open = this.settings.revealAll;
    setIcon(this.ribbonEl, open ? 'eye' : 'eye-off');
    this.ribbonEl.setAttribute('aria-label', open ? 'Mask again' : 'Reveal all');
  }

  applyBodyClasses() {
    document.body.classList.toggle('eh-hover-only', this.settings.hoverOnly && !Platform.isMobile);
  }

  onRename(oldPath, newPath) {
    let changed = false;
    this.settings.maskedPaths = this.settings.maskedPaths.map((p) => {
      if (p === oldPath) { changed = true; return newPath; }
      if (p.startsWith(oldPath + '/')) { changed = true; return newPath + p.slice(oldPath.length); }
      return p;
    });
    if (changed) this.save(); else this.schedule();
  }

  onDelete(path) {
    const before = this.settings.maskedPaths.length;
    this.settings.maskedPaths = this.settings.maskedPaths.filter((p) => p !== path && !p.startsWith(path + '/'));
    if (this.settings.maskedPaths.length !== before) this.save();
  }

  // ---------- DOM ----------
  attach() {
    for (const type of ['file-explorer', 'search']) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const el = leaf.view && leaf.view.containerEl;
        if (!el || this.observed.has(el)) continue;
        this.observed.add(el);
        const obs = new MutationObserver(() => this.schedule());
        obs.observe(el, { childList: true, subtree: true });
        this.observers.push(obs);
      }
    }
    this.schedule();
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.refresh();
    });
  }

  maskEl(el, on) {
    if (!el) return;
    el.classList.toggle('eh-mask-text', on);
    if (on) el.setAttribute('data-eh-stars', STARS);
  }

  refresh() {
    this.refreshExplorer();
    this.refreshSearch();
    this.refreshLeaves();
  }

  refreshExplorer() {
    for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
      const titles = leaf.view.containerEl.querySelectorAll('.nav-file-title[data-path], .nav-folder-title[data-path]');
      titles.forEach((title) => {
        const path = title.getAttribute('data-path');
        if (!path || path === '/') return;
        const own = this.settings.maskedPaths.includes(path);
        const masked = this.isMasked(path);
        const active = this.isMaskActive(path);

        let btn = title.querySelector(':scope > .eh-btn');
        if (!btn) {
          btn = document.createElement('div');
          btn.className = 'eh-btn clickable-icon';
          btn.setAttribute('draggable', 'false');
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.onEyeClick(title.getAttribute('data-path'));
          });
          btn.addEventListener('mousedown', (e) => e.stopPropagation());
          btn.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
          title.appendChild(btn);
        }
        const state = masked ? 'off' : 'on';
        if (btn.dataset.state !== state) {
          btn.dataset.state = state;
          setIcon(btn, masked ? 'eye-off' : 'eye');
          btn.setAttribute('aria-label', masked ? 'Unmask' : 'Mask with stars');
        }
        btn.classList.toggle('eh-inherited', masked && !own);
        title.classList.toggle('eh-is-masked', masked);

        const content = title.querySelector('.nav-file-title-content, .nav-folder-title-content');
        this.maskEl(content, active);
        const tag = title.querySelector('.nav-file-tag');
        if (tag) tag.classList.toggle('eh-gone', active);
      });
    }
  }

  // Search results (Obsidian internals; skipped silently if they change)
  refreshSearch() {
    for (const leaf of this.app.workspace.getLeavesOfType('search')) {
      try {
        const lookup = leaf.view && leaf.view.dom && leaf.view.dom.resultDomLookup;
        if (!lookup || typeof lookup.forEach !== 'function') continue;
        lookup.forEach((rd, file) => {
          const el = rd && rd.el;
          if (!el || !file || !file.path) return;
          el.classList.toggle('eh-gone', this.settings.hideInSearch && this.isMaskActive(file.path));
        });
      } catch (e) { /* ignore */ }
    }
  }

  // Tabs, view headers and note content of open notes
  refreshLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!view || !view.containerEl) return;
      const file = view.file;
      const active = !!(file && this.isMaskActive(file.path));

      const tabTitle = leaf.tabHeaderInnerTitleEl ||
        (leaf.tabHeaderEl && leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-title'));
      this.maskEl(tabTitle, active);
      this.maskEl(view.containerEl.querySelector('.view-header-title'), active);
      const parent = view.containerEl.querySelector('.view-header-title-parent');
      if (parent) parent.classList.toggle('eh-gone', active);

      const content = view.contentEl || view.containerEl.querySelector('.view-content');
      if (!content) return;
      content.classList.toggle('eh-masked-content', active);
      let ov = content.querySelector(':scope > .eh-overlay');
      if (!active) { if (ov) ov.remove(); return; }
      if (!ov) ov = this.createOverlay(content);
      const key = file.path + '|' + (file.stat ? file.stat.mtime : '');
      if (ov.dataset.key !== key) {
        ov.dataset.key = key;
        this.fillOverlay(ov, file, key);
      }
    });
  }

  createOverlay(content) {
    const ov = document.createElement('div');
    ov.className = 'eh-overlay';
    const bar = document.createElement('div');
    bar.className = 'eh-overlay-bar';
    const btn = document.createElement('div');
    btn.className = 'clickable-icon';
    setIcon(btn, 'eye-off');
    btn.setAttribute('aria-label', 'Unmask');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cover = this.coveringEntry(ov.dataset.path);
      if (cover) this.removeMask(cover);
    });
    const label = document.createElement('span');
    label.textContent = 'Masked – tap the eye to reveal';
    bar.append(btn, label);
    const body = document.createElement('div');
    body.className = 'eh-overlay-body';
    ov.append(bar, body);
    content.appendChild(ov);
    return ov;
  }

  async fillOverlay(ov, file, key) {
    ov.dataset.path = file.path;
    let text = '';
    if (file instanceof TFile && (file.extension === 'md' || file.extension === 'txt')) {
      try { text = await this.app.vault.cachedRead(file); } catch (e) { text = ''; }
    }
    if (ov.dataset.key !== key) return; // a newer fill started meanwhile
    const body = ov.querySelector('.eh-overlay-body');
    body.textContent = STARS + '\n\n' + (text ? text.replace(/\S/g, '*') : STARS);
  }

  // ---------- Quick switcher (Obsidian internals) ----------
  patchSwitcher() {
    try {
      const sw = this.app.internalPlugins && this.app.internalPlugins.getPluginById('switcher');
      const Modal = sw && sw.instance && sw.instance.QuickSwitcherModal;
      if (!Modal || !Modal.prototype.getSuggestions) return;
      const orig = Modal.prototype.getSuggestions;
      const plugin = this;
      const filter = (arr) => {
        if (!Array.isArray(arr) || !plugin.settings.hideInSwitcher) return arr;
        return arr.filter((s) => !plugin.isMaskActive(s && s.file && s.file.path));
      };
      Modal.prototype.getSuggestions = function (query) {
        const res = orig.call(this, query);
        return res && typeof res.then === 'function' ? res.then(filter) : filter(res);
      };
      this.register(() => { Modal.prototype.getSuggestions = orig; });
    } catch (e) {
      console.warn('Eye Hider: could not patch quick switcher', e);
    }
  }
}

class EyeHiderSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Reveal everything')
      .setDesc('Same as the eye in the ribbon: shows all masked names and notes in clear.')
      .addToggle((t) => t.setValue(p.settings.revealAll).onChange(async (v) => {
        p.settings.revealAll = v; p.updateRibbon(); await p.save();
      }));

    new Setting(containerEl)
      .setName('Show eye buttons only on hover')
      .setDesc('Desktop only. On mobile the buttons are always visible.')
      .addToggle((t) => t.setValue(p.settings.hoverOnly).onChange(async (v) => {
        p.settings.hoverOnly = v; p.applyBodyClasses(); await p.save();
      }));

    new Setting(containerEl)
      .setName('Leave masked notes out of search')
      .setDesc('Otherwise search results would show their names and text.')
      .addToggle((t) => t.setValue(p.settings.hideInSearch).onChange(async (v) => {
        p.settings.hideInSearch = v; await p.save();
      }));

    new Setting(containerEl)
      .setName('Leave masked notes out of the quick switcher')
      .addToggle((t) => t.setValue(p.settings.hideInSwitcher).onChange(async (v) => {
        p.settings.hideInSwitcher = v; await p.save();
      }));

    new Setting(containerEl).setName('Masked items').setHeading()
      .addButton((b) => b.setButtonText('Unmask all').onClick(async () => {
        p.settings.maskedPaths = []; await p.save(); this.display();
      }));

    if (p.settings.maskedPaths.length === 0) {
      containerEl.createEl('p', { text: 'Nothing is masked.', cls: 'setting-item-description' });
    }
    for (const path of [...p.settings.maskedPaths].sort()) {
      new Setting(containerEl).setName(path)
        .addExtraButton((b) => b.setIcon('eye').setTooltip('Unmask').onClick(async () => {
          await p.removeMask(path); this.display();
        }));
    }
  }
}

module.exports = EyeHiderPlugin;
