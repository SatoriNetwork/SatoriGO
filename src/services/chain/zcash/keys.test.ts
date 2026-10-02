// Derivation vectors for Zcash transparent keys (design §2.3). PUBLISHED rows
// come from Trust Wallet Core, zcash-test-vectors zip_0320.json and Trezor's
// device tests; COMPUTED rows were produced by the research prototype whose
// code the published rows prove. A wrong prefix, a dropped passphrase, a wrong
// change branch, testnet bytes or account/index handling each fail here.

import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hash160 } from '../keys';
import { encodeP2pkh, p2pkhScript } from './address';
import {
  ZCASH_COIN_TYPE,
  ZCASH_WATCH_EXTERNAL,
  ZCASH_WATCH_INTERNAL,
  cloneZcashKeys,
  zcashKeysFromBip39,
  zcashKeysFromSeed,
  zcashPath,
  zcashWatchAddresses,
  zeroZcashKeys,
} from './keys';
import zip320 from './testing/zip_0320.json';

const RIPPLE = 'ripple scissors kick mammal hire column oak again sun offer wealth tomorrow wagon turn fatal';
const ABANDON12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ABANDON24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const LEGAL =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
const ALL = 'all all all all all all all all all all all all';

const zip320Rows = (zip320 as unknown[]).slice(2) as [string, string, string, number, number][];

describe('zcash keys: constants', () => {
  it('uses coin type 133 and a 10 + 5 watch set', () => {
    expect(ZCASH_COIN_TYPE).toBe(133);
    expect(ZCASH_WATCH_EXTERNAL).toBe(10);
    expect(ZCASH_WATCH_INTERNAL).toBe(5);
    expect(zcashPath(0, 0)).toBe("m/44'/133'/0'/0/0");
    expect(zcashPath(1, 4)).toBe("m/44'/133'/0'/1/4");
    expect(zcashPath(0, 7, 'test')).toBe("m/44'/1'/0'/0/7");
  });
});

describe('zcash keys: PUBLISHED vectors', () => {
  it('Trust Wallet Core: ripple... with passphrase TREZOR, /0/5 and /0/3', async () => {
    const keys = await zcashKeysFromBip39(RIPPLE, 'TREZOR');
    expect(keys.watch[5].address).toBe('t1TWk2mmvESDnE4dmCfT7MQ97ij6ZqLpNVU');
    expect(keys.watch[3].address).toBe('t1cWhcXydPYTG1pgHMsZ6JEPsWGxVMdJ5t6');
    zeroZcashKeys(keys);
  });

  it('Trust Wallet Core: the account xpub and an xpub-derived address', () => {
    const account = HDKey.fromMasterSeed(mnemonicToSeedSync(RIPPLE, 'TREZOR')).derive("m/44'/133'/0'");
    expect(account.publicExtendedKey).toBe(
      'xpub6CksSgKBhD9KaLgxLE9LXpSj74b2EB9d1yKvhWxrstk4Md8gmiJb5GwkMeBhpLxVjACMdNbRsAm2GG5ehVuyq42QBYYPAjXjcBxMVmpaaNL',
    );
    const xpub2 = HDKey.fromExtendedKey(
      'xpub6C7HhMqpir3KBA6ammv5B58RT3XFTJqoZFoj3J56dz9XwehZ2puSH38ERtnz7HaXGxaZP8AHT4M2bSRHpBXUZrbsJ2xg3xs53DGKYCqj8mr',
    );
    expect(encodeP2pkh(hash160(xpub2.derive('m/0/0').publicKey!))).toBe('t1TKCtCETHPrAdA6eY1fdhhnTkTmb371oPt');
  });

  it('Trust Wallet Core: private key to address', () => {
    const rows: [string, string][] = [
      ['4646464646464646464646464646464646464646464646464646464646464646', 't1b9xfAk3kZp5Qk3rinDPq7zzLkJGHTChDS'],
      ['2d8f68944bdbfbc0769542fba8fc2d2a3de67393334471624364c7006da2aa54', 't1Wg9uPPAfwhBWeRjtDPa5ZHNzyBx9rJVKY'],
      ['be88df1d0bf30a923cb39c3bb953178baaf3726e8d3ce81e7c8462e046e0d835', 't1gaySCXCYtXE3ygP38YuWtVZczsEbdjG49'],
      ['987919d988ef94e678bce254c932e7a7a76744b2c008467448406d4246513132', 't1RygJmrLdNGgi98gUgEJDTVaELTAYWoMBy'],
    ];
    for (const [pk, addr] of rows) {
      expect(encodeP2pkh(hash160(secp256k1.getPublicKey(hexToBytes(pk), true)))).toBe(addr);
    }
  });

  it('zip_0320.json: all 15 t-addresses from seed 00..1f (accounts 0 to 4, indices 0 to 2)', () => {
    expect(zip320Rows).toHaveLength(15);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const root = HDKey.fromMasterSeed(seed);
    for (const [taddr, p2pkhHex, , account, index] of zip320Rows) {
      const node = root.derive(`m/44'/133'/${account}'/0/${index}`);
      const h = hash160(node.publicKey!);
      expect(bytesToHex(h)).toBe(p2pkhHex);
      expect(encodeP2pkh(h)).toBe(taddr);
    }
    // Account 0 through the module's own derivation.
    const keys = zcashKeysFromSeed(seed);
    const account0 = zip320Rows.filter((r) => r[3] === 0);
    expect(account0).toHaveLength(3);
    for (const [taddr, , , , index] of account0) expect(keys.watch[index].address).toBe(taddr);
    zeroZcashKeys(keys);
  });

  it('Trezor device tests: testnet addresses of the "all" phrase', async () => {
    const keys = await zcashKeysFromBip39(ALL, '', 'test');
    expect(keys.watch[0].address).toBe('tmQoJ3PTXgQLaRRZZYT6xk8XtjRbr2kCqwu');
    expect(keys.watch[7].address).toBe('tmAgYbANTzZp7YoMkRbbaemQETgV5GkBEjF');
    expect(keys.watch[8].address).toBe('tmCYEhUmZGpzyFrhUdKqwt64DrPqkFNChxx');
    expect(keys.watch[9].address).toBe('tmBMyeJebzkP5naji8XUKqLyL1NDwNkgJFt');
    zeroZcashKeys(keys);
  });
});

describe('zcash keys: COMPUTED vectors (design §2.3, vectors_computed.json)', () => {
  const rows: { m: string; pw: string; idx: number; pub: string; addr: string }[] = [
    { m: ABANDON12, pw: '', idx: 0, pub: '03db98d8f87716269ed31879aef19bdadbc869a9ea67729e36332d023b916cbcc9', addr: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F' },
    { m: ABANDON12, pw: '', idx: 1, pub: '03a68f202ac4e530cdaf1ff3d508cd55c8866049234f9f1b325338ddeb47d78f9c', addr: 't1aQ2b1XszNVo15BguYLbQGqETBL9QZA8Jq' },
    { m: ABANDON12, pw: '', idx: 10, pub: '02779a08b7952e5a18522028afd0f7dde8e98955c4daa6ef47eb2d33441606590d', addr: 't1YF8h4qviS77p36wWdUfe8faw4DXduYZnm' },
    { m: ABANDON24, pw: '', idx: 0, pub: '02210c61f823441f608327080bbbe75a1bcb197279016a0567deb51e348d415378', addr: 't1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F' },
    { m: ABANDON24, pw: '', idx: 1, pub: '0254acb3741a23bae1ad025bec6a6357953117453cf0d97e406f67d9231de77ba7', addr: 't1QArW6GKrvHngPMPn9cjAk2A9rjKenbhmc' },
    { m: ABANDON24, pw: '', idx: 10, pub: '03cc8c8ada2a95efc073b2383b0fd1b4d47e9213dc88129a7573e7dd774a586fe4', addr: 't1eFjJFc6eRbhVLeDwsAkjTQoUid6LHi631' },
    { m: LEGAL, pw: '', idx: 0, pub: '030827e9afaed8b851b6ab1ce1f69ea9894296a0d73a1420353b54b859e68f4a9a', addr: 't1NuJmpM1AyuFDjBa7veRdhYNZGSZuzNkXG' },
    { m: LEGAL, pw: '', idx: 1, pub: '02219bda24bc6c7530a72cee2b430e30ce170a4867bc3729af70f8d21b09876f54', addr: 't1aqTLMD2dqnwkKaPh11Y4v5JYVxrKm97Cf' },
    { m: LEGAL, pw: '', idx: 10, pub: '03220620b487b3ec75df7711574f2832a947ca2e9365c3c5b72d226d00042111c7', addr: 't1co1ZjKqwV9rKPkQmC2Pdb3UwFMoZuxhpA' },
    { m: ABANDON12, pw: 'TREZOR', idx: 0, pub: '025438214b684cd8b1b35b2d9435ee7d21de43694237e9f87cf90872ca2e2f3012', addr: 't1eB9Q9aDobjEnazefA9hdGyx3ku7dHshw5' },
    { m: ABANDON12, pw: 'TREZOR', idx: 1, pub: '02a6b4278553214bd7d16550e4a2f0fdde45bd44ec7e9b8b9a343de801384a093f', addr: 't1LHSHqJjDVC3BH9rPHs12C2TteJAWaXioE' },
    { m: ABANDON12, pw: 'TREZOR', idx: 10, pub: '03eea578876acac25d18151ef54b02738cd7ec9988f245c2f3d0a44b5dcb526c32', addr: 't1NVvfStBq6Dqci3DCjEhxtKBCpB65CK6Us' },
  ];
  it.each(rows)('$addr (watch[$idx], passphrase "$pw")', async ({ m, pw, idx, pub, addr }) => {
    const keys = await zcashKeysFromBip39(m, pw);
    const k = keys.watch[idx];
    expect(bytesToHex(k.publicKey)).toBe(pub);
    expect(k.address).toBe(addr);
    expect(k.change).toBe(idx < 10 ? 0 : 1);
    expect(k.index).toBe(idx < 10 ? idx : idx - 10);
    expect(bytesToHex(k.script)).toBe(bytesToHex(p2pkhScript(hash160(k.publicKey))));
    expect(bytesToHex(secp256k1.getPublicKey(k.privateKey, true))).toBe(pub);
    zeroZcashKeys(keys);
  });
});

describe('zcash keys: the watch set and key hygiene', () => {
  it('watches /0/0..9 then /1/0..4, primary first (abandon phrase)', async () => {
    const keys = await zcashKeysFromBip39(ABANDON12);
    const addrs = zcashWatchAddresses(keys);
    expect(addrs).toHaveLength(15);
    expect(new Set(addrs).size).toBe(15);
    expect(addrs[0]).toBe('t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F');
    expect(addrs[10]).toBe('t1YF8h4qviS77p36wWdUfe8faw4DXduYZnm');
    expect(keys.primary).toBe(keys.watch[0]);
    expect(keys.watch.map((k) => `${k.change}/${k.index}`)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `0/${i}`),
      ...Array.from({ length: 5 }, (_, i) => `1/${i}`),
    ]);
    for (const a of addrs) expect(a.startsWith('t1')).toBe(true);
    zeroZcashKeys(keys);
  });

  it('passes the passphrase through (a different passphrase is a different wallet)', async () => {
    const a = await zcashKeysFromBip39(ABANDON12, '');
    const b = await zcashKeysFromBip39(ABANDON12, 'TREZOR');
    expect(a.primary.address).not.toBe(b.primary.address);
    zeroZcashKeys(a);
    zeroZcashKeys(b);
  });

  it('seed and phrase entry points agree', async () => {
    const seed = mnemonicToSeedSync(LEGAL, '');
    const fromSeed = zcashKeysFromSeed(seed);
    const fromPhrase = await zcashKeysFromBip39(LEGAL);
    expect(zcashWatchAddresses(fromSeed)).toEqual(zcashWatchAddresses(fromPhrase));
    // The caller's seed is not modified.
    expect(bytesToHex(seed)).toBe(bytesToHex(mnemonicToSeedSync(LEGAL, '')));
    zeroZcashKeys(fromSeed);
    zeroZcashKeys(fromPhrase);
  });

  it('zeroZcashKeys fills every private key with 0, and clones are independent', async () => {
    const keys = await zcashKeysFromBip39(LEGAL);
    const copy = cloneZcashKeys(keys);
    expect(copy.primary).toBe(copy.watch[0]);
    zeroZcashKeys(keys);
    for (const k of keys.watch) expect(k.privateKey.every((b) => b === 0)).toBe(true);
    for (const k of copy.watch) expect(k.privateKey.some((b) => b !== 0)).toBe(true);
    zeroZcashKeys(copy);
    for (const k of copy.watch) expect(k.privateKey.every((b) => b === 0)).toBe(true);
    // Idempotent.
    expect(() => zeroZcashKeys(copy)).not.toThrow();
  });

  it('private keys are independent buffers (zeroing one leaves the others)', async () => {
    const keys = await zcashKeysFromBip39(LEGAL);
    keys.watch[1].privateKey.fill(0);
    expect(keys.watch[0].privateKey.some((b) => b !== 0)).toBe(true);
    expect(keys.watch[2].privateKey.some((b) => b !== 0)).toBe(true);
    zeroZcashKeys(keys);
  });

  it('refuses an invalid phrase and a bad seed', async () => {
    await expect(zcashKeysFromBip39('abandon abandon abandon')).rejects.toThrow(/invalid recovery phrase/);
    expect(() => zcashKeysFromSeed(new Uint8Array(8))).toThrow(/seed/);
  });
});
