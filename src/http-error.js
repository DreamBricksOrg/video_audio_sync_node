// An error with the HTTP status the admin API should answer with
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { HttpError };
