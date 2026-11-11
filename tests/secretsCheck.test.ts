import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mayRevealSecrets, shellCode } from '../src/main/permissions'

// The "may print your secrets" check looks for env-printing commands in what the shell runs, not in text written to
// files: sandboxed autonomous agents were held up by notes that said "height set by its content".

test('secrets check: words in heredocs and quoted text written to files don\'t count', () => {
  for (const c of [
    `cd "$PWD"; python3 - <<'EOF'\np='ui-vault/Screens/Settings.md'\ns=open(p).read()\ns=s.replace("a", "height set by its content (~450 px)")\nEOF`,
    `cd "$PWD" && python3 - <<'EOF'\nprint("Players export their loadout")\nEOF`,
    `cat > notes.md <<'EOF'\nThe env is set up and we export builds.\nEOF`,
    `git commit -m "set spawn rates and env lighting"`,
    `set -euo pipefail; rojo build -o x.rbxl`,
    `export PATH="$HOME/.rokit/bin:$PATH" && selene src`,
    `grep -rn "Secret door" src`,
    `echo 'secret room unlocked'`
  ]) {
    assert.equal(mayRevealSecrets(c), false, c)
  }
})

test('secrets check: ways to print the environment still ask', () => {
  for (const c of [
    'env',
    'printenv',
    'set',
    'export -p',
    'declare -x',
    'ls; env | grep CLAUDE',
    'echo "$(printenv)"',
    'echo `env`',
    "bash -c 'env'",
    "sh <<'EOF'\nenv\nEOF",
    "eval 'set'",
    'python3 - <<EOF\nimport os\nprint(os.environ)\nEOF',
    'python3 -c "import os; print(os.getenv(\'HOME\'))"',
    'node -p process.env',
    'perl -e \'print %ENV\'',
    'cat /proc/self/environ',
    'echo $ANTHROPIC_BASE_URL',
    'echo $CLAUDE_CODE_OAUTH_TOKEN',
    'Get-ChildItem env:',
    'echo $env:USERPROFILE'
  ]) {
    assert.equal(mayRevealSecrets(c), true, c)
  }
})

test('secrets check: heredoc bodies are dropped only up to their end marker', () => {
  assert.equal(shellCode("python3 - <<'EOF'\nset\nEOF\nenv"), "python3 - <<''\nenv")
  assert.equal(mayRevealSecrets("python3 - <<'EOF'\nx\nEOF\nprintenv"), true)
})
