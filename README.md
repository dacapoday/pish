# pish

**Your shell, with AI built in.**

pish wraps bash or zsh transparently. Every command you know works exactly as before — zero overhead. When you type something the shell doesn't recognize, an AI agent ([pi](https://github.com/mariozechner/pi-coding-agent)) kicks in automatically.

```
❯ ls -la                          # normal shell, as always
❯ fix the type error in main.ts   # AI agent activates
⠋ Working...
  edit src/main.ts
✓ done (3.2s)
❯ pi                              # full pi TUI, with session continuity
```

## How it works

pish runs your shell inside a PTY with lightweight hooks injected via rcfile. Normal commands flow through untouched. Only when `command_not_found` fires does pish intercept — it sends your recent shell history as context to the AI agent, which can read files, run commands, and edit code.

```
You ←→ pish (Node.js) ←→ PTY (bash/zsh + hooks)
              ↓
        Agent (pi --mode rpc, on demand)
              ↓
        Renderer → stderr
```

Agent output goes to **stderr**, never contaminating your shell's stdout. Your prompt, pipes, and redirections work exactly as expected.

## Quick start

**Requirements:**
- Node.js ≥ 18
- bash ≥ 4.4 or zsh ≥ 5.0
- [`pi`](https://github.com/mariozechner/pi-coding-agent) installed and on PATH

### Install from npm

```bash
npm install -g pish
```

### Install from source

```bash
git clone https://github.com/dacapoday/pish.git
cd pish
npm install
npm run build
npm link          # makes `pish` available globally
```

### Run

```bash
pish                            # start with $SHELL (or bash)
pish zsh                        # start with zsh
pish /usr/local/bin/bash        # use a specific shell binary
pish --pi /path/to/pi           # use a specific pi binary
```

## Usage

### Normal commands

Everything works exactly like your regular shell — aliases, functions, pipes, redirections, job control, history, tab completion.

### AI agent

Type anything the shell doesn't recognize. The agent sees your recent commands and their outputs as context:

```
❯ find all TODO comments in src/
⠋ Working...
  $ grep -rn "TODO" src/
✓ done (2.1s)
```

### Reverse to pi TUI

Type `pi` with no arguments to open the full pi TUI. Your conversation carries over — the AI remembers everything from the current session. When you exit pi, you're back in pish.

### Control commands

```
/compact [instructions]     # compact agent context
/model provider/model       # switch model
/think [level]              # set thinking level (none/low/medium/high)
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+C` | Abort running agent |
| `Ctrl+L` | Clear screen + reset context + reset session |

## Configuration

Priority: **CLI > ENV > defaults**

```
pish [options] [shell]

Options:
  -s, --shell <name>  Shell name or path
  --pi <path>         Path to pi binary
  --no-agent          Disable agent (for debugging)
  -v, --version       Show version
  -h, --help          Show help
```

| Environment variable | Description | Default |
|---------------------|-------------|---------|
| `PISH_SHELL` | Shell name or path | `$SHELL` or `bash` |
| `PISH_PI` | Path to pi binary | `pi` |
| `PISH_MAX_CONTEXT` | Max history entries sent to AI | `20` |
| `PISH_HEAD_LINES` | Output head lines kept | `50` |
| `PISH_TAIL_LINES` | Output tail lines kept | `30` |
| `PISH_LINE_WIDTH` | Max chars per line | `512` |
| `PISH_TOOL_LINES` | Max tool result lines shown | `10` |
| `PISH_LOG` | Event log (`stderr` or file path) | off |
| `PISH_DEBUG` | Debug log file path | off |
| `PISH_NO_BANNER` | Hide startup banner (set to `1`) | off |

## Known limitations

- **Bash keywords** — `do something` or `if something` triggers a syntax error instead of the AI agent. Rephrase as `please do something`.
- **CNF returns 0** — `$?` after an agent run is always 0, not 127.

## License

[MIT](LICENSE) © [dacapoday](https://github.com/dacapoday)
