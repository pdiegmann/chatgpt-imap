import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server as HttpServer } from "node:http";
import { dirname, join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import express, { type Express, type Request, type Response } from "express";
import { timingSafeTokenEqual } from "../utils/crypto.js";
import { logger } from "../utils/logging.js";

const SUPPORTED_SCOPES = ["mcp:tools"] as const;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = "mcp_oauth_session";

type ServerFactory = () => McpServer;

type AuthSession = {
  id: string;
  csrfToken: string;
  expiresAt: number;
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: URL;
  expiresAt: number;
};

type TokenRecord = {
  clientId: string;
  scopes: string[];
  resource: URL;
  expiresAt: number;
  revoked: boolean;
};

type ParsedAuthorizationRequest = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  formFields: Record<string, string>;
};

type AuthorizeContext = {
  provider: SingleUserOAuthProvider;
  sessions: Map<string, AuthSession>;
  authorizePath: string;
  publicBaseUrl: URL;
  mcpServerUrl: URL;
  oauthPassword?: string;
};

class PersistentClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    let data: string;
    try {
      data = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        logger.warn("Failed to read OAuth clients store file", {
          error: String(error),
          file: this.filePath,
        });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      logger.warn("OAuth clients store file contains invalid JSON; ignoring", {
        error: String(error),
        file: this.filePath,
      });
      return;
    }

    if (!Array.isArray(parsed)) {
      logger.warn(
        "OAuth clients store file has unexpected format; ignoring",
        { file: this.filePath },
      );
      return;
    }

    let loaded = 0;
    for (const item of parsed) {
      const record = item as Record<string, unknown>;
      if (
        item !== null &&
        typeof item === "object" &&
        typeof record.client_id === "string" &&
        Array.isArray(record.redirect_uris) &&
        (record.redirect_uris as unknown[]).every((u) => typeof u === "string")
      ) {
        const client = item as OAuthClientInformationFull;
        this.clients.set(client.client_id, client);
        loaded++;
      } else {
        logger.warn("Skipping invalid OAuth client record in persistent store", {
          file: this.filePath,
        });
      }
    }
    logger.info("Loaded OAuth clients from persistent store", {
      count: loaded,
      file: this.filePath,
    });
  }

  private save(): void {
    const dir = dirname(this.filePath);
    const tmpPath = join(dir, `.oauth_clients_tmp_${randomUUID()}.json`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        tmpPath,
        JSON.stringify([...this.clients.values()], null, 2),
        "utf8",
      );
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      logger.warn("Failed to save OAuth clients to persistent store", {
        error: String(error),
        file: this.filePath,
      });
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup of temp file
      }
    }
  }

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): Promise<OAuthClientInformationFull> {
    const tokenEndpointAuthMethod = client.token_endpoint_auth_method ?? "none";
    const registeredClient: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret:
        tokenEndpointAuthMethod === "none" ? undefined : randomUUID(),
      client_secret_expires_at:
        tokenEndpointAuthMethod === "none" ? undefined : 0,
      grant_types: client.grant_types ?? [
        "authorization_code",
        "refresh_token",
      ],
      response_types: client.response_types ?? ["code"],
    };

    this.clients.set(registeredClient.client_id, registeredClient);
    this.save();
    return registeredClient;
  }
}

class SingleUserOAuthProvider implements OAuthServerProvider {
  public readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly authorizationCodes = new Map<
    string,
    AuthorizationCodeRecord
  >();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();

  constructor(
    private readonly resourceServerUrl: URL,
    private readonly accessTokenTtlSeconds: number,
    private readonly refreshTokenTtlSeconds: number,
    clientsStore: OAuthRegisteredClientsStore,
  ) {
    this.clientsStore = clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.validateRedirectUri(client, params.redirectUri);
    const scopes = normalizeScopes(params.scopes);
    const resource = normalizeRequestedResource(
      params.resource,
      this.resourceServerUrl,
    );

    const code = randomUUID();
    this.authorizationCodes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      resource,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const targetUrl = new URL(params.redirectUri);
    targetUrl.searchParams.set("code", code);
    if (params.state) {
      targetUrl.searchParams.set("state", params.state);
    }

    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.getAuthorizationCodeRecord(client, authorizationCode)
      .codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.getAuthorizationCodeRecord(client, authorizationCode);

    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError(
        "redirect_uri does not match the original request",
      );
    }

    if (resource && resource.toString() !== record.resource.toString()) {
      throw new InvalidTargetError(
        "resource does not match the original request",
      );
    }

    this.authorizationCodes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.scopes, record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.revoked) {
      throw new InvalidGrantError("refresh token is invalid or revoked");
    }

    if (record.expiresAt <= Date.now()) {
      this.refreshTokens.delete(refreshToken);
      throw new InvalidGrantError("refresh token has expired");
    }

    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "refresh token was not issued to this client",
      );
    }

    const requestedScopes = scopes?.length
      ? normalizeScopes(scopes)
      : record.scopes;
    for (const scope of requestedScopes) {
      if (!record.scopes.includes(scope)) {
        throw new InvalidScopeError(
          "requested scope exceeds the original grant",
        );
      }
    }

    const requestedResource = resource
      ? normalizeRequestedResource(resource, this.resourceServerUrl)
      : record.resource;

    if (requestedResource.toString() !== record.resource.toString()) {
      throw new InvalidTargetError(
        "resource does not match the original grant",
      );
    }

    record.revoked = true;
    this.refreshTokens.delete(refreshToken);

    return this.issueTokens(
      client.client_id,
      requestedScopes,
      requestedResource,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token);
    if (!record || record.revoked) {
      throw new InvalidTokenError("access token is invalid or revoked");
    }

    if (record.expiresAt <= Date.now()) {
      this.accessTokens.delete(token);
      throw new InvalidTokenError("access token has expired");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const accessRecord = this.accessTokens.get(request.token);
    if (accessRecord && accessRecord.clientId === client.client_id) {
      accessRecord.revoked = true;
      this.accessTokens.delete(request.token);
    }

    const refreshRecord = this.refreshTokens.get(request.token);
    if (refreshRecord && refreshRecord.clientId === client.client_id) {
      refreshRecord.revoked = true;
      this.refreshTokens.delete(request.token);
    }
  }

  private getAuthorizationCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.authorizationCodes.get(authorizationCode);
    if (!record) {
      throw new InvalidGrantError("authorization code is invalid");
    }

    if (record.expiresAt <= Date.now()) {
      this.authorizationCodes.delete(authorizationCode);
      throw new InvalidGrantError("authorization code has expired");
    }

    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "authorization code was not issued to this client",
      );
    }

    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL,
  ): OAuthTokens {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const accessExpiresAt = Date.now() + this.accessTokenTtlSeconds * 1000;
    const refreshExpiresAt = Date.now() + this.refreshTokenTtlSeconds * 1000;

    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: accessExpiresAt,
      revoked: false,
    });

    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: refreshExpiresAt,
      revoked: false,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: this.accessTokenTtlSeconds,
      scope: scopes.join(" "),
    };
  }

  private validateRedirectUri(
    client: OAuthClientInformationFull,
    redirectUri: string,
  ): void {
    if (
      !client.redirect_uris.some((registeredUri) =>
        redirectUriMatches(redirectUri, registeredUri),
      )
    ) {
      throw new InvalidRequestError(
        "redirect_uri is not registered for this client",
      );
    }
  }
}

export async function startHttp(createServer: ServerFactory): Promise<void> {
  const rawPort = parsePositiveInt(process.env.MCP_PORT, 3000);
  const port = rawPort >= 1 && rawPort <= 65535 ? rawPort : 3000;
  const host = process.env.MCP_HOST ?? "0.0.0.0";
  const publicBaseUrl = resolvePublicBaseUrl(port);
  const publicBasePath = normalizeBasePath(publicBaseUrl.pathname);
  const mcpPath = joinPath(publicBasePath, "/mcp");
  const authorizePath = joinPath(publicBasePath, "/authorize");
  const routeMountPath = publicBasePath === "/" ? "/" : publicBasePath;
  const mcpServerUrl = new URL("mcp", ensureTrailingSlash(publicBaseUrl));
  const oauthPassword = process.env.MCP_OAUTH_PASSWORD;

  if (!oauthPassword) {
    logger.error(
      "MCP_OAUTH_PASSWORD must be set when using HTTP transport",
      {},
    );
    process.exit(1);
  }

  const provider = new SingleUserOAuthProvider(
    mcpServerUrl,
    parsePositiveInt(
      process.env.MCP_OAUTH_ACCESS_TOKEN_TTL,
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    ),
    parsePositiveInt(
      process.env.MCP_OAUTH_REFRESH_TOKEN_TTL,
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    ),
    new PersistentClientsStore(
      process.env.MCP_OAUTH_CLIENTS_FILE ?? "./data/oauth_clients.json",
    ),
  );
  const sessions = new Map<string, AuthSession>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const app = createHttpApp(host);
  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [...SUPPORTED_SCOPES],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
  });

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (!isOAuthRequestPath(req.path, publicBasePath, mcpServerUrl)) {
      next();
      return;
    }

    logger.info("OAuth HTTP request", {
      method: req.method,
      path: req.path,
      content_type: getHeaderValue(req.headers["content-type"]),
      content_length: getHeaderValue(req.headers["content-length"]),
      user_agent: getHeaderValue(req.headers["user-agent"]),
    });

    res.on("finish", () => {
      logger.info("OAuth HTTP response", {
        method: req.method,
        path: req.path,
        status_code: res.statusCode,
      });
    });

    next();
  });

  const authContext: AuthorizeContext = {
    provider,
    sessions,
    authorizePath,
    publicBaseUrl,
    mcpServerUrl,
    oauthPassword,
  };

  app.get(authorizePath, async (req, res) => {
    await handleAuthorizeGet(req, res, authContext);
  });

  app.post(
    authorizePath,
    express.urlencoded({ extended: false }),
    async (req, res) => {
      await handleAuthorizePost(req, res, authContext);
    },
  );

  app.use(
    routeMountPath,
    mcpAuthRouter({
      provider,
      issuerUrl: publicBaseUrl,
      resourceServerUrl: mcpServerUrl,
      scopesSupported: [...SUPPORTED_SCOPES],
      resourceName: "chatgpt-imap",
    }),
  );

  app.post(
    mcpPath,
    express.json({ limit: "1mb" }),
    authMiddleware,
    async (req, res) => {
      const sessionId = getHeaderValue(req.headers["mcp-session-id"]);

      try {
        const transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          if (sessionId || !isInitializeRequest(req.body)) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
              },
              id: null,
            });
            return;
          }

          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, newTransport);
            },
          });

          newTransport.onclose = () => {
            if (newTransport.sessionId) {
              transports.delete(newTransport.sessionId);
            }
          };

          const server = createServer();
          await server.connect(newTransport);
          await newTransport.handleRequest(req, res, req.body);
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error("HTTP MCP POST request failed", {
          error: String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    },
  );

  app.get(mcpPath, authMiddleware, async (req, res) => {
    await handleSessionRequest(req, res, transports, "GET");
  });

  app.delete(mcpPath, authMiddleware, async (req, res) => {
    await handleSessionRequest(req, res, transports, "DELETE");
  });

  const httpServer = await listen(app, port, host);
  registerShutdownHandler(httpServer, transports);

  logger.info("MCP server started via HTTP", {
    port,
    host,
    endpoint: mcpPath,
    base_url: publicBaseUrl.toString(),
    authorize_endpoint: authorizePath,
  });
}

async function handleSessionRequest(
  req: Request,
  res: Response,
  transports: Map<string, StreamableHTTPServerTransport>,
  method: "GET" | "DELETE",
): Promise<void> {
  const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
  if (!sessionId) {
    res.status(400).send("Missing mcp-session-id header");
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).send("Invalid session ID");
    return;
  }

  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    logger.error(`HTTP MCP ${method} request failed`, {
      error: String(error),
    });
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
}

async function handleAuthorizeGet(
  req: Request,
  res: Response,
  context: AuthorizeContext,
): Promise<void> {
  try {
    const parsedRequest = await parseAuthorizationRequest(
      req.query as Record<string, unknown>,
      context.provider,
      context.mcpServerUrl,
    );
    const session = getSession(req, res, context.sessions);

    if (!session) {
      renderLoginPage(res, {
        authorizePath: context.authorizePath,
        client: parsedRequest.client,
        formFields: parsedRequest.formFields,
        publicBaseUrl: context.publicBaseUrl,
      });
      return;
    }

    renderConsentPage(res, {
      authorizePath: context.authorizePath,
      client: parsedRequest.client,
      formFields: parsedRequest.formFields,
      session,
      publicBaseUrl: context.publicBaseUrl,
    });
  } catch (error) {
    handleAuthorizationError(res, error);
  }
}

async function handleAuthorizePost(
  req: Request,
  res: Response,
  context: AuthorizeContext,
): Promise<void> {
  try {
    const action = getRequiredString(
      req.body as Record<string, unknown>,
      "action",
    );
    const parsedRequest = await parseAuthorizationRequest(
      req.body as Record<string, unknown>,
      context.provider,
      context.mcpServerUrl,
    );

    if (action === "login") {
      const password = getRequiredString(
        req.body as Record<string, unknown>,
        "password",
      );
      if (!timingSafeTokenEqual(password, context.oauthPassword ?? "")) {
        renderLoginPage(res, {
          authorizePath: context.authorizePath,
          client: parsedRequest.client,
          formFields: parsedRequest.formFields,
          publicBaseUrl: context.publicBaseUrl,
          errorMessage: "Incorrect password",
          statusCode: 401,
        });
        return;
      }

      const session = createSession(
        res,
        context.sessions,
        context.publicBaseUrl,
      );
      renderConsentPage(res, {
        authorizePath: context.authorizePath,
        client: parsedRequest.client,
        formFields: parsedRequest.formFields,
        session,
        publicBaseUrl: context.publicBaseUrl,
      });
      return;
    }

    const session = getSession(req, res, context.sessions);
    if (!session) {
      renderLoginPage(res, {
        authorizePath: context.authorizePath,
        client: parsedRequest.client,
        formFields: parsedRequest.formFields,
        publicBaseUrl: context.publicBaseUrl,
        errorMessage: "Please sign in again",
        statusCode: 401,
      });
      return;
    }

    const csrfToken = getRequiredString(
      req.body as Record<string, unknown>,
      "csrf_token",
    );
    if (csrfToken !== session.csrfToken) {
      res.status(403).send("Invalid CSRF token");
      return;
    }

    if (action === "deny") {
      redirectAuthorizationError(
        res,
        parsedRequest.params.redirectUri,
        parsedRequest.params.state,
        "access_denied",
        "The authorization request was denied",
      );
      return;
    }

    if (action !== "approve") {
      throw new InvalidRequestError("unknown authorization action");
    }

    await context.provider.authorize(
      parsedRequest.client,
      parsedRequest.params,
      res,
    );
  } catch (error) {
    handleAuthorizationError(res, error);
  }
}

async function parseAuthorizationRequest(
  input: Record<string, unknown>,
  provider: SingleUserOAuthProvider,
  mcpServerUrl: URL,
): Promise<ParsedAuthorizationRequest> {
  const responseType = getRequiredString(input, "response_type");
  if (responseType !== "code") {
    throw new InvalidRequestError("response_type must be 'code'");
  }

  const codeChallengeMethod =
    getOptionalString(input, "code_challenge_method") ?? "S256";
  if (codeChallengeMethod !== "S256") {
    throw new InvalidRequestError("code_challenge_method must be 'S256'");
  }

  const clientId = getRequiredString(input, "client_id");
  const redirectUri = getRequiredString(input, "redirect_uri");
  const codeChallenge = getRequiredString(input, "code_challenge");
  const state = getOptionalString(input, "state");
  const scopeString = getOptionalString(input, "scope");
  const scopes = normalizeScopes(scopeString?.split(/\s+/).filter(Boolean));
  const resourceString = getOptionalString(input, "resource");
  const resource = normalizeRequestedResource(
    resourceString ? new URL(resourceString) : undefined,
    mcpServerUrl,
  );

  const client = await provider.clientsStore.getClient(clientId);
  if (!client) {
    throw new InvalidRequestError("unknown client_id");
  }

  if (
    !client.redirect_uris.some((registeredUri) =>
      redirectUriMatches(redirectUri, registeredUri),
    )
  ) {
    throw new InvalidRequestError(
      "redirect_uri is not registered for this client",
    );
  }

  return {
    client,
    params: {
      state,
      scopes,
      codeChallenge,
      redirectUri,
      resource,
    },
    formFields: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      ...(state ? { state } : {}),
      ...(scopeString ? { scope: scopeString } : {}),
      resource: resource.toString(),
    },
  };
}

function normalizeScopes(input?: string[]): string[] {
  const scopes = input?.length ? [...new Set(input)] : [...SUPPORTED_SCOPES];
  for (const scope of scopes) {
    if (
      !SUPPORTED_SCOPES.includes(scope as (typeof SUPPORTED_SCOPES)[number])
    ) {
      throw new InvalidScopeError(`unsupported scope: ${scope}`);
    }
  }
  return scopes;
}

function normalizeRequestedResource(
  requestedResource: URL | undefined,
  mcpServerUrl: URL,
): URL {
  const normalizedResource = requestedResource
    ? resourceUrlFromServerUrl(requestedResource)
    : resourceUrlFromServerUrl(mcpServerUrl);

  if (
    !checkResourceAllowed({
      requestedResource: normalizedResource,
      configuredResource: mcpServerUrl,
    })
  ) {
    throw new InvalidTargetError("requested resource is not allowed");
  }

  return normalizedResource;
}

function handleAuthorizationError(res: Response, error: unknown): void {
  logger.warn("OAuth authorization request failed", {
    error: String(error),
  });

  if (!res.headersSent) {
    res
      .status(400)
      .send(
        renderDocument(
          "Authorization error",
          `<p>${escapeHtml(String(error))}</p>`,
        ),
      );
  }
}

function getSession(
  req: Request,
  res: Response,
  sessions: Map<string, AuthSession>,
): AuthSession | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[COOKIE_NAME];
  if (!sessionId) {
    return undefined;
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    res.clearCookie(COOKIE_NAME, { path: "/" });
    return undefined;
  }

  session.expiresAt = Date.now() + DEFAULT_SESSION_TTL_MS;
  return session;
}

function createSession(
  res: Response,
  sessions: Map<string, AuthSession>,
  publicBaseUrl: URL,
): AuthSession {
  const session: AuthSession = {
    id: randomUUID(),
    csrfToken: randomUUID(),
    expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
  };

  sessions.set(session.id, session);
  res.cookie(COOKIE_NAME, session.id, {
    httpOnly: true,
    secure: publicBaseUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: DEFAULT_SESSION_TTL_MS,
  });

  return session;
}

function renderLoginPage(
  res: Response,
  options: {
    authorizePath: string;
    client: OAuthClientInformationFull;
    formFields: Record<string, string>;
    publicBaseUrl: URL;
    errorMessage?: string;
    statusCode?: number;
  },
): void {
  const clientName = escapeHtml(
    options.client.client_name ?? options.client.client_id,
  );
  const hiddenInputs = renderHiddenInputs(options.formFields);
  const errorBlock = options.errorMessage
    ? `<p style="color:#b91c1c">${escapeHtml(options.errorMessage)}</p>`
    : "";

  res.status(options.statusCode ?? 200).send(
    renderDocument(
      "Sign in",
      `<div style="max-width:480px;margin:48px auto;font-family:system-ui,sans-serif">
        <h1 style="margin-bottom:8px">Sign in</h1>
        <p style="color:#4b5563">Authorize <strong>${clientName}</strong> to access your chatgpt-imap MCP server at ${escapeHtml(options.publicBaseUrl.toString())}.</p>
        ${errorBlock}
        <form method="post" action="${escapeHtml(options.authorizePath)}" style="display:grid;gap:12px;margin-top:20px">
          <input type="hidden" name="action" value="login" />
          ${hiddenInputs}
          <label style="display:grid;gap:6px">
            <span>Password</span>
            <input name="password" type="password" required autofocus style="padding:10px;border:1px solid #d1d5db;border-radius:8px" />
          </label>
          <button type="submit" style="padding:10px 14px;border:0;border-radius:8px;background:#111827;color:white;cursor:pointer">Continue</button>
        </form>
      </div>`,
    ),
  );
}

function renderConsentPage(
  res: Response,
  options: {
    authorizePath: string;
    client: OAuthClientInformationFull;
    formFields: Record<string, string>;
    session: AuthSession;
    publicBaseUrl: URL;
  },
): void {
  const clientName = escapeHtml(
    options.client.client_name ?? options.client.client_id,
  );
  const scopes = escapeHtml(
    options.formFields.scope ?? SUPPORTED_SCOPES.join(" "),
  );
  const hiddenInputs = renderHiddenInputs(options.formFields);

  res.status(200).send(
    renderDocument(
      "Approve access",
      `<div style="max-width:560px;margin:48px auto;font-family:system-ui,sans-serif">
        <h1 style="margin-bottom:8px">Approve access</h1>
        <p style="color:#4b5563"><strong>${clientName}</strong> wants to use your chatgpt-imap MCP server.</p>
        <ul style="color:#111827;line-height:1.6">
          <li>Base URL: ${escapeHtml(options.publicBaseUrl.toString())}</li>
          <li>Scopes: ${scopes}</li>
          <li>Redirect URI: ${escapeHtml(options.formFields.redirect_uri ?? "")}</li>
        </ul>
        <div style="display:flex;gap:12px;margin-top:20px">
          <form method="post" action="${escapeHtml(options.authorizePath)}">
            <input type="hidden" name="action" value="approve" />
            <input type="hidden" name="csrf_token" value="${escapeHtml(options.session.csrfToken)}" />
            ${hiddenInputs}
            <button type="submit" style="padding:10px 14px;border:0;border-radius:8px;background:#111827;color:white;cursor:pointer">Allow</button>
          </form>
          <form method="post" action="${escapeHtml(options.authorizePath)}">
            <input type="hidden" name="action" value="deny" />
            <input type="hidden" name="csrf_token" value="${escapeHtml(options.session.csrfToken)}" />
            ${hiddenInputs}
            <button type="submit" style="padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;background:white;color:#111827;cursor:pointer">Deny</button>
          </form>
        </div>
      </div>`,
    ),
  );
}

function renderHiddenInputs(formFields: Record<string, string>): string {
  return Object.entries(formFields)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`,
    )
    .join("");
}

function renderDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="background:#f9fafb;color:#111827;margin:0;padding:24px">${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redirectAuthorizationError(
  res: Response,
  redirectUri: string,
  state: string | undefined,
  error: string,
  errorDescription: string,
): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", errorDescription);
  if (state) {
    target.searchParams.set("state", state);
  }
  res.redirect(target.toString());
}

function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) {
          return [part, ""];
        }

        return [
          part.slice(0, separatorIndex),
          decodeURIComponent(part.slice(separatorIndex + 1)),
        ] as const;
      }),
  );
}

function getRequiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = getOptionalString(input, key);
  if (!value) {
    throw new InvalidRequestError(`${key} is required`);
  }
  return value;
}

function getOptionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new InvalidRequestError(`${key} must not be repeated`);
  }
  if (typeof value !== "string") {
    throw new InvalidRequestError(`${key} must be a string`);
  }
  return value;
}

function getHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

function isInitializeRequest(body: unknown): body is { method: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    typeof (body as { method?: unknown }).method === "string" &&
    (body as { method: string }).method === "initialize"
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url.toString());
  if (!copy.pathname.endsWith("/")) {
    copy.pathname = `${copy.pathname}/`;
  }
  return copy;
}

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function joinPath(basePath: string, suffix: string): string {
  if (basePath === "/") {
    return suffix;
  }
  return `${basePath}${suffix}`;
}

function resolvePublicBaseUrl(port: number): URL {
  const configuredBaseUrl = process.env.MCP_BASE_URL;

  if (!configuredBaseUrl) {
    const fallback = new URL(`http://127.0.0.1:${port}/`);
    logger.warn("MCP_BASE_URL is not set; defaulting to a local-only URL", {
      MCP_BASE_URL: fallback.toString(),
    });
    return fallback;
  }

  const url = new URL(configuredBaseUrl);
  if (url.search || url.hash) {
    throw new Error("MCP_BASE_URL must not include a query string or fragment");
  }
  return ensureTrailingSlash(url);
}

async function listen(
  app: Express,
  port: number,
  host: string,
): Promise<HttpServer> {
  return await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on("error", reject);
  });
}

function createHttpApp(host: string): Express {
  const app = express();
  const localhostHosts = ["127.0.0.1", "localhost", "::1"];
  const trustProxy = resolveTrustProxyValue();

  if (trustProxy !== false) {
    app.set("trust proxy", trustProxy);
    logger.info("Express trust proxy enabled", { trust_proxy: trustProxy });
  } else {
    logger.warn(
      "Express trust proxy is disabled; OAuth rate-limiting may misbehave behind reverse proxies",
      {},
    );
  }

  if (localhostHosts.includes(host)) {
    app.use(localhostHostValidation());
  } else if (host === "0.0.0.0" || host === "::") {
    logger.warn(
      `Server is binding to ${host} without DNS rebinding protection. Consider using MCP_ALLOWED_HOSTS to restrict allowed hosts, or use authentication to protect the server.`,
      {},
    );
  }

  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowedHosts?.length) {
    app.use(hostHeaderValidation(allowedHosts));
  }

  return app;
}

function resolveTrustProxyValue(): boolean | number {
  const raw = process.env.MCP_TRUST_PROXY?.trim();

  if (!raw) {
    return 1;
  }

  const normalized = raw.toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }

  const numericValue = Number.parseInt(raw, 10);
  if (Number.isFinite(numericValue) && numericValue >= 0) {
    return numericValue;
  }

  logger.warn(`Invalid MCP_TRUST_PROXY value "${raw}"; defaulting to 1`, {});
  return 1;
}

function isOAuthRequestPath(
  requestPath: string,
  publicBasePath: string,
  mcpServerUrl: URL,
): boolean {
  const oauthPaths = new Set([
    joinPath(publicBasePath, "/authorize"),
    joinPath(publicBasePath, "/register"),
    joinPath(publicBasePath, "/token"),
    joinPath(publicBasePath, "/revoke"),
    "/.well-known/oauth-authorization-server",
    new URL(getOAuthProtectedResourceMetadataUrl(mcpServerUrl)).pathname,
  ]);

  return oauthPaths.has(requestPath);
}

function registerShutdownHandler(
  httpServer: HttpServer,
  transports: Map<string, StreamableHTTPServerTransport>,
): void {
  const shutdown = async () => {
    for (const [sessionId, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch (error) {
        logger.warn("Failed to close MCP transport during shutdown", {
          session_id: sessionId,
          error: String(error),
        });
      }
    }

    transports.clear();
    httpServer.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
