// TEST ONLY. Fixtures for the Substrate engine (design bittensor-engine.md
// §2.3, §4, §12.1). Not imported by any shipped module.
//
// Provenance, so a reader knows which numbers are published and which were
// computed by the research stack (tao-research/proto_tao.mjs, xcheck.mjs,
// xcheck2.mjs; 45 of 45 checks against @polkadot/keyring 14.0.3 and
// @polkadot/types over the saved spec-470 metadata; substrate-interface 1.8.1
// agrees on every address):
//
//   KEY_VECTORS         the design's table verbatim, plus the two rows Set A
//                       had to compute (passphrase "TREZOR" pass-through, a
//                       24-word phrase with non-zero entropy), each equal to
//                       polkadot.js in the same run.
//   SPEC470_DIGEST      what GET /tao/main/runtime serves for spec 470,
//                       read from the live v14 metadata with decode_meta.mjs.
//   ONCHAIN_TRANSFER    a real transfer_keep_alive from Finney block 9,168,516
//                       (chain_getBlock on 2026-09-28), decoded by polkadot.js.
//   PJS_PAYLOADS        the reference builder's 145-byte transfers with the
//                       signing payload bytes polkadot.js's ExtrinsicPayload
//                       produced for the same fields (byte-identical), and
//                       the signature polkadot.js verified.
//   PROTO_SIGNED        proto_run.txt's transfer: the one the live node
//                       validated (Invalid(Payment) from an unfunded account,
//                       Invalid(BadProof) with one bit flipped).
//   ACCOUNT_INFO        state_getStorage blobs of System.Account, read live.

export const ABANDON_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const ABANDON_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
export const DEV_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
export const PJS_DOC_12 = 'seed sock milk update focus rotate barely fade car face mechanic mercy';
export const LEGAL_WINNER_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

export interface KeyVector {
  name: string;
  mnemonic: string;
  passphrase: string;
  /** hex, no 0x */
  miniSecret?: string;
  publicKey: string;
  ss58: string;
  source: string;
}

/** Root accounts (no path), SS58 prefix 42. */
export const KEY_VECTORS: readonly KeyVector[] = [
  {
    name: 'abandon-12',
    mnemonic: ABANDON_12,
    passphrase: '',
    miniSecret: '4ed8d4b17698ddeaa1f1559f152f87b5d472f725ca86d341bd0276f1b61197e2',
    publicKey: '66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972',
    ss58: '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH',
    source: 'computed; equal in @polkadot/keyring addFromUri and substrate-interface; live on Finney (35639 rao, nonce 7)',
  },
  {
    name: 'abandon-24',
    mnemonic: ABANDON_24,
    passphrase: '',
    publicKey: '66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972',
    ss58: '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH',
    source: 'computed; degenerate (all-zero entropy of both lengths collides), a regression check only',
  },
  {
    name: 'dev-phrase',
    mnemonic: DEV_PHRASE,
    passphrase: '',
    publicKey: '46ebddef8cd9bb167dc30878d7113b7e168e6f0646beffd77d69d39bad76b47a',
    ss58: '5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV',
    source: 'sp_core DEV_PHRASE root; computed, equal in polkadot.js; the key also appears in schnorrkel from_half_ed25519_bytes doc test',
  },
  {
    name: 'pjs-doc-12',
    mnemonic: PJS_DOC_12,
    passphrase: '',
    publicKey: '9c25e4a0d216aa8b1b2f4d3a2eb9dc85c16272438ab81fc73e20b7603ed22531',
    ss58: '5FbSap4BsWfjyRhCchoVdZHkDnmDm3NEgLZ25mesq4aw2WvX',
    source: 'polkadot.js docs example phrase; computed, equal in polkadot.js and substrate-interface',
  },
  {
    name: 'abandon-12-TREZOR',
    mnemonic: ABANDON_12,
    passphrase: 'TREZOR',
    miniSecret: 'b43c67f1b354a8c17e73d8b483f349f3a3549a4ee730ef08fbbd577d4decf064',
    publicKey: 'baa4036a6b212012c67b91fd47c2e3e64b65bbd538969544c71b2f905227374c',
    ss58: '5GHRV8fpuNjWCxfoRjCBc1BqY33ddAHs9DVdkhwccAjY71pN',
    source: 'computed by Set A (xcheck2.mjs); equal to polkadot.js mnemonicToMiniSecret(phrase, "TREZOR") and addFromUri(phrase + "///TREZOR"). Proves the salt pass-through',
  },
  {
    name: 'legal-winner-24',
    mnemonic: LEGAL_WINNER_24,
    passphrase: '',
    miniSecret: 'f02cdc109954e34cd3f0c60fdb0c97ffb3a934ad1cc9a4df87b8417024b8bdbe',
    publicKey: '5294e5a4859a235bed10b8a38cf5e832f1a2b560c36533a36200fc4cba1ad171',
    ss58: '5Dvz1qwrSmKZkD82LgS7mrsgJSQMExLp3eZHHwfm7MqKs3nd',
    source: 'computed by Set A (xcheck2.mjs); equal to polkadot.js. Non-zero 32-byte entropy: proves the 24-word path is not the 16-byte one padded',
  },
  {
    name: 'legal-winner-24-TREZOR',
    mnemonic: LEGAL_WINNER_24,
    passphrase: 'TREZOR',
    miniSecret: 'bbaf46f044dfca3560712240253ce26eabd7f4996bb241409697a292c673e3a7',
    publicKey: 'dc30aeb76d66f32c20fa33e5e8d8894d095e281be79dcce85385f0aae67e702c',
    ss58: '5H3QrTUbPZncGwkgUeTGXWerJnzRXJGbw1Rz3XYT4APTNT51',
    source: 'computed by Set A (xcheck2.mjs); equal to polkadot.js',
  },
];

/** Hard-derived children ("//junction"), SS58 42; computed, equal in polkadot.js and substrate-interface. */
export const HARD_CHILD_VECTORS: readonly { mnemonic: string; junction: string; publicKey?: string; ss58: string; source: string }[] = [
  {
    mnemonic: ABANDON_12,
    junction: '//0',
    publicKey: '5244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad1671',
    ss58: '5DvaFrBesD6jTWd3GEefcM72BSXaFRHqQuZtwBSZii1VMnuP',
    source: 'computed; equal in polkadot.js and substrate-interface create_from_uri(mnemonic + "//0")',
  },
  {
    mnemonic: ABANDON_12,
    junction: '//1',
    ss58: '5DJ8y4CAHnmjt4rdoZpR1wgXnQDnKDksskx7JTphZhMxthiG',
    source: 'computed; equal in polkadot.js (xcheck_run.txt)',
  },
  {
    mnemonic: DEV_PHRASE,
    junction: '//Alice',
    publicKey: 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',
    ss58: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    source: 'PUBLISHED: polkadot-sdk substrate/primitives/core/src/sr25519.rs derive_hard_known_pair_should_work',
  },
  {
    mnemonic: DEV_PHRASE,
    junction: '//0',
    publicKey: '2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972',
    ss58: '5D34dL5prEUaGNQtPPZ3yN5Y6BnkfXunKXXz6fo7ZJbLwRRH',
    source: 'computed; equal in polkadot.js and substrate-interface',
  },
  {
    mnemonic: PJS_DOC_12,
    junction: '//0',
    publicKey: 'e27ed800d359cd3b336d97b637056d05c499102870ae784d94a89164abb2d626',
    ss58: '5HBgMorR1xrFgoabcF898oBsY7YG9XPZtyQpDUrZUoaKJuEa',
    source: 'computed; equal in polkadot.js and substrate-interface',
  },
];

/** sp_core derive_soft_known_pair_should_work: DEV_PHRASE "/Alice" (public key only). PUBLISHED. */
export const SOFT_ALICE_PUBLIC_KEY = 'd6c71059dbbe9ad2b0ed3f289738b800836eb425544ce694825285b958ca755e';

/** sp_core sr_test_vector_should_work: a raw 32-byte mini secret and its public key. PUBLISHED. Proves the Ed25519 expansion mode. */
export const SP_CORE_MINI_SECRET = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const SP_CORE_PUBLIC_KEY = '44a996beb1eef7bdcab976ab6d2ca26104834164ecf28fb375600576fcc6eb0f';

/** sp_core seeded_pair_should_work: the ASCII seed "12345678901234567890123456789012". PUBLISHED. */
export const SP_CORE_SEEDED_PUBLIC_KEY = '741c08a06f41c596608f6774259bd9043304adfa5d3eea62760bd9be97634d63';

/**
 * The SEED route (HDKey/mnemonicToSeed style: PBKDF2 over the phrase TEXT,
 * first 32 bytes as the mini secret) gives THIS address for the abandon
 * phrase. It exists in no Substrate wallet; keys.test.ts asserts it is NOT
 * what the engine derives.
 */
export const ABANDON_12_SEED_ROUTE_SS58 = '5EqgEeg5SfVAMYLbxzv7kyXoCZsDYwscpjtgQ5gGnVVtZ5U2';

/** GET /tao/main/runtime for spec 470 (design §7.2), as JSON. */
export const SPEC470_DIGEST = {
  specName: 'node-subtensor',
  specVersion: 470,
  transactionVersion: 1,
  genesis: '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03',
  ss58: 42,
  decimals: 9,
  symbol: 'TAO',
  existentialDeposit: '500',
  extrinsicVersion: 4,
  balanceBytes: 8,
  balances: { pallet: 5, transfer_allow_death: 0, transfer_keep_alive: 3, transfer_all: 4 },
  signedExtensions: [
    'CheckNonZeroSender',
    'CheckSpecVersion',
    'CheckTxVersion',
    'CheckGenesis',
    'CheckMortality',
    'CheckNonce',
    'CheckWeight',
    'ChargeTransactionPayment',
    'SudoTransactionExtension',
    'CheckShieldedTxValidity',
    'SubtensorTransactionExtension',
    'DrandPriority',
    'CheckMetadataHash',
  ],
  node: 'https://entrypoint-finney.opentensor.ai',
  finalizedHeight: 9168527,
};

/**
 * A real Balances.transfer_keep_alive included in Finney block 9,168,516
 * (2026-09-28). 148 bytes with the length prefix (the nonce takes a 4-byte
 * compact and the era period is 1024). polkadot.js decoded it as below and
 * reported the hash; the hash is blake2b-256 of the full bytes.
 *
 * Its signer is an ED25519 coldkey (MultiSignature tag 0x00; btcli's opt-in
 * crypto type), which makes it the strongest fixture here: the signature
 * verifies with plain ed25519 over the payload rebuilt by this engine's
 * layout with the era checkpoint at block 9,168,512 (the only checkpoint
 * with phase 640 within 1024 blocks; 9,168,513..515 do not verify), which
 * pins spec 470 / tx 1 / genesis / mode byte / Option::None independently
 * of anything sr25519 or polkadot.js. verify_onchain.mjs in tao-research.
 */
export const ONCHAIN_TRANSFER = {
  blockNumber: 9168516,
  blockHash: '0x0648bc120c2cd5d818f442481dc500adfce8fdd57afc448181362623f129429f',
  signatureType: 'ed25519' as const,
  checkpointNumber: 9168512,
  checkpointHash: '0x16607230c1cda9eb3cdf260af117944514143ad894c36e8451e61184986c981c',
  payload:
    '0x05030016c05a97cf96fd5272e37f2a4fa74925254383aa87790bb97a85d54e60ad471de2f3c72c0928ba8602000000d6010000010000002f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c0316607230c1cda9eb3cdf260af117944514143ad894c36e8451e61184986c981c00',
  hex: '0x4902840051a9f3ebc7c5cd9c551769ccf1530dccb6b8e6565d3335662ae4ea42ee6e5e3b00f1bf77e89657a673c42be4ed73effb45ab6035ba87e705a1b96a742823cddf666cacbe445d4d5799b404e433fba38e8cd1130e9de0243c33cf5d3da16fe9f0040928ba860200000005030016c05a97cf96fd5272e37f2a4fa74925254383aa87790bb97a85d54e60ad471de2f3c72c',
  hash: '0xdcf03287e765fc7d573da61b6b44c0dba8ceb5109e30ed7de3e3d2a1850f4180',
  signer: '5DunDrFV6BPbzsgLZUtMQtCq7w9fcUEbM59BUwx5E7N9Bn5E',
  signerPublicKey: '51a9f3ebc7c5cd9c551769ccf1530dccb6b8e6565d3335662ae4ea42ee6e5e3b',
  dest: '5CaY3x3RLNJqWG2eWdEM3uaHJq8cs348SU2fdM9iF1MjbcHR',
  destPublicKey: '16c05a97cf96fd5272e37f2a4fa74925254383aa87790bb97a85d54e60ad471d',
  nonce: 41390,
  tip: 0n,
  era: { bytes: '0928', period: 1024, phase: 640 },
  kind: 'transfer_keep_alive' as const,
  rao: 187825400n,
};

/**
 * The reference builder's transfer_keep_alive (abandon-12 root to its //0
 * child, 0.001 TAO) with the signing payload polkadot.js's ExtrinsicPayload
 * produced for the same fields, byte-identical, and a signature polkadot.js
 * verified over its own payload. 145 bytes each with the length prefix.
 */
export const PJS_PAYLOADS = [
  {
    name: 'xcheck (nonce 7, tip 5, era at 9168516)',
    nonce: 7,
    tip: 5n,
    checkpointNumber: 9168516,
    checkpointHash: '0x0648bc120c2cd5d818f442481dc500adfce8fdd57afc448181362623f129429f',
    rao: 1_000_000n,
    era: { bytes: '4500', period: 64, phase: 4 },
    call: '0503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d00',
    payload:
      '0x0503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d0045001c1400d6010000010000002f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c030648bc120c2cd5d818f442481dc500adfce8fdd57afc448181362623f129429f00',
    signedHex:
      '0x3d02840066933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed797201f0ce803151838122782b9e25ddafc6336b9150d05f634620584c80d61126ca2daf3e508d71acffb5da16b99a30b35edc4b93a03c491be1a89b1f4898f11c6b8745001c14000503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d00',
    signature:
      'f0ce803151838122782b9e25ddafc6336b9150d05f634620584c80d61126ca2daf3e508d71acffb5da16b99a30b35edc4b93a03c491be1a89b1f4898f11c6b87',
  },
  {
    name: 'proto (nonce 7, tip 0, era at 9168527)',
    nonce: 7,
    tip: 0n,
    checkpointNumber: 9168527,
    checkpointHash: '0xdddad25c9bd28dbb346e4cab04097189cef1707c3b65129272820e366c1f46af',
    rao: 1_000_000n,
    era: { bytes: 'f500', period: 64, phase: 15 },
    call: '0503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d00',
    payload:
      '0x0503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d00f5001c0000d6010000010000002f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03dddad25c9bd28dbb346e4cab04097189cef1707c3b65129272820e366c1f46af00',
    signedHex:
      '0x3d02840066933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed79720142a5f254ee26aad9bf4fe77974c3eb75f34c68f68e8a868935b661634d6f491409c0d1d5dabf41b18a6f90628bcd6c8dea9bef814eaea9e9bb544a064260248ff5001c00000503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d00',
    signature:
      '42a5f254ee26aad9bf4fe77974c3eb75f34c68f68e8a868935b661634d6f491409c0d1d5dabf41b18a6f90628bcd6c8dea9bef814eaea9e9bb544a064260248f',
  },
] as const;

/**
 * proto_run.txt: the same fields as PJS_PAYLOADS[1], signed in the reference
 * run that the live node validated (validate_transaction answered
 * Invalid(Payment) 0x010001; with one signature bit flipped, Invalid(BadProof)
 * 0x010004). 145 bytes. Its signature verifies over PJS_PAYLOADS[1].payload.
 */
export const PROTO_SIGNED_HEX =
  '0x3d02840066933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972014e0d5bd9fe2a797185d8d44958e1e157d93372bf5f2b8f83fc383d501aacf3206bb6e5d442e2494084448ddf0d699678e5e41ffa13217674bfa2a89087cb2784f5001c00000503005244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad167102093d00';

/** state_getStorage(System.Account key) blobs, 56 bytes each, read live 2026-09-28. */
export const ACCOUNT_INFO = {
  /** The reference account of design §12.1 at block 9,168,516 (after its transfer in that block). */
  reference: {
    address: '5DunDrFV6BPbzsgLZUtMQtCq7w9fcUEbM59BUwx5E7N9Bn5E',
    key: '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9edc1ffa2f4de3d176c79c670a6fe8efd51a9f3ebc7c5cd9c551769ccf1530dccb6b8e6565d3335662ae4ea42ee6e5e3b',
    hex: '0xafa10000000000000100000000000000a434af321a0000000000000000000000000000000000000000000000000000000000000000000080',
    nonce: 41391,
    consumers: 0,
    providers: 1,
    sufficients: 0,
    free: 112_519_492_772n,
    reserved: 0n,
    frozen: 0n,
    flags: 0x8000_0000_0000_0000_0000_0000_0000_0000n,
  },
  /** The abandon-12 account: 35,639 rao, nonce 7, unchanged between block 9,168,516 and the read. */
  abandon: {
    address: '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH',
    key: '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da985eed350b03894f4ee3db867915c839566933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972',
    hex: '0x07000000000000000100000000000000378b0000000000000000000000000000000000000000000000000000000000000000000000000080',
    nonce: 7,
    consumers: 0,
    providers: 1,
    sufficients: 0,
    free: 35_639n,
    reserved: 0n,
    frozen: 0n,
    flags: 0x8000_0000_0000_0000_0000_0000_0000_0000n,
  },
  /** The abandon-12 //0 child: no account on chain (state_getStorage answers null). */
  absent: {
    address: '5DvaFrBesD6jTWd3GEefcM72BSXaFRHqQuZtwBSZii1VMnuP',
    key: '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da99bcb02f0b7651dadee4a202da835dce95244eb2b8a9f975c603485c5a76eeec41fdad88aa6ef204b7c56691940ad1671',
    hex: null,
  },
};

/** payment_queryInfo / state_call answers measured for the proto transfer (design §4.3). */
export const FEE_ANSWERS = {
  /** state_call TransactionPaymentApi_query_info: weight { ref_time 224051000, proof_size 7791 }, class Normal, partial_fee 83124 (u64). */
  runtimeDispatchInfo: '0x' + 'e2fc6a35' + 'bd79' + '00' + 'b444010000000000',
  partialFee: 83_124n,
  refTime: 224_051_000n,
  proofSize: 7_791n,
  validity: {
    payment: '0x010001',
    badProof: '0x010004',
    /** A ValidTransaction: Ok || priority u64 || requires Vec<> || provides Vec<Vec<u8>> || longevity u64 || propagate bool. */
    valid: '0x00' + '0100000000000000' + '00' + '04' + '20' + '00'.repeat(32) + '4000000000000000' + '01',
  },
};
