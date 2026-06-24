package zooid

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "zooid-test-*")
	if err != nil {
		panic(err)
	}

	os.Setenv("DATA", dir)

	code := m.Run()

	os.RemoveAll(dir)
	os.Exit(code)
}
