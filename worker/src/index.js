import { handleStatus } from './routes/status.js';
import { handleVote } from './routes/vote.js';
import { handleAdminResults } from './routes/admin.js';
import { withCors, handlePreflight } from './lib/cors.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return handlePreflight(request, env);

    let response;
    if (pathname === '/api/status' && request.method === 'GET') {
      response = await handleStatus(request, env);
    } else if (pathname === '/api/vote' && request.method === 'POST') {
      response = await handleVote(request, env);
    } else if (pathname === '/admin/results' && request.method === 'GET') {
      response = await handleAdminResults(request, env);
    } else {
      response = new Response('No encontrado', { status: 404 });
    }

    return withCors(response, request, env);
  }
};
