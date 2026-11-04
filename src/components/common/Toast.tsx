import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

export interface ToastState {
  id?: number;
  message: string;
  type?: 'success' | 'error' | 'info';
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastProps {
  toast: ToastState | null;
  onClose: () => void;
}

export function Toast({ toast, onClose }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const duration = toast.duration || 3500;
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const isSuccess = toast.type === 'success' || !toast.type;
  const isError = toast.type === 'error';

  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl glass-panel bg-surface-elevated/95 border shadow-2xl animate-fade-in backdrop-blur-xl max-w-md">
      {isSuccess && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
      {isError && <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
      {toast.type === 'info' && <Info className="w-5 h-5 text-sky-400 shrink-0" />}

      <p className="text-xs sm:text-sm font-medium text-main flex-1">{toast.message}</p>

      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick();
            onClose();
          }}
          className="px-2.5 py-1 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-semibold transition-colors"
        >
          {toast.action.label}
        </button>
      )}

      <button
        onClick={onClose}
        className="p-1 rounded-lg text-muted hover:text-main hover:bg-white/10 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
