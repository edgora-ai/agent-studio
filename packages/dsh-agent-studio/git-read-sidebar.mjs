// Serialized into the hash-locked native client; keep every dependency local.
export function studioGitErrorCode(error) {
  const code = error?.code;
  if (typeof code !== 'string' || code.length > 80 || !/^[a-zA-Z][a-zA-Z0-9._/-]*$/.test(code)) return 'read-failed';
  return code;
}
