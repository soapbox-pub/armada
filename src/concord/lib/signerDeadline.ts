/**
 * How long a write holding the community's Control lock (`withControlWrite`) waits on
 * the signer. A bunker or Amber that never answers otherwise holds every role and
 * channel change in the community for its own timeout (minutes), with nothing on screen
 * saying why. A late approval signs a seal nobody publishes, which is harmless.
 */
export const LOCKED_SIGN_DEADLINE_MS = 60_000;

export class SignerTimeoutError extends Error {}

export function withSignerDeadline<T>(signing: Promise<T>, message: string, ms = LOCKED_SIGN_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SignerTimeoutError(message)), ms);
  });
  return Promise.race([signing, deadline]).finally(() => clearTimeout(timer));
}
