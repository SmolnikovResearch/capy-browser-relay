package relay

import (
	"context"
	"log"
)

// ConfirmRequest describes a dangerous action that needs the owner.
type ConfirmRequest struct {
	Tenant      string
	Agent       string
	Device      string
	Cmd         string
	Domain      string
	Description string
}

type Decision struct {
	Approved bool
	By       string
}

// Confirmer is the hook that asks the owner about a dangerous action. The
// real approval happens in the extension UI (slice 2) or an owner channel;
// an agent can never approve for itself.
type Confirmer interface {
	Confirm(ctx context.Context, r ConfirmRequest) Decision
}

// StubConfirmer only logs the request and declines: nothing dangerous runs
// until a real owner channel is wired in.
type StubConfirmer struct{}

func (StubConfirmer) Confirm(_ context.Context, r ConfirmRequest) Decision {
	log.Printf("confirmation needed (stub, declined): tenant=%s agent=%s cmd=%s domain=%s: %s",
		r.Tenant, r.Agent, r.Cmd, r.Domain, r.Description)
	return Decision{Approved: false}
}
