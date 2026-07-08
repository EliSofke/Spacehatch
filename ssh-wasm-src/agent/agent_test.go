package agent

import (
	"context"
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"

	pb "spacehatch/ssh-wasm/gen/sshserverhost"
)

type fakeAgent struct {
	pb.UnimplementedSshServerHostServer
	gotAuth string
	gotKey  string
}

func (f *fakeAgent) StartRemoteServerAsync(ctx context.Context, req *pb.StartRemoteServerRequest) (*pb.StartRemoteServerResponse, error) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			f.gotAuth = v[0]
		}
	}
	f.gotKey = req.GetUserPublicKey()
	return &pb.StartRemoteServerResponse{Result: true, ServerPort: "2222", User: "vscode"}, nil
}

// Proves the canonical grpc-go path (generated proto + sentinel metadata) makes
// the exact StartRemoteServerAsync call the hand-rolled JS stack made — over a
// real gRPC server, no codespace required.
func TestStartRemoteServer(t *testing.T) {
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	fake := &fakeAgent{}
	pb.RegisterSshServerHostServer(srv, fake)
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	cc, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer cc.Close()

	port, user, err := StartRemoteServer(context.Background(), cc, "ecdsa-sha2-nistp256 AAAAtest spacehatch")
	if err != nil {
		t.Fatal(err)
	}
	if port != 2222 || user != "vscode" {
		t.Fatalf("got port=%d user=%q; want 2222/vscode", port, user)
	}
	if fake.gotAuth != "Bearer token" {
		t.Fatalf("sentinel auth not received: %q", fake.gotAuth)
	}
	if fake.gotKey == "" {
		t.Fatal("public key not received by agent")
	}
}
