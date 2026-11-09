import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UltraPill } from './UltraPill';

import { SettingsOverlayContext } from '@/lib/settingsOverlay';

const login = vi.hoisted(() => ({ logins: [] as unknown[] }));
vi.mock('@nostrify/react/login', () => ({ useNostrLogin: () => login }));

// floating-ui constructs a ResizeObserver; the global stub is an arrow fn.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

describe('UltraPill', () => {
  it('renders nothing for a profile without Ultra', () => {
    const { container } = render(<UltraPill metadata={{ name: 'Ana' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the details popover on click', async () => {
    login.logins = [];
    render(<UltraPill force />);
    fireEvent.click(screen.getByRole('button', { name: /Ultra/ }));

    expect(await screen.findByText(/All the premium perks/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get Ultra' })).not.toBeInTheDocument();
  });

  it('links a logged-in viewer to the Ultra settings page', async () => {
    login.logins = [{ id: 'x' }];
    const show = vi.fn();
    render(
      <SettingsOverlayContext.Provider value={{ open: false, section: '', show, close: () => {} }}>
        <UltraPill force />
      </SettingsOverlayContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ultra/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Get Ultra' }));

    expect(show).toHaveBeenCalledWith('ultra');
  });

  it('is a plain label when not interactive', () => {
    render(<UltraPill force interactive={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTitle('Armada Ultra member')).toHaveTextContent('Ultra');
  });
});
