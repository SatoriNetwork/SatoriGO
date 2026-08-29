// The three recipient warnings, rendered identically on both send screens
// (UTXO: LiveSend, EVM: LiveSendEvm) and on both their steps (form and
// review). Presentation only: every decision was already made by
// `assessRecipient` (services/recipientRisk.ts) and, for the contract check,
// by the store's `isEvmContractAddress`.
//
// NONE of these blocks a send. The wallet is non-custodial: it says what it
// knows and the user decides. Ordered most severe first, because on a short
// screen the first banner is the one that gets read.

import type { CSSProperties } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

export interface RecipientRiskBannersProps {
  /** Recipient not in my wallets, my address book, or my history. */
  firstTime: boolean;
  /** Short form of the known address this recipient imitates, or null. */
  lookalikeOf: string | null;
  /** EVM only: eth_getCode says there is code at this address. Never true on
   *  a UTXO chain, where the screen simply never passes it. */
  isContract?: boolean;
  /** Bottom margin of the block, matching the surrounding form or review. */
  style?: CSSProperties;
}

export function RecipientRiskBanners({
  firstTime,
  lookalikeOf,
  isContract = false,
  style,
}: RecipientRiskBannersProps) {
  if (!firstTime && !lookalikeOf && !isContract) return null;
  return (
    <div style={style}>
      {lookalikeOf && (
        <div
          className="banner danger"
          data-testid="live-send-lookalike"
          style={{ alignItems: 'flex-start', marginBottom: 10 }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            This address looks like one you have used before ({lookalikeOf}) but it is not the same.
            Address poisoning scams rely on that; compare every character before you send.
          </span>
        </div>
      )}
      {isContract && (
        <div
          className="banner warning"
          data-testid="live-send-contract"
          style={{ alignItems: 'flex-start', marginBottom: 10 }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            This address is a contract, not a wallet. Coins or tokens sent to a contract are usually
            lost unless it is built to receive them.
          </span>
        </div>
      )}
      {firstTime && (
        <div
          className="banner info"
          data-testid="live-send-first-time"
          style={{ alignItems: 'flex-start', marginBottom: 10 }}
        >
          <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            First time sending to this address. Check every character: a sent transaction cannot be
            reversed.
          </span>
        </div>
      )}
    </div>
  );
}
