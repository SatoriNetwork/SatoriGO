import type { ReactNode } from 'react';
import { Button } from './Button';

interface ModalProps {
  title: string;
  children?: ReactNode;
  onClose(): void;
  actions?: ReactNode;
  testId?: string;
}

export function Modal({ title, children, onClose, actions, testId }: ModalProps) {
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
  testId?: string;
}

export function ConfirmModal({
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  testId,
}: ConfirmModalProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      testId={testId}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description}
    </Modal>
  );
}
