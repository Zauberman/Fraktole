import { Dialog } from './Dialog.js';

/** Help → Reviewer commands… — rendered through the shared dialog primitive. */
export function HelpDialog(props: { body: string; onClose: () => void }): React.JSX.Element {
  return (
    <Dialog title="reviewer commands" onClose={props.onClose} footer={
      <button type="button" className="btn btn-sm btn-primary" onClick={props.onClose}>
        close
      </button>
    }>
      <pre className="help-pre">{props.body}</pre>
    </Dialog>
  );
}
