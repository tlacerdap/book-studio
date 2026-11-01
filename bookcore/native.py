"""WeasyPrint needs Pango. On macOS, Homebrew's lib directory is not on dyld's default search path,
and dyld only reads the variable at process start, so a command-line entry point re-executes itself
once with the path set. Call `ensure_native_libs()` first thing in an entry point, never on import."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def ensure_native_libs() -> None:
    if sys.platform != "darwin" or os.environ.get("_BOOK_STUDIO_REEXEC"):
        return
    try:
        import weasyprint  # noqa: F401
        return
    except OSError:
        pass
    libs = [p for p in ("/opt/homebrew/lib", "/usr/local/lib") if Path(p).is_dir()]
    if not libs:
        return
    env = dict(os.environ, _BOOK_STUDIO_REEXEC="1")
    env["DYLD_FALLBACK_LIBRARY_PATH"] = ":".join([*libs, env.get("DYLD_FALLBACK_LIBRARY_PATH", "")]).strip(":")
    os.execve(sys.executable, [sys.executable, *sys.argv], env)


def import_weasyprint():
    """Import WeasyPrint with a message a person can act on if Pango is missing."""
    try:
        import weasyprint
    except OSError as exc:
        raise RuntimeError(
            "WeasyPrint could not load Pango. On macOS run `brew install pango`; on Debian or Ubuntu "
            "`apt install libpango-1.0-0 libpangoft2-1.0-0`."
        ) from exc
    return weasyprint
