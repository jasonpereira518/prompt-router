export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "invalid_request",
  ) {
    super(message);
  }
}
export function publicError(error: unknown) {
  if (error instanceof AppError)
    return { error: error.message, code: error.code, status: error.status };
  return {
    error: "The operation could not finish. Check the server and try again.",
    code: "internal_error",
    status: 500,
  };
}
