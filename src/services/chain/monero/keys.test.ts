// keys.test.ts: the BIP39 and 25-word derivations against every vector the
// design pins (monero-engine.md §2.3 and research vectors_final.json).
//
// What the set distinguishes, so a wrong implementation cannot pass:
// SHA3-256 instead of Keccak-256 (every view key), big-endian instead of
// little-endian in sc_reduce32 (every spend key), clamping via
// ed25519.getPublicKey (every public key and address), scheme A versus B
// versus C (the same phrase gives three different rows), and the passphrase
// pass-through (the "TREZOR" rows).
//
// Provenance: VECTORS_FINAL is vectors_final.json verbatim, computed by the
// pure-TS reference xmr_noble.mjs and cross-checked field by field with
// bip_utils 2.12.2 + monero-python 1.1.1 and with monero-ts 0.11.16 (the
// official C++ in WASM). The PUBLISHED blocks below come from the projects'
// own test suites and are the ground truth the three implementations agree on.

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { keccak_256, sha3_256 } from '@noble/hashes/sha3';
import {
  ED25519_L,
  MONERO_BIP39_SCHEME,
  MONERO_COIN_TYPE,
  MoneroKeyError,
  hashToScalar,
  moneroCacheSecrets,
  moneroKeysFromBip39,
  moneroKeysFromBip39Account,
  moneroKeysFromLegacyWords,
  moneroKeysFromSpendKey,
  scReduce32,
  zeroMoneroKeys,
  type Bip39MoneroScheme,
} from './keys';
import { MoneroMnemonicError, spendKeyToLegacyWords } from './mnemonic';
import { primaryAddress, subaddress } from './address';

interface Vector {
  name: string;
  scheme: Bip39MoneroScheme;
  mnemonic: string;
  passphrase: string;
  spendKey: string;
  viewKey: string;
  spendPub: string;
  viewPub: string;
  primaryAddress: string;
  legacy25Words: string;
  subaddresses: Record<string, string>;
}

const VECTORS_FINAL: Vector[] = [
  {
    name: 'bip39-12-abandon',
    scheme: 'cake-exodus',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: '',
    spendKey: 'bfafd1eb0e43da200c5c11537d355e458e7c326b3bc1b19f4546573d6bac9d0f',
    viewKey: 'b92e5bd93ac8b259bd0e08417af9d7ed45a50a1548c2907c66ed7dd3e8436500',
    spendPub: '2fe2f4de346ab4c14954fdbda6503a3edc191d687198d39336e9a65c1b68914b',
    viewPub: '66162ca57f4e20035e55fc5918de8d342ad2f8ee28b94135773c4afa8b2b2375',
    primaryAddress: '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756',
    legacy25Words: 'subtly emerge cucumber wield jester neutral echo guide problems hiding necklace tapestry offend tell erase ugly envy turnip click iguana pebbles idols listen nail cucumber',
    subaddresses: {
      '0/1': '88DAExP6fh2iR45U7DJcFRP5YEQbg8T4EKhhYz7J5vg1YA17kxiQZyv6AMaMyW7yDhaKYTyDN6M5v8AAAVdtMEEB8AeZUEA',
      '0/2': '89gbTkB4ZkDZ58W3dp3dFjWYurmmNaSvuVNdeYxSJtUpdF5ghnTFkdCcJVWn4YeYNaSRagoBeL7fPVqsYg2oJRdGSsgBCZE',
      '1/0': '85wbu4rX8FncmJsDyMH9xGNduwuLsoSS4eMA48s6GjKeRp2NjCUD7R6TtHuJ98XMAFD9oQQ4Ej2NnQXeNdWYH85GKbM5wbM',
      '1/1': '8995LXowKuhhugRcFANupg5PSsmb12YHVUMBmBcUNj3giqFDq3nZ3qcLwmm2whaxGVAbtc78jdb3C4jNHL6Hbo2UAZKnFg4',
    },
  },
  {
    name: 'bip39-12-abandon',
    scheme: 'ledger',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: '',
    spendKey: '3b094ca7218f175e91fa2402b4ae239a2fe8262792a3e718533a1a357a1e4109',
    viewKey: '0f3fe25d0c6d4c94dde0c0bcc214b233e9c72927f813728b0f01f28f9d5e1201',
    spendPub: 'dae41d6b13568fdd71ec3d20c2f614c65fe819f36ca5da8d24df3bd89b2bad9d',
    viewPub: '865cbfab852a1d1ccdfc7328e4dac90f78fc2154257d07522e9b79e637326dfa',
    primaryAddress: '49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn',
    legacy25Words: 'tavern judge beyond bifocals deepest mural onward dummy eagle diode gained vacation rally cause firm idled jerseys moat vigilant upload bobsled jobs cunning doing jobs',
    subaddresses: {
      '0/1': '8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ',
      '0/2': '8696JpJ6Yvw8VtJqpQ7V8gNLBdgwLK5xYLQPfE7DpzdQGo4gKPWMJSubTt8rvvTrWagePa2q1P3k3TvRkGiHZGGUL1cuAwo',
      '1/0': '8BwfMo73i9GeqjRg6vctzrL7vTuG3Ap6JDaT8cqWrLTJGsHuJP2aSq4NFutnw8giH7goWTFSbg5ny3Rukad8cBQeEv9KMst',
      '1/1': '82rYviTJiZtJPQAdXY3MndTh9kyf32GkhLQfygHwLL11FcVTb4SqmojZv6RaDEDafxbjuvRcR4oGY7gmeqnWchzn4EFR3y4',
    },
  },
  {
    name: 'bip39-12-abandon',
    scheme: 'trezor',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: '',
    spendKey: '8f2d521d4334f4d5d174c47aacb346e7633516416fae089d74ecfd0c389a6b08',
    viewKey: '84b0087a63854856686f80596a5a1a6090795b4d1311139173262170d7e7180f',
    spendPub: '51fd81faa5e2641bca8a5c43d764ab276033c12b459fd9f5c9c23b7733af67e6',
    viewPub: 'eb8855fd7d21670f9bdfc0cdcfa54172e80322c4eaee5ce30d85cb9ec90d21d1',
    primaryAddress: '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR',
    legacy25Words: 'symptoms ugly ablaze anchor roster neon feel gemstone spud plywood extra daft alchemy apart fowls dexterity puck films liquid vigilant yesterday people awful blender plywood',
    subaddresses: {
      '0/1': '84JQzHWT7SjgNhmiYDb7bh9R894vS4m8VUvQib2W9s4e8CEUTg97NdoiLjP9oUBwcLJreYA2ZKdQP1mFw4EzfNALHJbCDyq',
      '0/2': '87n6LvK4UJBL22CUwFB4yWaC6VcpxqfTo9Z1AR5STuFWGKMEnTrcBYjDVHPTEMMgfXc9UuW7ihRKC3bXvXmercQ6UkijU4a',
      '1/0': '89gMN28NBgi2ZCi11YyfaxW9rHCEKk9UddQVCDAkvL5rUxxKqNLXdTAS5bCkmSNogncXiihL8RFmKJhgcmFqmakNK5cvKyq',
      '1/1': '87p7uZBuB5cCF4q4mbWFTyiRj3oYGQBLaNSk1ZznZVBddQmGnxZwwmLQqvDr3vXYqYTiXVW22TWwqVuYTpbgiaUqEYyKoBm',
    },
  },
  {
    name: 'bip39-24-legal-winner',
    scheme: 'cake-exodus',
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
    passphrase: '',
    spendKey: '076bfda9fa30dba503321e5f6f310b356cb616bbbfc64fd086a65ad91fc30402',
    viewKey: '616d2679ef55bda0aa04e02f38ac5121be406ec30461fde6af106180943f2a0f',
    spendPub: 'fccfd4382d83d52790f16be437c1ff91921b2a1889b7854c999ef7efb59fbcd6',
    viewPub: '307f4239a3a41a60c2296e16c074300fd2c4a317b13568a684b1acd730b1d0a7',
    primaryAddress: '4BCmqSJ5GVJ7cqoxcu5wXURMDfhgvw596Dp7mjtVoD8fcpuYR3gad8VHBgLBwC11HZ3eWM3DJqWk7UrSKDZ26RtBKwJccRo',
    legacy25Words: 'inbound bite sighting mighty academy phone pool erosion oxidant went natural shackles juicy pipeline hotel gang divers adrenalin iris pumpkins mice bowling venomous village sighting',
    subaddresses: {
      '0/1': '83zoUcLk5bRH7pz9rXk8uW2L3tzyEWXoh7wTgCRRMXZhKEHYjerDefRCqMYTYgTQWQh7mRik9c9EpKxB5a4FaTP2JPngecs',
      '0/2': '867vbS9JfZFVcwi29kB8yfjjMYapSSvJuU5iiRp18S9t6svuzPbMVmZEUNCGdn5zZb2LPNtnicfHWYN74U91R1gbRKN6mHt',
      '1/0': '85zSDast7nnWpvkDhP3bcd8Upa8XJLJZti8W1zJJik8dNNvKJSfu1fEHQh9G5CRYLKbPvYwdxaeJQ6vGu2PWArBvQPgjdce',
      '1/1': '879FmPNPTfni57bxJKwAb2LDWaV6wmHv1PVXDaWJHUxoTxRNd4vnGtzQ1zFb2bf3oeZ68ZK6vbG7KgzYqhhdyNH87cMaaHP',
    },
  },
  {
    name: 'bip39-24-legal-winner',
    scheme: 'ledger',
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
    passphrase: '',
    spendKey: '349f70f666036272b6eef09159d30fca85f02e291d31eb2941de136541ab3c07',
    viewKey: 'eae974e2ab2e897aab01c0be3e5447c3cc0658dbf7d014f9b39bfed22a8b2c05',
    spendPub: 'bad06b743968008877e3043b7c3ea628470f3e6cfd978cfa7d62d22d91aa6f5d',
    viewPub: '601d678473fae143bbf739785c18e017fe170bc52d222d713f94ebda1f91b39b',
    primaryAddress: '48hiR4FqNUoPpuz87bHjAM7jk6GMv65ATiu4kkn3MTEvGcrp4tdYcHWCL7CuFZQNAB51kwrFi8vccKwem1EoYD1kJadsEdP',
    legacy25Words: 'ornament juggled injury splendid peaches bailed younger baffles pimple educated karate emails oxidant wickets building cider citadel fuselage wounded hope skirting until syllabus tiger juggled',
    subaddresses: {
      '0/1': '89TEF8DL1SrNRMBzUE5fZq2DjTKX9ArNvaxFhoCyx5D5UkqfTTXSEqhJ7nnRj9b4jt8o1FBue1favNdmEwMxJRGmCwu6irK',
      '0/2': '8A51FMXoZXPcjFKjj1AMMx7Ls55k1TPjxLLSfG4o8MHMbCqaVfEwJ5cjg63ozXHnJ16J6jb2a6h3hVpY86MqPrYN1hwnBfN',
      '1/0': '88qDDebzqJLbdr8RhqFHj2Wa2Fbq3UBxKaAvrU6EyVu3L5q3vDstYij35McBsui6icebGqr9ABWnmT1vjLT8g8jdAmdqFQT',
      '1/1': '83nMxQhUqLKfn1uZqhGtSMGSsSfkfxrd5dzh5DASLZAFVqPtXuYtNriJr31woJMMirMQTVuuAy7DA9ZckYS2Roa6662vQTS',
    },
  },
  {
    name: 'bip39-24-legal-winner',
    scheme: 'trezor',
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
    passphrase: '',
    spendKey: '46e79f42e7e80b2f34be1476379ade1eeaef0bd24669c79c9d0db65957ed6808',
    viewKey: '75a41365b7208e94a5b6b1bd62fe3fdcc585175c23057c01ee5ff7f6cdd9a007',
    spendPub: '93ae1a5186f505826071a98689be89eb817018e58453866b58de87e72ecac05d',
    viewPub: '3e7dbb4151906a67a9f8d2c80f9c26d3135fd335bad64b30ed74907740f71c38',
    primaryAddress: '47DhaxiV9wSNopRYKTUVWpgPha5bhBjfsJxQJbAiApGfGbauhSx1fP7JLfsYpnrZqocJhWnWUwgSe9BfCbfVoK9M7RatZ5Z',
    legacy25Words: 'vacation rash website foes terminal ailments smelting baptism musical roomy orbit ruling elbow buzzer wagtail launching goodbye weavers semifinal amaze hover superior deftly dude foes',
    subaddresses: {
      '0/1': '8Baj7eWNk2KNLPxAogpZv9C1tHABHfNM8AYS1fjLbntKTmQGgNQs9yy5wtwxfuuGABUoStiRNCbucPUTME44k8HrPJiz372',
      '0/2': '83mb81uSTVSFwSBpaf57Bv7aryC3jHqYNdWCuhqRb4rG61atUvkzRQQ9Gy7eE9n5N9PJqS26rSDtLa4aMppDTE5UFQsNTd5',
      '1/0': '84mJ7gaqkZwGtqEPhsbabs47zGmJtUAVnBbA7wMm9MRAK2dBxrAcUwVanto5P3bg9uWWXTMyMTDtP4tAjs7uyMBW3EsXyT3',
      '1/1': '84xskKwZHEdZ7vYazmDkFKZhPHfVvKVDuR72BJsmrzuKARqMdhXsjPHfqqDF5ZiaxmSupBNb9X51j3Vu9nH3CTTeUiNjwWL',
    },
  },
  {
    name: 'bip39-24-abandon-art',
    scheme: 'cake-exodus',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
    passphrase: '',
    spendKey: '4fe2e8fa6ad56846a4b70b5cf85a8a5ff310d8eb5daaf5b11af9591d79fc0a02',
    viewKey: 'f6375bd99c5d6ba250660fe1bda555cf1eee558a5076207afb7b12602b66980b',
    spendPub: '32698cece58bce4fc230bfc85244917c046adc40abc88dd0952b1aac47b45022',
    viewPub: '76064b01b75935a0936914a89af49f8756424f034350d6213ec8f216f3f649fb',
    primaryAddress: '43Xuqb8woKbELkxbc4U8ZEMk87rx8VingbtWmxXpFiJK6mKHJuK8bGGTrndC4y6DmGPdwQDyJaWgu6ZXCKNfeoRSVMTUBCX',
    legacy25Words: 'coal gourmet geometry raking lilac sewage pawnshop rudely bays ascend gifts reinvest voted moisture kept podcast vocal paradise acidic espionage hijack wrap vogue waist sewage',
    subaddresses: {
      '0/1': '84SRAaUXDrhfxRo41T7TGD8WKCC3w6VjZW7uVLTMU7BLgqHnn2t59MW1qkhGU1rsC8bhsswDJaLyeQ9qbybxKWHq6PKnQc4',
      '0/2': '83dTVFH9Tm9ZYuEE1fZvdiMPWjWnZfdteLMQWdeyqDTUfWZ2SZNdeKp2AhaikuQussfpd8PY8zFFdD13gfSXqdmNTPZ2KwU',
      '1/0': '89gxQfqWpNVUMkcCGFJVo2VFkmLkugY8KGngNcXRMUa8d4MziN7W95MDkqAR5pPLyoShd3KH1EnG9gGWGJ1MpuKgCgMTWf6',
      '1/1': '86UTBQutD6u9P6tDdD1Rnyh2i5xeFjLF72BCPCxjq9nBSGi8fCtGkXLMTvtar9RDjvYjaWBjhfgQSEMBTWt2dATu6CPEYcZ',
    },
  },
  {
    name: 'bip39-24-abandon-art',
    scheme: 'ledger',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
    passphrase: '',
    spendKey: 'a8a74bafd9b1d6c8078fc771c6c976d4aaad85a7cba949be4e4f55568fa2c60c',
    viewKey: 'e44353a6003c8799a19bb6e864666451a54d6483fa6f1be851276a062a21a600',
    spendPub: 'f21501e3d54f0aa21b01233512a735851494d96dd48cd49ea1ff1a8a96c7caa3',
    viewPub: 'a2b83fc0e88d845a8b522c20f41b25dd452c9ec38afaff22ebd0ea42520ade49',
    primaryAddress: '4AoBztrjij3U7dKo8AaQLLPG3haszmAH1TXwLbebyZdbUNUHs7Ly7ByG9PkxxPpZZEe1bhTBcJfze6qnBRvdjKG19KhWXfy',
    legacy25Words: 'dizzy nightly envy lemon vivid rockets loyal magically weekday archer fewest bomb blender cocoa stick films sovereign morsel elbow baby irate axle cobra doing irate',
    subaddresses: {
      '0/1': '847DEkqU1cvUPtctHE94PXfmkTbFrTDpT2DamgzK4YEa59gkiRkapXpTKYAK8oAfy59QFjzT1oe7PJ9SmZAxyvD1MqRhFT4',
      '0/2': '8BPgWeyYkbzKFwqNmaDHUz46HaCEqxSbFBr7LAA9Za8fHQQZjK3fK8RH3ZzmHBLnW3XfpgCT9DmofdfZHEjx5SGL6DWD3nM',
      '1/0': '88gjBjdYMSmUQbkhQvmoppj5XVQctwvPTjPEoo3V2mr1Y7jRo5bw3QqXpyuF2tjpobZx3ETATVzjxJea46EWLWE2BitUJpv',
      '1/1': '89PybZhNGNHB4NJv39Lf4ML53fUhpDMnqj8zjXbvF55y3tKL7nHasQiSM5oaC1onYgg29FXYp8rh97RZiQN2APSCEyok9sV',
    },
  },
  {
    name: 'bip39-24-abandon-art',
    scheme: 'trezor',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
    passphrase: '',
    spendKey: '2a06fcf45634065ea883a2fc697179e738587b9974f465be95751491de886208',
    viewKey: '58060994479a395cee1aa788be41bacc184747b41b5f305de29849f16758d305',
    spendPub: '0291ea1fb11602f80351ff8b641daa4112c05388f6bd6fac8c0a237d6548ef86',
    viewPub: 'ababca424511f3fa06fb104477eee1fe1dbe7b55d84ae0e5ca5b86c3782dd1cc',
    primaryAddress: '41ikscv8RiHiV37j6nGxYZBtHwKxqyYZtVrvViWynLBQPXUTagzEMNiipaWPKeihFWjWFEKpycAw9fSFoqA5uJeCQ6eFuMc',
    legacy25Words: 'antics peeled offend ounce fabrics pause awoken dwarf dotted snout pierce nanny gigantic february tutor nutshell sonic moment stockpile jigsaw acquire cupcake himself inflamed offend',
    subaddresses: {
      '0/1': '86zJ1TAiiNLJZA84gzwt1GYLN5zaQLwTfdUUWdgjUDwhBPBJWqA6THyQCTk7z9yg8uLptUkvwRyrZfJbim6GgdUpGtxHvEv',
      '0/2': '83sFwo7i8MygbfGvk3zBeLKDNGYXTeL2SdwekJK4o3t6DXM7EQ8ac6dSJCpm8MuctjC1zWvq9egsTjFbB1TtoS518RwwZWN',
      '1/0': '8BmhW39rXJrVkQTkU3MM7eCaEkDGCX2FDiQBKo2hs7EgifroBT5ZxnbaivaCSNHAdECYstpGfaSmtLCc3RWkF621AQnMyzh',
      '1/1': '8AWerbf7SUmDBBohftk9WuQ8zZAxah54HaYTaR7iXbNBX75ojFnuhfDFUpxvYxY69NHs6wzhSWPFDUtsjN9pwShULhFNno2',
    },
  },
  {
    name: 'bip39-12-abandon-TREZOR-passphrase',
    scheme: 'cake-exodus',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: 'TREZOR',
    spendKey: '674ba1caeaf8a79e66a026858c78d4e565032953e98d39bdea12559bcae86a0c',
    viewKey: '5a24f0986fda040878c8767c1150133450bd42146c43c0f1e783c52f2b01a508',
    spendPub: '796f196622ba1042947813b759a29f79c0e5de6e89dddeb6fa7b8f7a3d5d1624',
    viewPub: '5cbb7d0694b1a34098e0b363e7ae11cd0202f15be0dc730bfd2b780d7a128ab9',
    primaryAddress: '46E1ieH9apfC8uiqBv3QEJMNANQvVvPFsXc7yCDD55Do75m35EESonaBog4pq7kZdJbHqKHDYEutW31JrNZSY9QDMxFRi7j',
    legacy25Words: 'hedgehog digit yearbook luxury firm urchins wade twice igloo likewise vacation sulking obnoxious fonts oval vessel rafts jagged adrenalin reef frying avatar tudor vampire urchins',
    subaddresses: {
      '0/1': '86SiAAqcXnsUvuPsMaLdd1LmviAo9hLTFMjfjrEKESAN54Vj5qtKrE9E6GWHbu89XVA6hcFt1pd8XVZrLaXVH618FadAGMu',
      '0/2': '82yCCSqptJoibpwVoKCffdgeQ9j9sYSdb6rnBQd5RtCGEdkaAuVG6UWCi8Z73cieDuN4HMF78YGj9QvqPkYdhM7RTs8JHtG',
      '1/0': '8C3VkBPTsfxYQJwSxmhgZS4iHdE51ou9kVbAmUuQX9GCWxcR4L2tq6RVy4qLsYyN3LVL2xWxRc5S94ZxYsJW6d6o8fgcRUs',
      '1/1': '84V84sGPpL69Hyidqa3VDXjGxX5DwYwAVcfax6tG4u9DGNHrQgEWNFoHToEUicsw5mYJobZA45aC2627GAX3vbUH7VowbaT',
    },
  },
  {
    name: 'bip39-12-abandon-TREZOR-passphrase',
    scheme: 'ledger',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: 'TREZOR',
    spendKey: 'd86391b9ce10695e3ba69a6ec7953da6284f53abc4fc2d38bf622c3e14b0de0e',
    viewKey: '0f8b7280537df8ade2188b348394bc3fee88039fe067972e2d8a7acd6e72da0c',
    spendPub: 'dc496388f7373ab53c26c268952b0fbb5680d9120e225f0a95b80be7a8b6af48',
    viewPub: '1ba26ddaeb11f0e5b9c1ffba5b1272ea18b3291523e1f7adbea2ae3f70ac0001',
    primaryAddress: '49yHWeHxzhoXKCxenjxaiAYLQv6E4K8C62mgoPSYa59QD4YArwurwTDfRdKh1CZfZjgA2h1M4F9cAW4YNicBPVZZ1BxEMFS',
    legacy25Words: 'snake going asylum eavesdrop germs rapid coils afoot jubilee fizzle dormant titans going maximum desk organs boldly gimmick onslaught cedar hookup revamp august buzzer coils',
    subaddresses: {
      '0/1': '87WE4Yn35dHBo77BFUBhvDTEzHaSxaSUyV8udAnzxkWj9qDwHZX3hrTS8BrenQ7d2QNmEAQNzJcAGYkysMKi2xFqRsRWadZ',
      '0/2': '86oSzZa95hHGpk87eRBUR8jQx54WcHH3GLurAphoeg9DX18zoGwudFPAiksEG5GswaWdfycaDe7d7PJPHisJdbqi4LkQ4WT',
      '1/0': '88bwVh98pWTR98MK2VBpfG5yF7rjpKdLqAxg6hVshrZseEdK6zminWEJGJrKWfyzvdCFV4ePWwFh79Q8ncR8yPZ5QVtjPqR',
      '1/1': '846EJmzgouzMqamaW347yddgr2iaAx6Vf8HeJFKejGuV5Lr8bL2Nw1pTkWNnEr4v2hLykghdT4yLLFUSbRB5M58R9RcvUL7',
    },
  },
  {
    name: 'bip39-12-abandon-TREZOR-passphrase',
    scheme: 'trezor',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: 'TREZOR',
    spendKey: 'aec44c4a32c2e8728b7d6b2fd5b05ebcc3ccd5513bd2ee222c17e3262c5c1806',
    viewKey: 'f78186af31a862828ef78eb8419bb5fa9a536ed4da820b2977733da859e28a02',
    spendPub: '50cdf692ba50a43c6ef27a1358b84cf710ffa04be6177e26cecea19a38646f05',
    viewPub: '63f32e372c220ec9ae1a2665a85d7f46824f4a23eeab2a5b82ab29656305527b',
    primaryAddress: '44giFrE94GbB7HDSTmk9rTiKrWRPANSgD7VV7QxD6tWA1uJ3jpEKcf7ajYsRxqpK6WCo2VviZeiSMGJmQy9UdcxZEvTTRbE',
    legacy25Words: 'twice haystack pimple rigid unnoticed gone puffin object sixteen ourselves wept randomly nuance twofold dodge soccer knapsack oilfield gown bogeys evicted himself apricot awesome dodge',
    subaddresses: {
      '0/1': '85n6L7FjeZeKu7NiRGRe5rXnjtj4mL6Es7Ya7cvEpeiofhdNAa5LHdAjYDw4PeVgTS9bJ7hVwxZjGSWYw9yCqXRr7jwbFp7',
      '0/2': '89YVk28uEV711RfFZMMzCnMer6j5sGifwNeM4y8mVBN1MXJPGqrRRpq7TEu3mga9hGGGzbGGfws3QGhYjziKcssrBcjHCYx',
      '1/0': '89gaBeuJkffWjuwwFo7T18SvVwH7XRmbfar8T2yTTe82Boabym3fV8sQUix8oAzTH8JYhyGCvxjhqY4pQC9VkdYJBTJzMWg',
      '1/1': '88pKbjGAAD91jHH64uDrebL9XbAFX5JtS1kaZfivpEFePqv7ZsiMi6ceVWzV6Qo93LaJWU5qGHN3HhFXnQqXs9vKNrCo6fG',
    },
  },
];

const ABANDON_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function lLittleEndian(): Uint8Array {
  const out = new Uint8Array(32);
  let x = ED25519_L;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function keysHex(mnemonic: string, passphrase: string, scheme: Bip39MoneroScheme) {
  const k = moneroKeysFromBip39(mnemonic, passphrase, scheme);
  return {
    spendKey: bytesToHex(k.spendSec),
    viewKey: bytesToHex(k.viewSec),
    spendPub: bytesToHex(k.spendPub),
    viewPub: bytesToHex(k.viewPub),
    primaryAddress: primaryAddress(k),
    legacy25Words: spendKeyToLegacyWords(k.spendSec).join(' '),
  };
}

describe('constants', () => {
  it('ships the Cake Wallet (Exodus-style) scheme on coin type 128', () => {
    // Owner decision 2026-09-28. Changing this after release makes every
    // user's Monero wallet open empty; this pin makes the change deliberate.
    expect(MONERO_BIP39_SCHEME).toBe('cake-exodus');
    expect(MONERO_COIN_TYPE).toBe(128);
  });

  it('uses the ed25519 group order', () => {
    expect(ED25519_L).toBe(2n ** 252n + 27742317777372353535851937790883648493n);
  });
});

describe('vectors_final.json, every row, every field', () => {
  it('covers 12 rows: 4 phrases x 3 schemes', () => {
    expect(VECTORS_FINAL).toHaveLength(12);
    for (const s of ['cake-exodus', 'ledger', 'trezor'] as const) {
      expect(VECTORS_FINAL.filter((v) => v.scheme === s)).toHaveLength(4);
    }
  });

  for (const v of VECTORS_FINAL) {
    it(`${v.name} [${v.scheme}]: keys, primary address, 25 words`, () => {
      const got = keysHex(v.mnemonic, v.passphrase, v.scheme);
      expect(got.spendKey).toBe(v.spendKey);
      expect(got.viewKey).toBe(v.viewKey);
      expect(got.spendPub).toBe(v.spendPub);
      expect(got.viewPub).toBe(v.viewPub);
      expect(got.primaryAddress).toBe(v.primaryAddress);
      expect(got.legacy25Words).toBe(v.legacy25Words);
    });

    it(`${v.name} [${v.scheme}]: subaddresses 0/1 0/2 1/0 1/1`, () => {
      const k = moneroKeysFromBip39(v.mnemonic, v.passphrase, v.scheme);
      expect(Object.keys(v.subaddresses).sort()).toEqual(['0/1', '0/2', '1/0', '1/1']);
      for (const [idx, want] of Object.entries(v.subaddresses)) {
        const [major, minor] = idx.split('/').map(Number);
        expect(subaddress(k, major, minor)).toBe(want);
      }
      // (0,0) is the primary address, not a derived subaddress.
      expect(subaddress(k, 0, 0)).toBe(v.primaryAddress);
    });

    it(`${v.name} [${v.scheme}]: the 25 words import back to the same wallet`, () => {
      const k = moneroKeysFromLegacyWords(v.legacy25Words);
      expect(bytesToHex(k.spendSec)).toBe(v.spendKey);
      expect(bytesToHex(k.viewSec)).toBe(v.viewKey);
      expect(primaryAddress(k)).toBe(v.primaryAddress);
    });
  }

  it('the shipped default (no scheme argument) is the cake-exodus row', () => {
    const k = moneroKeysFromBip39(ABANDON_12);
    expect(bytesToHex(k.spendSec)).toBe('bfafd1eb0e43da200c5c11537d355e458e7c326b3bc1b19f4546573d6bac9d0f');
    expect(bytesToHex(k.viewSec)).toBe('b92e5bd93ac8b259bd0e08417af9d7ed45a50a1548c2907c66ed7dd3e8436500');
    expect(primaryAddress(k)).toBe(
      '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756',
    );
    expect(spendKeyToLegacyWords(k.spendSec).join(' ')).toBe(
      'subtly emerge cucumber wield jester neutral echo guide problems hiding necklace tapestry offend tell erase ugly envy turnip click iguana pebbles idols listen nail cucumber',
    );
  });

  it('the 24-word cake-exodus vector (legal winner ... title)', () => {
    // Named separately because a Satori GO phrase may be 24 words and Cake's
    // own UI only auto-selects BIP39 for 12. The derivation is length-blind.
    const got = keysHex(
      'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
      '',
      'cake-exodus',
    );
    expect(got.spendKey).toBe('076bfda9fa30dba503321e5f6f310b356cb616bbbfc64fd086a65ad91fc30402');
    expect(got.viewKey).toBe('616d2679ef55bda0aa04e02f38ac5121be406ec30461fde6af106180943f2a0f');
    expect(got.primaryAddress).toBe(
      '4BCmqSJ5GVJ7cqoxcu5wXURMDfhgvw596Dp7mjtVoD8fcpuYR3gad8VHBgLBwC11HZ3eWM3DJqWk7UrSKDZ26RtBKwJccRo',
    );
    expect(got.legacy25Words).toBe(
      'inbound bite sighting mighty academy phone pool erosion oxidant went natural shackles juicy pipeline hotel gang divers adrenalin iris pumpkins mice bowling venomous village sighting',
    );
  });

  it('the passphrase passes through to PBKDF2 (TREZOR row differs from the empty one)', () => {
    const plain = moneroKeysFromBip39(ABANDON_12, '');
    const withPass = moneroKeysFromBip39(ABANDON_12, 'TREZOR');
    expect(bytesToHex(withPass.spendSec)).toBe('674ba1caeaf8a79e66a026858c78d4e565032953e98d39bdea12559bcae86a0c');
    expect(bytesToHex(withPass.spendSec)).not.toBe(bytesToHex(plain.spendSec));
  });
});

describe('PUBLISHED: Cake Wallet cw_monero/test/bip39_seed_test.dart ("Exodus Style bip39")', () => {
  const cases = [
    {
      mnemonic: 'meadow tip best belt boss eyebrow control affair eternal piece very shiver',
      account0:
        'tasked eight afraid laboratory tail feline rift reinvest vane cafe bailed foggy dormant paper jigsaw king hazard suture king dapper dummy jolted dating dwindling king',
      account1:
        'palace pairing axes mohawk rekindle excess awful juvenile shipped talent nibs efficient dapper biggest swung fight pact innocent emerge issued titans affair nearby noises emerge',
    },
    {
      mnemonic: 'color ranch color remove subway public water embrace before begin liberty fault',
      account0:
        'somewhere problems gauze gigantic intended foxes upcoming saved waffle pipeline lurk bogeys empty wipeout abbey italics novelty tucks rafts elite lunar obnoxious awful bugs elite',
      account1:
        'playful toxic wildly eluded mesh fainted february mugged maps repent vigilant hitched seventh threaten clue fetches sample diet number alkaline future cottage tuition vegan alkaline',
    },
  ];
  for (const [n, c] of cases.entries()) {
    it(`Test Wallet ${n + 1}: account 0 and account 1 give Cake's 25 words`, () => {
      const a0 = moneroKeysFromBip39(c.mnemonic);
      expect(spendKeyToLegacyWords(a0.spendSec).join(' ')).toBe(c.account0);
      const a1 = moneroKeysFromBip39Account(c.mnemonic, '', 'cake-exodus', 1);
      expect(spendKeyToLegacyWords(a1.spendSec).join(' ')).toBe(c.account1);
    });
  }
});

describe('PUBLISHED: LedgerHQ app-monero tests (the ledger switch)', () => {
  it('abandon x11 about: spend, view, both public keys, and the STAGENET address', () => {
    const k = moneroKeysFromBip39(ABANDON_12, '', 'ledger');
    expect(bytesToHex(k.spendSec)).toBe('3b094ca7218f175e91fa2402b4ae239a2fe8262792a3e718533a1a357a1e4109');
    expect(bytesToHex(k.viewSec)).toBe('0f3fe25d0c6d4c94dde0c0bcc214b233e9c72927f813728b0f01f28f9d5e1201');
    expect(bytesToHex(k.spendPub)).toBe('dae41d6b13568fdd71ec3d20c2f614c65fe819f36ca5da8d24df3bd89b2bad9d');
    expect(bytesToHex(k.viewPub)).toBe('865cbfab852a1d1ccdfc7328e4dac90f78fc2154257d07522e9b79e637326dfa');
    // Ledger publishes the stagenet encoding (prefix 24, starts with 5).
    expect(primaryAddress(k, 'stagenet')).toBe(
      '5A8FgbMkmG2e3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVHCRUaE',
    );
  });
});

describe('PUBLISHED: trezor-firmware tests/device_tests/monero (the trezor switch)', () => {
  const M = 'alcohol woman abuse must during monitor noble actual mixed trade anger aisle';
  const want = [
    ['4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM', '8722520a581e2a50cc1adab4a1692401effd37b0d63b9d9b60fd7f34ea2b950e'],
    ['44iAazhoAkv5a5RqLNVyh82a1n3ceNggmN4Ho7bUBJ14WkEVR8uFTe9f7v5rNnJ2kEbVXxfXiRzsD5Jtc6NvBi4D6WNHPie', '1f70b7d9e86c11b7a5bee883b75c43d6be189c8f812726ea1ecd94b06bb7db04'],
    ['47ejhmbZ4wHUhXaqA4b7PN667oPMkokf4ZkNdWrMSPy9TNaLVr7vLqVUQHh2MnmaAEiyrvLsX8xUf99q3j1iAeMV8YvSFcH', 'e0671fbed2c9231fe4f286962862813a4a4d153c793bf5d0e3742119723f3000'],
  ] as const;
  for (const [account, [address, view]] of want.entries()) {
    it(`m/44'/128'/${account}': address and private view key`, () => {
      const k = moneroKeysFromBip39Account(M, '', 'trezor', account);
      expect(primaryAddress(k)).toBe(address);
      expect(bytesToHex(k.viewSec)).toBe(view);
    });
  }
});

describe('PUBLISHED: monero-python tests/test_seed.py (25-word import)', () => {
  it('adjust mugged ... fuzzy: spend, view, public keys, address', () => {
    const k = moneroKeysFromLegacyWords(
      'adjust mugged vaults atlas nasty mews damp toenail suddenly toxic possible framed succeed fuzzy return demonstrate nucleus album noises peculiar virtual rowboat inorganic jester fuzzy',
    );
    expect(bytesToHex(k.spendSec)).toBe('482700617ba810f94035d7f4d7ccc1a29878e165b4867872b705204c85406906');
    expect(bytesToHex(k.viewSec)).toBe('09ed72c713d3e9e19bef2f5204cf85f6cb25de7842aa0722abeb12697f171903');
    expect(bytesToHex(k.spendPub)).toBe('4ee576f52b9c6a824a3d5c2832d117177d2bb9992507c2c78788bb8dbaf4b640');
    expect(bytesToHex(k.viewPub)).toBe('e1ef99d66312ec0b16b17c66c591ab59594e21621588b63b62fa69fe615a768e');
    expect(primaryAddress(k)).toBe(
      '44cWztNFdAqNnycvZbUoj44vsbAEmKnx9aNgkjHdjtMsBrSeKiY8J4s2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH4YtKdH',
    );
  });
});

describe('PUBLISHED: monero-project tests/functional_tests/wallet.py (velvet lymph)', () => {
  it('spend, view and primary address', () => {
    const k = moneroKeysFromLegacyWords(
      'velvet lymph giddy number token physics poetry unquoted nibs useful sabotage limits benches lifestyle eden nitrogen anvil fewest avoid batch vials washing fences goat unquoted',
    );
    expect(bytesToHex(k.spendSec)).toBe('148d78d2aba7dbca5cd8f6abcfb0b3c009ffbdbea1ff373d50ed94d78286640e');
    expect(bytesToHex(k.viewSec)).toBe('49774391fa5e8d249fc2c5b45dadef13534bf2483dede880dac88f061e809100');
    expect(primaryAddress(k)).toBe(
      '42ey1afDFnn4886T7196doS9GPMzexD9gXpsZJDwVjeRVdFCSoHnv7KPbBeGpzJBzHRCAs9UxqeoyFQMYbqSWYTfJJQAWDm',
    );
  });
});

describe('PUBLISHED: bip_utils tests/monero/test_monero.py (spend key to key set)', () => {
  it('reduces a non-canonical 32-byte key exactly as Monero does', () => {
    // bip_utils' first mainnet vector feeds an UNREDUCED seed (2c96...17, above
    // l) and expects the reduced spend key 3fc2...07.
    const k = moneroKeysFromSpendKey(hexToBytes('2c9623882df4940a734b009e0732ce5a8de7a62c4c1a2a53767a8f6c04874117'));
    expect(bytesToHex(k.spendSec)).toBe('3fc22d2b139182b29cae08fb2838ef458de7a62c4c1a2a53767a8f6c04874107');
    expect(bytesToHex(k.viewSec)).toBe('66e7495a49d2f1b9458204386bd6aadf6402c270d37d503a1cebde58a0d38a00');
    expect(bytesToHex(k.spendPub)).toBe('f7ee64693c501c0f6112f5ab4d33b405c35f66efb2c704ffbd2f7dc63408235e');
    expect(bytesToHex(k.viewPub)).toBe('7f9e54e6dc3fbbd4b7a3b4412c22f4e2d78ee91ddfeaa30a9181e4b374ac3613');
    expect(primaryAddress(k)).toBe(
      '4B23epeYLCj3aCTG8X83ZM1xunHBjWEB5jmzM1zfrAKcGokjBPvS7eAcadEQZEgDhDeweod9KEZ5L2mXYVthxdxy3CQiRDK',
    );
  });

  it('stagenet and testnet vectors encode with their own prefixes', () => {
    const s = moneroKeysFromSpendKey(hexToBytes('b4d9eab56043b1f0ac82affae32cd58049536d2289ec948502076961ae7da50e'));
    expect(bytesToHex(s.viewSec)).toBe('b9c02bf2e8e30169cbbe2c22135a65e02cb80531f7bed1105f562cc61ce10b07');
    expect(primaryAddress(s, 'stagenet')).toBe(
      '5Aro6RZf2gc9AZGHkyVLkvU4Qonc8yQ8fR4PZTy9haCVe6NHSMH4TtNLyWhovaP75PFDSUC9cAML7MAGhXS56o16H7BmpEP',
    );
    const t = moneroKeysFromSpendKey(hexToBytes('a52d32df742c7ecf639be062ef4cd3d726117645542693fbfc44f5a186724307'));
    expect(bytesToHex(t.viewSec)).toBe('5a07cb9f334ee0f28078f1dea3b554e8747db04b3e628b61f59fc4e455785f07');
    expect(primaryAddress(t, 'testnet')).toBe(
      '9zSaACcBx3HbeizJiyvY5USNcoMNtPiQvExkCKzBGJQqA1xpKhWGjDjDQnzBbubxx3i51d9mZCNvrSHcQVRUAK3H2HmhC9w',
    );
  });
});

describe('scReduce32 and Hs', () => {
  it('reads little-endian and reduces mod l', () => {
    // l itself (little-endian) reduces to zero; l + 1 to one.
    const lLe = lLittleEndian();
    expect(bytesToHex(scReduce32(lLe))).toBe('00'.repeat(32));
    const lPlus1 = lLe.slice();
    lPlus1[0] += 1;
    expect(bytesToHex(scReduce32(lPlus1))).toBe('01' + '00'.repeat(31));
    // A canonical value is unchanged, and the input is not mutated.
    const canon = hexToBytes('bfafd1eb0e43da200c5c11537d355e458e7c326b3bc1b19f4546573d6bac9d0f');
    const before = bytesToHex(canon);
    expect(bytesToHex(scReduce32(canon))).toBe(before);
    expect(bytesToHex(canon)).toBe(before);
  });

  it('refuses anything but 32 bytes', () => {
    expect(() => scReduce32(new Uint8Array(31))).toThrow(MoneroKeyError);
    expect(() => scReduce32(new Uint8Array(64))).toThrow(MoneroKeyError);
  });

  it('Hs is keccak-256 (original Keccak), not SHA3-256', () => {
    const spend = hexToBytes('bfafd1eb0e43da200c5c11537d355e458e7c326b3bc1b19f4546573d6bac9d0f');
    expect(bytesToHex(hashToScalar(spend))).toBe('b92e5bd93ac8b259bd0e08417af9d7ed45a50a1548c2907c66ed7dd3e8436500');
    expect(bytesToHex(scReduce32(keccak_256(spend)))).toBe(bytesToHex(hashToScalar(spend)));
    expect(bytesToHex(scReduce32(sha3_256(spend)))).not.toBe(bytesToHex(hashToScalar(spend)));
  });
});

describe('refusals', () => {
  it('a spend key that reduces to zero is refused, not used', () => {
    expect(() => moneroKeysFromSpendKey(new Uint8Array(32))).toThrow(MoneroKeyError);
    expect(() => moneroKeysFromSpendKey(lLittleEndian())).toThrow(/zero/);
  });

  it('a spend key of the wrong length is refused', () => {
    expect(() => moneroKeysFromSpendKey(new Uint8Array(33).fill(1))).toThrow(MoneroKeyError);
  });

  it('an invalid BIP39 phrase is refused instead of deriving an empty wallet', () => {
    // Bad checksum.
    expect(() => moneroKeysFromBip39(Array(12).fill('abandon').join(' '))).toThrow(/Invalid recovery phrase/);
    // A 25-word Monero seed handed to the BIP39 path by mistake.
    expect(() =>
      moneroKeysFromBip39(
        'adjust mugged vaults atlas nasty mews damp toenail suddenly toxic possible framed succeed fuzzy return demonstrate nucleus album noises peculiar virtual rowboat inorganic jester fuzzy',
      ),
    ).toThrow(MoneroKeyError);
  });

  it('an unknown scheme and a bad account are refused', () => {
    expect(() => moneroKeysFromBip39(ABANDON_12, '', 'exodus' as Bip39MoneroScheme)).toThrow(/scheme/);
    expect(() => moneroKeysFromBip39Account(ABANDON_12, '', 'cake-exodus', -1)).toThrow(MoneroKeyError);
    expect(() => moneroKeysFromBip39Account(ABANDON_12, '', 'cake-exodus', 0x80000000)).toThrow(MoneroKeyError);
    expect(() => moneroKeysFromBip39Account(ABANDON_12, '', 'cake-exodus', 1.5)).toThrow(MoneroKeyError);
  });

  it('bad 25 words throw MoneroMnemonicError through the key layer', () => {
    expect(() => moneroKeysFromLegacyWords('abbey abbey abbey')).toThrow(MoneroMnemonicError);
  });
});

describe('key hygiene', () => {
  it('moneroKeysFromSpendKey copies its input; zeroing the result leaves the caller alone', () => {
    const input = hexToBytes('482700617ba810f94035d7f4d7ccc1a29878e165b4867872b705204c85406906');
    const k = moneroKeysFromSpendKey(input);
    expect(k.spendSec).not.toBe(input);
    zeroMoneroKeys(k);
    expect(bytesToHex(input)).toBe('482700617ba810f94035d7f4d7ccc1a29878e165b4867872b705204c85406906');
  });

  it('zeroMoneroKeys zeroes all four keys in place', () => {
    const k = moneroKeysFromBip39(ABANDON_12);
    zeroMoneroKeys(k);
    for (const b of [k.spendSec, k.viewSec, k.spendPub, k.viewPub]) {
      expect(b.every((x) => x === 0)).toBe(true);
    }
  });
});

describe('moneroCacheSecrets (design §6.5)', () => {
  // Expected values computed independently with Node's crypto.hkdfSync
  // ('sha256', spend, 'satori-go/monero/v1', info, 32), not with this code.
  it('pins HKDF-SHA256(spend, "satori-go/monero/v1", "cache" | "wallet2")', () => {
    const s = moneroCacheSecrets(moneroKeysFromBip39(ABANDON_12));
    expect(bytesToHex(s.cacheKey)).toBe('e2279b9b58216378124fdb6d30362437f6f11ed83b13a14edf5099bb7053f7ee');
    expect(s.wallet2Password).toBe('edbe5489e1263e7be19a74467c1db3ead5835e120e9b526242cb6a4adea1a0e0');

    const imported = moneroKeysFromSpendKey(
      hexToBytes('482700617ba810f94035d7f4d7ccc1a29878e165b4867872b705204c85406906'),
    );
    const t = moneroCacheSecrets(imported);
    expect(bytesToHex(t.cacheKey)).toBe('afd8bea33f6e2d41975316ff6a15d0f62684cc09afed462c86ca3dce462f073a');
    expect(t.wallet2Password).toBe('a5d1efd6c09cb4544c28e42ad7625a4db0d022e54db860dfde4cffedb962c285');
  });

  it('is deterministic, and the two secrets are independent', () => {
    const a = moneroCacheSecrets(moneroKeysFromBip39(ABANDON_12));
    const b = moneroCacheSecrets(moneroKeysFromBip39(ABANDON_12));
    expect(bytesToHex(a.cacheKey)).toBe(bytesToHex(b.cacheKey));
    expect(a.wallet2Password).toBe(b.wallet2Password);
    expect(a.wallet2Password).toMatch(/^[0-9a-f]{64}$/);
    expect(a.wallet2Password).not.toBe(bytesToHex(a.cacheKey));
  });

  it('refuses zeroed keys (a locked wallet must not yield a cache key)', () => {
    const k = moneroKeysFromBip39(ABANDON_12);
    zeroMoneroKeys(k);
    expect(() => moneroCacheSecrets(k)).toThrow(MoneroKeyError);
  });
});
