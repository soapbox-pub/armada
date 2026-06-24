package zooid

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/url"
	"path/filepath"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/eventstore"
	"fiatjaf.com/nostr/khatru/blossom"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/spf13/afero"
)

type BlossomStore struct {
	Config *Config
	Events eventstore.Store
}

func (bl *BlossomStore) Enable(instance *Instance) {
	backend := blossom.New(instance.Relay, "https://"+bl.Config.Host)
	backend.Store = blossom.EventStoreBlobIndexWrapper{
		Store:      bl.Events,
		ServiceURL: "https://" + bl.Config.Host,
	}

	switch bl.Config.Blossom.Adapter {
	case "local":
		if err := bl.UseLocalAdapter(backend); err != nil {
			log.Fatalf("blossom: failed to use local adapter %q", err)
		}
	case "s3":
		if err := bl.UseS3Adapter(backend); err != nil {
			log.Fatalf("blossom: failed to use s3 adapter %q", err)
		}
	default:
		log.Fatalf("blossom: unknown backend %q", bl.Config.Blossom.Adapter)
	}

	backend.RejectUpload = func(ctx context.Context, auth *nostr.Event, size int, ext string) (bool, string, int) {
		if size > 10*1024*1024 {
			return true, "file too large", 413
		}

		if auth == nil || !instance.Management.IsMember(auth.PubKey) {
			return true, "unauthorized", 403
		}

		return false, ext, size
	}

	backend.RejectGet = func(ctx context.Context, auth *nostr.Event, sha256 string, ext string) (bool, string, int) {
		if !bl.Config.Blossom.AuthenticatedRead {
			return false, "", 200
		}

		if auth == nil || !instance.Management.IsMember(auth.PubKey) {
			return true, "unauthorized", 403
		}

		return false, "", 200
	}

	backend.RejectList = func(ctx context.Context, auth *nostr.Event, pubkey nostr.PubKey) (bool, string, int) {
		if auth == nil || !instance.Management.IsMember(auth.PubKey) {
			return true, "unauthorized", 403
		}

		return false, "", 200
	}

	backend.RejectDelete = func(ctx context.Context, auth *nostr.Event, sha256 string, ext string) (bool, string, int) {
		if auth == nil || !instance.Management.IsMember(auth.PubKey) {
			return true, "unauthorized", 403
		}

		return false, "", 200
	}

	instance.Relay.Info.SupportedNIPs = append(instance.Relay.Info.SupportedNIPs, "BUD-00")
	instance.Relay.Info.SupportedNIPs = append(instance.Relay.Info.SupportedNIPs, "BUD-01")
	instance.Relay.Info.SupportedNIPs = append(instance.Relay.Info.SupportedNIPs, "BUD-02")
	instance.Relay.Info.SupportedNIPs = append(instance.Relay.Info.SupportedNIPs, "BUD-11")
}

// Local adapter

func (bl *BlossomStore) UseLocalAdapter(backend *blossom.BlossomServer) error {
	dir := filepath.Join(Env("MEDIA"), bl.Config.Schema)
	osfs := afero.NewOsFs()
	_ = osfs.MkdirAll(dir, 0755)

	backend.StoreBlob = func(ctx context.Context, sha256 string, ext string, body []byte) error {
		file, err := osfs.Create(filepath.Join(dir, sha256))
		if err != nil {
			return err
		}

		if _, err := io.Copy(file, bytes.NewReader(body)); err != nil {
			return err
		}

		return nil
	}

	backend.LoadBlob = func(ctx context.Context, sha256 string, ext string) (io.ReadSeeker, *url.URL, error) {
		file, err := osfs.Open(filepath.Join(dir, sha256))
		if err != nil {
			return nil, nil, err
		}
		return file, nil, nil
	}

	backend.DeleteBlob = func(ctx context.Context, sha256 string, ext string) error {
		return osfs.Remove(filepath.Join(dir, sha256))
	}

	return nil
}

// S3 adapter

func (bl *BlossomStore) S3Key(sha256 string) string {
	key := bl.Config.Schema + "/" + sha256

	if bl.Config.Blossom.S3.KeyPrefix != "" {
		key = bl.Config.Blossom.S3.KeyPrefix + "/" + key
	}

	return key
}

func (bl *BlossomStore) UseS3Adapter(backend *blossom.BlossomServer) error {
	ctx := context.Background()
	awsConfig, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(bl.Config.Blossom.S3.Region),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(
				bl.Config.Blossom.S3.AccessKey,
				bl.Config.Blossom.S3.SecretKey,
				"",
			),
		),
	)

	if err != nil {
		return fmt.Errorf("aws config: %w", err)
	}

	client := s3.NewFromConfig(awsConfig, func(o *s3.Options) {
		if bl.Config.Blossom.S3.Endpoint != "" {
			o.BaseEndpoint = aws.String(bl.Config.Blossom.S3.Endpoint)
			o.UsePathStyle = true
		}
	})

	backend.StoreBlob = func(ctx context.Context, sha256 string, ext string, body []byte) error {
		_, err := client.PutObject(ctx, &s3.PutObjectInput{
			Bucket: aws.String(bl.Config.Blossom.S3.Bucket),
			Key:    aws.String(bl.S3Key(sha256)),
			Body:   bytes.NewReader(body),
		})

		return err
	}

	backend.LoadBlob = func(ctx context.Context, sha256 string, ext string) (io.ReadSeeker, *url.URL, error) {
		out, err := client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(bl.Config.Blossom.S3.Bucket),
			Key:    aws.String(bl.S3Key(sha256)),
		})
		if err != nil {
			return nil, nil, err
		}
		defer out.Body.Close()

		data, err := io.ReadAll(out.Body)
		if err != nil {
			return nil, nil, err
		}

		return bytes.NewReader(data), nil, nil
	}

	backend.DeleteBlob = func(ctx context.Context, sha256 string, ext string) error {
		_, err := client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(bl.Config.Blossom.S3.Bucket),
			Key:    aws.String(bl.S3Key(sha256)),
		})

		return err
	}

	return nil
}
