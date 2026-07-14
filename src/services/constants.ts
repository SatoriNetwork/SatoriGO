export const APP_VERSION = '1.0.0';

/** Minimum password length enforced everywhere a wallet password is set or
 *  changed (create / import / private-key import / change-password). Keep every
 *  call site referencing THIS constant so the flows can never diverge. */
export const MIN_PASSWORD_LENGTH = 8;

export const MAX_LOGO_BYTES = 512 * 1024;

export function getAppVersion(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      return chrome.runtime.getManifest().version;
    }
  } catch {
    // not running as an extension
  }
  return APP_VERSION;
}
