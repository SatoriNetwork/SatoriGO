/**
 * @vitest-environment jsdom
 *
 * The switching screen (1.6.5): the outline of Home with the TARGET wallet in
 * its header, and never a figure that could be read as a balance.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { LiveSwitching } from './LiveSwitching';

afterEach(cleanup);

describe('LiveSwitching', () => {
  it('names the wallet being opened, with its short address, under the smoke testid', () => {
    render(
      <LiveSwitching
        target={{ id: 'w2', name: 'Trading', address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' }}
      />,
    );
    const frame = screen.getByTestId('live-syncing');
    expect(frame).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('live-switching-name')).toHaveTextContent('Trading');
    expect(frame).toHaveTextContent('0x9858…da94');
    expect(screen.getByRole('status')).toHaveTextContent('Switching to Trading');
  });

  it('draws no number at all: placeholders only, whoever the target is', () => {
    render(<LiveSwitching target={{ id: 'w2', name: 'Savings', address: 'EMc6LdHEXXXXXXXXXXXXXXXXXXXXX2D9Ew' }} />);
    const content = screen.getByTestId('live-syncing').querySelector('.app-content');
    expect(content?.textContent ?? '').not.toMatch(/\d/);
  });

  it('still renders, without a name, when the target is not in the list', () => {
    render(<LiveSwitching target={null} />);
    expect(screen.getByTestId('live-syncing')).toBeInTheDocument();
    expect(screen.queryByTestId('live-switching-name')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Switching wallet');
  });
});
