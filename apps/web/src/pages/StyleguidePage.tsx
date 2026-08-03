import { useState } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { Button } from '../components/Button.js';
import { StatusBadge } from '../components/Badge.js';
import { Note } from '../components/Note.js';
import { InfoNotice } from '../components/InfoNotice.js';
import { ErrorText } from '../components/ErrorText.js';
import { Field } from '../components/Field.js';
import { CopyButton } from '../components/CopyButton.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { DropdownMenu } from '../components/DropdownMenu.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { SkeletonRows } from '../components/SkeletonRows.js';
import { useToast } from '../components/Toast.js';

/**
 * Living documentation for the apps/web design system. Every shared primitive is rendered here in
 * its variants and states — it doubles as the visual reference and a smoke-test surface. Add a
 * section whenever you add a primitive.
 */
export function StyleguidePage() {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="page styleguide">
      <PageHeader title="Styleguide" />
      <Note>
        These are the shared components in <code>apps/web/src/components/</code>. Compose new UI from
        them (and the tokens in <code>design/tokens.css</code>) rather than hand-rolling styles.
      </Note>

      <section>
        <h2>Buttons</h2>
        <div className="styleguide__row">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </section>

      <section>
        <h2>Status badges</h2>
        <div className="styleguide__row">
          <StatusBadge label="Queued" tone="neutral" icon="•" />
          <StatusBadge label="Planning" tone="progress" icon="◐" />
          <StatusBadge label="Running" tone="progress" icon="▶" />
          <StatusBadge label="Waiting for input" tone="attention" icon="⏳" />
          <StatusBadge label="Completed" tone="success" icon="✓" />
          <StatusBadge label="Failed" tone="danger" icon="✕" />
        </div>
      </section>

      <section>
        <h2>Notices</h2>
        <Note>A plain always-present explainer (Note).</Note>
        <InfoNotice learnMoreHref="https://example.com">
          A compact dismissible banner with an icon and a learn-more link (InfoNotice).
        </InfoNotice>
        <ErrorText>An inline error, announced via role=alert (ErrorText).</ErrorText>
      </section>

      <section>
        <h2>Form field</h2>
        <Field label="Example field">
          {(id) => <input id={id} type="text" placeholder="labelled input" />}
        </Field>
      </section>

      <section>
        <h2>Inline controls</h2>
        <div className="styleguide__row">
          <span>
            Copy: <CopyButton value="copied-value" label="Copy example" />
          </span>
          <span>
            Relative time: <RelativeTime iso={new Date(Date.now() - 120000).toISOString()} />
          </span>
          <DropdownMenu
            label="Example actions"
            items={[
              { label: 'First action', onSelect: () => toast.show('First') },
              { label: 'Destructive', danger: true, onSelect: () => toast.show('Destructive', 'error') },
            ]}
          />
        </div>
      </section>

      <section>
        <h2>Overlays</h2>
        <div className="styleguide__row">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>
            Open modal
          </Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Open confirm
          </Button>
          <Button variant="secondary" onClick={() => toast.show('Hello from a toast', 'success')}>
            Fire toast
          </Button>
        </div>
        {modalOpen && (
          <Modal title="Example modal" onClose={() => setModalOpen(false)}>
            <p>Modals trap focus and restore it on close.</p>
            <div className="modal__actions">
              <Button variant="secondary" onClick={() => setModalOpen(false)}>
                Close
              </Button>
            </div>
          </Modal>
        )}
        {confirmOpen && (
          <ConfirmDialog
            title="Confirm example?"
            message="Destructive actions require a confirmation step."
            confirmLabel="Confirm"
            onConfirm={() => setConfirmOpen(false)}
            onCancel={() => setConfirmOpen(false)}
          />
        )}
      </section>

      <section>
        <h2>Loading skeleton</h2>
        <table className="task-table">
          <SkeletonRows rows={2} />
        </table>
      </section>
    </div>
  );
}
