/**
 * Typed client for the persistence API.
 *
 * Saving is optional by design: with no `VITE_API_BASE_URL` the app is a fully
 * functional single-session tool, and `isEnabled` lets the UI hide the save
 * affordance rather than offer a button that always fails.
 */

import type {
  CreateEditedModelRequest,
  CreateExtractionRequest,
  EditedModel,
  Extraction,
} from '@gme/shared';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    /** Supplies a bearer token once auth is wired up. */
    private readonly getToken: () => string | null = () => null,
  ) {}

  get isEnabled(): boolean {
    return this.baseUrl.length > 0;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      // The API reports problems as {error}; fall back to the status text when
      // something upstream (a proxy, say) answers with something else.
      const detail = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => null);
      throw new ApiError(detail ?? `Request failed with ${response.status}`, response.status);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  createExtraction(input: CreateExtractionRequest): Promise<Extraction> {
    return this.request<Extraction>('/api/extractions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listExtractions(): Promise<Extraction[]> {
    return this.request<Extraction[]>('/api/extractions');
  }

  createModel(input: CreateEditedModelRequest): Promise<EditedModel> {
    return this.request<EditedModel>('/api/models', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listModels(): Promise<EditedModel[]> {
    return this.request<EditedModel[]>('/api/models');
  }

  /** Upload the exported GLB for an already-created model. */
  uploadMesh(modelId: string, glb: ArrayBuffer): Promise<{ key: string; url: string }> {
    return this.request<{ key: string; url: string }>(`/api/models/${modelId}/mesh`, {
      method: 'PUT',
      headers: { 'content-type': 'model/gltf-binary' },
      body: glb,
    });
  }

  deleteModel(id: string): Promise<void> {
    return this.request<void>(`/api/models/${id}`, { method: 'DELETE' });
  }
}
