package zooid

import (
	"encoding/json"
	"fiatjaf.com/nostr"
	"fmt"
	"github.com/BurntSushi/toml"
	"os"
	"path/filepath"
	"regexp"
	"slices"
)

type Role struct {
	Pubkeys   []string `toml:"pubkeys" json:"pubkeys"`
	CanInvite bool     `toml:"can_invite" json:"can_invite"`
	CanManage bool     `toml:"can_manage" json:"can_manage"`
}

type Config struct {
	Host     string `toml:"host" json:"host"`
	Schema   string `toml:"schema" json:"schema"`
	Secret   string `toml:"secret" json:"secret"`
	Inactive bool   `toml:"inactive" json:"inactive"`
	Info     struct {
		Name        string `toml:"name" json:"name"`
		Icon        string `toml:"icon" json:"icon"`
		Pubkey      string `toml:"pubkey" json:"pubkey"`
		Description string `toml:"description" json:"description"`
	} `toml:"info" json:"info"`

	Policy struct {
		PublicJoin      bool `toml:"public_join" json:"public_join"`
		StripSignatures bool `toml:"strip_signatures" json:"strip_signatures"`
	} `toml:"policy" json:"policy"`

	Groups struct {
		Enabled bool `toml:"enabled" json:"enabled"`
	} `toml:"groups" json:"groups"`

	Push struct {
		Enabled bool `toml:"enabled" json:"enabled"`
	} `toml:"push" json:"push"`

	Management struct {
		Enabled bool `toml:"enabled" json:"enabled"`
	} `toml:"management" json:"management"`

	Blossom struct {
		Enabled           bool              `toml:"enabled" json:"enabled"`
		AuthenticatedRead bool              `toml:"authenticated_read" json:"authenticated_read"`
		Adapter           string            `toml:"adapter" json:"adapter"`
		S3                BlossomS3Settings `toml:"s3" json:"s3"`
	} `toml:"blossom" json:"blossom"`

	Livekit struct {
		ServerURL string `toml:"server_url" json:"server_url"`
		APIKey    string `toml:"api_key" json:"api_key"`
		APISecret string `toml:"api_secret" json:"api_secret"`
	} `toml:"livekit" json:"livekit"`

	Roles map[string]Role `toml:"roles" json:"roles"`

	// Parsed values
	path   string
	secret nostr.SecretKey
}

// BlossomS3Settings configures S3-compatible object storage for Blossom blobs
// when [blossom] adapter is "s3".
type BlossomS3Settings struct {
	Endpoint  string `toml:"endpoint" json:"endpoint"`
	Region    string `toml:"region" json:"region"`
	Bucket    string `toml:"bucket" json:"bucket"`
	AccessKey string `toml:"access_key" json:"access_key"`
	SecretKey string `toml:"secret_key" json:"secret_key"`
	KeyPrefix string `toml:"key_prefix" json:"key_prefix"`
}

func ConfigNameFromId(id string) string {
	return id + ".toml"
}

func ConfigPathFromName(name string) string {
	return filepath.Join(Env("CONFIG"), name)
}

func LoadConfigFromPath(path string) (*Config, error) {
	var config Config
	if _, err := toml.DecodeFile(path, &config); err != nil {
		return nil, fmt.Errorf("Failed to parse config file %s: %w", path, err)
	}

	config.path = path

	if err := config.Validate(); err != nil {
		return nil, err
	}

	return &config, nil
}

func LoadConfigFromJson(path string, body []byte) (*Config, error) {
	var config Config
	if err := json.Unmarshal(body, &config); err != nil {
		return nil, fmt.Errorf("invalid json config: %w", err)
	}

	config.path = path

	if err := config.Validate(); err != nil {
		return nil, err
	}

	return &config, nil
}

func (config *Config) Validate() error {
	if config.Blossom.Adapter == "" {
		config.Blossom.Adapter = "local"
	}

	if config.Host == "" {
		return fmt.Errorf("host is required")
	}

	if config.Schema == "" {
		return fmt.Errorf("schema is required")
	}

	if !regexp.MustCompile(`^[a-z_][a-z0-9_]*$`).MatchString(config.Schema) {
		return fmt.Errorf("schema must contain only lowercase letters, numbers, and underscores")
	}

	secret, err := nostr.SecretKeyFromHex(config.Secret)

	if err != nil {
		return fmt.Errorf("invalid secret key: %w", err)
	}

	config.secret = secret

	if _, err := nostr.PubKeyFromHex(config.Info.Pubkey); err != nil {
		return fmt.Errorf("invalid info.pubkey: %w", err)
	}

	if config.Blossom.Adapter == "s3" {
		if config.Blossom.S3.Bucket == "" {
			return fmt.Errorf("blossom.s3.bucket is required when blossom.adapter is s3")
		}
		if config.Blossom.S3.Region == "" {
			return fmt.Errorf("blossom.s3.region is required when blossom.adapter is s3")
		}
		if config.Blossom.S3.AccessKey == "" {
			return fmt.Errorf("blossom.s3.access_key is required when blossom.adapter is s3")
		}
		if config.Blossom.S3.SecretKey == "" {
			return fmt.Errorf("blossom.s3.secret_key is required when blossom.adapter is s3")
		}
	} else if config.Blossom.Adapter != "local" {
		return fmt.Errorf("invalid blossom adapter")
	}

	return nil
}

func (config *Config) Save() error {
	file, err := os.Create(config.path)
	if err != nil {
		return fmt.Errorf("Failed to open config file %s: %w", config.path, err)
	}
	defer file.Close()

	encoder := toml.NewEncoder(file)
	if err := encoder.Encode(config); err != nil {
		return fmt.Errorf("Failed to encode config file %s: %w", config.path, err)
	}

	return nil
}

func (config *Config) SetName(name string) error {
	config.Info.Name = name

	return config.Save()
}

func (config *Config) SetDescription(description string) error {
	config.Info.Description = description

	return config.Save()
}

func (config *Config) SetIcon(icon string) error {
	config.Info.Icon = icon

	return config.Save()
}

func (config *Config) Sign(event *nostr.Event) error {
	return event.Sign(config.secret)
}

func (config *Config) GetSelf() nostr.PubKey {
	return config.secret.Public()
}

func (config *Config) IsSelf(pubkey nostr.PubKey) bool {
	return pubkey == config.GetSelf()
}

func (config *Config) GetOwner() nostr.PubKey {
	return nostr.MustPubKeyFromHex(config.Info.Pubkey)
}

func (config *Config) IsOwner(pubkey nostr.PubKey) bool {
	return pubkey == config.GetOwner()
}

func (config *Config) GetAssignedRoles(pubkey nostr.PubKey) []Role {
	roles := make([]Role, 0)
	for _, role := range config.Roles {
		if slices.Contains(role.Pubkeys, pubkey.Hex()) {
			roles = append(roles, role)
		}
	}

	return roles
}

func (config *Config) GetAllRoles(pubkey nostr.PubKey) []Role {
	roles := make([]Role, 0)
	for name, role := range config.Roles {
		if name == "member" {
			roles = append(roles, role)
		} else if slices.Contains(role.Pubkeys, pubkey.Hex()) {
			roles = append(roles, role)
		}
	}

	return roles
}

func (config *Config) CanInvite(pubkey nostr.PubKey) bool {
	if config.IsOwner(pubkey) || config.IsSelf(pubkey) {
		return true
	}

	for _, role := range config.GetAllRoles(pubkey) {
		if role.CanInvite {
			return true
		}
	}

	return false
}

func (config *Config) CanManage(pubkey nostr.PubKey) bool {
	if config.IsOwner(pubkey) || config.IsSelf(pubkey) {
		return true
	}

	for _, role := range config.GetAllRoles(pubkey) {
		if role.CanManage {
			return true
		}
	}

	return false
}
