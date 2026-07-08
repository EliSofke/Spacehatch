// Command gh-wasm mirrors `gh api <endpoint>` using GitHub's official, unmodified
// go-gh library (github.com/cli/go-gh/v2) — the same auth/config/REST logic gh
// uses internally. Compiled to GOOS=js GOARCH=wasm and driven from the browser.
//
// The full gh *binary* cannot be compiled to WASM: its dependency tree and its
// own internal packages (internal/flock, internal/telemetry, plus survey,
// bubbletea, tcell, termenv, clipboard, in-toto) hard-require POSIX terminal/
// process/lock syscalls with no js/wasm fallback. go-gh is the buildable,
// unmodified core of gh's networking.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cli/go-gh/v2/pkg/api"
)

func main() {
	args := os.Args // e.g. ["gh", "api", "user", "-X", "GET"]
	if len(args) < 3 || args[1] != "api" {
		fmt.Fprintln(os.Stderr, "usage: gh api <endpoint> [-X METHOD]")
		os.Exit(2)
	}

	endpoint := strings.TrimPrefix(args[2], "/") // `gh api /user` and `gh api user` are equivalent
	method := "GET"
	for i := 3; i < len(args); i++ {
		if (args[i] == "-X" || args[i] == "--method") && i+1 < len(args) {
			method = strings.ToUpper(args[i+1])
			i++
		}
	}

	client, err := api.DefaultRESTClient()
	if err != nil {
		fmt.Fprintln(os.Stderr, "gh: client/auth error:", err)
		os.Exit(1)
	}

	resp, err := client.Request(method, endpoint, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gh:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gh: read body:", err)
		os.Exit(1)
	}

	// `gh api` prints the raw response body.
	os.Stdout.Write(body)
	if len(body) == 0 || body[len(body)-1] != '\n' {
		fmt.Println()
	}
}
