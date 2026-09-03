import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import {
  accountPersistenceAllowsSubject,
  resolveAccountPersistencePolicy,
} from '../../../../integration/account-persistence-release.mjs';
import {
  accountSiteConfig,
  createPreparedSiteEndpoint,
} from '../../../../integration/site-runtime.mjs';

export const dynamic = 'force-dynamic';

type MeshfulRuntimeBindings = {
  DB?: unknown;
  ASSETS?: unknown;
  MESHFUL_ACCOUNT_PERSISTENCE_MODE?: unknown;
  MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS?: unknown;
};

const runtime = env as MeshfulRuntimeBindings;
const accountPolicy = resolveAccountPersistencePolicy(
  runtime.MESHFUL_ACCOUNT_PERSISTENCE_MODE,
  runtime.MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS,
);

// Sites supplies the logical DB binding declared in .openai/hosting.json. This
// resolver exists only inside the generated Sites server route and calls the
// platform helper once for this request. Raw request headers never enter the
// identity decision; email and name remain display-only.
async function resolveTrustedSitesRequest() {
  const user = await getChatGPTUser();
  return user === null || !accountPersistenceAllowsSubject(
    runtime.MESHFUL_ACCOUNT_PERSISTENCE_MODE,
    runtime.MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS,
    user.userId,
  )
    ? { trusted: true, authenticated: false } as const
    : { trusted: true, authenticated: true, subject: user.userId } as const;
}

const database = runtime.DB ?? null;
const assets = runtime.ASSETS ?? null;
const learnerEndpoint = createPreparedSiteEndpoint({
  database,
  assets,
  activation: accountPolicy.enabled
    ? { ...accountSiteConfig, allowProvisioning: accountPolicy.allowProvisioning,
      resolveTrustedSitesRequest }
    : null,
});

async function handleLearnerRequest(request: Request): Promise<Response> {
  const response = await learnerEndpoint.handle(request);
  // The account boundary can reject a POST before Backend needs its body. Mark
  // that stream handled before Vinext returns the response so its post-response
  // drain cannot restart the Worker while trying to read an untouched stream.
  if (request.body && !request.bodyUsed && !request.body.locked)
    await request.body.cancel();
  return response;
}

export const GET = handleLearnerRequest;
export const POST = handleLearnerRequest;
