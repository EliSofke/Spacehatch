/**
 * Codespace agent gRPC contract — reverse-engineered from cli/cli
 * internal/codespaces/rpc/ssh/ssh_server_host_service.v1.proto (v2.83.2).
 *
 *   package Codespaces.Grpc.SshServerHostService.v1;
 *   service SshServerHost {
 *     rpc StartRemoteServerAsync(StartRemoteServerRequest)
 *         returns (StartRemoteServerResponse);
 *   }
 *   message StartRemoteServerRequest  { string UserPublicKey = 1; }
 *   message StartRemoteServerResponse { bool Result = 1; string ServerPort = 2;
 *                                       string User = 3; string Message = 4; }
 *
 * Transport is plaintext h2c (cli uses insecure.NewCredentials()), on the
 * codespace's internal port 16634. That matches our GrpcConnection exactly.
 */
import { Writer, Reader } from "./protobuf.js";

export const SSH_SERVICE = "Codespaces.Grpc.SshServerHostService.v1.SshServerHost";
export const START_REMOTE_SERVER = "StartRemoteServerAsync";
export const AGENT_PORT = 16634;

export function encodeStartRemoteServerRequest(userPublicKey) {
  return new Writer().string(1, userPublicKey).finish();
}

export function decodeStartRemoteServerResponse(msg) {
  const r = new Reader(msg);
  const out = { result: false, serverPort: "", user: "", message: "" };
  while (!r.eof) {
    const { field, wireType } = r.tag();
    if (field === 1) out.result = r.bool();
    else if (field === 2) out.serverPort = r.string();
    else if (field === 3) out.user = r.string();
    else if (field === 4) out.message = r.string();
    else r.skip(wireType);
  }
  return out;
}

/**
 * Call StartRemoteServerAsync over a connected GrpcConnection.
 * Returns { port: number, user: string } on success; throws otherwise.
 */
export async function startRemoteServer(conn, userPublicKey) {
  const { message } = await conn.call(SSH_SERVICE, START_REMOTE_SERVER, encodeStartRemoteServerRequest(userPublicKey));
  const resp = decodeStartRemoteServerResponse(message);
  if (!resp.result) {
    throw new Error(`StartRemoteServer failed: ${resp.message || "unknown error"}`);
  }
  const port = parseInt(resp.serverPort, 10);
  if (!Number.isInteger(port)) throw new Error(`StartRemoteServer: bad port ${resp.serverPort}`);
  return { port, user: resp.user };
}
