// Browser-safe transport receipts. UI status mapping must not import Node HTTP.
export const CONNECTION_ISSUES = ["reset", "refused", "dns-temporary", "dns-not-found", "timeout", "pipe",
  "tls-record", "tls-certificate", "tls-handshake", "unknown"] as const;
export type ConnectionIssue = typeof CONNECTION_ISSUES[number];
const transientConnections = new Set<ConnectionIssue>(["reset", "refused", "dns-temporary", "dns-not-found", "timeout", "pipe", "tls-record"]);
const socketFailures = new WeakSet<object>();
type SocketConnectionReceipt = Readonly<{connectionIssue:ConnectionIssue;retryableConnection:boolean;receivedBytes:number;status?:number}>;
const connectionResults = new WeakMap<object, SocketConnectionReceipt>();

/** A finite transport-owned receipt, not an error-message heuristic. Exported
 * for deterministic socket fault injection; arbitrary Error text is untrusted. */
export class SocketTransportError extends Error {
  readonly #issue: ConnectionIssue;
  constructor(issue: ConnectionIssue) {
    if (!CONNECTION_ISSUES.includes(issue)) throw new Error("invalid-connection-issue");
    super(issue.startsWith("tls-") ? "api-secure-connection-failed" : issue === "unknown" ? "api-transport-failed" : "api-connection-failed");
    this.name = "SocketTransportError";
    this.#issue = issue;
    socketFailures.add(this);
  }
  get connectionIssue(): ConnectionIssue { return this.#issue; }
  get retryableConnection(): boolean { return transientConnections.has(this.#issue); }
}

/** Register only socket-owned errors, never lookalikes from messages or fields. */
export function recordConnectionReceipt(result:object,error:unknown,receivedBytes:number,status?:number):SocketConnectionReceipt|undefined {
  if (!(error instanceof SocketTransportError) || !socketFailures.has(error)) return undefined;
  const receipt = {connectionIssue:error.connectionIssue,retryableConnection:error.retryableConnection,receivedBytes,...(status===undefined?{}:{status})};
  connectionResults.set(result,receipt);
  return {...receipt};
}

/** A copied/forged result cannot promote arbitrary consumer error text into a
 * retry. Only the actual catch of a transport-owned socket receipt registers it. */
export function verifiedConnectionReceipt(result:object):SocketConnectionReceipt|undefined {
  const receipt=connectionResults.get(result);
  return receipt?{...receipt}:undefined;
}
