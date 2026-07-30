import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastMessage {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

interface ToastApi {
  show: (text: string, tone?: ToastMessage['tone']) => void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const show = useCallback<ToastApi['show']>((text, tone = 'info') => {
    const id = Date.now() + Math.random();
    setMessages((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => setMessages((prev) => prev.filter((m) => m.id !== id)), 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`toast toast--${m.tone}`}>
            {m.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
