// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import { useState } from 'react';
import { ChevronDown, IdCard, LogOut, Smile, UserIcon, UserPlus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.tsx';
import { getAvatarShape } from '@/lib/avatarShape';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';
import { useServerScope } from '@/contexts/ServerScopeContext';
import { ServerProfileDialog } from '@/components/dialogs/ServerProfileDialog';
import { StatusDialog } from '@/components/dialogs/StatusDialog';
import { clearRenderedPlaintext } from '@/hooks/dmRenderCache';
import { purgeClientStorage } from '@/lib/purgeClientStorage';
import { clearWalletStorage } from '@/lib/walletStorage';

interface AccountSwitcherProps {
  onAddAccountClick: () => void;
}

export function AccountSwitcher({ onAddAccountClick }: AccountSwitcherProps) {
  const { currentUser, otherUsers, isLoading, setLogin, removeLogin } = useLoggedInAccounts();
  const [isOpen, setIsOpen] = useState(false);
  // The server (relay) currently being viewed, if any. Drives the optional
  // "Server identity" item (per-server nickname/label/color).
  const serverScope = useServerScope();
  const [serverIdentityOpen, setServerIdentityOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  if (!currentUser) return null;

  const handleLogout = () => {
    // Close the dropdown first to avoid React error #300
    setIsOpen(false);
    // Is this the last logged-in identity? If so we do a full storage purge
    // and hard-redirect to the landing page so a fresh logout holds onto
    // nothing; otherwise we just drop this account and keep the others' caches.
    const isLastAccount = otherUsers.length === 0;
    // Use setTimeout to ensure the dropdown closes before removing login
    setTimeout(() => {
      removeLogin(currentUser.id);
      // The removed account's NWC wallet secrets must not outlive it (the
      // full purge below only runs on the final logout).
      clearWalletStorage(currentUser.pubkey);
      clearRenderedPlaintext();
      if (isLastAccount) {
        void purgeClientStorage().finally(() => window.location.assign('/welcome'));
      }
    }, 0);
  };

  const getDisplayName = (account: Account): string => {
    return account.metadata.name || account.metadata.display_name || 'Anonymous';
  }

  return (
    <>
    <DropdownMenu modal={false} open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button className='flex items-center gap-3 p-2 clip-corner-lg bg-accent/50 hover:bg-accent transition-all w-full text-foreground'>
          {isLoading ? (
            <Skeleton className='w-8 h-8 rounded-full shrink-0' />
          ) : (
            <Avatar shape={getAvatarShape(currentUser.metadata)} className='w-8 h-8'>
              <AvatarImage src={currentUser.metadata.picture} alt={getDisplayName(currentUser)} />
              <AvatarFallback>{getDisplayName(currentUser).charAt(0)}</AvatarFallback>
            </Avatar>
          )}
          <div className='flex-1 text-left block truncate min-w-0'>
            {isLoading ? (
              <Skeleton className='h-4 w-24' />
            ) : (
              <p className='font-medium text-sm truncate'>{getDisplayName(currentUser)}</p>
            )}
          </div>
          <ChevronDown className='w-4 h-4 text-muted-foreground' />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className='w-56 p-2 animate-scale-in'>
        <div className='font-medium text-sm px-2 py-1.5'>Switch Account</div>
        {otherUsers.map((user) => (
          <DropdownMenuItem
            key={user.id}
            onClick={() => setLogin(user.id)}
            className='flex items-center gap-2 cursor-pointer p-2 rounded-md'
          >
            <Avatar shape={getAvatarShape(user.metadata)} className='w-8 h-8'>
              <AvatarImage src={user.metadata.picture} alt={getDisplayName(user)} />
              <AvatarFallback>{getDisplayName(user)?.charAt(0) || <UserIcon />}</AvatarFallback>
            </Avatar>
            <div className='flex-1 truncate'>
              <p className='text-sm font-medium'>{getDisplayName(user)}</p>
            </div>
            {user.id === currentUser.id && <div className='w-2 h-2 rounded-full bg-primary'></div>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setStatusOpen(true)}
          className='flex items-center gap-2 cursor-pointer p-2 rounded-md'
        >
          <Smile className='w-4 h-4' />
          <span>Set status</span>
        </DropdownMenuItem>
        {serverScope && (
          <DropdownMenuItem
            onClick={() => setServerIdentityOpen(true)}
            className='flex items-center gap-2 cursor-pointer p-2 rounded-md'
          >
            <IdCard className='w-4 h-4' />
            <span>Server identity</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={onAddAccountClick}
          className='flex items-center gap-2 cursor-pointer p-2 rounded-md'
        >
          <UserPlus className='w-4 h-4' />
          <span>Add another account</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleLogout}
          className='flex items-center gap-2 cursor-pointer p-2 rounded-md text-red-500'
        >
          <LogOut className='w-4 h-4' />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {serverScope && (
      <ServerProfileDialog
        relayUrl={serverScope}
        open={serverIdentityOpen}
        onOpenChange={setServerIdentityOpen}
      />
    )}
    <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} />
    </>
  );
}