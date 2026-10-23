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

/** Animations: follow the OS's "reduce motion" setting, or force them on or off. Stored per computer. */
export type MotionChoice = 'system' | 'on' | 'off'
const MOTION_KEY = 'hangar-motion'

export function getMotion(): MotionChoice {
  try {
    const v = localStorage.getItem(MOTION_KEY)
    return v === 'on' || v === 'off' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyMotion(choice: MotionChoice = getMotion()): void {
  if (choice === 'system') delete document.documentElement.dataset.motion
  else document.documentElement.dataset.motion = choice
}

export function setMotion(choice: MotionChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(MOTION_KEY)
    else localStorage.setItem(MOTION_KEY, choice)
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
  applyMotion(choice)
}
