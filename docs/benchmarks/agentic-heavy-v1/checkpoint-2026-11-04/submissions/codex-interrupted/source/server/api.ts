import { ApiError, json } from './common';
import { authRoutes, getContext, workspaceAuthRoutes } from './data';
import { businessRoutes } from './routes';

export async function handleApi(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ok:true});
    const authResponse = await authRoutes(request, url);
    if (authResponse) return authResponse;
    const match = url.pathname.match(/^\/api\/w\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      let workspaceId: string;
      let segments: string[];
      try { workspaceId = decodeURIComponent(match[1]); segments = (match[2] || '').split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new ApiError(400, 'invalid_path', 'The URL contains an invalid path.'); }
      const ctx = getContext(request, workspaceId);
      const memberResponse = await workspaceAuthRoutes(request, url, ctx, segments);
      if (memberResponse) return memberResponse;
      const response = await businessRoutes(request, url, ctx, segments);
      if (response) return response;
    }
    throw new ApiError(404, 'not_found', 'This API endpoint does not exist.');
  } catch (error) {
    if (error instanceof ApiError) return json({error:{code:error.code,message:error.message}}, error.status);
    // Never print request bodies, cookies, credentials or invite tokens.
    console.error('API request failed:', error instanceof Error ? error.name : 'Unknown error');
    return json({error:{code:'internal_error',message:'The request could not be completed. Please try again.'}},500);
  }
}
