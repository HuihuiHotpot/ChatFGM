import type {
  BinaryResource,
  ReadBinaryResourceInput,
  ServiceResult,
} from '../../services/capabilities';

const pendingReads = new Map<
  string,
  Promise<ServiceResult<BinaryResource>>
>();

function resourceKey(
  input: ReadBinaryResourceInput,
  sourcePath?: string,
  sourceVersion?: string | number,
  instanceId?: string,
): string {
  return [
    input.projectId,
    input.fileIdentity,
    input.relativePath ?? '',
    sourcePath ?? '',
    sourceVersion === undefined ? '' : String(sourceVersion),
    instanceId ?? '',
  ].join('\u0000');
}

/**
 * Shares an in-flight binary request between duplicate mounts of the same
 * document instance and content version. A caller that observes a newer file
 * version, or a newly opened document instance (whose revision restarts at
 * zero), must pass that identity/version so an older in-flight read is never
 * joined to the new viewer. Completed requests are removed immediately; object
 * URLs remain owned by the viewer instance that consumes the result.
 */
export function readBinaryResourceOnce(
  input: ReadBinaryResourceInput,
  loader: (
    input: ReadBinaryResourceInput,
  ) => Promise<ServiceResult<BinaryResource>>,
  sourcePath?: string,
  sourceVersion?: string | number,
  instanceId?: string,
): Promise<ServiceResult<BinaryResource>> {
  const key = resourceKey(input, sourcePath, sourceVersion, instanceId);
  const existing = pendingReads.get(key);
  if (existing) return existing;
  const request = Promise.resolve()
    .then(() => loader(input))
    .catch(
      (): ServiceResult<BinaryResource> => ({
        status: 'error',
        message: '无法读取图片资源。',
      }),
    );
  pendingReads.set(key, request);
  void request.finally(() => {
    if (pendingReads.get(key) === request) {
      pendingReads.delete(key);
    }
  });
  return request;
}
