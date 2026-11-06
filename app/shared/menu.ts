// The application menu as data, so the native menu (which carries the keyboard shortcuts) and the custom in-window menu bar
// on Windows and Linux are built from one definition and can never drift. macOS keeps its own native menu (see main.ts).

import type { Appearance, MenuCommand, Theme } from "./api.ts";

/** What a menu item does when chosen. Roles map to the platform's own behaviour; the rest are the app's own commands. */
export type MenuAction =
  | { kind: "command"; cmd: MenuCommand }
  | { kind: "open-folder"; folder: string }
  | { kind: "set-theme"; theme: Theme }
  | { kind: "set-warmth"; warmth: number }
  | { kind: "role"; role: "cut" | "copy" | "paste" | "selectAll" | "minimize" | "togglemaximize" | "close" | "quit" | "toggleDevTools" };

export type MenuItem =
  | { type: "separator" }
  | { type?: "normal" | "checkbox" | "radio"; label: string; accelerator?: string; action: MenuAction; checked?: boolean; enabled?: boolean }
  | { type: "submenu"; label: string; submenu: MenuItem[]; enabled?: boolean };

export interface MenuSection {
  label: string;
  submenu: MenuItem[];
}

export interface MenuContext {
  recent: { folder: string; title: string }[];
  appearance: Appearance;
  packaged: boolean;
}

const THEME_LABELS: Record<Theme, string> = { light: "Light", sepia: "Sepia (warm paper)", dark: "Dark", black: "Black", system: "Match the System" };
const THEME_ORDER: Theme[] = ["light", "sepia", "dark", "black", "system"];
const WARMTH_STEPS: [string, number][] = [["Off", 0], ["Low", 0.25], ["Medium", 0.5], ["High", 0.75]];

/** True when `w` is the warmth step that is currently selected (mirrors the native menu's radio logic). */
function warmthChecked(current: number, w: number): boolean {
  return Math.abs(current - w) < 0.13 && (w === 0 ? current === 0 : current > 0);
}

function command(label: string, cmd: MenuCommand, accelerator?: string): MenuItem {
  return { label, accelerator, action: { kind: "command", cmd } };
}

const SEP: MenuItem = { type: "separator" };

/** The whole menu for Windows and Linux, in display order. Dynamic parts (recent books, the theme and tint radios) come
 *  from the context so the menu is rebuilt whenever they change. */
export function buildMenuModel(ctx: MenuContext): MenuSection[] {
  const recent: MenuItem =
    ctx.recent.length > 0
      ? { type: "submenu", label: "Open Recent", submenu: ctx.recent.map((r) => ({ label: `${r.title} (${baseName(r.folder)})`, action: { kind: "open-folder" as const, folder: r.folder } })) }
      : { type: "submenu", label: "Open Recent", submenu: [{ label: "No recent books", action: { kind: "command", cmd: "open-book" }, enabled: false }] };

  const appearance: MenuItem = {
    type: "submenu",
    label: "Appearance",
    submenu: THEME_ORDER.map((t) => ({ type: "radio" as const, label: THEME_LABELS[t], checked: ctx.appearance.theme === t, action: { kind: "set-theme" as const, theme: t } })),
  };

  const eyeComfort: MenuItem = {
    type: "submenu",
    label: "Eye Comfort",
    submenu: WARMTH_STEPS.map(([label, w]) => ({ type: "radio" as const, label: `Warm Tint: ${label}`, checked: warmthChecked(ctx.appearance.warmth, w), action: { kind: "set-warmth" as const, warmth: w } })),
  };

  const sections: MenuSection[] = [
    {
      label: "File",
      submenu: [
        command("New Chapter...", "new-chapter", "CmdOrCtrl+N"),
        SEP,
        command("Open Book Folder...", "open-book", "CmdOrCtrl+O"),
        recent,
        SEP,
        command("Save", "save", "CmdOrCtrl+S"),
        command("Version History...", "history", "CmdOrCtrl+Shift+H"),
        command("Print PDF", "print", "CmdOrCtrl+P"),
        {
          type: "submenu",
          label: "Export",
          submenu: [
            command("Book as EPUB...", "export:epub"),
            command("Book as One Web Page...", "export:html"),
            SEP,
            command("This Chapter as PDF...", "export:chapter-pdf"),
            command("Every Chapter as Its Own PDF...", "export:all-pdf"),
          ],
        },
        SEP,
        { label: "Quit", accelerator: "CmdOrCtrl+Q", action: { kind: "role", role: "quit" } },
      ],
    },
    {
      label: "Edit",
      submenu: [
        command("Undo", "undo", "CmdOrCtrl+Z"),
        command("Redo", "redo", "Shift+CmdOrCtrl+Z"),
        SEP,
        { label: "Cut", accelerator: "CmdOrCtrl+X", action: { kind: "role", role: "cut" } },
        { label: "Copy", accelerator: "CmdOrCtrl+C", action: { kind: "role", role: "copy" } },
        { label: "Paste", accelerator: "CmdOrCtrl+V", action: { kind: "role", role: "paste" } },
        { label: "Select All", accelerator: "CmdOrCtrl+A", action: { kind: "role", role: "selectAll" } },
        SEP,
        command("Edit This Paragraph", "edit-block", "CmdOrCtrl+E"),
        command("Add Note", "add-note", "CmdOrCtrl+Shift+M"),
        command("Find in Chapter", "find", "CmdOrCtrl+F"),
        command("Find in Book", "find-book", "CmdOrCtrl+Shift+F"),
        command("Go to Chapter or Heading...", "goto", "CmdOrCtrl+K"),
        SEP,
        command("Study Flashcards...", "study", "CmdOrCtrl+Alt+S"),
      ],
    },
    {
      label: "Format",
      submenu: [
        command("Bold", "format:bold", "CmdOrCtrl+B"),
        command("Italic", "format:italic", "CmdOrCtrl+I"),
        command("Code", "format:code", "CmdOrCtrl+Alt+C"),
        SEP,
        command("Section Heading", "format:h2", "CmdOrCtrl+2"),
        command("Subheading", "format:h3", "CmdOrCtrl+3"),
        SEP,
        command("Bulleted List", "format:bullets", "CmdOrCtrl+Shift+8"),
        command("Numbered List", "format:numbers", "CmdOrCtrl+Shift+7"),
        command("Quote", "format:quote", "CmdOrCtrl+Shift+."),
        command("Link", "format:link", "CmdOrCtrl+L"),
        command("Insert Table", "format:table"),
        command("Insert Picture...", "insert-image"),
        command("Insert Diagram", "format:diagram"),
      ],
    },
    {
      label: "View",
      submenu: [
        command("Reading", "view-reading", "CmdOrCtrl+Alt+1"),
        command("Edit", "view-edit", "CmdOrCtrl+Alt+2"),
        command("Source", "view-source", "CmdOrCtrl+Alt+3"),
        command("Switch View", "toggle-view", "CmdOrCtrl+/"),
        SEP,
        command("Show or Hide Chapters", "toggle-panel", "CmdOrCtrl+\\"),
        command("Focus Mode", "focus", "CmdOrCtrl+Alt+F"),
        appearance,
        eyeComfort,
        command("Previous Chapter", "prev-chapter", "CmdOrCtrl+["),
        command("Next Chapter", "next-chapter", "CmdOrCtrl+]"),
        SEP,
        command("Zoom In", "zoom-in", "CmdOrCtrl+="),
        command("Zoom Out", "zoom-out", "CmdOrCtrl+-"),
        command("Actual Size", "zoom-reset", "CmdOrCtrl+0"),
        command("Fit Page to Window", "zoom-fit", "CmdOrCtrl+9"),
        SEP,
        command("Reload Book", "reload-book"),
        ...(ctx.packaged ? [] : [{ label: "Toggle Developer Tools", accelerator: "CmdOrCtrl+Shift+I", action: { kind: "role" as const, role: "toggleDevTools" as const } }]),
      ],
    },
    {
      label: "Window",
      submenu: [
        { label: "Minimize", accelerator: "CmdOrCtrl+M", action: { kind: "role", role: "minimize" } },
        { label: "Maximize", action: { kind: "role", role: "togglemaximize" } },
        { label: "Close", accelerator: "CmdOrCtrl+W", action: { kind: "role", role: "close" } },
      ],
    },
  ];
  return sections;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Turn an Electron accelerator ("CmdOrCtrl+Shift+.") into what to show next to a menu item on Windows/Linux. */
export function formatAccelerator(accel: string): string {
  return accel.replace(/CmdOrCtrl|Command|Cmd|Control/gi, "Ctrl");
}
