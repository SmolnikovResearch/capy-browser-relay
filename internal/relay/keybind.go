package relay

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"math/big"
)

// Device key binding. The extension generates an ECDSA P-256 key pair whose
// private half never leaves the browser (non-extractable WebCrypto key). At
// pairing it sends the public key (base64 SPKI) plus a signature over the
// pairing code, proving it holds the private key. Each later WebSocket
// connection starts with a challenge: a stolen device token alone is useless
// without the key.

// ParseDevicePublicKey decodes a base64 SPKI P-256 public key.
func ParseDevicePublicKey(b64 string) (*ecdsa.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("device key must be ECDSA P-256")
	}
	return pub, nil
}

// VerifyDeviceSig checks an IEEE P1363 (r||s, 64 bytes, what WebCrypto
// produces) ECDSA P-256 / SHA-256 signature over msg.
func VerifyDeviceSig(pubB64, msg, sigB64 string) bool {
	pub, err := ParseDevicePublicKey(pubB64)
	if err != nil {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != 64 {
		return false
	}
	h := sha256.Sum256([]byte(msg))
	return ecdsa.Verify(pub, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func pairProofMsg(code, name string) string { return "capy-pair|" + code + "|" + name }
func authProofMsg(deviceID, nonce string) string {
	return "capy-auth|" + deviceID + "|" + nonce
}
