import { auth } from '../config/firebase';

export async function getAuthHeaders(
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extraHeaders };
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return headers;
  }

  const token = await currentUser.getIdToken();
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = await getAuthHeaders(
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init.headers as Record<string, string> | undefined) || {},
  );

  return fetch(input, {
    ...init,
    headers,
  });
}
