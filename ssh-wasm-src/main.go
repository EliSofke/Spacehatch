//go:build js && wasm

// Command spacehatch-ssh is the browser transport for Spacehatch: it drives the
// whole codespace SSH connection with canonical Go libraries — dev-tunnels/go
// (relay), grpc-go (agent StartRemoteServer), x/crypto/ssh (shell) — over a
// single JS WebSocket bridge. JS only opens the WebSocket, does the REST hops,
// and renders xterm; all protocol lives here.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"syscall/js"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"spacehatch/ssh-wasm/agent"
	"spacehatch/ssh-wasm/bridge"
	"spacehatch/ssh-wasm/sshshell"
	"spacehatch/ssh-wasm/tunnel"
)

const agentPort uint16 = 16634

func main() {
	js.Global().Set("spacehatchSSHConnect", js.FuncOf(connect))
	select {} // keep the Go runtime alive for callbacks
}

// connect(opts) -> Promise<{push, write, resize, close}>
//
// opts: {
//   sink:       function(Uint8Array),  // send bytes on the relay WebSocket
//   onData:     function(Uint8Array),  // shell output -> xterm
//   onStatus:   function(string),      // progress messages
//   workerUrl:  string,                // for the /port hop
//   cluster:    string, tunnelId: string, managePortsToken: string,
//   cols:       number, rows: number,
// }
func connect(this js.Value, args []js.Value) any {
	opts := args[0]
	sink := opts.Get("sink")
	onData := opts.Get("onData")
	onStatus := opts.Get("onStatus")
	onRtt := opts.Get("onRtt")
	onClosed := opts.Get("onClosed")
	status := func(s string) {
		if onStatus.Type() == js.TypeFunction {
			onStatus.Invoke(s)
		}
	}
	// notifyClosed tells JS the transport is gone (e.g. the relay dropped an idle
	// connection) so the UI can stop showing a stale "connected" and reconnect.
	// Invoked at most once, from the keepalive loop when a ping errors.
	closedOnce := false
	notifyClosed := func() {
		if closedOnce {
			return
		}
		closedOnce = true
		if onClosed.Type() == js.TypeFunction {
			onClosed.Invoke()
		}
	}
	// emitRtt reports a measured round-trip time (milliseconds, sub-ms precision)
	// for a named stage to JS, if an onRtt callback was provided.
	emitRtt := func(stage string, d time.Duration) {
		if onRtt.Type() == js.TypeFunction {
			onRtt.Invoke(stage, float64(d.Microseconds())/1000.0)
		}
	}

	br := bridge.NewConn(sink)

	// Promise executor: run the orchestration in a goroutine.
	handler := js.FuncOf(func(this js.Value, pa []js.Value) any {
		resolve, reject := pa[0], pa[1]
		go func() {
			shell, err := run(opts, br, onData, status)
			if err != nil {
				reject.Invoke(err.Error())
				return
			}
			result := map[string]any{
				"write":  js.FuncOf(func(_ js.Value, a []js.Value) any { _ = shell.Write([]byte(a[0].String())); return nil }),
				"resize": js.FuncOf(func(_ js.Value, a []js.Value) any { _ = shell.Resize(a[0].Int(), a[1].Int()); return nil }),
				"close":  js.FuncOf(func(_ js.Value, a []js.Value) any { _ = shell.Close(); return nil }),
				// ping() -> Promise<number ms> (-1 on error): on-demand transport RTT.
				"ping": js.FuncOf(func(_ js.Value, _ []js.Value) any {
					return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, pr []js.Value) any {
						res := pr[0]
						go func() {
							d, err := shell.Ping()
							if err != nil {
								res.Invoke(-1.0)
								return
							}
							res.Invoke(float64(d.Microseconds()) / 1000.0)
						}()
						return nil
					}))
				}),
			}
			// Baseline latency probe: emit the full-stack SSH keepalive RTT every
			// 2 s so the UI can show a live readout. When a ping errors the
			// connection is gone: tell JS (so it can reconnect) and stop.
			go func() {
				for {
					time.Sleep(2 * time.Second)
					d, err := shell.Ping()
					if err != nil {
						notifyClosed()
						return
					}
					emitRtt("ssh", d)
				}
			}()
			resolve.Invoke(js.ValueOf(result))
		}()
		return nil
	})

	// Expose push immediately so JS can feed inbound WS bytes during connect.
	push := js.FuncOf(func(_ js.Value, a []js.Value) any {
		n := a[0].Get("length").Int()
		b := make([]byte, n)
		js.CopyBytesToGo(b, a[0])
		br.Push(b)
		return nil
	})
	promise := js.Global().Get("Promise").New(handler)
	return map[string]any{"push": push, "promise": promise}
}

func run(opts js.Value, br *bridge.Conn, onData js.Value, status func(string)) (*sshshell.Shell, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	logger := log.New(io.Discard, "", 0)

	status("relay: SSH session …")
	tc, err := tunnel.Connect(ctx, br, logger)
	if err != nil {
		return nil, err
	}

	status("agent: generating key …")
	key, err := sshshell.GenerateKey()
	if err != nil {
		return nil, err
	}

	status("agent: StartRemoteServer …")
	_ = tc.RefreshPorts()
	if err := waitAndReady(ctx, tc, agentPort); err != nil {
		return nil, fmt.Errorf("agent port %d: %w", agentPort, err)
	}
	agentConn, err := tc.OpenPort(ctx, agentPort)
	if err != nil {
		return nil, err
	}
	cc, err := grpc.NewClient("passthrough:///agent",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return agentConn, nil }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, err
	}
	port, user, err := agent.StartRemoteServer(ctx, cc, key.Authorized)
	if err != nil {
		return nil, err
	}
	status(fmt.Sprintf("agent: sshd on port %d as %s", port, user))

	// Register the agent-started sshd port on the tunnel (worker /port hop).
	if err := registerPort(opts, port); err != nil {
		status("warning: register port: " + err.Error())
	}
	_ = tc.RefreshPorts()
	if err := waitAndReady(ctx, tc, uint16(port)); err != nil {
		return nil, fmt.Errorf("ssh port %d: %w", port, err)
	}

	status("ssh: connecting shell …")
	sshConn, err := tc.OpenPort(ctx, uint16(port))
	if err != nil {
		return nil, err
	}
	cb := func(b []byte) {
		arr := js.Global().Get("Uint8Array").New(len(b))
		js.CopyBytesToJS(arr, b)
		onData.Invoke(arr)
	}
	cols, rows := 80, 24
	if v := opts.Get("cols"); v.Type() == js.TypeNumber {
		cols = v.Int()
	}
	if v := opts.Get("rows"); v.Type() == js.TypeNumber {
		rows = v.Int()
	}
	shell, err := sshshell.Open(sshConn, user, key, cols, rows, cb)
	if err != nil {
		return nil, err
	}
	status("shell: connected")
	return shell, nil
}

// waitAndReady waits (briefly) for a forwarded port, tolerating hosts that
// forward eagerly (OpenPort then works even without a prior notification).
func waitAndReady(ctx context.Context, tc *tunnel.Client, port uint16) error {
	wctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	_ = tc.WaitForPort(wctx, port) // best-effort; some hosts don't notify
	return nil
}

func registerPort(opts js.Value, port int) error {
	workerURL := opts.Get("workerUrl").String()
	body, _ := json.Marshal(map[string]any{
		"cluster":  opts.Get("cluster").String(),
		"tunnelId": opts.Get("tunnelId").String(),
		"port":     port,
		"token":    opts.Get("managePortsToken").String(),
	})
	resp, err := http.Post(workerURL+"/port", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.ReadAll(resp.Body)
	return nil
}
