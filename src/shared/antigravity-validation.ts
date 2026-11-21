/** Only offer account verification on Google's sign-in origin. */
export function isAntigravityVerificationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.origin === 'https://accounts.google.com' && !url.username && !url.password
  } catch {
    return false
  }
}
