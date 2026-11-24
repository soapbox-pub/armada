import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StaffPill } from '@/components/StaffPill';
import { MemberRolesContext, type MemberRole, type MemberRolesValue, type StaffTier } from '@/contexts/MemberRolesContext';

function scope(tiers: Record<string, StaffTier>, roles: Record<string, MemberRole> = {}): MemberRolesValue {
  return { rolesOf: () => [], staffTierOf: (pk) => tiers[pk], staffRoleOf: (pk) => roles[pk] };
}

describe('StaffPill', () => {
  it('labels each staff tier', () => {
    const value = scope({ a: 'owner', b: 'admin', c: 'moderator' });
    render(
      <MemberRolesContext.Provider value={value}>
        <StaffPill pubkey="a" />
        <StaffPill pubkey="b" />
        <StaffPill pubkey="c" />
        <StaffPill pubkey="d" />
      </MemberRolesContext.Provider>,
    );
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Mod')).toBeInTheDocument();
    expect(screen.getAllByTitle(/^Community /)).toHaveLength(3);
  });

  it('names the Role behind a staff tier', () => {
    const value = scope({ a: 'owner', c: 'moderator' }, { c: { id: 'r', name: 'Code Contributor', color: 0 } });
    render(
      <MemberRolesContext.Provider value={value}>
        <StaffPill pubkey="a" />
        <StaffPill pubkey="c" />
      </MemberRolesContext.Provider>,
    );
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Code Contributor')).toBeInTheDocument();
    expect(screen.queryByText('Mod')).not.toBeInTheDocument();
    expect(screen.getByTitle('Code Contributor (Community moderator)')).toBeInTheDocument();
  });

  it('renders nothing outside a community scope', () => {
    const { container } = render(<StaffPill pubkey="a" />);
    expect(container).toBeEmptyDOMElement();
  });
});
