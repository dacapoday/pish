<div align="center">

# pish

**Your shell, with AI built in.**

[![CI](https://github.com/dacapoday/pish/actions/workflows/ci.yml/badge.svg)](https://github.com/dacapoday/pish/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@aerode/pish?color=cb0000&label=npm)](https://www.npmjs.com/package/@aerode/pish)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<br/>

<p>
  <a href="#-features">Features</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-usage">Usage</a> ·
  <a href="#%EF%B8%8F-configuration">Configuration</a> ·
  <a href="#-how-it-works">How It Works</a> ·
  <a href="#-contributing">Contributing</a>
</p>

<br/>

<img src="pish-example.gif" alt="pish demo" width="640">

</div>

---

## Why pish?

You already know your shell. You've built muscle memory for `cd`, `grep`, `git`, pipes, redirections, and a hundred aliases. **Why should talking to AI mean leaving all that behind?**

pish doesn't replace your shell — it **is** your shell. Every command you know works exactly as before, with zero overhead. The moment you type something the shell doesn't recognize, an AI coding agent ([pi](https://github.com/badlogic/pi-mono)) seamlessly steps in — reading files, running commands, and editing code — all without breaking your flow.

> **Think of it as autocomplete for intent:** you describe what you want in plain English, and pish makes it happen, right where you are.

## ✨ Features

<table>
<tr>
<td width="50%">

### 🔄 Transparent Shell Wrapper
Every alias, function, pipe, redirection, job control, tab completion, and history feature works exactly as in your native bash/zsh.

### 🤖 Automatic AI Agent
Type anything the shell doesn't recognize — the AI agent activates with your recent shell context, reads files, runs commands, and edits code.

### 🚀 Zero Overhead
Normal commands never touch the AI. No hooks intercepting your keystrokes, no latency. The agent is on-demand only.

</td>
<td width="50%">

### 🧠 Context-Aware
The agent automatically sees your recent commands and their outputs — it understands what you've been doing and can pick up where you left off.

### 🔀 Seamless pi TUI
Type `pi` to switch to the full pi TUI. Your conversation carries over — the AI remembers everything. Exit pi, and you're right back in pish.

### ⚡ Control Commands
Switch models, adjust thinking levels, and compact context — all without leaving your terminal. Just type `/model`, `/think`, or `/compact`.

</td>
</tr>
</table>

## 📦 Quick Start

### Prerequisites

- **Node.js** ≥ 18
- **bash** ≥ 4.4 or **zsh** ≥ 5.0
- [**pi**](https://github.com/badlogic/pi-mono) installed and on PATH

### Install from npm

```bash
npm install -g @aerode/pish
```

### Install from source

```bash
git clone https://github.com/dacapoday/pish.git
cd pish
npm install
npm run build
npm link          # makes `pish` available globally
```

### Launch

```bash
pish                            # start with $SHELL (or bash)
pish zsh                        # start with zsh
pish /usr/local/bin/bash        # use a specific shell binary
pish --pi /path/to/pi           # use a specific pi binary
```

## 🎯 Usage

### Normal commands — everything just works

Aliases, functions, pipes, redirections, job control, history, tab completion — **all unchanged**. pish adds zero overhead to normal shell operations.

### AI agent — just describe what you want

Type anything the shell doesn't recognize. The agent sees your recent commands and their outputs as context:

```
❯ find all TODO comments in src/
⠋ Working...
  $ grep -rn "TODO" src/
✓ done (2.1s · 1.2k tokens · $0.003 · claude-sonnet-4-20250514)
```

The agent can:
- 📖 Read files and understand project structure
- ⚡ Run commands to gather information
- ✏️ Edit code across multiple files
- 🔍 Debug errors using your recent shell output as context

### Reverse to pi TUI

Type `pi` with no arguments to open the full [pi](https://github.com/badlogic/pi-mono) TUI. Your conversation carries over — the AI remembers everything from the current session. When you exit, you're back in pish with the updated session.

> **Tip:** `pi` with any arguments (e.g. `pi --help`, `pi some-file.txt`) is passed straight through to the original pi binary — only bare `pi` activates the session handoff. You can also use `command pi` to bypass pish entirely.

### Control commands

| Command | Description | Example |
|---------|-------------|---------|
| `/compact [instructions]` | Compact agent context | `/compact focus on auth` |
| `/model [provider/model]` | Switch or query model | `/model anthropic/claude-sonnet-4-20250514` |
| `/think [level]` | Set thinking level | `/think high` |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Abort running agent |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Clear screen + reset context + reset session |

## ⚙️ Configuration

Configuration priority: **CLI args > Environment variables > Defaults**

### CLI Options

```
pish [options] [shell]

Arguments:
  shell               bash, zsh, or full path (default: $SHELL or bash)

Options:
  -s, --shell <name>  Shell name or path
  --pi <path>         Path to pi binary
  --no-agent          Disable agent (for debugging)
  -v, --version       Show version
  -h, --help          Show help
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PISH_SHELL` | Shell name or path | `$SHELL` or `bash` |
| `PISH_PI` | Path to pi binary | `pi` |
| `PISH_MAX_CONTEXT` | Max history entries sent to AI | `20` |
| `PISH_HEAD_LINES` | Output head lines kept per command | `50` |
| `PISH_TAIL_LINES` | Output tail lines kept per command | `30` |
| `PISH_LINE_WIDTH` | Max chars per output line | `512` |
| `PISH_TOOL_LINES` | Max tool result lines displayed | `10` |
| `PISH_LOG` | Event log (`stderr` or file path) | off |
| `PISH_DEBUG` | Debug log file path | off |
| `PISH_NO_BANNER` | Hide startup banner (set to `1`) | off |

## 🏗️ How It Works

pish runs your shell inside a PTY with lightweight hooks injected via a temporary rcfile. An [OSC 9154](https://en.wikipedia.org/wiki/ANSI_escape_code#OSC_(Operating_System_Command)_sequences) signal protocol embedded in the terminal data stream lets pish detect shell events — command execution, prompts, errors — without interfering with normal operation.

```
┌─────────────────────────────────────────────────────┐
│  Terminal (stdin/stdout)                            │
│       ▲                                             │
│       │                                             │
│       ▼                                             │
│  ┌─────────────────────────────────────────────┐    │
│  │  pish (Node.js)                             │    │
│  │                                             │    │
│  │  ┌──────────┐   ┌──────────┐                │    │
│  │  │ Recorder │◄──│ OSC      │  PTY data      │    │
│  │  │ (context)│   │ Parser   │◄──────────┐    │    │
│  │  └────┬─────┘   └──────────┘           │    │    │
│  │       │                                │    │    │
│  │       ▼                                │    │    │
│  │  ┌──────────┐                  ┌───────┴─┐  │    │
│  │  │ Agent    │  pi --mode rpc   │ PTY     │  │    │
│  │  │ Manager  │◄────────────────►│ bash/zsh│  │    │
│  │  └────┬─────┘   (on demand)    │ +hooks  │  │    │
│  │       │                        └────┬────┘  │    │
│  │       ▼                             │       │    │
│  │  ┌──────────┐                  ┌────┴────┐  │    │
│  │  │ Renderer │──► stderr        │ FIFO    │  │    │
│  │  │ (pi-tui) │    (AI output)   │ (sync)  │  │    │
│  │  └──────────┘                  └─────────┘  │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| Agent output goes to **stderr** | Never contaminates shell stdout — pipes and redirections work perfectly |
| Normal commands **never touch FIFO** | Zero latency for regular shell operations |
| Agent spawns **on demand** | No background process until you need it — instant startup |
| Session persists **across agent restarts** | Your conversation context survives `kill` and `reverse` |
| Context is **automatically truncated** | Smart head/tail truncation keeps AI context relevant without overwhelming tokens |

### The four signal paths

| Path | Trigger | What happens |
|------|---------|-------------|
| **Normal command** | `ls`, `git status`, etc. | Flows through PTY untouched. Recorder captures output for context. |
| **AI agent** | Unknown command like `fix the bug` | CNF fires → FIFO blocks shell → agent runs → PROCEED unblocks |
| **Reverse pi** | `pi` (no args) | Switches to full pi TUI with session handoff, returns to pish on exit |
| **Empty line** | Just pressing Enter | No-op, no context captured |

## 🧪 Testing

pish has a comprehensive three-layer test suite:

```bash
# Run everything
bash test/run_tests.sh

# Unit tests only (~60s, 104 tests covering osc/strip/recorder/agent/config)
npm run test:unit

# Fast scenario tests (~10s, no pi binary needed)
bash test/run_tests.sh fast

# Slow scenario tests (~2min, needs real pi + LLM)
bash test/run_tests.sh slow

# Single test
bash test/run_tests.sh bash normal_cmd
```

| Layer | Tests | What it covers | Requires pi? |
|-------|-------|---------------|-------------|
| **Unit** | 104 | OSC parsing, ANSI stripping, recorder logic, agent RPC, config loading | No |
| **Fast scenarios** | 10 × bash/zsh + 3 edge | Shell lifecycle, context capture, truncation, nesting, control commands | No |
| **Slow scenarios** | 6 × bash/zsh | Real agent interaction, abort, reverse, model switching | Yes |

Scenario tests use `expect` scripts to drive real shell sessions, produce JSONL event logs, and verify with assertion-based checks.

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

```bash
git clone https://github.com/dacapoday/pish.git
cd pish
npm install
npm run build
```

### Development workflow

```bash
npm run dev           # Watch mode (tsc --watch)
npm run lint          # Biome lint + format check
npm run test:unit     # Quick unit tests
bash test/run_tests.sh fast   # Fast scenario tests
```

### Project structure

```
src/
├── main.ts        # Entry point: bootstrap + I/O wiring
├── app.ts         # Core state machine + event dispatch
├── config.ts      # Unified config (CLI + ENV + defaults)
├── recorder.ts    # PTY stream → context entries
├── agent.ts       # pi RPC process management
├── hooks.ts       # bash/zsh rcfile generation
├── render.ts      # Agent UI → stderr (Markdown, spinner, status)
├── osc.ts         # OSC 9154 signal parser
├── session.ts     # pi session file discovery
├── theme.ts       # ANSI colors + Markdown theme
├── vterm.ts       # xterm headless prompt replay
├── strip.ts       # ANSI stripping + truncation
└── log.ts         # JSON event logging
```

Before submitting a PR, please:
1. Run `npm run lint` to ensure code style
2. Run `bash test/run_tests.sh fast` to verify nothing is broken
3. Update documentation if behavior changes

## 📋 Known Limitations

- **Bash keywords** — `do something` or `if something` triggers a bash syntax error instead of the AI agent. Rephrase as `please do something`.
- **CNF returns 0** — `$?` after an agent run is always 0, not 127.
- **Reverse context** — When switching to pi TUI, shell context history is not transferred (only the agent session carries over).
- **bash 4.4+ required** — macOS ships bash 3.2; install a newer version via `brew install bash`.

## 📄 License

[MIT](LICENSE) © [dacapoday](https://github.com/dacapoday)

---

<div align="center">

**[⬆ Back to top](#pish)**

</div>
