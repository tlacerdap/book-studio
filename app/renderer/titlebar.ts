// The window's own title bar and menu, on Windows and Linux, so both follow the reading theme and the warm tint (the OS
// menu could not — see the README). macOS keeps its native menu and this module does nothing there. The native menu still
// exists behind the scenes for the keyboard shortcuts; here we draw the matching menu from the very same model (menu.ts).

import { clear, h } from "./dom.ts";
import type { MenuCommand } from "../shared/api.ts";
import type { MenuAction, MenuItem, MenuSection } from "../shared/menu.ts";
import { formatAccelerator } from "../shared/menu.ts";

const api = window.studio;

interface TitlebarHooks {
  /** Run one of the app's own menu commands (shared with the native menu handler). */
  run: (cmd: MenuCommand) => void;
  /** Open a book folder (File > Open Recent). */
  openFolder: (folder: string) => void;
}

export interface Titlebar {
  /** Show the book's name in the centre of the bar. */
  setTitle: (text: string) => void;
}

/** Build the title bar into #titlebar, or do nothing on macOS (which keeps its native menu). Returns null on macOS. */
export async function setupTitlebar(hooks: TitlebarHooks): Promise<Titlebar | null> {
  const bar = document.getElementById("titlebar");
  if (!bar) return null;
  const info = await api.chromeInfo();
  if (!info.custom) {
    bar.hidden = true;
    return null;
  }

  bar.hidden = false;
  document.documentElement.classList.add("custom-chrome");
  document.documentElement.style.setProperty("--titlebar-h", `${info.height}px`);
  document.documentElement.style.setProperty("--controls-w", `${info.controlsWidth}px`);
  const isLinux = info.platform === "linux";

  clear(bar);
  const menubar = h("div", { class: "tb-menubar", role: "menubar", "aria-label": "Main menu" });
  const titleEl = h("div", { class: "tb-title", "aria-hidden": "true" }, "Book Studio");
  bar.append(menubar, titleEl);

  // Double-clicking the empty part of the bar maximizes or restores, as a title bar normally does.
  titleEl.addEventListener("dblclick", () => void api.toggleMaximizeWindow());

  if (isLinux) bar.append(buildWindowControls());

  // ---- the menu -------------------------------------------------------------------------------
  let openSection: { label: string; button: HTMLButtonElement; panel: HTMLElement } | null = null;

  function closeMenu(focusButton = false): void {
    if (!openSection) return;
    const btn = openSection.button;
    openSection.panel.remove();
    openSection.button.setAttribute("aria-expanded", "false");
    openSection = null;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
    if (focusButton) btn.focus();
  }

  function onOutside(e: MouseEvent): void {
    const t = e.target as Node;
    if (openSection && !openSection.panel.contains(t) && !openSection.button.contains(t) && !menubar.contains(t)) closeMenu();
  }

  function onMenuKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // Move to the previous/next top-level menu while the bar is open.
      const labels = sections.map((s) => s.label);
      const i = openSection ? labels.indexOf(openSection.label) : 0;
      const next = sections[(i + (e.key === "ArrowRight" ? 1 : labels.length - 1)) % labels.length];
      if (next) {
        e.preventDefault();
        void openAt(next);
      }
    }
  }

  async function openAt(section: MenuSection): Promise<void> {
    const button = buttons.get(section.label);
    if (!button) return;
    const wasOpen = openSection?.label === section.label;
    closeMenu();
    if (wasOpen) return;
    // Rebuild from a fresh model so recent books and the theme/tint ticks are always current.
    const model = await api.menuModel();
    const fresh = model.find((s) => s.label === section.label) ?? section;
    const panel = buildPanel(fresh.submenu);
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.top = `${Math.round(rect.bottom)}px`;
    document.body.append(panel);
    // Keep the panel on screen if it would spill off the right edge.
    const pr = panel.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) panel.style.left = `${Math.max(8, window.innerWidth - 8 - pr.width)}px`;
    button.setAttribute("aria-expanded", "true");
    openSection = { label: section.label, button, panel };
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onMenuKey, true);
  }

  function dispatch(action: MenuAction): void {
    closeMenu();
    switch (action.kind) {
      case "command":
        hooks.run(action.cmd);
        break;
      case "open-folder":
        hooks.openFolder(action.folder);
        break;
      case "set-theme":
        void api.setAppearance({ theme: action.theme });
        break;
      case "set-warmth":
        void api.setAppearance({ warmth: action.warmth });
        break;
      case "role":
        runRole(action.role);
        break;
    }
  }

  function buildPanel(items: MenuItem[]): HTMLElement {
    const panel = h("div", { class: "tb-menu", role: "menu" });
    for (const item of items) {
      if (item.type === "separator") {
        panel.append(h("div", { class: "tb-sep", role: "separator" }));
        continue;
      }
      if (item.type === "submenu") {
        panel.append(buildSubmenuItem(item.label, item.submenu, item.enabled !== false));
        continue;
      }
      const enabled = item.enabled !== false;
      const row = h(
        "button",
        {
          type: "button",
          class: `tb-item${item.checked ? " checked" : ""}`,
          role: item.type === "radio" ? "menuitemradio" : item.type === "checkbox" ? "menuitemcheckbox" : "menuitem",
          "aria-checked": item.type === "radio" || item.type === "checkbox" ? String(!!item.checked) : undefined,
          disabled: enabled ? undefined : true,
          onClick: enabled ? () => dispatch(item.action) : undefined,
        },
        h("span", { class: "tb-check" }, item.checked ? "✓" : ""),
        h("span", { class: "tb-label" }, item.label),
        h("span", { class: "tb-accel" }, item.accelerator ? formatAccelerator(item.accelerator) : ""),
      );
      panel.append(row);
    }
    return panel;
  }

  function buildSubmenuItem(label: string, sub: MenuItem[], enabled: boolean): HTMLElement {
    const wrap = h("div", { class: "tb-subwrap" });
    let flyout: HTMLElement | null = null;
    let hideTimer: number | undefined;
    const open = () => {
      window.clearTimeout(hideTimer);
      if (flyout) return;
      flyout = buildPanel(sub);
      flyout.classList.add("tb-flyout");
      wrap.append(flyout);
      const fr = flyout.getBoundingClientRect();
      if (fr.right > window.innerWidth - 8) flyout.classList.add("left");
    };
    const close = () => {
      hideTimer = window.setTimeout(() => {
        flyout?.remove();
        flyout = null;
      }, 120);
    };
    const btn = h(
      "button",
      {
        type: "button",
        class: "tb-item tb-has-sub",
        role: "menuitem",
        "aria-haspopup": "true",
        disabled: enabled ? undefined : true,
        onClick: enabled ? () => (flyout ? close() : open()) : undefined,
      },
      h("span", { class: "tb-check" }, ""),
      h("span", { class: "tb-label" }, label),
      h("span", { class: "tb-accel tb-arrow" }, "›"),
    );
    wrap.append(btn);
    if (enabled) {
      wrap.addEventListener("mouseenter", open);
      wrap.addEventListener("mouseleave", close);
    }
    return wrap;
  }

  function runRole(role: Extract<MenuAction, { kind: "role" }>["role"]): void {
    switch (role) {
      case "cut":
      case "copy":
      case "paste":
        document.execCommand(role);
        break;
      case "selectAll":
        document.execCommand("selectAll");
        break;
      case "minimize":
        void api.minimizeWindow();
        break;
      case "togglemaximize":
        void api.toggleMaximizeWindow();
        break;
      case "close":
      case "quit":
        void api.closeWindow();
        break;
      case "toggleDevTools":
        void api.toggleDevTools();
        break;
    }
  }

  // ---- top-level buttons ----------------------------------------------------------------------
  const buttons = new Map<string, HTMLButtonElement>();
  let sections: MenuSection[] = await api.menuModel();

  function renderMenubar(): void {
    clear(menubar);
    buttons.clear();
    for (const section of sections) {
      const btn = h(
        "button",
        {
          type: "button",
          class: "tb-top",
          role: "menuitem",
          "aria-haspopup": "true",
          "aria-expanded": "false",
          onMousedown: (e: MouseEvent) => {
            e.preventDefault();
            void openAt(section);
          },
          onMouseenter: () => {
            // Once a menu is open, sliding across the bar switches menus, like a real menu bar.
            if (openSection && openSection.label !== section.label) void openAt(section);
          },
        },
        section.label,
      ) as HTMLButtonElement;
      buttons.set(section.label, btn);
      menubar.append(btn);
    }
  }
  renderMenubar();

  // Alt focuses the first menu, the Windows convention.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !e.repeat && !openSection && sections[0]) {
      e.preventDefault();
      void openAt(sections[0]);
    }
  });

  // The theme or the recent list changed: refresh the top labels so a renamed or added book shows up.
  api.onAppearance(() => void api.menuModel().then((m) => {
    sections = m;
    renderMenubar();
  }));

  return {
    setTitle: (text: string) => {
      titleEl.textContent = text || "Book Studio";
    },
  };
}

/** The minimise / maximise / close buttons for Linux (Windows draws its own in the native overlay). */
function buildWindowControls(): HTMLElement {
  const wrap = h("div", { class: "tb-winctl", role: "group", "aria-label": "Window controls" });
  const min = h("button", { type: "button", class: "wc", title: "Minimize", "aria-label": "Minimize", onClick: () => void api.minimizeWindow() }, glyph("M0 5 h10"));
  const max = h("button", { type: "button", class: "wc", title: "Maximize", "aria-label": "Maximize", onClick: () => void api.toggleMaximizeWindow() }, glyph("M0 0 h10 v10 h-10 z"));
  const close = h("button", { type: "button", class: "wc wc-close", title: "Close", "aria-label": "Close", onClick: () => void api.closeWindow() }, glyph("M0 0 L10 10 M10 0 L0 10"));
  wrap.append(min, max, close);
  const setMaxTitle = (maxed: boolean) => (max.title = maxed ? "Restore" : "Maximize");
  void api.isWindowMaximized().then(setMaxTitle);
  api.onMaximizeChange(setMaxTitle);
  return wrap;
}

/** A small 10×10 stroked icon for a window-control button, coloured with the bar's ink via currentColor. */
function glyph(path: string): HTMLElement {
  const span = h("span", { class: "wc-ico", "aria-hidden": "true" });
  span.innerHTML = `<svg width="10" height="10" viewBox="-0.5 -0.5 11 11" fill="none" stroke="currentColor" stroke-width="1"><path d="${path}"/></svg>`;
  return span;
}
