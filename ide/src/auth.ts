// Config + auth for the IDE. Reuses the PWA's Cognito session (same origin,
// same localStorage) and the same token API.
import {
  CognitoUserPool,
  CognitoUser,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js'

export interface AppConfig {
  tokenApiUrl: string
  region: string
  userPoolId: string
  userPoolClientId: string
}

export async function loadConfig(): Promise<AppConfig> {
  const resp = await fetch('./config.json', { cache: 'no-store' })
  if (!resp.ok) throw new Error(`config ${resp.status}`)
  return resp.json()
}

function pool(cfg: AppConfig): CognitoUserPool {
  return new CognitoUserPool({ UserPoolId: cfg.userPoolId, ClientId: cfg.userPoolClientId })
}

// A valid ID token from the existing session, refreshing if needed.
export function getIdToken(cfg: AppConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const user: CognitoUser | null = pool(cfg).getCurrentUser()
    if (!user) return reject(new Error('Not signed in — sign in via the terminal app first.'))
    user.getSession((err: Error | null, session: CognitoUserSession) => {
      if (err) return reject(err)
      if (!session.isValid()) return reject(new Error('Session expired — sign in again.'))
      resolve(session.getIdToken().getJwtToken())
    })
  })
}

export async function fetchToken(
  cfg: AppConfig,
  jwt: string,
): Promise<{ authToken: string; endpoint: string }> {
  const resp = await fetch(cfg.tokenApiUrl, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!resp.ok) throw new Error(`token API ${resp.status}`)
  const data = await resp.json()
  return { authToken: data.authToken, endpoint: data.endpoint }
}
