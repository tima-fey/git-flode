/** Something with a `focus()` — an input, or HA's code editor's CodeMirror view. */
function canFocus(value: unknown): value is { focus: () => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'focus' in value &&
    typeof value.focus === 'function'
  );
}

function containsFocus(field: Element): boolean {
  const tree = field.getRootNode();
  return (
    ('activeElement' in tree && tree.activeElement === field) || field.matches(':focus-within')
  );
}

const FIELDS = 'ha-code-editor, input, textarea, ha-textarea, ha-textfield, ha-input';

/**
 * Puts the keyboard into a dialog's first field — call it when the dialog
 * opens. HA's dialog animates in and its code editor loads CodeMirror first,
 * so it tries again until the field has the focus (for up to ~2 s). Typing
 * then goes into the field instead of triggering HA's single-key shortcuts.
 * Cancel when the dialog closes; detached roots stop retrying automatically.
 */
export function focusFirstField(root: ParentNode & Node, tries = 20): () => void {
  const view = root.ownerDocument?.defaultView;
  let timer: number | undefined;
  let cancelled = false;

  function cancel(): void {
    cancelled = true;
    if (timer !== undefined) view?.clearTimeout(timer);
    timer = undefined;
  }

  function attempt(remaining: number): void {
    if (cancelled || !view || !root.isConnected) return;
    timer = view.setTimeout(() => {
      timer = undefined;
      if (cancelled || !root.isConnected) return;
      const field = root.querySelector(FIELDS);
      // HA's code editor exposes its CodeMirror view once it has loaded.
      const target =
        field?.localName === 'ha-code-editor' ? Reflect.get(field, 'codemirror') : field;
      if (canFocus(target)) target.focus();
      if ((!field || !containsFocus(field)) && remaining > 0) attempt(remaining - 1);
    }, 80);
  }

  attempt(tries);
  return cancel;
}
