/** Appearance: follow the OS, or force light/dark. Stored per computer (a convenience, not app data). */
export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'hangar-theme'

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice = getTheme()): void {
  if (choice === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = choice
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
  applyTheme(choice)
}
