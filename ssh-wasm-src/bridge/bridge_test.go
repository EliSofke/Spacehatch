//go:build js && wasm

package bridge

import (
	"bytes"
	"io"
	"syscall/js"
	"testing"
	"time"
)

// Exercises the real JS interop path: Write hands bytes to a JS sink; the sink
// echoes them back through Push (a loopback WebSocket); Read returns them.
func TestConnLoopbackJS(t *testing.T) {
	var c *Conn
	sink := js.FuncOf(func(this js.Value, args []js.Value) any {
		arr := args[0]
		n := arr.Get("length").Int()
		b := make([]byte, n)
		js.CopyBytesToGo(b, arr)
		go c.Push(b) // async echo, like a network round-trip
		return nil
	})
	defer sink.Release()
	c = NewConn(sink.Value)

	msg := []byte("hello ssh relay \x00\x01\x02 binary")
	if _, err := c.Write(msg); err != nil {
		t.Fatal(err)
	}

	got := make([]byte, len(msg))
	done := make(chan error, 1)
	go func() { _, err := io.ReadFull(c, got); done <- err }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for loopback read")
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("loopback mismatch: got %q want %q", got, msg)
	}
}
