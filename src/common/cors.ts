import type { FastifyCorsOptions } from '@fastify/cors';

/**
 * CORS : seules les adresses listées dans CORS_ORIGINS (séparées par des virgules) sont autorisées ; liste vide = aucune.
 * `Retry-After` est exposé : sans cela, le navigateur le cache au code JavaScript du front, qui ne peut alors pas
 * dire « réessayez dans 30 secondes » après une réponse 429 (trop de requêtes).
 */
export function corsOptions(origins: string): FastifyCorsOptions {
  const list = origins.split(',').map((s) => s.trim()).filter(Boolean);
  return { origin: list.length ? list : false, credentials: true,
    // Par défaut @fastify/cors n'autorise que GET, HEAD, POST : le navigateur bloquerait PATCH / PUT / DELETE (modifier, publier, supprimer).
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], exposedHeaders: ['Retry-After'] };
}
