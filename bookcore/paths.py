"""Where book-studio's own files live (not the book's)."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STYLES = REPO / "styles"          # book.css and fonts: the typography shared by the app view and the PDF
TEMPLATES = Path(__file__).resolve().parent / "templates"
DEFAULT_CSS = STYLES / "book.css"
