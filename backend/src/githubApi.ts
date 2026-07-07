/**
 * Thin, typed wrapper around the documented GitHub REST API v3 endpoints
 * for Codespaces. Everything in this file is officially documented:
 * https://docs.github.com/en/rest/codespaces
 *
 * The UNdocumented part of the system (the SSH tunnel transport) lives in
 * src/ssh/ and is clearly flagged there.
 */

const API = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface Codespace {
  name: string;
  state:
    | "Unknown"
    | "Created"
    | "Queued"
    | "Provisioning"
    | "Available"
    | "Awaiting"
    | "Unavailable"
    | "Deleted"
    | "Moved"
    | "Shutdown"
    | "Archived"
    | "Starting"
    | "ShuttingDown"
    | "Failed"
    | "Exporting"
    | "Updating"
    | "Rebuilding";
  repository: { full_name: string };
  web_url: string;
  idle_timeout_minutes: number;
}

async function ghFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `GitHub API ${res.status} on ${path}`;
    throw new GitHubApiError(res.status, message, body);
  }

  // 202/204 responses (stop, delete) may carry no meaningful body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST /repos/{owner}/{repo}/codespaces — create (and start) a Codespace. */
export function createCodespace(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  options: { machine?: string; idleTimeoutMinutes?: number } = {},
): Promise<Codespace> {
  return ghFetch<Codespace>(token, `/repos/${owner}/${repo}/codespaces`, {
    method: "POST",
    body: JSON.stringify({
      ref,
      ...(options.machine ? { machine: options.machine } : {}),
      ...(options.idleTimeoutMinutes
        ? { idle_timeout_minutes: options.idleTimeoutMinutes }
        : {}),
    }),
  });
}

/** GET /user/codespaces/{name} — used for polling until state === "Available". */
export function getCodespace(token: string, name: string): Promise<Codespace> {
  return ghFetch<Codespace>(token, `/user/codespaces/${encodeURIComponent(name)}`);
}

/** GET /repos/{owner}/{repo}/codespaces — existing Codespaces of the user for this repo. */
export async function listRepoCodespaces(
  token: string,
  owner: string,
  repo: string,
): Promise<Codespace[]> {
  const data = await ghFetch<{ codespaces: Codespace[] }>(
    token,
    `/repos/${owner}/${repo}/codespaces`,
  );
  return data.codespaces;
}

/** POST /user/codespaces/{name}/start — restart a stopped Codespace. */
export function startCodespace(token: string, name: string): Promise<Codespace> {
  return ghFetch<Codespace>(token, `/user/codespaces/${encodeURIComponent(name)}/start`, {
    method: "POST",
  });
}

/** POST /user/codespaces/{name}/stop — stop, keeps the Codespace (billing: storage only). */
export function stopCodespace(token: string, name: string): Promise<Codespace> {
  return ghFetch<Codespace>(token, `/user/codespaces/${encodeURIComponent(name)}/stop`, {
    method: "POST",
  });
}

/** DELETE /user/codespaces/{name} — delete the Codespace entirely. */
export function deleteCodespace(token: string, name: string): Promise<void> {
  return ghFetch<void>(token, `/user/codespaces/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

/** GET /user — resolve the login of the authenticated user for display. */
export async function getViewerLogin(token: string): Promise<string> {
  const user = await ghFetch<{ login: string }>(token, "/user");
  return user.login;
}
