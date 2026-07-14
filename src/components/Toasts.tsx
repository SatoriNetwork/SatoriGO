import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { useUiStore } from '../store/uiStore';

const ICONS = {
  success: <CheckCircle2 size={16} className="text-success" />,
  error: <XCircle size={16} className="text-danger" />,
  info: <Info size={16} className="text-dim" />,
};

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} data-testid="toast">
          {ICONS[toast.kind]}
          {toast.text}
        </div>
      ))}
    </div>
  );
}
