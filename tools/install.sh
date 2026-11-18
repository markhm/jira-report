#!/bin/bash
#
# install.sh — put jira-report on your PATH. Idempotent; safe to re-run.
#
#   tools/install.sh        # symlinks ~/bin/jira-report -> ../bin/jira-report.mjs
#   tools/install.sh DIR    # install into DIR instead of ~/bin

set -euo pipefail

DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root (this script lives in tools/)
BINDIR="${1:-$HOME/bin}"

mkdir -p "$BINDIR"
chmod +x "$DIR/bin/jira-report.mjs"
ln -sf "$DIR/bin/jira-report.mjs" "$BINDIR/jira-report"
echo "✓ linked $BINDIR/jira-report -> $DIR/bin/jira-report.mjs"

if ! command -v node >/dev/null 2>&1; then
    echo "  note: 'node' not found — jira-report needs Node 20 or newer."
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    echo "  note: Node $(node -v) is too old — jira-report needs Node 20 or newer."
fi
case ":$PATH:" in
    *":$BINDIR:"*) : ;;
    *) echo "  note: $BINDIR is not on your PATH — add it, e.g.  export PATH=\"$BINDIR:\$PATH\"" ;;
esac

echo "Next:  jira-report https://<site>.atlassian.net/jira/software/c/projects/<KEY>/boards/<id>"
