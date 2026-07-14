// English dictionary — the canonical key set. The Polish dictionary is typed
// against this one, so a missing translation is a compile-time error.
//
// The UI is almost entirely English-in-place; only the few strings that are
// still selected dynamically by key go through this table: the network status
// pill (StatusPill) and the accent-color labels (AccentSwatches), plus the
// clipboard copy toasts (CopyButton).

export const en = {
  'network.connected': 'Connected',
  'network.connecting': 'Connecting',
  'network.offline': 'Offline',
  'network.degraded': 'Degraded',

  'accent.satori': 'Satori',
  'accent.azure': 'Azure',
  'accent.violet': 'Violet',
  'accent.cyan': 'Cyan',
  'accent.emerald': 'Emerald',
  'accent.amber': 'Amber',
  'accent.rose': 'Rose',

  'toast.copied': 'Copied to clipboard',
  'toast.copiedSecret': 'Copied to clipboard. It auto-clears in ~30 s. Clipboard history/sync may still capture it.',
  'toast.copyFailed': 'Copy failed',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
