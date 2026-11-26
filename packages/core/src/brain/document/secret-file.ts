/** Files whose content is a secret, never a document. */
export const SECRET_FILE =
  /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_[a-z0-9]+|[\w.-]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|txt|env))$/i
