import { Genome } from '../shared/types.js';
import { genomeToSystemPrompt } from './genome.js';

/**
 * Build a prompt structure from the agent's genome and a user message.
 * Returns system prompt (persona) and user message separately.
 */
export function buildPrompt(
  genome: Genome,
  userMessage: string,
): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt: genomeToSystemPrompt(genome),
    userMessage,
  };
}
