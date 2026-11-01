#!/bin/sh
# Dev loop: build chapters $2 of the book in $1 and rasterise the given pages into scratch.
# usage: scripts/try.sh <book> <chapters> <out.pdf> [pages...]
set -e
node bin/book-studio.js pdf "$1" --chapters "$2" --out "$3" --html "${3%.pdf}.html"
