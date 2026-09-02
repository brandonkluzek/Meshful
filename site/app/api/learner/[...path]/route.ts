import { env } from 'cloudflare:workers';
import { createSiteRequestHandler } from '../../../../integration/site-runtime.mjs';

export const dynamic = 'force-dynamic';

const handler = createSiteRequestHandler({
  database: env.DB ?? null,
  accountActivation: env.MESHFUL_ACCOUNT_SYNC ?? null,
  allowedOrigin: env.MESHFUL_ALLOWED_ORIGIN ?? null,
});

export const GET = (request: Request) => handler.handle(request);
export const POST = (request: Request) => handler.handle(request);
