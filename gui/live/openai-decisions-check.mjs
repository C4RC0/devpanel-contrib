/*
 * Live check of the OpenAI Decisions API provider (decisions/openai.yaml): the
 * same ONE request, retries off, and the same three questions as --jev, through
 * the OpenAI client (server/decisions/openai.mjs).
 *
 *   npm run live -- --openai-decisions --plan
 *   DEVPANEL_LIVE=1 npm run live -- --openai-decisions
 *
 * An operator runs it once a key is
 * placed at decisions/openai.yaml's credentialRef (file:~/.config/openai/key of
 * the service user). It needs a real API key; a ChatGPT login does not grant
 * API access. It checks the provider whether or not decisions/active.yaml
 * selects it.
 *
 * It passes when the key is accepted and the response, translated back, satisfies
 * the contract. Whether the answers are the obvious ones is reported beside that.
 * Whether the response carries `usage` is recorded in the report (`record.usage`):
 * the guide does not show one, and this is where it is observed.
 */
import { runJevCheck } from './jev-check.mjs'

export const plan = [
  '1. load decisions/openai.yaml and read the key from its credentialRef   (free)',
  '2. ONE request to the OpenAI Decisions API with three questions (a choice, a predicate, a score); retries off',
  '3. translate the answers back and check them against the questions asked; record whether usage was reported'
]

export const runOpenAIDecisionsCheck = ({ log }) => runJevCheck({ log, providerId: 'openai', flag: '--openai-decisions' })
