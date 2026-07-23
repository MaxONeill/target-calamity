/**
 * GestaltButton — the `[ Enter Gestalt Channel ]` action (spec §7 "Gestalt
 * Integration" / v3.2).
 *
 * SPEC DEVIATION (ADR / comprehensive §8 Roadmap): the spec prose describes this
 * button as "executing a deep-link handover" that connects the user's local P2P
 * node to a cryptographic channel topic. That entire integration is Phase 2
 * ROADMAP — no Gestalt protocol, handler, or transport exists in this codebase,
 * and `gestalt_channel_address` is null until assigned. Shipping a button that
 * LOOKS live but silently no-ops would be dishonest on a product whose whole
 * credibility rests on not overclaiming. So we render it permanently disabled,
 * explicitly tagged "PHASE 2", with a plain-language explanation. It deep-links
 * nowhere and does not pretend to.
 */
import type { FC } from 'react';

export interface GestaltButtonProps {
  /**
   * The factor's Gestalt channel anchor. In Phase 1 this is effectively always
   * null (the column is unpopulated); we accept it so the Phase 2 wiring has a
   * seam to attach to, but it does not enable the button today.
   */
  channelAddress: string | null;
}

export const GestaltButton: FC<GestaltButtonProps> = ({ channelAddress }) => {
  // Even when an address is present, the action is inert in Phase 1: there is no
  // handler to hand off to. Disabled is the only honest state.
  const hasAddress = channelAddress !== null && channelAddress.length > 0;

  return (
    <div className="tc-gestalt">
      <button
        type="button"
        className="tc-gestalt__btn"
        disabled
        aria-disabled="true"
        title={
          hasAddress
            ? 'Gestalt trust-graph hand-off is a Phase 2 feature — not yet available.'
            : 'No Gestalt channel assigned. Trust-graph hand-off arrives in Phase 2.'
        }
      >
        [ Enter Gestalt Channel ]
      </button>
      <span className="tc-gestalt__tag" aria-hidden="true">
        PHASE 2
      </span>
    </div>
  );
};

export default GestaltButton;
