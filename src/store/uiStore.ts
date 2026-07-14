import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error' | 'info';
}

interface UiState {
  toasts: Toast[];
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

let toastCounter = 0;

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],

  toast(text, kind = 'success') {
    const id = ++toastCounter;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), 2600);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
