// Exposes the workbench's Cognito session to VS Code as an authentication
// provider, so the Accounts menu and extensions see the signed-in Bivack user.
import * as vscode from 'vscode'
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js'
import type { AppConfig } from './auth'

const PROVIDER_ID = 'bivack'
const PROVIDER_LABEL = 'Bivack'

function makePool(config: AppConfig): CognitoUserPool {
  return new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.userPoolClientId })
}

function getCognitoSession(user: CognitoUser): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.getSession((err: Error | null, session: CognitoUserSession) =>
      err ? reject(err) : resolve(session),
    )
  })
}

interface IdTokenClaims {
  sub: string
  email?: string
  'cognito:username'?: string
}

function toAuthenticationSession(
  session: CognitoUserSession,
  fallbackLabel: string,
): vscode.AuthenticationSession | null {
  if (!session.isValid()) return null
  const idToken = session.getIdToken()
  const claims = idToken.decodePayload() as unknown as IdTokenClaims
  const label = claims.email ?? claims['cognito:username'] ?? fallbackLabel
  return {
    id: claims.sub,
    accessToken: idToken.getJwtToken(),
    account: { id: claims.sub, label },
    scopes: [],
  }
}

class BivackAuthProvider implements vscode.AuthenticationProvider {
  private sessions: vscode.AuthenticationSession[] = []
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()
  readonly onDidChangeSessions = this.changeEmitter.event

  constructor(private readonly config: AppConfig) {}

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const user = makePool(this.config).getCurrentUser()
    if (!user) {
      this.sessions = []
      return this.sessions
    }
    try {
      const session = toAuthenticationSession(await getCognitoSession(user), 'Bivack user')
      this.sessions = session ? [session] : []
    } catch {
      this.sessions = []
    }
    return this.sessions
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const email = await vscode.window.showInputBox({
      prompt: 'Bivack email',
      ignoreFocusOut: true,
    })
    if (!email) throw new Error('Sign-in cancelled')

    const password = await vscode.window.showInputBox({
      prompt: 'Bivack password',
      password: true,
      ignoreFocusOut: true,
    })
    if (!password) throw new Error('Sign-in cancelled')

    const user = new CognitoUser({ Username: email, Pool: makePool(this.config) })
    const session = await new Promise<CognitoUserSession>((resolve, reject) => {
      user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
        onSuccess: resolve,
        onFailure: reject,
        newPasswordRequired: () =>
          reject(new Error('Your password must be changed on the web login first.')),
      })
    })

    const authSession = toAuthenticationSession(session, email)
    if (!authSession) throw new Error('Cognito returned an invalid session')

    this.sessions = [authSession]
    this.changeEmitter.fire({ added: [authSession], removed: [], changed: [] })
    return authSession
  }

  async removeSession(sessionId: string): Promise<void> {
    makePool(this.config).getCurrentUser()?.signOut()
    const removed = this.sessions.filter((session) => session.id === sessionId)
    this.sessions = this.sessions.filter((session) => session.id !== sessionId)
    this.changeEmitter.fire({ added: [], removed, changed: [] })
  }

  dispose(): void {
    this.changeEmitter.dispose()
  }
}

export function registerBivackAuth(config: AppConfig): void {
  try {
    vscode.authentication.registerAuthenticationProvider(
      PROVIDER_ID,
      PROVIDER_LABEL,
      new BivackAuthProvider(config),
    )
  } catch (e) {
    console.warn('Bivack: could not register the authentication provider', e)
  }
}
