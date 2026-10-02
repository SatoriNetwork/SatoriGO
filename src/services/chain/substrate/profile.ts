// The runtime profile: what the hand-rolled extrinsic (extrinsic.ts) assumes
// about the chain, made explicit so it can be compared (design
// bittensor-engine.md §4.4).
//
// A runtime upgrade that reorders or adds a signed extension, moves Balances
// off its pallet index, widens Balance to u128 or switches to extrinsic v5
// would make the wallet sign garbage (BadProof, funds safe) or, if call
// indices were reused, sign a different call. So the wallet pins a profile
// (tao.ts) and, before every send, compares it with what the chain reports:
//
//   'same'            spec and tx versions equal: sign.
//   'version-only'    the versions moved but every layout field is equal:
//                     the gateway's digest of the live metadata says the
//                     wire format did not change, so sign with the live
//                     versions for this session.
//   'layout-changed'  anything else: refuse to send until a wallet release
//                     carries the new layout. Balance and receive keep working.
//
// Only EQUALITY is ever accepted, never a "compatible" mapping: the gateway
// cannot redirect a call index by serving a different digest.

export interface TaoRuntimeProfile {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  /** 0x hex, 32 bytes: the hash of block 0. */
  genesis: string;
  ss58: number;
  decimals: number;
  symbol: string;
  /** In rao (bigint; the gateway serves it as a decimal string). */
  existentialDeposit: bigint;
  /** The only extrinsic format this engine encodes. */
  extrinsicVersion: 4;
  /** Balance is u64 on subtensor; this engine encodes nothing else. */
  balanceBytes: 8;
  balances: { pallet: number; transfer_allow_death: number; transfer_keep_alive: number; transfer_all: number };
  /** Signed-extension identifiers in metadata order. */
  signedExtensions: readonly string[];
}

export type ProfileVerdict = 'same' | 'version-only' | 'layout-changed';

/** Thrown when a runtime digest from the gateway is not the JSON shape of §7.2. */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** The fields that define the wire layout: everything but the two version numbers. */
export function sameLayout(a: TaoRuntimeProfile, b: TaoRuntimeProfile): boolean {
  return (
    a.specName === b.specName &&
    a.genesis.toLowerCase() === b.genesis.toLowerCase() &&
    a.ss58 === b.ss58 &&
    a.decimals === b.decimals &&
    a.symbol === b.symbol &&
    a.existentialDeposit === b.existentialDeposit &&
    a.extrinsicVersion === b.extrinsicVersion &&
    a.balanceBytes === b.balanceBytes &&
    a.balances.pallet === b.balances.pallet &&
    a.balances.transfer_allow_death === b.balances.transfer_allow_death &&
    a.balances.transfer_keep_alive === b.balances.transfer_keep_alive &&
    a.balances.transfer_all === b.balances.transfer_all &&
    a.signedExtensions.length === b.signedExtensions.length &&
    a.signedExtensions.every((id, i) => id === b.signedExtensions[i])
  );
}

/**
 * Compares the pinned profile with a live one (the gateway digest, or the
 * pinned profile with the versions of state_getRuntimeVersion patched in).
 */
export function compareProfiles(pinned: TaoRuntimeProfile, live: TaoRuntimeProfile): ProfileVerdict {
  if (!sameLayout(pinned, live)) return 'layout-changed';
  if (pinned.specVersion === live.specVersion && pinned.transactionVersion === live.transactionVersion) return 'same';
  return 'version-only';
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ProfileError(`Runtime digest: ${what} is not a whole number.`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new ProfileError(`Runtime digest: ${what} is not text.`);
  return v;
}

/**
 * Parses the gateway's GET /tao/<set>/runtime JSON (design §7.2) into a
 * profile. Strict: every field must be present and of the right shape, the
 * extrinsic version must be 4 and balanceBytes 8 (any other value is a
 * layout this engine cannot encode, reported as ProfileError rather than
 * silently compared). Extra fields (node, finalizedHeight) are ignored.
 */
export function parseTaoRuntimeProfile(json: unknown): TaoRuntimeProfile {
  if (typeof json !== 'object' || json === null) throw new ProfileError('Runtime digest is not an object.');
  const o = json as Record<string, unknown>;
  const genesis = str(o.genesis, 'genesis');
  if (!/^0x[0-9a-fA-F]{64}$/.test(genesis)) throw new ProfileError('Runtime digest: genesis is not a 32-byte hash.');
  const edRaw = o.existentialDeposit;
  let existentialDeposit: bigint;
  if (typeof edRaw === 'string' && /^\d+$/.test(edRaw)) existentialDeposit = BigInt(edRaw);
  else if (typeof edRaw === 'number' && Number.isSafeInteger(edRaw) && edRaw >= 0) existentialDeposit = BigInt(edRaw);
  else throw new ProfileError('Runtime digest: existentialDeposit is not a whole number.');
  const extrinsicVersion = num(o.extrinsicVersion, 'extrinsicVersion');
  if (extrinsicVersion !== 4) throw new ProfileError(`Runtime digest: extrinsic version ${extrinsicVersion} is not supported.`);
  const balanceBytes = num(o.balanceBytes, 'balanceBytes');
  if (balanceBytes !== 8) throw new ProfileError(`Runtime digest: a ${balanceBytes * 8}-bit balance is not supported.`);
  const b = o.balances;
  if (typeof b !== 'object' || b === null) throw new ProfileError('Runtime digest: balances is missing.');
  const bo = b as Record<string, unknown>;
  const ext = o.signedExtensions;
  if (!Array.isArray(ext) || ext.length === 0 || !ext.every((e) => typeof e === 'string' && e.length > 0)) {
    throw new ProfileError('Runtime digest: signedExtensions is not a list of names.');
  }
  return {
    specName: str(o.specName, 'specName'),
    specVersion: num(o.specVersion, 'specVersion'),
    transactionVersion: num(o.transactionVersion, 'transactionVersion'),
    genesis: genesis.toLowerCase(),
    ss58: num(o.ss58, 'ss58'),
    decimals: num(o.decimals, 'decimals'),
    symbol: str(o.symbol, 'symbol'),
    existentialDeposit,
    extrinsicVersion: 4,
    balanceBytes: 8,
    balances: {
      pallet: num(bo.pallet, 'balances.pallet'),
      transfer_allow_death: num(bo.transfer_allow_death, 'balances.transfer_allow_death'),
      transfer_keep_alive: num(bo.transfer_keep_alive, 'balances.transfer_keep_alive'),
      transfer_all: num(bo.transfer_all, 'balances.transfer_all'),
    },
    signedExtensions: Object.freeze([...(ext as string[])]),
  };
}

/** The pinned profile with the live version numbers, for the 'version-only' path. */
export function withVersions(
  profile: TaoRuntimeProfile,
  versions: { specVersion: number; transactionVersion: number },
): TaoRuntimeProfile {
  return { ...profile, specVersion: versions.specVersion, transactionVersion: versions.transactionVersion };
}
