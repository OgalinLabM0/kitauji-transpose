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
