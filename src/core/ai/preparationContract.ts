import { createHash } from 'node:crypto';
import { CHARACTER_PRE_READ_PROMPT, EVENT_PRE_READ_PROMPT } from './prompts/preReadPrompt';
import { TERM_SELECTION_INSTRUCTION } from './prompts/termSelectionPrompt';
import { TERM_EXTRACT_PROMPT } from './prompts/termPrompts';

/** Bump the protocol revision when parser/write semantics change without prompt changes.
 * Terms certify extraction only: existing translation proposals are not rerun by extraction. */
const contracts = {
  preread: ['split-preread-identity-dependencies-v9', CHARACTER_PRE_READ_PROMPT, EVENT_PRE_READ_PROMPT],
  terms: ['term-extraction-selection-v2', TERM_EXTRACT_PROMPT, TERM_SELECTION_INSTRUCTION],
} as const;
export const preparationContract = (kind: keyof typeof contracts): string =>
  createHash('sha256').update(JSON.stringify(contracts[kind])).digest('hex');

// Exact, one-way compatibility for the surface-name instruction correction.
// Earlier successfully validated observations retain identical factual meaning;
// new normalization only accepts responses the earlier parser rejected. This
// does not re-sign any receipt or exempt source, identity or event dependencies.
// A future prompt/parser contract gets no inherited compatibility automatically.
const surfaceNameRevision = {
  previous: '3f0d3e16def7f74832ab72fab53e7ac5c703af0b7cc7d85e4b84152a86e57a84',
  current: '24e293a6ff2ee337b149d4457ddd5e453d2ef9e1d729eca461a05e92cb19309d',
};
export function compatiblePreparationContracts(kind: keyof typeof contracts, current = preparationContract(kind)): readonly string[] {
  return kind === 'preread' && current === surfaceNameRevision.current ? [current, surfaceNameRevision.previous] : [current];
}
export function preparationContractAccepted(kind: keyof typeof contracts, recorded: unknown): boolean {
  return typeof recorded === 'string' && compatiblePreparationContracts(kind).includes(recorded);
}
