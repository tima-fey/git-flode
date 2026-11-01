// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { FlodeTemplates } from '../flode-templates';

afterEach(() => document.body.replaceChildren());

it('previews templates without offering unsupported automation-run variables', async () => {
  const workshop = new FlodeTemplates();
  workshop.open = true;
  document.body.append(workshop);
  await workshop.updateComplete;
  expect(workshop.shadowRoot?.querySelector('ha-code-editor')).not.toBeNull();
  expect(workshop.shadowRoot?.querySelector('.sources')).toBeNull();
  expect(workshop.shadowRoot?.querySelector('.vars')).toBeNull();
  expect(workshop.shadowRoot?.textContent).not.toContain('Last run');
});
