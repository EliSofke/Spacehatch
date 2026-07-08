// Package agent calls the codespace's internal SSH-server-host gRPC service,
// exactly as gh's internal/codespaces/rpc does — over canonical grpc-go instead
// of a hand-rolled HTTP/2 + HPACK + protobuf stack.
package agent

import (
	"context"
	"fmt"
	"strconv"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	pb "spacehatch/ssh-wasm/gen/sshserverhost"
)

// StartRemoteServer asks the codespace agent to start its SSH server and returns
// the resulting port and user. The agent's Kestrel gRPC server requires a fixed
// sentinel Authorization header on every call (real auth is at the tunnel
// layer); gh sends exactly "Bearer token".
func StartRemoteServer(ctx context.Context, cc grpc.ClientConnInterface, userPublicKey string) (port int, user string, err error) {
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer token")
	resp, err := pb.NewSshServerHostClient(cc).StartRemoteServerAsync(ctx, &pb.StartRemoteServerRequest{
		UserPublicKey: userPublicKey,
	})
	if err != nil {
		return 0, "", err
	}
	if !resp.GetResult() {
		return 0, "", fmt.Errorf("StartRemoteServer failed: %s", resp.GetMessage())
	}
	p, err := strconv.Atoi(resp.GetServerPort())
	if err != nil {
		return 0, "", fmt.Errorf("bad port %q: %w", resp.GetServerPort(), err)
	}
	return p, resp.GetUser(), nil
}
