import {createPostgresTripReviewRepository} from './postgres-trip-review-repository';
import {createTripOperationalReviewProvider} from './trip-operational-review-provider';

type Client = Parameters<typeof createPostgresTripReviewRepository>[0];
type Target = Parameters<typeof createPostgresTripReviewRepository>[1];

/** Composes the production read boundary for a server that supplies a reviewed client and cookie name. */
export function createCookieAuthenticatedTripReviewProvider(client: Client, target: Target, cookieName: string) {
  if (!/^__Host-[A-Za-z0-9_-]+$/.test(cookieName)) throw new Error('Invalid operational session cookie name');

  return createTripOperationalReviewProvider(target.authority,createPostgresTripReviewRepository(client,target,request=>{
    const cookies=request.headers.get('cookie');
    if (!cookies || cookies.includes(',')) return null;

    let token: string|null = null;
    for (const pair of cookies.split(';')) {
      const field=pair.trimStart();
      const equals=field.indexOf('=');
      const name=(equals===-1 ? field : field.slice(0,equals)).trimEnd();
      if (name!==cookieName) continue;

      if (token!==null || equals!==cookieName.length) return null;
      const value=field.slice(equals+1);
      if (!/^[a-f0-9]{64}$/.test(value)) return null;
      token=value;
    }
    return token;
  }));
}
