import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../services/clipboard';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useT } from '../i18n/useT';

interface CopyButtonProps {
  value: string;
  label: string;
  size?: number;
  testId?: string;
  /** Mark this copy as secret material (recovery phrase / private key). Forces
   *  an auto-clear within SECRET_CLIPBOARD_CLEAR_SECONDS and shows a stronger
   *  warning toast, regardless of the user's clipboard-clear setting. */
  secret?: boolean;
}

export function CopyButton({ value, label, size = 14, testId, secret }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const clearAfter = useSettingsStore((s) => s.settings.clipboardClearSeconds);
  const toast = useUiStore((s) => s.toast);
  const t = useT();

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const ok = await copyText(value, clearAfter, { secret });
    if (ok) {
      setCopied(true);
      toast(t(secret ? 'toast.copiedSecret' : 'toast.copied'));
      setTimeout(() => setCopied(false), 1600);
    } else {
      toast(t('toast.copyFailed'), 'error');
    }
  };

  return (
    <button
      type="button"
      className="icon-btn"
      style={{ width: size + 12, height: size + 12 }}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={handleCopy}
    >
      {copied ? <Check size={size} className="text-success" /> : <Copy size={size} />}
    </button>
  );
}
