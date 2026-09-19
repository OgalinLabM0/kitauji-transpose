import { createHash } from 'node:crypto';
import { CHARACTER_PRE_READ_PROMPT, EVENT_PRE_READ_PROMPT } from './prompts/preReadPrompt';
import { TERM_SELECTION_INSTRUCTION } from './prompts/termSelectionPrompt';
import { TERM_EXTRACT_PROMPT } from './prompts/termPrompts';

/** Bump the protocol revision when parser/write semantics change without prompt changes.
 * Terms certify extraction only: existing translation proposals are not rerun by extraction. */
const contracts = {
  preread: ['split-preread-literal-name-review-v11', CHARACTER_PRE_READ_PROMPT, EVENT_PRE_READ_PROMPT],
  terms: ['term-extraction-reviewed-names-v3', TERM_EXTRACT_PROMPT, TERM_SELECTION_INSTRUCTION],
} as const;
export const preparationContract = (kind: keyof typeof contracts): string =>
  createHash('sha256').update(JSON.stringify(contracts[kind])).digest('hex');

// Exact, one-way compatibility for surface-name and independently reviewed name boundaries.
// Earlier successfully validated observations retain identical factual meaning;
// new normalization only accepts responses the earlier parser rejected. This
// does not re-sign any receipt or exempt source, identity or event dependencies.
// A future prompt/parser contract gets no inherited compatibility automatically.
const nameReviewRevision = '74b53d5a3d6259aa8f046094608092dac69cfce0714099abe5fc7a390b24e4bc';
const surfaceNameRevision = {
  previous: '3f0d3e16def7f74832ab72fab53e7ac5c703af0b7cc7d85e4b84152a86e57a84',
  current: '24e293a6ff2ee337b149d4457ddd5e453d2ef9e1d729eca461a05e92cb19309d',
};
export function compatiblePreparationContracts(kind: keyof typeof contracts, current = preparationContract(kind)): readonly string[] {
  if (kind === 'terms' && current === '836ab0a5642137ff9d7c6c0772101c4f0bab9c6ee3b4f8a17893b5c68e8af9ef') return [current, 'a35b122cdd1886e3606285f0020e4b97588efaef88afca31e55929cc8d865486'];
  // Earlier successful facts remain valid; compatibility does not assert that
  // earlier runs performed the newly added semantic review for generic shapes.
  if (kind === 'preread' && current === '0f5c24209d3cd26c4a977c24825dbc3c0526db189c8a1ee2e20598ea68788c5a') return [current, nameReviewRevision, surfaceNameRevision.current, surfaceNameRevision.previous];
  if (kind === 'preread' && current === nameReviewRevision) return [current, surfaceNameRevision.current, surfaceNameRevision.previous];
  return kind === 'preread' && current === surfaceNameRevision.current ? [current, surfaceNameRevision.previous] : [current];
}
export function preparationContractAccepted(kind: keyof typeof contracts, recorded: unknown): boolean {
  return typeof recorded === 'string' && compatiblePreparationContracts(kind).includes(recorded);
}
