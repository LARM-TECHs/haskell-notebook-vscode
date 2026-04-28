# Haskell Notebook

Interactive Haskell notebooks for VS Code, powered by GHCi — no Jupyter, no Python, no ZeroMQ required.

![Haskell Notebook](images/icon.png)

## Features

- **Run Haskell code** directly in notebook cells via GHCi
- **Rich error formatting** — errors and warnings rendered with location, flag badges, and colour-coded severity
- **Syntax highlighting** on cell outputs using the Haskell grammar
- **Mixed cells** — declarations, type signatures, and expressions in the same cell
- **Markdown cells** for documentation and notes
- **Show Type** — query the type of any expression via `:t` with a persistent history
- **Persistent outputs** — outputs are saved to disk and restored on reopen
- **Native `.ihsnb` format** — compatible with the [HaskellNotebook desktop app](https://github.com/LARM-TECHs/Haskell-Notebook)

## Requirements

- [Haskell Platform](https://www.haskell.org/platform/) 8.6.5 or later (`ghci` must be on your PATH)
- VS Code 1.85.0 or later

To verify GHCi is available:

```
ghci --version
```

## Getting Started

1. Create a new file with the `.ihsnb` extension
2. VS Code opens it as a Haskell Notebook automatically
3. Add a code cell and press **Shift+Enter** to run it

GHCi starts automatically on first execution. The status bar shows the current GHCi state.

## Usage

### Running cells

Press **Shift+Enter** or click the ▶ button to run a cell. Multiple statements, type signatures, and expressions can coexist in a single cell:

```haskell
-- Type signature + definition are grouped automatically
fib :: Int -> Int
fib 0 = 0
fib 1 = 1
fib n = fib (n-1) + fib (n-2)

fib 10
```

### Show Type

Click the **⟨T⟩** button in the cell toolbar (or run `Haskell: Show Type` from the Command Palette) to query the type of an expression. If text is selected in the cell editor, it is used as the expression automatically. Previous queries are saved and shown in a searchable history.

### GHCi controls

| Command | Description |
|---|---|
| `Haskell: Start GHCi` | Start the GHCi process |
| `Haskell: Restart GHCi` | Restart GHCi (clears all definitions) |
| `Haskell: Stop GHCi` | Stop the GHCi process |
| `Haskell: Clear Type Query History` | Clear the Show Type history |

## Settings

| Setting | Default | Description |
|---|---|---|
| `haskellNotebook.ghciPath` | `"ghci"` | Path to the GHCi executable |
| `haskellNotebook.timeoutMs` | `30000` | Execution timeout per cell (ms) |

If GHCi is not on your PATH, set the full path in settings:

```json
{
  "haskellNotebook.ghciPath": "C:\\ghc\\bin\\ghci.exe"
}
```

## File Format

Notebooks are saved as `.ihsnb` files — a JSON format compatible with the HaskellNotebook desktop app. The format is human-readable and version-controlled friendly.

```json
{
  "version": "1.0",
  "metadata": { "ghcVersion": "8.6.5", ... },
  "cells": [
    {
      "id": "cell-abc123",
      "type": "code",
      "source": "map (*2) [1..5]",
      "output": { "type": "success", "value": "..." },
      "executed": true,
      "executionCount": 1,
      "executionTimeMs": 12
    }
  ]
}
```

## Known Limitations

- GHCi state is global — all cells share the same REPL session. Restarting GHCi clears all definitions.
- `:load` and `:module` commands work but require absolute paths or files in the workspace.
- Infinite loops require using **Restart GHCi** to recover (`Ctrl+Shift+P → Haskell: Restart GHCi`).
- Autocompletion inside cells is provided by the [Haskell extension](https://marketplace.visualstudio.com/items?itemName=haskell.haskell) if installed.

## License

MIT — see [LICENSE](LICENSE)