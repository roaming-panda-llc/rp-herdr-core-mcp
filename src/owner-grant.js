import { jwtVerify } from 'jose';
import { makeAuthenticatedHttpApp } from './server.js';

// The operator supplies the trusted issuer's public key; never resolve keys
// from token headers. This is validation, not an OAuth authorization server.
export function makeOwnerGrantApp(core, config, { issuer, audience, subject, publicKey, grantIsOn, advertiseResource = false }) {
  if (new URL(issuer).protocol !== 'https:' ||
      ![issuer, audience, subject].every(v => typeof v === 'string' && v.trim() === v && v.length) ||
      publicKey?.type !== 'public' || publicKey.algorithm?.name !== 'RSASSA-PKCS1-v1_5' ||
      typeof grantIsOn !== 'function' || config.events?.enabled) throw new Error('Invalid isolated owner grant configuration');

  const resourceMetadata = advertiseResource ? { resource: audience, authorization_servers: [issuer] } : undefined;
  const challenge = resourceMetadata
    ? `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', audience).href}"`
    : 'Bearer';
  return makeAuthenticatedHttpApp(core, config, async (req, res, next) => {
    const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    let claims;
    try {
      if (!token) throw new Error('Missing token');
      ({ payload: claims } = await jwtVerify(token, publicKey, {
        algorithms: ['RS256'], typ: 'at+jwt', issuer, audience,
        requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '5m',
      }));
    } catch {
      return res.status(401).set('WWW-Authenticate', challenge).end();
    }
    // Read the operator's grant on each request, not from a token or client header.
    if (claims.sub !== subject) return res.status(403).end();
    try {
      if (await grantIsOn() !== true) return res.status(403).end();
    } catch {
      return res.status(403).end();
    }
    next();
  }, `owner:${JSON.stringify([issuer, subject])}`, resourceMetadata);
}
