package relay

import (
	"bytes"
	"encoding/json"
	"net/http"
)

// MCP over Streamable HTTP, stateless: every POST gets a single JSON reply.

var supportedProtocols = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
	cmd         string         // relay command; "" = list_browsers
	scope       string
	required    []string
}

func obj(props map[string]any, required ...string) map[string]any {
	props["browser"] = map[string]any{"type": "string", "description": "Browser id or name (optional when exactly one is online)"}
	m := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

var str = func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
var tabID = map[string]any{"type": "integer", "description": "Tab id from browser_tabs_list. Only tabs this agent opened in this session."}
var sessionField = str("Stable id of this chat. Tabs stay private to this agent and this session.")
var target = func(m map[string]any) map[string]any {
	m["tab_id"] = tabID
	m["selector"] = str("CSS selector")
	m["ref"] = str("Element ref from a browser_read_page snapshot")
	return m
}

var (
	readOnly = map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true}
	acting   = map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true}
)

var tools = []tool{
	{Name: "browser_list", Annotations: readOnly, Description: "List the user's paired browsers and whether they are online.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}}},
	{Name: "browser_tabs_list", Annotations: readOnly, Description: "List tabs this agent opened in this session. Other agents' tabs and the user's own tabs are omitted.", cmd: "tabs_list", scope: ScopeRead,
		InputSchema: obj(map[string]any{"session": sessionField})},
	{Name: "browser_tabs_open", Annotations: acting, Description: "Open a URL in this agent session's tab group. The tab stays inactive and Chrome is not brought to the foreground.", cmd: "tabs_open", scope: ScopeAct, required: []string{"url"},
		InputSchema: obj(map[string]any{"url": str("http(s) URL"), "session": sessionField}, "url")},
	{Name: "browser_navigate", Annotations: acting, Description: "Navigate a tab this agent opened. Other sessions' tabs are refused.", cmd: "navigate", scope: ScopeAct, required: []string{"tab_id", "url"},
		InputSchema: obj(map[string]any{"tab_id": tabID, "url": str("http(s) URL"), "session": sessionField}, "tab_id", "url")},
	{Name: "browser_read_page", Annotations: readOnly, Description: "Read a tab this agent opened. mode=text returns visible text, mode=snapshot returns a DOM snapshot with element refs.",
		cmd: "read_page", scope: ScopeRead, required: []string{"tab_id"},
		InputSchema: obj(map[string]any{"tab_id": tabID, "session": sessionField, "mode": map[string]any{"type": "string", "enum": []string{"text", "snapshot"}}}, "tab_id")},
	{Name: "browser_click", Annotations: acting, Description: "Click an element in a tab this agent opened (selector or ref).", cmd: "click", scope: ScopeAct, required: []string{"tab_id"},
		InputSchema: obj(target(map[string]any{"session": sessionField}), "tab_id")},
	{Name: "browser_type", Annotations: acting, Description: "Type text into an element in a tab this agent opened. Password fields are refused (needs_human).", cmd: "type", scope: ScopeAct, required: []string{"tab_id", "text"},
		InputSchema: obj(target(map[string]any{"text": str("Text to type"), "session": sessionField}), "tab_id", "text")},
	{Name: "browser_form_input", Annotations: acting, Description: "Set a form field in a tab this agent opened. Password fields are refused (needs_human).", cmd: "form_input", scope: ScopeAct, required: []string{"tab_id", "value"},
		InputSchema: obj(target(map[string]any{"value": str("Value to set"), "session": sessionField}), "tab_id", "value")},
	{Name: "browser_screenshot", Annotations: readOnly, Description: "Screenshot a tab this agent opened, only if that tab is already visible. Never raises a window and never switches the user's tab.", cmd: "screenshot", scope: ScopeRead, required: []string{"tab_id"},
		InputSchema: obj(map[string]any{"tab_id": tabID, "session": sessionField}, "tab_id")},
	{Name: "browser_activate", Annotations: acting, Description: "Activate a tab this agent opened.", cmd: "activate", scope: ScopeAct, required: []string{"tab_id"},
		InputSchema: obj(map[string]any{"tab_id": tabID, "session": sessionField}, "tab_id")},
	{Name: "browser_set_file", Annotations: acting, Description: "Attach a file to input[type=file] in a tab this agent opened. First POST the bytes to /v1/agent/blobs, then pass that blob url and token. Does not open a file dialog and does not touch the user's tab.", cmd: "set_file", scope: ScopeAct, required: []string{"tab_id", "url", "token"},
		InputSchema: obj(target(map[string]any{
			"url": str("Blob URL returned by POST /v1/agent/blobs"),
			"token": str("Blob token returned with that URL"),
			"filename": str("File name, for example video.mp4"),
			"session": sessionField,
		}), "tab_id", "url", "token")},
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	// DNS-rebinding guard: browsers always send Origin, MCP clients do not.
	if o := r.Header.Get("Origin"); o != "" && !contains(s.cfg.AllowedOrigins, o) {
		jerr(w, http.StatusForbidden, "origin not allowed")
		return
	}
	a, ok := s.Store.AgentByToken(bearer(r), s.now())
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="capy-browser-relay"`)
		jerr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req rpcReq
	if !readBody(w, r, &req, 1<<20) {
		return
	}
	if len(req.ID) == 0 { // notification
		w.WriteHeader(http.StatusAccepted)
		return
	}
	reply := func(result any) {
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}
	rpcErr := func(code int, msg string) {
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": code, "message": msg}})
	}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		ver := supportedProtocols[0]
		if contains(supportedProtocols, p.ProtocolVersion) {
			ver = p.ProtocolVersion
		}
		reply(map[string]any{
			"protocolVersion": ver,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "capy-browser-relay", "version": "0.1.0"},
			"instructions":    "Controls the owner's real browser through a relay. Pass the same session string on every call from one chat. browser_tabs_open adds an inactive tab to that session's tab group and does not focus Chrome. Do not reuse another session's tab id. Never switch the user's current tab. To upload a video, POST the file to /v1/agent/blobs and then call browser_set_file with the returned url and token.",
		})
	case "ping":
		reply(map[string]any{})
	case "tools/list":
		list := []tool{}
		for _, t := range tools {
			if t.scope == "" || a.HasScope(t.scope) {
				list = append(list, t)
			}
		}
		reply(map[string]any{"tools": list})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if json.Unmarshal(req.Params, &p) != nil {
			rpcErr(-32602, "invalid params")
			return
		}
		var t *tool
		for i := range tools {
			if tools[i].Name == p.Name {
				t = &tools[i]
			}
		}
		if t == nil {
			rpcErr(-32602, "unknown tool "+p.Name)
			return
		}
		if t.cmd == "" {
			b, _ := json.Marshal(map[string]any{"browsers": s.ListBrowsers(a)})
			reply(textResult(string(b), false))
			return
		}
		args := p.Arguments
		if args == nil {
			args = map[string]any{}
		}
		browser, _ := args["browser"].(string)
		delete(args, "browser")
		for _, k := range t.required {
			if _, ok := args[k]; !ok {
				reply(textResult("missing argument: "+k, true))
				return
			}
		}
		res, cerr := s.Execute(r.Context(), a, browser, t.cmd, args)
		if cerr != nil {
			b, _ := json.Marshal(cerr)
			reply(textResult(string(b), true))
			return
		}
		reply(resultContent(t.cmd, res))
	default:
		rpcErr(-32601, "method not found")
	}
}

func textResult(text string, isErr bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isErr}
}

// resultContent turns a screenshot into an MCP image block and everything
// else into JSON text.
func resultContent(cmd string, res json.RawMessage) map[string]any {
	if cmd == "screenshot" {
		var v struct {
			Data     string `json:"data"`
			MimeType string `json:"mime_type"`
		}
		if json.Unmarshal(res, &v) == nil && v.Data != "" {
			mt := v.MimeType
			if mt == "" {
				mt = "image/png"
			}
			return map[string]any{"content": []map[string]any{{"type": "image", "data": v.Data, "mimeType": mt}}, "isError": false}
		}
	}
	var buf bytes.Buffer
	if json.Compact(&buf, res) != nil {
		return textResult(string(res), false)
	}
	return textResult(buf.String(), false)
}
