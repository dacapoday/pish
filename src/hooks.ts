/**
 * Shell hook rcfile generation.
 *
 * Generates a temporary rcfile that sources the user's original rc
 * and appends pish hooks (OSC signals, FIFO, CNF handler, etc.).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HooksConfig {
  shell: 'bash' | 'zsh';
  fifoPath: string;
  tmpDir: string; // Shared tmp dir (created by main.ts)
}

export function generateRcfile(config: HooksConfig): string {
  // zsh needs ZDOTDIR/.zshrc; bash uses --rcfile.
  // zsh ZDOTDIR must be a separate dir to avoid conflicts with user .zshrc.
  // We create a subdirectory under tmpDir instead of a separate mkdtemp.
  let rcDir: string;
  let rcName: string;
  if (config.shell === 'zsh') {
    rcDir = path.join(config.tmpDir, 'zdotdir');
    fs.mkdirSync(rcDir);
    rcName = '.zshrc';
  } else {
    rcDir = config.tmpDir;
    rcName = 'rc.bash';
  }
  const rcPath = path.join(rcDir, rcName);

  let content: string;
  if (config.shell === 'bash') {
    content = generateBashRc(config);
  } else {
    content = generateZshRc(config);
  }

  fs.writeFileSync(rcPath, content, 'utf-8');
  return rcPath;
}

function generateBashRc(c: HooksConfig): string {
  return `
# === pish rcfile (bash) ===

# 1. Source user startup files — simulate login shell sourcing order
#    bash --rcfile is non-login: it skips /etc/profile and ~/.*profile.
#    We source them here so PATH and env from login files take effect.
#    Order: /etc/profile → first of ~/.bash_profile, ~/.bash_login, ~/.profile
#    Then always source ~/.bashrc (idempotent; may already be sourced by profile).
if [[ -z "\${PISH_NORC:-}" ]]; then
  [[ -f /etc/profile ]] && source /etc/profile
  if [[ -f ~/.bash_profile ]]; then
    source ~/.bash_profile
  elif [[ -f ~/.bash_login ]]; then
    source ~/.bash_login
  elif [[ -f ~/.profile ]]; then
    source ~/.profile
  fi
  [[ -f ~/.bashrc ]] && source ~/.bashrc
else
  PS1='PISH_READY\$ '
fi

# 2. Version check — requires bash 4.4+
if [[ "\${BASH_VERSINFO[0]}" -lt 4 || \\
      ( "\${BASH_VERSINFO[0]}" -eq 4 && "\${BASH_VERSINFO[1]}" -lt 4 ) ]]; then
  printf '\\033]9154;E;bash %s not supported (requires 4.4+)\\007' "$BASH_VERSION"
  return 0 2>/dev/null || exit 0
fi

# 3. Environment
export PISH_FIFO="${c.fifoPath}"

# 4. Debug
__pish_debug() {
  [[ -n "\${PISH_DEBUG:-}" ]] &&
    printf '[%s] HOOK %s\\n' "$(date +%H:%M:%S.%3N)" "$*" >> "$PISH_DEBUG"
}

# 5. D signal — precmd (non-blocking)
__pish_precmd() {
  local rc=$?
  __pish_debug "precmd rc=$rc"
  printf '\\033]9154;D;%d\\007' "$rc"
  return "$rc"
}
PROMPT_COMMAND="__pish_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"

# 6. C signal — truncation boundary (PS0)
PS0='$(printf "\\033]9154;C\\007")'

# 7. P signal — CNF agent entry
command_not_found_handle() {
  __pish_debug "CNF: $*"
  printf '\\033]9154;P;%s\\007' "$*"
  read -r _ <&"\${PISH_RFD}"
  return 0
}

# 8. R signal — reverse / pi command
pi() {
  if [[ $# -eq 0 ]]; then
    __pish_debug "reverse"
    printf '\\033]9154;R\\007'
    local sig
    read -r sig <&"\${PISH_RFD}"
    local session="\${sig#SESSION:}"
    if [[ -n "$session" ]]; then
      command pi --session "$session"
    else
      command pi
    fi
  else
    command pi "$@"
  fi
}

# 9. Control commands
/compact()  { local a; [[ $# -gt 0 ]] && a=" $*" || a=""; printf '\\033]9154;P;/compact%s\\007' "$a";  read -r _ <&"\${PISH_RFD}"; }
/model()    { local a; [[ $# -gt 0 ]] && a=" $*" || a=""; printf '\\033]9154;P;/model%s\\007' "$a";    read -r _ <&"\${PISH_RFD}"; }
/think()    { local a; [[ $# -gt 0 ]] && a=" $*" || a=""; printf '\\033]9154;P;/think%s\\007' "$a";    read -r _ <&"\${PISH_RFD}"; }

# 10. Open FIFO fd + send S signal
exec {PISH_RFD}<>"${c.fifoPath}"
export PISH_RFD
__pish_debug "shell ready, fd=\${PISH_RFD}"
printf '\\033]9154;S\\007'
`;
}

function generateZshRc(c: HooksConfig): string {
  return `
# === pish rcfile (zsh) ===

# 0. Restore ZDOTDIR (we temporarily set it to load this .zshrc)
[[ -n "\${__PISH_ORIG_ZDOTDIR+x}" ]] && ZDOTDIR="\$__PISH_ORIG_ZDOTDIR" || unset ZDOTDIR

# 1. Source user startup files — simulate login shell sourcing order
#    pish starts zsh -i (non-login) with ZDOTDIR override, which skips:
#    - ~/.zshenv (ZDOTDIR changed, zsh read $ZDOTDIR/.zshenv instead)
#    - /etc/zprofile, ~/.zprofile (login-only)
#    - /etc/zshrc (ZDOTDIR override)
#    On macOS this is critical: /etc/zprofile runs path_helper,
#    and ~/.zprofile often has Homebrew PATH setup.
if [[ -z "\${PISH_NORC:-}" ]]; then
  [[ -f ~/.zshenv ]]    && source ~/.zshenv
  [[ -f /etc/zprofile ]]     && source /etc/zprofile
  [[ -f /etc/zsh/zprofile ]] && source /etc/zsh/zprofile
  [[ -f ~/.zprofile ]]       && source ~/.zprofile
  [[ -f ~/.zshrc ]]          && source ~/.zshrc
else
  PS1='PISH_READY%% '
fi

# 2. Version check — requires zsh 5.0+
if [[ "\${ZSH_VERSION%%.*}" -lt 5 ]]; then
  printf '\\033]9154;E;zsh %s not supported (requires 5.0+)\\007' "$ZSH_VERSION"
  return 0
fi

# 3. Environment
export PISH_FIFO="${c.fifoPath}"

# 4. D signal — precmd (non-blocking)
__pish_precmd() {
  local rc=$?
  printf '\\033]9154;D;%d\\007' "$rc"
  return "$rc"
}
precmd_functions+=(__pish_precmd)

# 5. C signal — preexec
__pish_preexec() {
  printf '\\033]9154;C\\007'
}
preexec_functions+=(__pish_preexec)

# 6. P signal — CNF
command_not_found_handler() {
  printf '\\033]9154;P;%s\\007' "$*"
  read -r _ <&"\${PISH_RFD}"
  return 0
}

# 7. R signal — reverse / pi command
pi() {
  if [[ $# -eq 0 ]]; then
    printf '\\033]9154;R\\007'
    local sig
    read -r sig <&"\${PISH_RFD}"
    local session="\${sig#SESSION:}"
    if [[ -n "$session" ]]; then
      command pi --session "$session"
    else
      command pi
    fi
  else
    command pi "$@"
  fi
}

# 8. Control commands
/compact()  { local a; [[ $# -gt 0 ]] && a=" $*" || a=""; printf '\\033]9154;P;/compact%s\\007' "$a";  read -r _ <&"\${PISH_RFD}"; }
/model()    { local a; [[ $# -gt 0 ]] && a=" $*" || a=""; printf '\\033]9154;P;/model%s\\007' "$a";    read -r _ <&"\${PISH_RFD}"; }
/think()    { local a; [[ $# -gt 0 ]] && a=" $*" || a=""; printf '\\033]9154;P;/think%s\\007' "$a";    read -r _ <&"\${PISH_RFD}"; }

# 9. Open FIFO fd + send S signal
exec {PISH_RFD}<>"${c.fifoPath}"
export PISH_RFD
printf '\\033]9154;S\\007'
`;
}
