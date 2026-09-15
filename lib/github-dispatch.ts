export type WorkflowDispatchInputs = Record<string, string>;

function canonicalMovieIds(movieIds: number[]): string {
  if (!Array.isArray(movieIds) || movieIds.length === 0 || movieIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('GITHUB_DISPATCH_MOVIE_IDS_INVALID');
  }
  return [...new Set(movieIds)].join(',');
}

export function buildTargetedWorkflowInputs(movieIds: number[], workflowInputs: WorkflowDispatchInputs = {}): WorkflowDispatchInputs {
  const expectedMovieIds = canonicalMovieIds(movieIds);
  const suppliedMovieIds = workflowInputs.movie_ids?.trim() || '';
  if (!suppliedMovieIds) throw new Error('GITHUB_DISPATCH_MOVIE_IDS_REQUIRED');
  if (suppliedMovieIds !== expectedMovieIds) throw new Error('GITHUB_DISPATCH_MOVIE_IDS_MISMATCH');
  return { ...workflowInputs, movie_ids: expectedMovieIds, dispatch_mode: 'targeted' };
}

export function serializeWorkflowDispatchBody(ref: string, inputs: WorkflowDispatchInputs): string {
  return JSON.stringify({ ref, inputs });
}
