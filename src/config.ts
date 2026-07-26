export function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim()

  if (!value) {
    throw new Error(
      `Missing required model environment variable: ${name}`,
    )
  }

  return value
}
