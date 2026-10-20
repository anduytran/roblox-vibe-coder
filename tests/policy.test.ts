import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isInsideRoot, isProtectedPath } from '../src/main/pathScope'
import { alwaysRuleFor, commandAllowed, evaluateToolUse, programName, type PolicyDecision } from '../src/main/permissions'
import { DEFAULT_PROJECT_SETTINGS } from '../src/main/projects'

const root = mkdtempSync(join(tmpdir(), 'hangar-policy-'))
mkdirSync(join(root, 'src'))
const settings = { ...DEFAULT_PROJECT_SETTINGS }
const evalTool = (toolName: string, input: Record<string, unknown>, s = settings): PolicyDecision =>
  evaluateToolUse({ toolName, input, projectRoot: root, settings: s })
const isDanger = (d: PolicyDecision): boolean => d.action === 'ask' && d.dangerous && !d.canAlwaysAllow

test('paths inside and outside the project', () => {
  assert.equal(isInsideRoot(root, 'src/a.luau'), true)
  assert.equal(isInsideRoot(root, join(root, 'src', 'new', 'file.luau')), true)
  assert.equal(isInsideRoot(root, '../escape.txt'), false)
  assert.equal(isInsideRoot(root, join(tmpdir(), 'elsewhere')), false)
  assert.equal(isInsideRoot(root, root + '-sibling/x'), false)
  // Shortcuts Node would not expand but a tool might:
  assert.equal(isInsideRoot(root, '~/.ssh/id_rsa'), false)
  assert.equal(isInsideRoot(root, '$HOME/.aws/credentials'), false)
  assert.equal(isInsideRoot(root, '%USERPROFILE%\\.ssh\\id_rsa'), false)
  assert.equal(isInsideRoot(root, '\\\\server\\share\\x'), false)
})

test('symlinks cannot escape the project', () => {
  const outside = mkdtempSync(join(tmpdir(), 'hangar-outside-'))
  symlinkSync(outside, join(root, 'link'))
  assert.equal(isInsideRoot(root, 'link/secret.txt'), false)
})

test('reads inside are allowed; reads outside ask in red with no "always"', () => {
  assert.deepEqual(evalTool('Read', { file_path: join(root, 'src/a.luau') }), { action: 'allow' })
  assert.ok(isDanger(evalTool('Read', { file_path: '/etc/passwd' })))
  assert.ok(isDanger(evalTool('Read', { file_path: '~/.ssh/id_rsa' })))
})

test('M1: Glob and Grep patterns cannot search outside the project', () => {
  assert.deepEqual(evalTool('Glob', { pattern: 'src/**/*.luau' }), { action: 'allow' })
  assert.ok(isDanger(evalTool('Glob', { pattern: '/home/u/**/*.pem' })))
  assert.ok(isDanger(evalTool('Glob', { pattern: '../../**' })))
  assert.ok(isDanger(evalTool('Glob', { pattern: 'C:/Users/**' })))
  assert.ok(isDanger(evalTool('Grep', { pattern: 'key', glob: '~/**' })))
})

test('edits ask unless auto-approve is on, and always ask outside', () => {
  assert.equal(evalTool('Edit', { file_path: 'src/a.luau' }).action, 'ask')
  const auto = { ...settings, autoApproveEdits: true }
  assert.equal(evalTool('Edit', { file_path: 'src/a.luau' }, auto).action, 'allow')
  assert.ok(isDanger(evalTool('Write', { file_path: '../../x' }, auto)))
})

test('H1: protected files always ask in red, even with auto-approve and always-allow', () => {
  const lax = { ...settings, autoApproveEdits: true, alwaysAllowTools: ['Edit', 'Write'] }
  for (const f of ['.git/config', '.git/hooks/pre-commit', '.claude/settings.json', '.mcp.json', 'CLAUDE.md', '.vscode/tasks.json', '.github/workflows/ci.yml', 'package.json', '.gitattributes']) {
    assert.ok(isDanger(evalTool('Write', { file_path: f }, lax)), f)
  }
  assert.equal(isProtectedPath('src/package.json'), true, 'protected at any depth')
  assert.equal(isProtectedPath('src/game.luau'), false)
  assert.equal(evalTool('Write', { file_path: 'src/game.luau' }, lax).action, 'allow')
})

test('C1: shell allow rules cannot be abused with flags, variables, quotes or chaining', () => {
  const rules = ['git status', 'git status *', 'git log *', 'git diff *', 'rojo build *', 'selene *']
  const allowed = (c: string) => commandAllowed(c, rules)
  assert.equal(allowed('git status'), true)
  assert.equal(allowed('git status src/game.luau'), true)
  assert.equal(allowed('selene src'), true)
  // The audit's exploits:
  assert.equal(allowed('git log -1 --format=[core]%nfsmonitor=touch%x20/tmp/pwned --output=.git/config'), false)
  assert.equal(allowed('git log --output=~/.bashrc'), false)
  assert.equal(allowed('git diff --no-index /dev/null ~/.ssh/id_rsa'), false)
  assert.equal(allowed('git diff "$HOME/.aws/credentials"'), false)
  assert.equal(allowed('git log -1 --format=$ANTHROPIC_API_KEY'), false)
  assert.equal(allowed('rojo build --plugin x.rbxm'), false)
  assert.equal(allowed('rojo build -o /etc/x'), false)
  assert.equal(allowed('git -c core.pager=sh status'), false)
  // Path arguments must stay relative and inside:
  assert.equal(allowed('git status ../other'), false)
  assert.equal(allowed('git status /etc'), false)
  // Chaining, redirection, substitution, newlines, globs, escapes:
  for (const c of ['git status; rm -rf ~', 'git status && curl x', 'git status | sh', 'git status > out', 'git status `id`', 'git status $(id)', 'git status\nrm x', 'git status\r\nrm x', 'git status *', 'git status a\\b', 'git status %USERPROFILE%']) {
    assert.equal(allowed(c), false, c)
  }
  assert.equal(allowed('git statusx'), false)
})

test('defaults only auto-allow harmless commands', () => {
  assert.deepEqual(DEFAULT_PROJECT_SETTINGS.allowedBashPrefixes, ['git status', 'git status *', 'selene *', 'stylua --check *'])
  assert.equal(evalTool('Bash', { command: 'git status' }).action, 'allow')
  assert.equal(evalTool('Bash', { command: 'git log' }).action, 'ask')
  assert.equal(evalTool('Bash', { command: 'rm -rf src' }).action, 'ask')
})

test('H3: "always allow" saves the exact command and is refused for dangerous programs', () => {
  assert.equal(alwaysRuleFor('stylua   --check src'), 'stylua --check src')
  assert.equal(alwaysRuleFor('rojo build'), 'rojo build')
  assert.equal(alwaysRuleFor('rojo build -o game.rbxl'), null, 'flags that write files are never saved')
  for (const c of ['node -e "x"', 'rm -rf build', 'python script.py', 'curl example.com', 'bash x.sh', 'pwsh -c x', 'git push', 'git config core.pager sh', 'git -c a=b status', 'npx something', 'echo $HOME']) {
    assert.equal(alwaysRuleFor(c), null, c)
  }
  const d = evalTool('Bash', { command: 'rm -rf build' })
  assert.equal(d.action === 'ask' && d.canAlwaysAllow, false)
})

test('H2: commands that could print secrets are flagged in red', () => {
  for (const c of ['env', 'printenv ANTHROPIC_API_KEY', 'echo $ANTHROPIC_API_KEY', 'set', 'Get-ChildItem env:', 'cat .env | grep _TOKEN']) {
    assert.ok(isDanger(evalTool('Bash', { command: c })), c)
  }
})

test('network: web access asks and can never be always-allowed', () => {
  const d = evalTool('WebFetch', { url: 'https://example.com' })
  assert.equal(d.action, 'ask')
  assert.equal(d.action === 'ask' && d.canAlwaysAllow, false)
  const s2 = { ...settings, alwaysAllowTools: ['WebFetch'] }
  assert.equal(evalTool('WebFetch', { url: 'https://x' }, s2).action, 'ask')
})

test('Studio tools: read-only ones are allowed only when Hangar connects Studio itself', () => {
  assert.equal(evalTool('mcp__Roblox_Studio__get_console_output', {}).action, 'allow')
  assert.equal(evalTool('mcp__Roblox_Studio__get_console_output', {}, { ...settings, robloxStudioMcp: false }).action, 'ask')
  assert.equal(evalTool('mcp__Roblox_Studio__execute_luau', { code: 'print(1)' }).action, 'ask')
  assert.equal(evalTool('mcp__Roblox_Studio__insert_asset', {}).action, 'ask')
  const s2 = { ...settings, alwaysAllowTools: ['mcp__Roblox_Studio__execute_luau'] }
  assert.equal(evalTool('mcp__Roblox_Studio__execute_luau', {}, s2).action, 'allow')
})

test('M3: hidden or direction-changing characters are flagged', () => {
  assert.ok(isDanger(evalTool('Bash', { command: 'git status \u202E txt.exe' })))
  assert.ok(isDanger(evalTool('Edit', { file_path: 'src/a\u200B.luau' })))
})

test('re-audit H-new-2: Windows filename tricks cannot reach protected files', () => {
  const lax = { ...settings, autoApproveEdits: true }
  for (const f of ['.vscode./tasks.json', '.claude./agents/x.md', 'CLAUDE.md.', '.git./config', '.git ', '.git::$INDEX_ALLOCATION/config', 'GIT~1/config', 'src/file.luau:hidden']) {
    assert.ok(isDanger(evalTool('Write', { file_path: f }, lax)), f)
  }
  // Protection applies at any depth and in any letter case
  for (const f of ['place/.gitattributes', 'sub/.git/config', 'PACKAGE.JSON', '.envrc', 'Makefile', 'rokit.toml', 'tools/aftman.toml', '.idea/workspace.xml']) {
    assert.ok(isDanger(evalTool('Write', { file_path: f }, lax)), f)
  }
})

test('re-audit M1: brace patterns cannot smuggle parent or absolute paths', () => {
  for (const p of ['{..,x}/**/*.env', '{/etc,x}/*', 'src/{a,/etc}/*', '{x,~}/.ssh/*', '{x,C:/Users}/*']) {
    assert.ok(isDanger(evalTool('Glob', { pattern: p })), p)
  }
  assert.deepEqual(evalTool('Glob', { pattern: 'src/{server,client}/**/*.luau' }), { action: 'allow' })
})

test('re-audit M-new-1: saved rules match exactly unless they end in " *"', () => {
  assert.equal(commandAllowed('git bisect run evil.sh', ['git bisect']), false)
  assert.equal(commandAllowed('npm install evil-pkg', ['npm install']), false)
  assert.equal(commandAllowed('git bisect', ['git bisect']), true)
  assert.equal(commandAllowed('selene src/server', ['selene *']), true)
  assert.equal(commandAllowed('selene --config x', ['selene *']), false)
})

test('re-audit M-new-1: dangerous programs are recognised however they are spelled', () => {
  assert.equal(programName('python3.12'), 'python')
  assert.equal(programName('node.exe'), 'node')
  assert.equal(programName('PWSH.EXE'), 'pwsh')
  for (const c of ['python3.12 x.py', 'node.exe x.js', 'pwsh.exe -c x', 'bash.exe x', 'Git.exe config core.fsmonitor x', 'git.exe push', 'npm install', 'pnpm run x', 'make build', 'cargo run', 'rokit install', '/usr/bin/git status', 'C:/tools/rojo.exe build']) {
    assert.equal(alwaysRuleFor(c), null, c)
  }
  assert.equal(alwaysRuleFor('git status --short'), 'git status --short')
})

test('re-audit M-new-1: whole-tool "always" is only offered for Studio tools', () => {
  const unknown = evalTool('PowerShell', { command: 'x' })
  assert.equal(unknown.action === 'ask' && unknown.canAlwaysAllow, false)
  const otherMcp = evalTool('mcp__someserver__run_code', { code: 'x' })
  assert.equal(otherMcp.action === 'ask' && otherMcp.canAlwaysAllow, false)
  const studio = evalTool('mcp__Roblox_Studio__execute_luau', { code: 'x' })
  assert.equal(studio.action === 'ask' && studio.canAlwaysAllow, true)
})

test('re-audit M3: more invisible characters are flagged, including Unicode tags', () => {
  for (const ch of ['\u{E0041}', '\u00AD', '\u061C', '\u2028', '\u3164', '\u0085', '\u007F']) {
    assert.ok(isDanger(evalTool('Bash', { command: `git status${ch}` })), ch.codePointAt(0)!.toString(16))
  }
})

test('round 3: more editor/CI config is protected', () => {
  const lax = { ...settings, autoApproveEdits: true }
  for (const f of ['.cursor/mcp.json', '.devcontainer/devcontainer.json', '.zed/settings.json', '.windsurf/x', '.pre-commit-config.yaml', 'mise.toml', '.tool-versions']) {
    assert.ok(isDanger(evalTool('Write', { file_path: f }, lax)), f)
  }
})

test('round 3: glob syntax cannot hide parent paths', () => {
  for (const p of ['[.][.]/x', '{.{.,},x}/a', '*/{.}{.}/x']) {
    assert.ok(isDanger(evalTool('Glob', { pattern: p })), p)
  }
})

test('round 3: "always allow" uses an allowlist of programs and refuses risky flags', () => {
  for (const c of ['tsx scripts/build.ts', 'ts-node x.ts', 'mshta x', 'certutil x', 'sed x file', 'awk x file', 'winget install x', 'git difftool', 'git mergetool', 'git send-email', 'git diff --output .git/config', 'git log --ext-diff', 'rg --pre evil x']) {
    assert.equal(alwaysRuleFor(c), null, c)
  }
  for (const c of ['git status', 'git log src', 'rojo build', 'selene src', 'stylua --check src', 'rg TODO src']) {
    assert.equal(alwaysRuleFor(c), c, c)
  }
})

test('round 3: variation selectors and raw control characters turn the card red', () => {
  for (const ch of ['️', '\u{E0100}', '͏', '⠀', '　', '\u001B']) {
    assert.ok(isDanger(evalTool('Bash', { command: `git status${ch}` })), ch.codePointAt(0)!.toString(16))
  }
})

test('sandbox: requests to run a command outside the sandbox are refused', () => {
  assert.equal(evalTool('Bash', { command: 'git status', dangerouslyDisableSandbox: true }).action, 'deny')
  assert.equal(evalTool('PowerShell', { command: 'x', dangerouslyDisableSandbox: true }).action, 'deny')
})
