import { votingState } from '../lib/window.js';
import { readCookie, VOTER_COOKIE } from '../lib/cookies.js';

export async function handleStatus(request, env) {
  const state = votingState(env);
  const voterId = readCookie(request, VOTER_COOKIE);

  let hasVoted = false;
  if (voterId) {
    const row = await env.DB
      .prepare("SELECT 1 AS found FROM votes WHERE voter_id = ? AND status = 'valid' LIMIT 1")
      .bind(voterId)
      .first();
    hasVoted = row !== null;
  }

  // Resultados sellados (§3): nunca se devuelve a quién votó.
  return Response.json(
    {
      state,
      open: state === 'open',
      opens_at: env.VOTING_OPEN,
      closes_at: env.VOTING_CLOSE,
      has_voted: hasVoted
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
