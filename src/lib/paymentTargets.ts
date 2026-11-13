/**
 * NIP-A3 payment targets (kind 10133 `payto` tags), restricted to a curated
 * allowlist ({@link PAYMENT_METHODS}) that validates, builds native URIs (over
 * RFC-8905 `payto:`), and renders. Bitcoin/Lightning override the derived
 * values but reuse their dedicated flows.
 *
 * @see https://github.com/ATXMJ/nips A3.md
 */
import type { NostrEvent } from '@nostrify/nostrify';

import { t } from '@/i18n';
import { validateBitcoinAddress } from '@/lib/bitcoinAddress';
import { parseBitcoinUri } from '@/lib/esploraApi';
import { isSilentPaymentAddress, validateSilentPaymentAddress } from '@/lib/silentPaymentsCore';

/** Replaceable kind for NIP-A3 payment targets. */
export const PAYMENT_TARGETS_KIND = 10133;

/** Curated NIP-A3 types (always lowercase; normalized on parse). */
export type PaymentTargetType =
  | 'bitcoin'
  | 'lightning'
  | 'monero'
  | 'ethereum'
  | 'nano'
  | 'cashme'
  | 'venmo'
  | 'revolut';

/** A parsed payment target — a single `payto` tag. */
export interface PaymentTarget {
  type: PaymentTargetType;
  authority: string;
}

/**
 * `bitcoin`/`lightning` are native (dedicated flows, no extra button);
 * `generic` renders a QR code, copyable address and native-URI button.
 */
export type PaymentMethodKind = 'bitcoin' | 'lightning' | 'generic';

/** Static metadata + behavior for a recognized payment type. */
export interface PaymentMethodDef {
  type: PaymentTargetType;
  label: string;
  short: string;
  /** Currency symbol from the NIP-A3 table. */
  symbol: string;
  /** Drives how the zap dialog renders the method. */
  kind: PaymentMethodKind;
  /** Whether `authority` is well-formed enough to store/render. */
  validate: (authority: string) => boolean;
  /** Preferred native URI for `generic` methods (`monero:<addr>`), else undefined. */
  uri: (authority: string) => string | undefined;
  placeholder: string;
}

/** Loose lightning-address / LNURL shape check. */
function isLightningAuthority(s: string): boolean {
  const v = s.trim();
  if (!v) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return true;
  if (/^lnurl1[02-9ac-hj-np-z]+$/i.test(v)) return true;
  return false;
}

/** Bitcoin authority: a mainnet on-chain address OR a BIP-352 silent payment code. */
function isBitcoinAuthority(s: string): boolean {
  const v = s.trim();
  if (!v) return false;
  if (isSilentPaymentAddress(v)) return validateSilentPaymentAddress(v);
  return validateBitcoinAddress(v);
}

/** Monero standard / integrated / subaddress: base58, 95/106 chars, starts 4/8. */
function isMoneroAuthority(s: string): boolean {
  const v = s.trim();
  return /^[48][0-9A-Za-z]{94,105}$/.test(v);
}

/** EVM hex address. */
function isEthereumAuthority(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

/** Nano address: `nano_` + 60 base32 chars. */
function isNanoAuthority(s: string): boolean {
  return /^(nano|xrb)_[13][13-9a-km-uw-z]{59}$/.test(s.trim());
}

/** Loose handle/username check for custodial apps (Cash App, Venmo, Revolut). */
function isHandle(s: string): boolean {
  const v = s.trim().replace(/^[$@]/, '');
  return /^[A-Za-z0-9_.-]{1,64}$/.test(v);
}

/** Recognized methods; order defines editor and zap-dialog order. */
export const PAYMENT_METHODS: Record<PaymentTargetType, PaymentMethodDef> = {
  bitcoin: {
    type: 'bitcoin',
    label: 'Bitcoin',
    short: 'BTC',
    symbol: '₿',
    kind: 'bitcoin',
    validate: isBitcoinAuthority,
    uri: () => undefined,
    placeholder: 'bc1… or sp1…',
  },
  lightning: {
    type: 'lightning',
    label: 'Lightning',
    short: 'LBTC',
    symbol: '⚡',
    kind: 'lightning',
    validate: isLightningAuthority,
    uri: () => undefined,
    placeholder: 'you@walletofsatoshi.com',
  },
  monero: {
    type: 'monero',
    label: 'Monero',
    short: 'XMR',
    symbol: 'ɱ',
    kind: 'generic',
    validate: isMoneroAuthority,
    uri: (a) => `monero:${a.trim()}`,
    get placeholder() {
      return t({ id: "paymentTargets.placeholder.monero", defaultMessage: "4… (Monero address)" });
    },
  },
  ethereum: {
    type: 'ethereum',
    label: 'Ethereum',
    short: 'ETH',
    symbol: 'Ξ',
    kind: 'generic',
    validate: isEthereumAuthority,
    uri: (a) => `ethereum:${a.trim()}`,
    get placeholder() {
      return t({ id: "paymentTargets.placeholder.ethereum", defaultMessage: "0x… (Ethereum address)" });
    },
  },
  nano: {
    type: 'nano',
    label: 'Nano',
    short: 'XNO',
    symbol: 'Ӿ',
    kind: 'generic',
    validate: isNanoAuthority,
    uri: (a) => `nano:${a.trim()}`,
    get placeholder() {
      return t({ id: "paymentTargets.placeholder.nano", defaultMessage: "nano_… (Nano address)" });
    },
  },
  cashme: {
    type: 'cashme',
    label: 'Cash App',
    short: 'Cash App',
    symbol: '$',
    kind: 'generic',
    validate: isHandle,
    // Cash App $cashtags resolve at cash.app/$handle — no native scheme.
    uri: (a) => `https://cash.app/$${a.trim().replace(/^\$/, '')}`,
    placeholder: '$cashtag',
  },
  venmo: {
    type: 'venmo',
    label: 'Venmo',
    short: 'Venmo',
    symbol: '$',
    kind: 'generic',
    validate: isHandle,
    uri: (a) => `https://venmo.com/u/${a.trim().replace(/^@/, '')}`,
    placeholder: '@username',
  },
  revolut: {
    type: 'revolut',
    label: 'Revolut',
    short: 'Revolut',
    symbol: '£',
    kind: 'generic',
    validate: isHandle,
    uri: (a) => `https://revolut.me/${a.trim().replace(/^@/, '')}`,
    placeholder: 'username',
  },
};

export const PAYMENT_METHOD_LIST: PaymentMethodDef[] = Object.values(PAYMENT_METHODS);

/** Narrow a raw type string to a recognized {@link PaymentTargetType}. */
export function isRecognizedPaymentType(type: string): type is PaymentTargetType {
  return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, type);
}

/**
 * Parse `["payto", type, authority, …]` tags: lowercase types, drop unrecognized
 * types and invalid authorities, keep the first per type. Returned in
 * {@link PAYMENT_METHOD_LIST} order.
 */
export function parsePaymentTargets(event: NostrEvent | null | undefined): PaymentTarget[] {
  if (!event || event.kind !== PAYMENT_TARGETS_KIND) return [];

  const byType = new Map<PaymentTargetType, PaymentTarget>();

  for (const tag of event.tags) {
    if (tag[0] !== 'payto') continue;
    const rawType = typeof tag[1] === 'string' ? tag[1].trim().toLowerCase() : '';
    const authority = typeof tag[2] === 'string' ? tag[2].trim() : '';
    if (!rawType || !authority) continue;
    if (!isRecognizedPaymentType(rawType)) continue;
    if (byType.has(rawType)) continue; // first one wins
    if (!PAYMENT_METHODS[rawType].validate(authority)) continue;
    byType.set(rawType, { type: rawType, authority });
  }

  return PAYMENT_METHOD_LIST.flatMap((m) => {
    const target = byType.get(m.type);
    return target ? [target] : [];
  });
}

/** Serialize to `payto` tags: valid entries only, one per type, registry order. */
export function paymentTargetsToTags(targets: PaymentTarget[]): string[][] {
  const byType = new Map<PaymentTargetType, string>();
  for (const t of targets) {
    if (!isRecognizedPaymentType(t.type)) continue;
    const authority = t.authority.trim();
    if (!authority) continue;
    if (!PAYMENT_METHODS[t.type].validate(authority)) continue;
    if (byType.has(t.type)) continue;
    byType.set(t.type, authority);
  }

  return PAYMENT_METHOD_LIST.flatMap((m) => {
    const authority = byType.get(m.type);
    return authority ? [['payto', m.type, authority]] : [];
  });
}

export function findBitcoinTarget(targets: PaymentTarget[]): PaymentTarget | undefined {
  return targets.find((t) => t.type === 'bitcoin');
}

export function findLightningTarget(targets: PaymentTarget[]): PaymentTarget | undefined {
  return targets.find((t) => t.type === 'lightning');
}

/** Whether a bitcoin authority is a BIP-352 silent-payment code (`sp1…`). */
export function isSilentPaymentLike(authority: string): boolean {
  return isSilentPaymentAddress(authority.trim());
}

/**
 * Whether `raw` is a `bitcoin:` (BIP-21) or `lightning:` URI naming a
 * well-formed address, the only shapes message content links. A `lightning:`
 * BOLT11 invoice is the invoice card's, not this.
 */
export function isPaymentUri(raw: string): boolean {
  const bip21 = parseBitcoinUri(raw);
  if (bip21) return bip21.address ? isBitcoinAuthority(bip21.address) : !!bip21.sp && isBitcoinAuthority(bip21.sp);
  const lightning = /^lightning:(.+)$/i.exec(raw);
  return !!lightning && isLightningAuthority(lightning[1]);
}
