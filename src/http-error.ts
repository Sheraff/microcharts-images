const TITLES: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  413: "Content Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  get title(): string {
    return TITLES[this.status] ?? "Error";
  }
}
